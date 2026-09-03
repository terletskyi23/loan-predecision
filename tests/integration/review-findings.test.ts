import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { TOKENS, testApp, testConfig } from '../support/app.js';
import { closePool, onClient, testDatabase, truncateAll, withDatabase } from '../support/db.js';
import { createMetrics } from '../../src/metrics.js';
import { createSweeper } from '../../src/services/sweeper.js';
import { verifyAuditChain } from '../../src/db/audit.js';

/**
 * The defects an adversarial review found after the vertical slice was declared
 * done, each with the test that would have caught it.
 *
 * They are kept in one file on purpose. A reviewer reading the repository should
 * be able to see what was found late and what now prevents it, without
 * reconstructing it from a diff.
 */

const app = async () => testApp({ database: testDatabase() });

const CONSENT_ACCEPTED_AT = new Date().toISOString();

const submission = (overrides: Record<string, unknown> = {}) => ({
  productCode: 'PERSONAL_UNSECURED_V1',
  requestedAmountMinor: 3_200_000,
  currency: 'USD',
  termMonths: 48,
  purpose: 'DEBT_CONSOLIDATION',
  consent: { attestedByCaller: true, acceptedAt: CONSENT_ACCEPTED_AT },
  applicant: {
    firstName: 'Maria',
    lastName: 'Delgado',
    dateOfBirth: '1991-04-12',
    nationalId: '900-55-0142',
    email: 'maria@example.com',
    residenceCountry: 'US',
  },
  finances: { monthlyIncomeMinor: 540_000, employmentStatus: 'EMPLOYED', declaredMonthlyObligationsMinor: 160_000 },
  ...overrides,
});

const post = async (
  server: Awaited<ReturnType<typeof app>>,
  body: Record<string, unknown>,
  key: string,
  token: string = TOKENS.submission,
) =>
  server.inject({
    method: 'POST',
    url: '/v1/applications',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': key },
    payload: body,
  });

