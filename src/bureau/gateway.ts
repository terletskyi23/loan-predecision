import { randomUUID } from 'node:crypto';
import type { BureauLookup, BureauReport, LookupFailureCause } from '../domain/bureau-lookup.js';
import type { Database } from '../db/pool.js';
import {
  claimPull,
  completeClaim,
  failClaim,
  findReportById,
  findReusableReport,
  insertBureauReport,
  readClaim,
} from '../db/bureau-reports.js';
import type { Metrics } from '../metrics.js';
import { pullKey } from './subject-key.js';
import type { BureauProvider } from './provider.js';
import { pullWithResilience } from './resilience.js';

/**
 * Layer 3 of docs/02-idempotency.md — the layer the brief is actually about.
 *
 *   "Duplicate submits must not create duplicate bureau work."
 *
 * Two guards in order, because they catch different things. REUSE catches
 * duplicates separated in time: one indexed lookup, no lock, and it covers the
 * common human case — a person declined at $32,000 who immediately tries
 * $28,000, or who submits through two channels. THE CLAIM catches duplicates
 * that arrive together, which reuse alone cannot: two requests in the same
 * instant both miss the lookup and both would call out.
 *
 * The reuse check runs FIRST because the common case should not take a lock.
 */

export interface GatewayRequest {
  readonly nationalId: string;
  readonly subjectKey: string;
  readonly applicationId: string;
  readonly clientId: string;
  readonly now: Date;
  /**
   * Appended BEFORE the network call, not after it, and only by the request
   * that actually places one. A process dying mid-pull must still leave a record
   * that this person's credit file was marked — otherwise the one harm this
   * whole module exists to prevent is erased by the crash that caused it.
   */
  readonly onPullRequested: () => Promise<void>;
}

export interface GatewayResult {
  readonly lookup: BureauLookup;
  /** Null only when nothing was learned: an UNAVAILABLE writes no evidence. */
  readonly reportId: string | null;
  /** True when no new enquiry was placed for THIS application — whether reused from the TTL or read from another request's pull. */
  readonly reused: boolean;
  readonly failureCause: LookupFailureCause | null;
}

export interface BureauGateway {
  getReport(request: GatewayRequest): Promise<GatewayResult>;
}

