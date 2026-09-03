import type { Queryable } from './pool.js';

/**
 * What a PERSON concluded, on criteria this service does not model.
 *
 * A different fact by a different actor, so a different row rather than an edit
 * to `pre_decisions` (ADR-0006). This is what keeps replay meaningful: replay
 * compares against the ENGINE's verdict, so a legitimate human override cannot
 * look like tampering.
 */

export type ReviewState = 'PENDING' | 'CLOSED';
export type ReviewOutcome = 'APPROVED' | 'DECLINED';

export interface ReviewRecord {
  readonly applicationId: string;
  readonly state: ReviewState;
  readonly outcome: ReviewOutcome | null;
  readonly approvedAmountMinor: number | null;
  readonly reviewerId: string | null;
  readonly rationale: string | null;
  readonly openedAt: Date;
  readonly closedAt: Date | null;
}

interface Row {
  application_id: string;
  state: ReviewState;
  outcome: ReviewOutcome | null;
  approved_amount_minor: string | null;
  reviewer_id: string | null;
  rationale: string | null;
  opened_at: Date;
  closed_at: Date | null;
}

const toRecord = (row: Row): ReviewRecord => ({
  applicationId: row.application_id,
  state: row.state,
  outcome: row.outcome,
  approvedAmountMinor: row.approved_amount_minor === null ? null : Number(row.approved_amount_minor),
  reviewerId: row.reviewer_id,
  rationale: row.rationale,
  openedAt: row.opened_at,
  closedAt: row.closed_at,
});

export const openReview = async (tx: Queryable, applicationId: string, openedAt: Date): Promise<void> => {
  await tx.query(
    `INSERT INTO reviews (application_id, state, opened_at) VALUES ($1, 'PENDING', $2)`,
    [applicationId, openedAt],
  );
};

export const findReview = async (db: Queryable, applicationId: string): Promise<ReviewRecord | null> => {
  const { rows } = await db.query<Row>(`SELECT * FROM reviews WHERE application_id = $1`, [applicationId]);
  const row = rows[0];
  return row === undefined ? null : toRecord(row);
};

/**
 * A compare-and-set, not a read-then-write.
 *
 * `WHERE state = 'PENDING'` is evaluated under the row lock, so two reviewers
 * closing the same application at the same moment produce one write and one
 * `409`. Read-then-write here would let the second overwrite the first: two
 * humans, two opinions, one silently discarded, and the audit showing only the
 * survivor.
 *
 * `reviewer_id` comes from the bearer token and never from the body. A reviewer
 * id a caller can choose is not an attribution.
 */
export const closeReview = async (
  tx: Queryable,
  input: {
    applicationId: string;
    outcome: ReviewOutcome;
    approvedAmountMinor: number | null;
    reviewerId: string;
    rationale: string;
    closedAt: Date;
  },
): Promise<ReviewRecord | null> => {
  const { rows } = await tx.query<Row>(
    `UPDATE reviews
        SET state = 'CLOSED', outcome = $2, approved_amount_minor = $3,
            reviewer_id = $4, rationale = $5, closed_at = $6
      WHERE application_id = $1 AND state = 'PENDING'
      RETURNING *`,
    [
      input.applicationId,
      input.outcome,
      input.approvedAmountMinor,
      input.reviewerId,
      input.rationale,
      input.closedAt,
    ],
  );
  const row = rows[0];
  return row === undefined ? null : toRecord(row);
};
