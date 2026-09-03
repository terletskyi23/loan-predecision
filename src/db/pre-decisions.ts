import type { LookupFailureCause } from '../domain/bureau-lookup.js';
import type { Verdict } from '../domain/engine.js';
import type { Queryable } from './pool.js';

/** What the ENGINE concluded. One row per application, written once, never updated (ADR-0006). */
export interface PreDecisionRecord {
  readonly applicationId: string;
  readonly verdict: Verdict;
  readonly reasonCodes: readonly string[];
  readonly requestedAmountMinor: number;
  readonly approvedAmountMinor: number | null;
  readonly monthlyPaymentMinor: number | null;
  readonly offerExpiresAt: Date | null;
  readonly score: number | null;
  readonly dti: number | null;
  readonly policyVersion: string;
  readonly engineVersion: string;
  readonly bureauReportId: string | null;
  readonly bureauReportReused: boolean;
  readonly lookupFailureCause: LookupFailureCause | null;
  readonly decidedAt: Date;
}

interface Row {
  application_id: string;
  verdict: Verdict;
  reason_codes: string[];
  requested_amount_minor: string;
  approved_amount_minor: string | null;
  monthly_payment_minor: string | null;
  offer_expires_at: Date | null;
  score: number | null;
  dti: string | null;
  policy_version: string;
  engine_version: string;
  bureau_report_id: string | null;
  bureau_report_reused: boolean;
  lookup_failure_cause: LookupFailureCause | null;
  decided_at: Date;
}

const toRecord = (row: Row): PreDecisionRecord => ({
  applicationId: row.application_id,
  verdict: row.verdict,
  reasonCodes: row.reason_codes,
  requestedAmountMinor: Number(row.requested_amount_minor),
  approvedAmountMinor: row.approved_amount_minor === null ? null : Number(row.approved_amount_minor),
  monthlyPaymentMinor: row.monthly_payment_minor === null ? null : Number(row.monthly_payment_minor),
  offerExpiresAt: row.offer_expires_at,
  score: row.score,
  // numeric arrives as a string for the same reason bigint does: the driver
  // will not silently narrow a value it cannot represent.
  dti: row.dti === null ? null : Number(row.dti),
  policyVersion: row.policy_version,
  engineVersion: row.engine_version,
  bureauReportId: row.bureau_report_id,
  bureauReportReused: row.bureau_report_reused,
  lookupFailureCause: row.lookup_failure_cause,
  decidedAt: row.decided_at,
});

export const insertPreDecision = async (tx: Queryable, record: PreDecisionRecord): Promise<void> => {
  await tx.query(
    `INSERT INTO pre_decisions
       (application_id, verdict, reason_codes, requested_amount_minor, approved_amount_minor,
        monthly_payment_minor, offer_expires_at, score, dti, policy_version, engine_version,
        bureau_report_id, bureau_report_reused, lookup_failure_cause, decided_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      record.applicationId,
      record.verdict,
      record.reasonCodes,
      record.requestedAmountMinor,
      record.approvedAmountMinor,
      record.monthlyPaymentMinor,
      record.offerExpiresAt,
      record.score,
      record.dti,
      record.policyVersion,
      record.engineVersion,
      record.bureauReportId,
      record.bureauReportReused,
      record.lookupFailureCause,
      record.decidedAt,
    ],
  );
};

export const findPreDecision = async (db: Queryable, applicationId: string): Promise<PreDecisionRecord | null> => {
  const { rows } = await db.query<Row>(`SELECT * FROM pre_decisions WHERE application_id = $1`, [applicationId]);
  const row = rows[0];
  return row === undefined ? null : toRecord(row);
};

/**
 * The auditor listing, joined to the subject key.
 *
 * The key is what makes "did this person apply eleven times this week" an
 * answerable audit question, and that linkage is the whole reason a listing
 * exists. docs/04 §4 states the consequence rather than hiding behind it: a
 * keyed hash is pseudonymous personal data, not de-identified data, and the
 * export is scoped to the auditor token and covered by the same retention rules
 * as everything else.
 */
export const listPreDecisions = async (
  db: Queryable,
  options: { limit: number; before?: Date },
): Promise<readonly (PreDecisionRecord & { subjectKey: string })[]> => {
  const { rows } = await db.query<Row & { subject_key: string }>(
    `SELECT p.*, a.subject_key
       FROM pre_decisions p JOIN applications a ON a.id = p.application_id
      WHERE ($2::timestamptz IS NULL OR p.decided_at < $2)
      ORDER BY p.decided_at DESC, p.application_id
      LIMIT $1`,
    [options.limit, options.before ?? null],
  );
  return rows.map((row) => ({ ...toRecord(row), subjectKey: row.subject_key }));
};