export interface GatewayOptions {
  readonly database: Database;
  readonly provider: BureauProvider;
  readonly metrics: Metrics;
  readonly reportTtlMinutes: number;
  readonly claimLeaseMs: number;
  readonly waitMs: number;
  readonly waitPollMs: number;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly backoffBaseMs: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Everything except `provider` and `pulledAt`, which are columns rather than payload. */
const toPayload = (report: BureauReport): Record<string, unknown> => {
  const { provider: _provider, pulledAt: _pulledAt, ...attributes } = report;
  return attributes as unknown as Record<string, unknown>;
};

const lookupFromStored = (
  outcome: 'FOUND' | 'NO_HIT',
  report: BureauReport | null,
  provider: string,
  pulledAt: Date,
): BureauLookup =>
  outcome === 'FOUND' && report !== null
    ? { outcome: 'FOUND', report }
    : { outcome: 'NO_HIT', provider, pulledAt };

export const createBureauGateway = (options: GatewayOptions): BureauGateway => {
  const { database, provider, metrics } = options;

  const readFinishedReport = async (reportId: string): Promise<GatewayResult | null> => {
    const stored = await findReportById(database, reportId);
    if (stored === null) return null;
    return {
      lookup: lookupFromStored(stored.outcome, stored.report, stored.provider, stored.pulledAt),
      reportId: stored.id,
      reused: true,
      failureCause: null,
    };
  };

  /**
   * A loser polls THE CLAIM ROW AND THE REPORT TOGETHER. Polling the report
   * alone is the subtle mistake: when the bureau is down the winner fails after
   * ~1.75 s and writes nothing, so a waiter watching only the report table sees
   * an empty table for the full 2 s and records WAIT_EXPIRED — the code meaning
   * "the bureau was fine, we ran out of patience" — during an actual outage,
   * while the winner recorded SERVER_ERROR for the same fact in the same second.
   * Reading the claim removes the case and shortens the loser's latency.
   */
  const waitForWinner = async (key: string, deadline: number): Promise<GatewayResult> => {
    metrics.bureauClaimContention.inc();

    for (;;) {
      const claim = await readClaim(database, key);

      if (claim?.state === 'DONE' && claim.reportId !== null) {
        const finished = await readFinishedReport(claim.reportId);
        if (finished !== null) {
          metrics.bureauLookups.inc({ result: 'waited' });
          return finished;
        }
      }

      if (claim?.state === 'FAILED') {
        // Adopt the winner's REAL cause (migration 003). Inventing one here
        // would put two contradictory explanations of a single external fact
        // into two applications decided in the same second.
        metrics.bureauLookups.inc({ result: 'unavailable' });
        return {
          lookup: { outcome: 'UNAVAILABLE', provider: provider.name, cause: claim.failureCause ?? 'RETRIES_EXHAUSTED' },
          reportId: null,
          reused: false,
          failureCause: claim.failureCause ?? 'RETRIES_EXHAUSTED',
        };
      }

      if (Date.now() >= deadline) break;
      await sleep(Math.min(options.waitPollMs, Math.max(0, deadline - Date.now())));
    }

    // Re-read once after the deadline. The winner may have committed a
    // millisecond after the last poll, and returning BUREAU_UNAVAILABLE while a
    // perfectly good report exists in the same database is the kind of bug that
    // never shows up in a test and always shows up in production.
    const last = await readClaim(database, key);
    if (last?.state === 'DONE' && last.reportId !== null) {
      const finished = await readFinishedReport(last.reportId);
      if (finished !== null) {
        metrics.bureauLookups.inc({ result: 'waited' });
        return finished;
      }
    }

    // A genuine WAIT_EXPIRED: the winner is still running and slower than our
    // patience. The bureau was not unavailable — WE stopped waiting. The verdict
    // is still MANUAL_REVIEW and the applicant's notice still says
    // BUREAU_UNAVAILABLE, because that is what it can honestly say; the distinct
    // cause lives in the audit and in this counter.
    metrics.bureauWaitExpired.inc();
    metrics.bureauLookups.inc({ result: 'unavailable' });
    return {
      lookup: { outcome: 'UNAVAILABLE', provider: provider.name, cause: 'WAIT_EXPIRED' },
      reportId: null,
      reused: false,
      failureCause: 'WAIT_EXPIRED',
    };
  };

  return {
    async getReport(request: GatewayRequest): Promise<GatewayResult> {
      const key = pullKey(request.subjectKey, provider.name);

      // ------------------------------------------------ 4.1 reuse
      const reusable = await findReusableReport(database, request.subjectKey, provider.name, request.now);
      if (reusable !== null) {
        metrics.bureauLookups.inc({ result: 'reused' });
        return {
          lookup: lookupFromStored(reusable.outcome, reusable.report, reusable.provider, reusable.pulledAt),
          reportId: reusable.id,
          reused: true,
          failureCause: null,
        };
      }

      // ------------------------------------------------ 4.2 claim
      const leaseExpiresAt = new Date(request.now.getTime() + options.claimLeaseMs);
      const claim = await claimPull(database, key, request.now, leaseExpiresAt);

      if (!claim.won) {
        // ---------------------------------------------- 4.3 bounded wait
        return waitForWinner(key, Date.now() + options.waitMs);
      }

      await request.onPullRequested();

      const lookup = await pullWithResilience(provider, request.nationalId, {
        timeoutMs: options.timeoutMs,
        maxAttempts: options.maxAttempts,
        backoffBaseMs: options.backoffBaseMs,
      });

      if (lookup.outcome === 'UNAVAILABLE') {
        // Only UNAVAILABLE writes nothing, because we learned nothing. FAILED is
        // immediately reclaimable so the next applicant does not sit out the
        // whole lease behind a call that already failed.
        await failClaim(database, key, lookup.cause === 'WAIT_EXPIRED' ? 'RETRIES_EXHAUSTED' : lookup.cause);
        metrics.bureauPulls.inc({ outcome: 'unavailable' });
        metrics.bureauLookups.inc({ result: 'unavailable' });
        return { lookup, reportId: null, reused: false, failureCause: lookup.cause };
      }

      const reportId = randomUUID();
      const pulledAt = lookup.outcome === 'FOUND' ? lookup.report.pulledAt : lookup.pulledAt;
      const expiresAt = new Date(pulledAt.getTime() + options.reportTtlMinutes * 60_000);

      // The report and the claim close together. A committed report with an
      // IN_FLIGHT claim would make every waiter sit out the full lease behind a
      // pull that already succeeded.
      await database.transaction(async (tx) => {
        await insertBureauReport(tx, {
          id: reportId,
          subjectKey: request.subjectKey,
          provider: provider.name,
          outcome: lookup.outcome,
          // WHOSE attestation caused this enquiry. Reuse crosses client
          // boundaries by design, so the client deciding on a report is
          // frequently not the client whose attestation caused it — and without
          // these two columns the audit answers "who said this person
          // authorised an enquiry" with the wrong client's name on every reused
          // report, which is the common case.
          attestedByClientId: request.clientId,
          causedByApplicationId: request.applicationId,
          pulledAt,
          expiresAt,
          payload: lookup.outcome === 'FOUND' ? toPayload(lookup.report) : {},
        });
        await completeClaim(tx, key, reportId);
      });

      metrics.bureauPulls.inc({ outcome: lookup.outcome.toLowerCase() });
      metrics.bureauLookups.inc({ result: 'pulled' });
      return { lookup, reportId, reused: false, failureCause: null };
    },
  };
};