describe.skipIf(!withDatabase)('what the review found', () => {
  beforeEach(truncateAll);
  afterAll(closePool);

  describe('replay compares the money, not only the verdict', () => {
    it('reports a mismatch when the instalment is altered', async () => {
      // FOUND BY REVIEW, REPRODUCED. The snapshot compared verdict, codes,
      // approved amount and score — and nothing else. Editing
      // monthly_payment_minor to a single cent left replay answering
      // `match: true` while the status endpoint served the altered figure. The
      // instalment is one of the two numbers an applicant is actually held to.
      const server = await app();
      const { applicationId } = (await post(server, submission(), 'money-1')).json();

      await onClient((client) =>
        client.query(`UPDATE pre_decisions SET monthly_payment_minor = 1 WHERE application_id = $1`, [applicationId]),
      );

      const replay = await server.inject({
        method: 'POST',
        url: `/v1/audit/pre-decisions/${applicationId}/replay`,
        headers: { authorization: `Bearer ${TOKENS.auditor}` },
      });

      expect(replay.json().match).toBe(false);
      expect(replay.json().differences).toContain('monthlyPaymentMinor');
      await server.close();
    });

    it('reports a mismatch when the offer expiry is stretched', async () => {
      const server = await app();
      const { applicationId } = (await post(server, submission(), 'money-2')).json();
      await onClient((client) =>
        client.query(
          `UPDATE pre_decisions SET offer_expires_at = now() + interval '3650 days' WHERE application_id = $1`,
          [applicationId],
        ),
      );
      const replay = await server.inject({
        method: 'POST',
        url: `/v1/audit/pre-decisions/${applicationId}/replay`,
        headers: { authorization: `Bearer ${TOKENS.auditor}` },
      });
      expect(replay.json().differences).toContain('offerExpiresAt');
      await server.close();
    });

    it('reports a mismatch when the DTI is altered', async () => {
      const server = await app();
      const { applicationId } = (await post(server, submission(), 'money-3')).json();
      await onClient((client) =>
        client.query(`UPDATE pre_decisions SET dti = 0.0001 WHERE application_id = $1`, [applicationId]),
      );
      const replay = await server.inject({
        method: 'POST',
        url: `/v1/audit/pre-decisions/${applicationId}/replay`,
        headers: { authorization: `Bearer ${TOKENS.auditor}` },
      });
      expect(replay.json().differences).toContain('dti');
      await server.close();
    });
  });

  describe('the chain verifier is exercised against actual tampering', () => {
    it('detects an altered event', async () => {
      // The verifier had unit tests for its hash arithmetic and no test that it
      // ever detects anything. The trigger refuses an UPDATE, so tampering has
      // to be staged by disabling it — which is exactly the "migration run as a
      // more privileged role" case docs/04 §3 says the chain is the third layer
      // for.
      const server = await app();
      const { applicationId } = (await post(server, submission(), 'tamper-1')).json();

      await onClient(async (client) => {
        await client.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update');
        // DECLINED, not APPROVED. The first draft of this test wrote the value
        // the row already held — the submission is a counter-offer, so its
        // verdict was already APPROVED — and jsonb_set changed nothing. The
        // chain verified, correctly, and the test failed for exactly the right
        // reason: a tamper test that does not tamper proves nothing.
        const changed = await client.query(
          `UPDATE audit_events SET payload = jsonb_set(payload, '{verdict}', '"DECLINED"')
            WHERE application_id = $1 AND chain_index = (SELECT max(chain_index) FROM audit_events WHERE application_id = $1)`,
          [applicationId],
        );
        if (changed.rowCount !== 1) throw new Error('the tamper touched no row; the test would prove nothing');
        await client.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update');
      });

      const verification = await verifyAuditChain(testDatabase(), applicationId);
      expect(verification.intact).toBe(false);
      expect(verification.brokenAt).not.toBeNull();
      await server.close();
    });

    it('does NOT detect truncation, and reports the count that would', async () => {
      // The honest limit, asserted rather than described. Deleting the tail
      // leaves a chain that verifies perfectly; `events` is the only thing an
      // external anchor could compare against, and that anchor is not built.
      const server = await app();
      const { applicationId } = (await post(server, submission(), 'tamper-2')).json();
      const before = await verifyAuditChain(testDatabase(), applicationId);

      await onClient(async (client) => {
        await client.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_delete');
        await client.query(
          `DELETE FROM audit_events WHERE application_id = $1 AND chain_index = (SELECT max(chain_index) FROM audit_events WHERE application_id = $1)`,
          [applicationId],
        );
        await client.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_delete');
      });

      const after = await verifyAuditChain(testDatabase(), applicationId);
      expect(after.intact, 'truncation is invisible to the chain — this is the documented limit').toBe(true);
      expect(after.events).toBe(before.events - 1);
      await server.close();
    });
  });

  describe('idempotency keys are scoped per client, proven with two clients', () => {
    it('lets two integrators use the same key string without seeing each other', async () => {
      // The earlier version of this test submitted as ONE client and counted
      // rows. It passed unchanged against a two-part key — against the exact
      // bug it was written to prevent.
      const server = await app();
      const mine = await post(server, submission(), '1', TOKENS.submission);
      const theirs = await post(server, submission({ requestedAmountMinor: 1_800_000, termMonths: 36 }), '1', TOKENS.otherSubmission);

      expect(mine.statusCode).toBe(201);
      expect(theirs.statusCode, 'not 422: a different body under the same key is only a conflict WITHIN one client').toBe(201);
      expect(theirs.json().applicationId).not.toBe(mine.json().applicationId);
      expect(theirs.json().product.requestedAmountMinor).toBe(1_800_000);

      const { rows } = await onClient((client) =>
        client.query<{ client_id: string }>(`SELECT client_id FROM idempotency_keys WHERE key = '1' ORDER BY client_id`),
      );
      expect(rows.map((r) => r.client_id)).toEqual(['acme-web', 'partner-bank']);
      await server.close();
    });

    it('refuses to show one client another\'s application', async () => {
      const server = await app();
      const { applicationId } = (await post(server, submission(), 'own-1', TOKENS.submission)).json();
      const peek = await server.inject({
        method: 'GET',
        url: `/v1/applications/${applicationId}`,
        headers: { authorization: `Bearer ${TOKENS.otherSubmission}` },
      });
      expect(peek.statusCode).toBe(404);
      await server.close();
    });
  });

  describe('an application with no verdict is answerable', () => {
    it('returns the envelope rather than a 500', async () => {
      // RECEIVED and ABANDONED are both in the documented status enum and
      // neither has a pre-decision, so a non-nullable shape made two documented
      // states unrenderable. It answered 500.
      const server = await app();
      const { applicationId } = (await post(server, submission(), 'orphan-1')).json();
      await onClient((client) =>
        client.query(`UPDATE applications SET status = 'RECEIVED' WHERE id = $1`, [applicationId]),
      );
      await onClient((client) => client.query(`DELETE FROM pre_decisions WHERE application_id = $1`, [applicationId]));

      const response = await server.inject({
        method: 'GET',
        url: `/v1/applications/${applicationId}`,
        headers: { authorization: `Bearer ${TOKENS.submission}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'RECEIVED', preDecision: null, outcome: null });
      await server.close();
    });
  });

  describe('the sweeper retires what nothing else will', () => {
    const sweeper = () =>
      createSweeper({
        database: testDatabase(),
        metrics: createMetrics(),
        logger: pino({ level: 'silent' }),
        afterMinutes: 15,
        intervalMinutes: 5,
        idempotencyRetentionHours: testConfig().IDEMPOTENCY_RETENTION_HOURS,
        claimLeaseMs: 5_000,
      });

    it('abandons a stale RECEIVED application, releases its key and closes its chain', async () => {
      const server = await app();
      const { applicationId } = (await post(server, submission(), 'sweep-1')).json();

      // Stage the orphan: a process that died between the insert and the verdict.
      await onClient((client) =>
        client.query(
          `UPDATE applications SET status = 'RECEIVED', submitted_at = now() - interval '1 hour' WHERE id = $1`,
          [applicationId],
        ),
      );
      await onClient((client) => client.query(`DELETE FROM pre_decisions WHERE application_id = $1`, [applicationId]));
      await onClient((client) =>
        client.query(`UPDATE idempotency_keys SET state = 'IN_PROGRESS', response_body = NULL WHERE application_id = $1`, [applicationId]),
      );

      const result = await sweeper().sweepOnce();
      expect(result.abandoned).toBe(1);

      const { rows } = await onClient((client) =>
        client.query<{ status: string; key_state: string; last_event: string }>(
          `SELECT a.status,
                  (SELECT state FROM idempotency_keys WHERE application_id = a.id) AS key_state,
                  (SELECT event_type FROM audit_events WHERE application_id = a.id ORDER BY chain_index DESC LIMIT 1) AS last_event
             FROM applications a WHERE a.id = $1`,
          [applicationId],
        ),
      );
      expect(rows[0]).toEqual({ status: 'ABANDONED', key_state: 'ABANDONED', last_event: 'APPLICATION_ABANDONED' });

      const verification = await verifyAuditChain(testDatabase(), applicationId);
      expect(verification.intact, 'the terminal event extends the chain rather than forking it').toBe(true);
      await server.close();
    });

    it('leaves an application that is merely slow alone', async () => {
      // The compare-and-set. A read-then-write here would abandon an application
      // that reached a verdict a millisecond later.
      const server = await app();
      const { applicationId } = (await post(server, submission(), 'sweep-2')).json();
      await onClient((client) =>
        client.query(`UPDATE applications SET submitted_at = now() - interval '1 hour' WHERE id = $1`, [applicationId]),
      );

      expect((await sweeper().sweepOnce()).abandoned).toBe(0);
      await server.close();
    });

    it('purges an expired key and leaves an in-flight one', async () => {
      // `expires_at` was written from the first commit and read by nothing, so a
      // COMPLETED key replayed forever and the table grew without bound.
      const server = await app();
      await post(server, submission(), 'purge-1');
      await onClient((client) => client.query(`UPDATE idempotency_keys SET expires_at = now() - interval '1 day'`));
      await onClient((client) =>
        client.query(
          `INSERT INTO idempotency_keys (client_id, scope, key, request_fingerprint, state, lease_expires_at, expires_at)
           VALUES ('acme-web', 'applications.submit', 'inflight', $1, 'IN_PROGRESS', now() + interval '1 minute', now() - interval '1 day')`,
          ['f'.repeat(64)],
        ),
      );

      const result = await sweeper().sweepOnce();
      expect(result.keysPurged).toBe(1);

      const { rows } = await onClient((client) =>
        client.query<{ key: string }>('SELECT key FROM idempotency_keys'),
      );
      expect(rows.map((r) => r.key), 'an IN_PROGRESS key is never purged, whatever its expiry says').toEqual(['inflight']);
      await server.close();
    });
  });

  describe('consent', () => {
    it('returns the documented code when the attestation is false', async () => {
      // CONSENT_REQUIRED was in the catalogue and unreachable: the schema used
      // z.literal(true), so zod rejected it as a generic VALIDATION_FAILED.
      const server = await app();
      const response = await post(
        server,
        submission({ consent: { attestedByCaller: false, acceptedAt: CONSENT_ACCEPTED_AT } }),
        'consent-1',
      );
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe('CONSENT_REQUIRED');
      await server.close();
    });

    it('refuses an attestation older than the policy window', async () => {
      const server = await app();
      const response = await post(
        server,
        submission({ consent: { attestedByCaller: true, acceptedAt: '2019-01-01T00:00:00Z' } }),
        'consent-2',
      );
      expect(response.json().code).toBe('CONSENT_STALE');
      await server.close();
    });
  });
});
