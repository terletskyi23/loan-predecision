import type { Queryable } from './pool.js';

/** docs/01-architecture.md §3. Identifying fields stay in `applicant`, which a future pseudonymisation job can clear. */
export interface ApplicantFields {
  readonly firstName: string;
  readonly lastName: string;
  readonly dateOfBirth: string;
  readonly email?: string;
  readonly phone?: string;
  readonly residenceCountry?: string;
}

/**
 * What the ENGINE reads, deliberately outside the erasable blob. `monthlyIncomeMinor`
 * is the denominator of DTI and the threshold at S1: a pre-decision cannot be
 * replayed without it, so erasing the applicant must not erase this.
 */
export interface FinanceFields {
  readonly monthlyIncomeMinor: number;
  readonly employmentStatus?: string;
  readonly employmentMonths?: number;
  readonly declaredMonthlyObligationsMinor: number;
}

export type ApplicationStatus = 'RECEIVED' | 'PRE_DECIDED' | 'IN_REVIEW' | 'REVIEW_CLOSED' | 'ABANDONED';

export interface ApplicationRecord {
  readonly id: string;
  readonly clientId: string;
  readonly status: ApplicationStatus;
  readonly productCode: string;
  readonly requestedAmountMinor: number;
  readonly termMonths: number;
  readonly currency: string;
  readonly purpose: string;
  readonly channel: string;
  readonly applicant: ApplicantFields;
  readonly finances: FinanceFields;
  readonly subjectKey: string;
  readonly customerId: string | null;
  readonly consentAttested: boolean;
  readonly consentAcceptedAt: Date;
  readonly submittedAt: Date;
}

interface Row {
  id: string;
  client_id: string;
  status: ApplicationStatus;
  product_code: string;
  requested_amount_minor: string;
  term_months: number;
  currency: string;
  purpose: string;
  channel: string;
  applicant: ApplicantFields;
  finances: FinanceFields;
  subject_key: string;
  customer_id: string | null;
  consent_attested: boolean;
  consent_accepted_at: Date;
  submitted_at: Date;
}

// `bigint` arrives from `pg` as a string, because a 64-bit integer does not fit
// a JS number. Every amount in this service is well inside Number.MAX_SAFE_INTEGER
// — a loan is not 9 quadrillion minor units — so converting here is safe and is
// done in exactly one place rather than at each call site.
const toRecord = (row: Row): ApplicationRecord => ({
  id: row.id,
  clientId: row.client_id,
  status: row.status,
  productCode: row.product_code,
  requestedAmountMinor: Number(row.requested_amount_minor),
  termMonths: row.term_months,
  currency: row.currency,
  purpose: row.purpose,
  channel: row.channel,
  applicant: row.applicant,
  finances: row.finances,
  subjectKey: row.subject_key,
  customerId: row.customer_id,
  consentAttested: row.consent_attested,
  consentAcceptedAt: row.consent_accepted_at,
  submittedAt: row.submitted_at,
});

/**
 * Inserts the application AND writes its id onto the idempotency key row in one
 * statement.
 *
 * The second half is what makes a crash recoverable. Without it, a lease
 * takeover creates a SECOND application for a key that already had one, and the
 * property "the same key twice produces one application" is false in exactly
 * the case the lease exists to handle.
 */
export const insertApplication = async (
  tx: Queryable,
  record: ApplicationRecord,
  key: { clientId: string; scope: string; key: string },
): Promise<void> => {
  await tx.query(
    `WITH inserted AS (
       INSERT INTO applications (
         id, client_id, status, product_code, requested_amount_minor, term_months, currency,
         purpose, channel, applicant, finances, subject_key, customer_id,
         consent_attested, consent_accepted_at, submitted_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14, $15, $16)
       RETURNING id
     )
     UPDATE idempotency_keys SET application_id = (SELECT id FROM inserted)
      WHERE client_id = $17 AND scope = $18 AND key = $19`,
    [
      record.id,
      record.clientId,
      record.status,
      record.productCode,
      record.requestedAmountMinor,
      record.termMonths,
      record.currency,
      record.purpose,
      record.channel,
      JSON.stringify(record.applicant),
      JSON.stringify(record.finances),
      record.subjectKey,
      record.customerId,
      record.consentAttested,
      record.consentAcceptedAt,
      record.submittedAt,
      key.clientId,
      key.scope,
      key.key,
    ],
  );
};

/**
 * Owner-scoped by `client_id`, always.
 *
 * An unknown id and another client's id both return nothing, and the route
 * turns both into `404`. A `403` would confirm the application exists, which
 * leaks the existence of a competitor's applicant to anyone who can guess a
 * UUID — the classic IDOR, and the reason this takes a client id rather than
 * offering a "find by id" that a caller might forget to scope.
 */
export const findApplication = async (
  db: Queryable,
  id: string,
  clientId: string,
): Promise<ApplicationRecord | null> => {
  const { rows } = await db.query<Row>(
    `SELECT * FROM applications WHERE id = $1 AND client_id = $2`,
    [id, clientId],
  );
  const row = rows[0];
  return row === undefined ? null : toRecord(row);
};

/** Unscoped, for the auditor endpoints and for replay, where the whole point is to read across clients. */
export const findApplicationForAudit = async (db: Queryable, id: string): Promise<ApplicationRecord | null> => {
  const { rows } = await db.query<Row>(`SELECT * FROM applications WHERE id = $1`, [id]);
  const row = rows[0];
  return row === undefined ? null : toRecord(row);
};

export const setApplicationStatus = async (
  tx: Queryable,
  id: string,
  status: ApplicationStatus,
): Promise<void> => {
  await tx.query(`UPDATE applications SET status = $2 WHERE id = $1`, [id, status]);
};
