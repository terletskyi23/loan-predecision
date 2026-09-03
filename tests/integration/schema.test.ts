import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PG,
  closePool,
  expectPgError,
  insertApplication,
  insertBureauReport,
  onClient,
  truncateAll,
  withDatabase,
} from '../support/db.js';

/**
 * The deterministic half of docs/07-testing.md §4.
 *
 * Each concurrency property in this service gets two tests: a probabilistic one
 * that races real requests, and one of these — insert the forbidden row
 * directly and assert the database refuses it. The probabilistic test proves
 * the code path relies on the constraint; this one proves the constraint
 * exists. A run that happens not to interleave badly still passes the first, so
 * the first alone would be overselling.
 *
 * These exist in the walking skeleton, before any application code writes to
 * these tables, because they are cheap now and they make the claims in
 * docs/01-architecture.md §3 true rather than aspirational.
 */
describe.skipIf(!withDatabase)('the constraints that carry correctness', () => {
  beforeEach(truncateAll);
  afterAll(closePool);

  describe('idempotency_keys (client_id, scope, key)', () => {
    const insertKey = (clientId: string, key: string, applicationId: string | null) =>
      onClient((client) =>
        client.query(
          `INSERT INTO idempotency_keys
             (client_id, scope, key, application_id, request_fingerprint, state, lease_expires_at, expires_at)
           VALUES ($1, 'applications.submit', $2, $3, $4, 'IN_PROGRESS',
                   now() + interval '30 seconds', now() + interval '24 hours')`,
          [clientId, key, applicationId, 'f'.repeat(64)],
        ),
      );

    it('refuses the same key twice for one client', async () => {
      const application = await insertApplication();
      await insertKey('acme-web', 'k-1', application.id);
      await expectPgError(insertKey('acme-web', 'k-1', null), PG.uniqueViolation);
    });

    it('allows two clients to use the same key string', async () => {
      // The cross-tenant case. On a two-part key these would collide and the
      // second integrator would receive the first one's stored response body:
      // someone else's verdict, someone else's application id.
      await insertKey('acme-web', '1', null);
      await insertKey('partner-bank', '1', null);

      const { rows } = await onClient((client) =>
        client.query<{ count: string }>(`SELECT count(*) FROM idempotency_keys WHERE key = '1'`),
      );
      expect(rows[0]?.count).toBe('2');
    });

    it('refuses a COMPLETED key with no stored response body', async () => {
      // A replay of a COMPLETED key returns the body byte for byte. One with no
      // body would answer a retry with nothing and look like success.
      await expectPgError(
        onClient((client) =>
          client.query(
            `INSERT INTO idempotency_keys
               (client_id, scope, key, request_fingerprint, state, lease_expires_at, expires_at)
             VALUES ('acme-web', 'applications.submit', 'k-2', $1, 'COMPLETED',
                     now(), now() + interval '24 hours')`,
            ['f'.repeat(64)],
          ),
        ),
        PG.checkViolation,
      );
    });
  });

  describe('pre_decisions (application_id)', () => {
    const insertPreDecision = (applicationId: string, verdict = 'DECLINED', codes = ['DTI_ABOVE_LIMIT']) =>
      onClient((client) =>
        client.query(
          `INSERT INTO pre_decisions
             (application_id, verdict, reason_codes, policy_version, engine_version,
              bureau_report_reused, decided_at)
           VALUES ($1, $2, $3, '2026.09.1', '1.0.0', false, now())`,
          [applicationId, verdict, codes],
        ),
      );

    it('refuses a second engine verdict on one application', async () => {
      const application = await insertApplication();
      await insertPreDecision(application.id);
      await expectPgError(insertPreDecision(application.id), PG.uniqueViolation);
    });

    it('refuses an APPROVED verdict with no offer, and a DECLINED one carrying an offer', async () => {
      // Written as an equivalence in the schema so neither direction can drift.
      const a = await insertApplication();
      await expectPgError(insertPreDecision(a.id, 'APPROVED', ['AMOUNT_REDUCED_TO_FIT_DTI']), PG.checkViolation);

      const b = await insertApplication();
      await expectPgError(
        onClient((client) =>
          client.query(
            `INSERT INTO pre_decisions
               (application_id, verdict, reason_codes, approved_amount_minor,
                monthly_payment_minor, offer_expires_at, policy_version, engine_version,
                bureau_report_reused, decided_at)
             VALUES ($1, 'DECLINED', ARRAY['DTI_ABOVE_LIMIT'], 2690000, 72033,
                     now() + interval '30 days', '2026.09.1', '1.0.0', false, now())`,
            [b.id],
          ),
        ),
        PG.checkViolation,
      );
    });

    it.each([
      ['no reason codes at all', []],
      ['five reason codes', ['A', 'B', 'C', 'D', 'E']],
    ])('refuses %s', async (_label, codes) => {
      // Regulation B's four-reason cap, and the rule that every verdict carries
      // at least one reason. A decision with no disclosed reason is not a
      // decision anyone can be told about.
      const application = await insertApplication();
      await expectPgError(insertPreDecision(application.id, 'DECLINED', codes), PG.checkViolation);
    });

    it('refuses bureau_report_reused = true with no report attached', async () => {
      const application = await insertApplication();
      await expectPgError(
        onClient((client) =>
          client.query(
            `INSERT INTO pre_decisions
               (application_id, verdict, reason_codes, policy_version, engine_version,
                bureau_report_reused, decided_at)
             VALUES ($1, 'DECLINED', ARRAY['DTI_ABOVE_LIMIT'], '2026.09.1', '1.0.0', true, now())`,
            [application.id],
          ),
        ),
        PG.checkViolation,
      );
    });
  });

  describe('bureau_pull_claims (pull_key)', () => {
    const claim = (pullKey: string, state = 'IN_FLIGHT', reportId: string | null = null) =>
      onClient((client) =>
        client.query(
          `INSERT INTO bureau_pull_claims (pull_key, state, lease_expires_at, report_id)
           VALUES ($1, $2, now() + interval '5 seconds', $3)`,
          [pullKey, state, reportId],
        ),
      );

    it('refuses two simultaneous holders of one pull', async () => {
      await claim('subject-a:MOCKBUREAU');
      await expectPgError(claim('subject-a:MOCKBUREAU'), PG.uniqueViolation);
    });

    it('refuses a DONE claim with no report', async () => {
      // A waiter reads this row to learn the winner's result rather than
      // inferring it from an absent report. DONE with no report makes that lie.
      await expectPgError(claim('subject-b:MOCKBUREAU', 'DONE'), PG.checkViolation);
    });

    it('accepts a DONE claim that points at its report', async () => {
      const application = await insertApplication();
      const reportId = await insertBureauReport(application);
      await claim('subject-c:MOCKBUREAU', 'DONE', reportId);
    });
  });

  describe('audit_events (application_id, chain_index)', () => {
    const append = (applicationId: string, index: number) =>
      onClient((client) =>
        client.query(
          `INSERT INTO audit_events
             (application_id, chain_index, event_type, actor, payload, occurred_at, prev_hash, hash)
           VALUES ($1, $2, 'APPLICATION_RECEIVED', 'client:acme-web', '{}'::jsonb, now(), $3, $4)`,
          [applicationId, index, '0'.repeat(64), '1'.repeat(64)],
        ),
      );

    it('refuses a concurrent double-append at the same index', async () => {
      const application = await insertApplication();
      await append(application.id, 0);
      await expectPgError(append(application.id, 0), PG.uniqueViolation);
    });

    it('refuses UPDATE, even one that would match no rows', async () => {
      // FOR EACH STATEMENT rather than FOR EACH ROW, so an UPDATE with a
      // predicate matching nothing still raises. Append-only enforced by the
      // database, not by discipline.
      const application = await insertApplication();
      await append(application.id, 0);
      await expectPgError(
        onClient((client) => client.query(`UPDATE audit_events SET actor = 'forged' WHERE chain_index = 999`)),
        PG.restrictViolation,
      );
    });

    it('refuses DELETE', async () => {
      const application = await insertApplication();
      await append(application.id, 0);
      await expectPgError(
        onClient((client) => client.query('DELETE FROM audit_events')),
        PG.restrictViolation,
      );
    });
  });

  describe('reviews: a closed review is attributable', () => {
    it('refuses CLOSED with no reviewer and no outcome', async () => {
      // The audit question this answers: "could anyone have altered a verdict
      // after the fact?" A closed review with no attributable human cannot
      // answer it, so it cannot exist. ADR-0006.
      const application = await insertApplication();
      await expectPgError(
        onClient((client) =>
          client.query(
            `INSERT INTO reviews (application_id, state, opened_at, closed_at)
             VALUES ($1, 'CLOSED', now(), now())`,
            [application.id],
          ),
        ),
        PG.checkViolation,
      );
    });

    it('refuses CLOSED with an outcome but no reviewer', async () => {
      const application = await insertApplication();
      await expectPgError(
        onClient((client) =>
          client.query(
            `INSERT INTO reviews (application_id, state, outcome, opened_at, closed_at)
             VALUES ($1, 'CLOSED', 'APPROVED', now(), now())`,
            [application.id],
          ),
        ),
        PG.checkViolation,
      );
    });

    it('accepts PENDING with neither, and CLOSED with both', async () => {
      const pending = await insertApplication();
      await onClient((client) =>
        client.query(`INSERT INTO reviews (application_id, state, opened_at) VALUES ($1, 'PENDING', now())`, [
          pending.id,
        ]),
      );

      const closed = await insertApplication();
      await onClient((client) =>
        client.query(
          `INSERT INTO reviews (application_id, state, outcome, reviewer_id, opened_at, closed_at)
           VALUES ($1, 'CLOSED', 'APPROVED', 'underwriting:j.okafor', now(), now())`,
          [closed.id],
        ),
      );
    });

    it('closing is a compare-and-set: two concurrent closes produce one write', async () => {
      const application = await insertApplication();
      await onClient((client) =>
        client.query(`INSERT INTO reviews (application_id, state, opened_at) VALUES ($1, 'PENDING', now())`, [
          application.id,
        ]),
      );

      const close = (reviewer: string) =>
        onClient((client) =>
          client.query(
            `UPDATE reviews
                SET state = 'CLOSED', outcome = 'APPROVED', reviewer_id = $2, closed_at = now()
              WHERE application_id = $1 AND state = 'PENDING'`,
            [application.id, reviewer],
          ),
        );

      const [first, second] = await Promise.all([close('underwriting:a'), close('underwriting:b')]);

      // Exactly one update matched. The loser gets zero rows, which the handler
      // turns into 409 REVIEW_ALREADY_CLOSED.
      expect((first.rowCount ?? 0) + (second.rowCount ?? 0)).toBe(1);
    });
  });

  describe('applications', () => {
    it('refuses an application that did not attest consent', async () => {
      // ADR-0007 makes the attestation mandatory at the edge. This makes it
      // impossible to bypass the edge and insert one anyway.
      await expectPgError(insertApplication({ consentAttested: false }), PG.checkViolation);
    });

    it('refuses an unknown status', async () => {
      await expectPgError(insertApplication({ status: 'WHATEVER' }), PG.checkViolation);
    });
  });

  describe('the migration ledger', () => {
    it('recorded 001_init with a checksum', async () => {
      const { rows } = await onClient((client) =>
        client.query<{ filename: string; checksum: string }>('SELECT filename, checksum FROM schema_migrations'),
      );
      expect(rows.map((r) => r.filename)).toContain('001_init.sql');
      expect(rows[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
    });

    it('created exactly the seven tables the design names', async () => {
      const { rows } = await onClient((client) =>
        client.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name <> 'schema_migrations'
            ORDER BY table_name`,
        ),
      );
      expect(rows.map((r) => r.table_name)).toEqual([
        'applications',
        'audit_events',
        'bureau_pull_claims',
        'bureau_reports',
        'idempotency_keys',
        'pre_decisions',
        'reviews',
      ]);
    });
  });
});

describe.skipIf(withDatabase)('without a database', () => {
  it('is skipped, and CI refuses to let that happen silently', () => {
    // REQUIRE_DATABASE=1 in CI turns the skip into a hard error in
    // tests/support/db.ts, so a green pipeline cannot mean "these did not run".
    expect(randomUUID()).toBeTruthy();
  });
});
