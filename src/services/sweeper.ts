import type { Logger } from 'pino';
import { appendAuditEvent } from '../db/audit.js';
import type { Database } from '../db/pool.js';
import type { Metrics } from '../metrics.js';

/**
 * The orphan sweeper, and the retention job that shares its tick.
 *
 * AN ORPHAN IS AN APPLICATION NOTHING ELSE WILL EVER RESOLVE. A process dies
 * between the application insert and the closing transaction — mid-pull, most
 * likely — and the row sits in `RECEIVED` with an `IN_PROGRESS` idempotency key
 * beside it. The caller never retried, so no takeover happens; the bureau claim
 * expires and is reclaimed by somebody else; and the row stays. Nothing in the
 * request path can clean it up, because there is no request.
 *
 * The consequences of leaving it are small but all real: the funnel counts an
 * application that will never reach a verdict, the audit chain ends at
 * `BUREAU_PULL_REQUESTED` with no terminal event after it — a record saying we
 * marked someone's credit file and never says what came of it — and the
 * idempotency key is never released.
 *
 * WHY THE STATUS CHANGE IS A COMPARE-AND-SET. `WHERE status = 'RECEIVED'` is
 * evaluated under the row lock, so a request that is slow rather than dead
 * cannot have its application abandoned out from under it: one of the two
 * writes wins, and if the request wins, the sweeper's update matches nothing and
 * it moves on. A read-then-write here would let the sweeper abandon an
 * application that was decided a millisecond later.
 */

export interface SweeperOptions {
  readonly database: Database;
  readonly metrics: Metrics;
  readonly logger: Logger;
  readonly afterMinutes: number;
  readonly intervalMinutes: number;
  readonly idempotencyRetentionHours: number;
  readonly claimLeaseMs: number;
  readonly now?: () => Date;
}

export interface SweepResult {
  readonly abandoned: number;
  readonly keysPurged: number;
  readonly claimsPurged: number;
}

const MS_PER_MINUTE = 60_000;

export const createSweeper = (options: SweeperOptions) => {
  const { database, metrics, logger } = options;
  const clock = options.now ?? ((): Date => new Date());

  /**
   * One pass. Returns what it did so a test can assert on it and an operator can
   * read it in the logs — a sweeper whose only evidence is the absence of rows
   * is one nobody can tell has stopped running.
   */
  const sweepOnce = async (): Promise<SweepResult> => {
    const now = clock();
    const cutoff = new Date(now.getTime() - options.afterMinutes * MS_PER_MINUTE);

    // Served by `applications_orphan_sweep_idx`, the partial index on
    // status = 'RECEIVED'. Candidates are a vanishing fraction of the table, so
    // this never scans it.
    const { rows } = await database.query<{ id: string }>(
      `SELECT id FROM applications WHERE status = 'RECEIVED' AND submitted_at < $1 ORDER BY submitted_at LIMIT 200`,
      [cutoff],
    );

    let abandoned = 0;
    for (const row of rows) {
      // One transaction per application: the status change, its audit event and
      // the key release are one fact about one applicant. Batching them would
      // mean a failure on the two-hundredth row rolls back the other 199.
      const closed = await database.transaction(async (tx) => {
        const claimed = await tx.query(
          `UPDATE applications SET status = 'ABANDONED' WHERE id = $1 AND status = 'RECEIVED' RETURNING id`,
          [row.id],
        );
        if (claimed.rowCount === 0) return false;

        await appendAuditEvent(tx, {
          applicationId: row.id,
          eventType: 'APPLICATION_ABANDONED',
          actor: 'system',
          payload: { reason: 'no verdict was reached', thresholdMinutes: options.afterMinutes },
          occurredAt: now,
        });

        // Released in the SAME transaction, so the two cannot disagree. An
        // ABANDONED key is treated as a fresh submission on a later retry — a
        // new application, and still no second bureau pull, because layer 3
        // holds independently of this.
        await tx.query(
          `UPDATE idempotency_keys SET state = 'ABANDONED' WHERE application_id = $1 AND state = 'IN_PROGRESS'`,
          [row.id],
        );
        return true;
      });

      if (closed) {
        abandoned += 1;
        metrics.applicationsAbandoned.inc();
      }
    }

    // Retention. `expires_at` was written on every key from the first commit and
    // read by nothing, so a COMPLETED key replayed a two-year-old body forever
    // and the table grew without bound. An IN_PROGRESS key is left alone
    // whatever its expiry says: deleting one mid-request would let a concurrent
    // retry start a second application under the same key.
    const keys = await database.query(
      `DELETE FROM idempotency_keys WHERE expires_at < $1 AND state <> 'IN_PROGRESS'`,
      [now],
    );

    // Coordination, not evidence: cleared well after any waiter could care.
    // Ten leases past expiry is arbitrary and deliberately generous — the row is
    // tiny and deleting one a waiter still wants is the only way to get this
    // wrong.
    const claims = await database.query(
      `DELETE FROM bureau_pull_claims WHERE lease_expires_at < $1`,
      [new Date(now.getTime() - options.claimLeaseMs * 10)],
    );

    const result = {
      abandoned,
      keysPurged: keys.rowCount ?? 0,
      claimsPurged: claims.rowCount ?? 0,
    };

    if (result.abandoned > 0 || result.keysPurged > 0 || result.claimsPurged > 0) {
      logger.info(result, 'sweep');
    }
    return result;
  };

  let timer: NodeJS.Timeout | undefined;

  return {
    sweepOnce,

    start(): void {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        // A sweep that throws must not take the process with it, and must not
        // stop the next one: an unhandled rejection here would kill a service
        // that is otherwise serving requests perfectly well.
        void sweepOnce().catch((error: unknown) => {
          logger.error({ err: error }, 'sweep failed; the next tick will retry');
        });
      }, options.intervalMinutes * MS_PER_MINUTE);

      // Unreferenced, so an idle sweeper never holds the event loop open and
      // delays a shutdown the platform is waiting on.
      timer.unref();
      logger.info({ everyMinutes: options.intervalMinutes, afterMinutes: options.afterMinutes }, 'sweeper started');
    },

    stop(): void {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
};

export type Sweeper = ReturnType<typeof createSweeper>;
