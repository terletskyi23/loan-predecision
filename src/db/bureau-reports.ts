import type { BureauProviderFailure, BureauReport } from '../domain/bureau-lookup.js';
import type { Queryable } from './pool.js';

/**
 * Two tables that look alike and are not.
 *
 * `bureau_reports` is IMMUTABLE EVIDENCE: written once, never updated, never
 * deleted. `expires_at` governs whether a row may still back a NEW pre-decision
 * and has nothing to do with deletion — deleting by it would break every replay
 * of every decision that used it.
 *
 * `bureau_pull_claims` is MUTABLE COORDINATION: a lock with a lease, changing
 * constantly, carrying no history worth keeping. Folding the two together means
 * a new pull overwrites the snapshot an old decision depends on.
 */

export type StoredOutcome = 'FOUND' | 'NO_HIT';

export interface StoredReport {
  readonly id: string;
  readonly subjectKey: string;
  readonly provider: string;
  readonly outcome: StoredOutcome;
  readonly report: BureauReport | null;
  readonly attestedByClientId: string;
  readonly causedByApplicationId: string;
  readonly pulledAt: Date;
  readonly expiresAt: Date;
}

interface ReportRow {
  id: string;
  subject_key: string;
  provider: string;
  outcome: StoredOutcome;
  payload: Record<string, unknown>;
  attested_by_client_id: string;
  caused_by_application_id: string;
  pulled_at: Date;
  expires_at: Date;
}

const toStored = (row: ReportRow): StoredReport => ({
  id: row.id,
  subjectKey: row.subject_key,
  provider: row.provider,
  outcome: row.outcome,
  report:
    row.outcome === 'FOUND'
      ? ({ ...(row.payload as unknown as BureauReport), pulledAt: row.pulled_at, provider: row.provider })
      : null,
  attestedByClientId: row.attested_by_client_id,
  causedByApplicationId: row.caused_by_application_id,
  pulledAt: row.pulled_at,
  expiresAt: row.expires_at,
});

/**
 * Layer 3, first move: the reuse lookup.
 *
 * The common case — the same person applying again after a decline — costs one
 * indexed lookup and no lock, which is why this runs before the claim rather
 * than after it.
 *
 * A `NO_HIT` is reusable too. It is evidence of what the bureau actually said,
 * and a second application inside the TTL must not trigger a second enquiry
 * just because the first one found nothing.
 */
export const findReusableReport = async (
  db: Queryable,
  subjectKey: string,
  provider: string,
  now: Date,
): Promise<StoredReport | null> => {
  const { rows } = await db.query<ReportRow>(
    `SELECT * FROM bureau_reports
      WHERE subject_key = $1 AND provider = $2 AND expires_at > $3
      ORDER BY pulled_at DESC
      LIMIT 1`,
    [subjectKey, provider, now],
  );
  const row = rows[0];
  return row === undefined ? null : toStored(row);
};

export const findReportById = async (db: Queryable, id: string): Promise<StoredReport | null> => {
  const { rows } = await db.query<ReportRow>(`SELECT * FROM bureau_reports WHERE id = $1`, [id]);
  const row = rows[0];
  return row === undefined ? null : toStored(row);
};

export const insertBureauReport = async (
  tx: Queryable,
  stored: Omit<StoredReport, 'report'> & { readonly payload: Record<string, unknown> },
): Promise<void> => {
  await tx.query(
    `INSERT INTO bureau_reports
       (id, subject_key, provider, outcome, payload, attested_by_client_id,
        caused_by_application_id, pulled_at, expires_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)`,
    [
      stored.id,
      stored.subjectKey,
      stored.provider,
      stored.outcome,
      JSON.stringify(stored.payload),
      stored.attestedByClientId,
      stored.causedByApplicationId,
      stored.pulledAt,
      stored.expiresAt,
    ],
  );
};

export type ClaimState = 'IN_FLIGHT' | 'DONE' | 'FAILED';

export interface ClaimRow {
  readonly pullKey: string;
  readonly state: ClaimState;
  readonly leaseExpiresAt: Date;
  readonly reportId: string | null;
  /** Set exactly when `state` is FAILED. Migration 003 makes that an invariant rather than a habit. */
  readonly failureCause: BureauProviderFailure | null;
}

interface RawClaim {
  pull_key: string;
  state: ClaimState;
  lease_expires_at: Date;
  report_id: string | null;
  failure_cause: BureauProviderFailure | null;
}

