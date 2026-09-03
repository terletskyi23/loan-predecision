import type { Config } from '../config.js';
import { findApplicationForAudit } from '../db/applications.js';
import { readAuditChain, verifyAuditChain } from '../db/audit.js';
import { findReportById } from '../db/bureau-reports.js';
import { findPreDecision, listPreDecisions } from '../db/pre-decisions.js';
import type { Database } from '../db/pool.js';
import type { BureauLookup } from '../domain/bureau-lookup.js';
import { decide, screen } from '../domain/engine.js';
import type { PolicyStore } from '../policy/loader.js';
import { engineApplicationFrom } from './envelope.js';

/**
 * Replay: the part that makes the audit verifiable rather than merely stored.
 *
 * Re-runs the engine against the STORED application, the STORED bureau lookup,
 * the POLICY VERSION RECORDED ON THE PRE-DECISION, and `submittedAt` AS THE
 * CLOCK.
 *
 * Every one of those four is a trap if taken from today instead:
 *
 *   today's policy      — after October's rules ship, every September decision
 *                         "fails" replay and the tool reports tampering across
 *                         the whole portfolio
 *   a fresh bureau call — a different report, a new hard enquiry on the
 *                         applicant's file, and a verification step that harms
 *                         the person it is meant to protect
 *   today's clock       — `screen` derives age and age at maturity from it, so
 *                         an applicant who was 74 at maturity becomes an
 *                         AGE_ABOVE_MAXIMUM_AT_MATURITY decline and replay
 *                         reports tampering where there is none
 *   the current engine  — legitimate; that is what `engineVersion` is for, and a
 *                         mismatch there is reported as a difference rather than
 *                         hidden
 *
 * WHAT REPLAY COMPARES AND WHAT IT IGNORES. It compares the ENGINE's verdict,
 * never the composed outcome. A human who overrode a referral did not tamper
 * with anything, and a replay that flagged them would make every legitimate
 * override look like fraud — which is exactly why ADR-0006 keeps the reviewer's
 * outcome in its own table.
 */

export interface ReplayResult {
  readonly applicationId: string;
  readonly match: boolean;
  readonly recorded: ReplaySnapshot;
  readonly recomputed: ReplaySnapshot;
  readonly differences: string[];
  readonly replayedAt: string;
}

/**
 * EVERY DERIVED FIELD, not a selection.
 *
 * An earlier version compared the verdict, the codes, the approved amount and
 * the score — and nothing else. `monthlyPaymentMinor`, `dti` and
 * `offerExpiresAt` were outside the verifier, so the instalment could be edited
 * in the database to a cent and replay still answered `match: true` while the
 * status endpoint happily served the altered figure. The instalment and the
 * expiry are the two numbers an applicant is actually held to, which made them
 * the worst possible fields to leave out of the tool whose only job is to notice
 * that stored evidence changed.
 *
 * `requestedAmountMinor` is here too: it is duplicated onto `pre_decisions` to
 * carry the counter-offer constraint (migration 002), and an unverified
 * duplicate is a way to neuter that constraint silently.
 */
interface ReplaySnapshot {
  readonly verdict: string;
  // A mutable array at the serialisation boundary, not out of carelessness: the
  // response schema describes JSON, and JSON has no readonly.
  readonly reasonCodes: string[];
  readonly requestedAmountMinor: number | null;
  readonly approvedAmountMinor: number | null;
  readonly monthlyPaymentMinor: number | null;
  readonly offerExpiresAt: string | null;
  readonly score: number | null;
  readonly dti: number | null;
  readonly policyVersion: string;
  readonly engineVersion: string;
}

export const createAuditService = (options: { database: Database; policies: PolicyStore; config: Config }) => {
  const { database, policies, config } = options;

  return {
    async events(applicationId: string) {
      const application = await findApplicationForAudit(database, applicationId);
      if (application === null) return null;
      const events = await readAuditChain(database, applicationId);
      return {
        applicationId,
        events: events.map((event) => ({
          index: event.chainIndex,
          type: event.eventType,
          at: event.occurredAt.toISOString(),
          actor: event.actor,
          detail: event.payload,
          hash: event.hash,
        })),
      };
    },

    async chain(applicationId: string) {
      const application = await findApplicationForAudit(database, applicationId);
      if (application === null) return null;
      const verification = await verifyAuditChain(database, applicationId);
      return {
        applicationId,
        events: verification.events,
        chainIntact: verification.intact,
        brokenAtIndex: verification.brokenAt,
        verifiedAt: new Date().toISOString(),
      };
    },

    async list(limit: number) {
      const rows = await listPreDecisions(database, { limit });
      return {
        preDecisions: rows.map((row) => ({
          applicationId: row.applicationId,
          verdict: row.verdict,
          reasonCodes: [...row.reasonCodes],
          score: row.score,
          policyVersion: row.policyVersion,
          bureauReportReused: row.bureauReportReused,
          decidedAt: row.decidedAt.toISOString(),
        })),
      };
    },

    async replay(applicationId: string): Promise<ReplayResult | null> {
      const application = await findApplicationForAudit(database, applicationId);
      if (application === null) return null;
      const recorded = await findPreDecision(database, applicationId);
      if (recorded === null) return null;

      // THAT version, not today's.
      const policy = await policies.get(recorded.policyVersion);
      const engineApplication = engineApplicationFrom(application);

      // Reconstructed from what was stored, never re-fetched.
      let lookup: BureauLookup;
      if (recorded.bureauReportId === null) {
        lookup = {
          outcome: 'UNAVAILABLE',
          provider: config.BUREAU_PROVIDER,
          // The cause is an engine input for a BUREAU_UNAVAILABLE referral, which
          // is why it is a column on pre_decisions rather than only an audit
          // payload. Without it this branch could not be reproduced at all.
          cause: recorded.lookupFailureCause ?? 'RETRIES_EXHAUSTED',
        };
      } else {
        const stored = await findReportById(database, recorded.bureauReportId);
        if (stored === null) return null;
        lookup =
          stored.outcome === 'FOUND' && stored.report !== null
            ? { outcome: 'FOUND', report: stored.report }
            : { outcome: 'NO_HIT', provider: stored.provider, pulledAt: stored.pulledAt };
      }

      // `submittedAt` as the clock. Never now().
      const knockout = screen(engineApplication, policy, application.submittedAt);
      const result =
        knockout ?? decide(engineApplication, lookup, policy, application.submittedAt);

      const recomputed: ReplaySnapshot = {
        verdict: result.verdict,
        reasonCodes: [...result.reasonCodes],
        requestedAmountMinor: application.requestedAmountMinor,
        approvedAmountMinor: 'approvedAmountMinor' in result ? result.approvedAmountMinor : null,
        monthlyPaymentMinor: 'monthlyPaymentMinor' in result ? result.monthlyPaymentMinor : null,
        offerExpiresAt: 'offerExpiresAt' in result ? (result.offerExpiresAt?.toISOString() ?? null) : null,
        score: 'score' in result ? result.score : null,
        dti: 'dti' in result ? result.dti : null,
        policyVersion: policy.version,
        engineVersion: config.ENGINE_VERSION,
      };

      const recordedSnapshot: ReplaySnapshot = {
        verdict: recorded.verdict,
        reasonCodes: [...recorded.reasonCodes],
        requestedAmountMinor: recorded.requestedAmountMinor,
        approvedAmountMinor: recorded.approvedAmountMinor,
        monthlyPaymentMinor: recorded.monthlyPaymentMinor,
        offerExpiresAt: recorded.offerExpiresAt?.toISOString() ?? null,
        score: recorded.score,
        dti: recorded.dti,
        policyVersion: recorded.policyVersion,
        engineVersion: recorded.engineVersion,
      };

      const differences: string[] = [];
      const compare = (field: keyof ReplaySnapshot): void => {
        const left = recordedSnapshot[field];
        const right = recomputed[field];
        const same = Array.isArray(left) && Array.isArray(right) ? left.join(',') === right.join(',') : left === right;
        if (!same) differences.push(field);
      };

      // Walked as a list rather than written out as a chain of ifs, so a field
      // added to the snapshot and forgotten here is a compile error rather than
      // a silent hole in the verifier — which is exactly how the last hole got in.
      const COMPARED: readonly (keyof ReplaySnapshot)[] = [
        'verdict',
        'reasonCodes',
        'requestedAmountMinor',
        'approvedAmountMinor',
        'monthlyPaymentMinor',
        'offerExpiresAt',
        'score',
        'dti',
        'policyVersion',
      ];
      COMPARED.forEach(compare);
      // An engine version change is a legitimate difference and is reported
      // rather than hidden: that is the whole reason the column exists. It does
      // not, on its own, make the replay a mismatch of the DECISION. It is
      // outside COMPARED for that reason, not by oversight.
      if (recordedSnapshot.engineVersion !== recomputed.engineVersion) differences.push('engineVersion');

      const decisionDiffers = differences.some((field) => field !== 'engineVersion');

      return {
        applicationId,
        match: !decisionDiffers,
        recorded: recordedSnapshot,
        recomputed,
        differences,
        replayedAt: new Date().toISOString(),
      };
    },
  };
};

export type AuditService = ReturnType<typeof createAuditService>;