const toClaim = (row: RawClaim): ClaimRow => ({
  pullKey: row.pull_key,
  state: row.state,
  leaseExpiresAt: row.lease_expires_at,
  reportId: row.report_id,
  failureCause: row.failure_cause,
});

/**
 * Layer 3, second move: try to become the one request that calls the bureau.
 *
 * `ON CONFLICT DO UPDATE ... WHERE` is a compare-and-set. Postgres evaluates the
 * predicate under the row lock, so exactly one of N simultaneous callers gets a
 * row back and the rest get nothing.
 *
 * THE TAKEOVER PREDICATE IS THE HONEST WEAKNESS OF THIS DESIGN, and it is
 * deliberate rather than overlooked. A claim whose lease has expired is
 * reclaimable, because otherwise a crashed holder blocks a subject forever. But
 * a holder that is merely SLOW — a GC pause, a stalled managed-Postgres write, a
 * container the platform paused — is indistinguishable from a dead one, so the
 * second caller proceeds and a second hard enquiry lands on the applicant. The
 * winner does not verify it still holds the lease before writing, and
 * `bureau_reports` carries no uniqueness on `(subject_key, provider)`.
 *
 * Fixing it means fencing: a monotonic token issued with the claim, carried
 * through the pull, and checked on the write. v1 does not pay for that; the
 * trigger for revisiting is contention showing up in the metrics, and
 * docs/01-architecture.md §3 names it.
 */
export const claimPull = async (
  db: Queryable,
  pullKey: string,
  now: Date,
  leaseExpiresAt: Date,
): Promise<{ won: true } | { won: false; claim: ClaimRow }> => {
  const { rows } = await db.query<RawClaim>(
    `INSERT INTO bureau_pull_claims (pull_key, state, lease_expires_at, report_id)
     VALUES ($1, 'IN_FLIGHT', $2, NULL)
     ON CONFLICT (pull_key) DO UPDATE
        SET state = 'IN_FLIGHT', lease_expires_at = $2, report_id = NULL, failure_cause = NULL
      WHERE bureau_pull_claims.state = 'FAILED'
         OR bureau_pull_claims.lease_expires_at < $3
     RETURNING *`,
    [pullKey, leaseExpiresAt, now],
  );

  const won = rows[0];
  if (won !== undefined) return { won: true };

  const existing = await readClaim(db, pullKey);
  // Only reachable if the holder finished and something deleted the row between
  // the two statements, which nothing does. Treated as "we lost" rather than
  // asserted away, so the caller waits instead of racing.
  return {
    won: false,
    claim: existing ?? { pullKey, state: 'IN_FLIGHT', leaseExpiresAt, reportId: null, failureCause: null },
  };
};

export const readClaim = async (db: Queryable, pullKey: string): Promise<ClaimRow | null> => {
  const { rows } = await db.query<RawClaim>(`SELECT * FROM bureau_pull_claims WHERE pull_key = $1`, [pullKey]);
  const row = rows[0];
  return row === undefined ? null : toClaim(row);
};

/** DONE always carries a report id: a waiter reads this row to learn the result, and DONE without one makes that read lie. */
export const completeClaim = async (
  tx: Queryable,
  pullKey: string,
  reportId: string,
  heldSince: Date,
): Promise<void> => {
  // Guarded on the lease this caller was granted. Without it a stale holder can
  // flip a LIVE claim belonging to somebody else — and because FAILED is
  // deliberately reclaimable at once, a third request then pulls immediately
  // rather than waiting out any lease. That amplifies the documented lease
  // weakness instead of merely inheriting it, which is why the guard is here
  // even though the fencing token that would close the hole properly is not.
  await tx.query(
    `UPDATE bureau_pull_claims
        SET state = 'DONE', report_id = $2, failure_cause = NULL
      WHERE pull_key = $1 AND state = 'IN_FLIGHT' AND lease_expires_at = $3`,
    [pullKey, reportId, heldSince],
  );
};

/**
 * FAILED is immediately reclaimable, so a waiter does not sit out the whole
 * lease behind a call that already failed — and it carries WHY, so the waiter
 * adopts the winner's real cause instead of inventing one. Migration 003.
 */
export const failClaim = async (
  db: Queryable,
  pullKey: string,
  cause: BureauProviderFailure,
  heldSince: Date,
): Promise<void> => {
  await db.query(
    `UPDATE bureau_pull_claims
        SET state = 'FAILED', report_id = NULL, failure_cause = $2
      WHERE pull_key = $1 AND state = 'IN_FLIGHT' AND lease_expires_at = $3`,
    [pullKey, cause, heldSince],
  );
};
