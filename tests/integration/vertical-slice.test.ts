import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { TOKENS, testApp } from '../support/app.js';
import { closePool, onClient, testDatabase, truncateAll, withDatabase } from '../support/db.js';

/**
 * docs/07-testing.md §4. The end-to-end path, against a real Postgres.
 *
 * These are the tests that cannot be written any other way: an in-memory
 * substitute cannot enforce a unique index, cannot roll back a transaction the
 * way Postgres does, and cannot lose a race — which makes it useless for exactly
 * the properties this service's correctness argument rests on.
 */

const app = async () => testApp({ database: testDatabase() });

/**
 * Fixed, not `new Date()` per call.
 *
 * A fresh timestamp on every call makes two "identical" submissions differ, so
 * the second one is a fingerprint mismatch rather than a replay — and the test
 * that counts applications then passes for the wrong reason: one application,
 * because the second request was rejected. Found by running the suite, not by
 * reading it.
 */
const CONSENT_ACCEPTED_AT = new Date().toISOString();

const submission = (overrides: Record<string, unknown> = {}) => ({
  productCode: 'PERSONAL_UNSECURED_V1',
  requestedAmountMinor: 1_800_000,
  currency: 'USD',
  termMonths: 36,
  purpose: 'HOME_IMPROVEMENT',
  consent: { attestedByCaller: true, acceptedAt: CONSENT_ACCEPTED_AT },
  applicant: {
    firstName: 'Daniel',
    lastName: 'Okonkwo',
    dateOfBirth: '1988-02-19',
    nationalId: '900-55-0601',
    email: 'daniel.okonkwo@example.com',
    residenceCountry: 'US',
  },
  finances: {
    monthlyIncomeMinor: 620_000,
    employmentStatus: 'EMPLOYED',
    declaredMonthlyObligationsMinor: 90_000,
  },
  ...overrides,
});

const post = async (
  server: Awaited<ReturnType<typeof app>>,
  body: Record<string, unknown>,
  key?: string,
  token: string = TOKENS.submission,
) =>
  server.inject({
    method: 'POST',
    url: '/v1/applications',
    headers: {
      authorization: `Bearer ${token}`,
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    },
    payload: body,
  });

describe.skipIf(!withDatabase)('the vertical slice', () => {
  beforeEach(truncateAll);
  afterAll(closePool);

  describe('a submission is decided, persisted and answerable', () => {
    it('approves a clean file in full, with no reason codes', async () => {
      const server = await app();
      const response = await post(server, submission());

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.preDecision.verdict).toBe('APPROVED');
      // ADR-0010: an approval on the requested terms is not adverse action.
      expect(body.preDecision.reasonCodes).toEqual([]);
      expect(body.preDecision.offer.approvedAmountMinor).toBe(1_800_000);
      expect(body.preDecision.offer.monthlyPaymentMinor).toBe(60_562);
      expect(body.preDecision.assessment.score).toBe(100);
      expect(body.preDecision.bureauReportReused).toBe(false);
      await server.close();
    });

    it('counter-offers when the DTI does not fit, exactly as documented', async () => {
      const server = await app();
      const response = await post(
        server,
        submission({
          requestedAmountMinor: 3_200_000,
          termMonths: 48,
          purpose: 'DEBT_CONSOLIDATION',
          applicant: { ...submission().applicant, nationalId: '900-55-0142', dateOfBirth: '1991-04-12' },
          finances: {
            monthlyIncomeMinor: 540_000,
            employmentStatus: 'EMPLOYED',
            declaredMonthlyObligationsMinor: 160_000,
          },
        }),
      );

      const body = response.json();
      expect(body.preDecision.verdict).toBe('APPROVED');
      expect(body.preDecision.offer.approvedAmountMinor).toBe(2_690_000);
      expect(body.preDecision.reasonCodes[0]).toBe('AMOUNT_REDUCED_TO_FIT_DTI');
      await server.close();
    });

    it('persists the application, the decision and the trail', async () => {
      const server = await app();
      const { applicationId } = (await post(server, submission())).json();

      const counts = await onClient((client) =>
        client.query<{ applications: string; decisions: string; events: string }>(
          `SELECT (SELECT count(*) FROM applications) AS applications,
                  (SELECT count(*) FROM pre_decisions) AS decisions,
                  (SELECT count(*) FROM audit_events WHERE application_id = $1) AS events`,
          [applicationId],
        ),
      );
      expect(counts.rows[0]).toMatchObject({ applications: '1', decisions: '1' });
      // APPLICATION_RECEIVED, BUREAU_PULL_REQUESTED, BUREAU_REPORT_ATTACHED, PRE_DECISION_MADE
      expect(Number(counts.rows[0]?.events)).toBe(4);
      await server.close();
    });

    it('never stores the national identifier', async () => {
      // The guarantee is about persistence and logging. JavaScript offers no way
      // to scrub a string from memory, so "discarded" would be a claim we cannot
      // keep — this is the half that can be proven.
      const server = await app();
      await post(server, submission());
      const { rows } = await onClient((client) =>
        client.query<{ dump: string }>(`SELECT applicant::text || finances::text AS dump FROM applications`),
      );
      expect(rows[0]?.dump).not.toContain('0601');
      expect(rows[0]?.dump).not.toContain('900-55');
      await server.close();
    });
  });

  describe('idempotency — layer 1', () => {
    it('replays the stored body byte for byte', async () => {
      const server = await app();
      const first = await post(server, submission(), 'k-1');
      const second = await post(server, submission(), 'k-1');

      expect(second.headers['idempotency-replayed']).toBe('true');
      // Byte for byte INCLUDING the original correlationId and decidedAt.
      // Regenerating any of it would let the replay differ from the original.
      expect(second.json()).toEqual(first.json());
      await server.close();
    });

    it('creates exactly one application for one key', async () => {
      const server = await app();
      await post(server, submission(), 'k-2');
      await post(server, submission(), 'k-2');
      const { rows } = await onClient((client) => client.query<{ count: string }>('SELECT count(*) FROM applications'));
      expect(rows[0]?.count).toBe('1');
      await server.close();
    });

    it('refuses the same key with a different body', async () => {
      // Answering with the first request's verdict would hide the caller's bug
      // and hand them a decision about a different application.
      const server = await app();
      await post(server, submission(), 'k-3');
      const second = await post(server, submission({ requestedAmountMinor: 2_000_000 }), 'k-3');
      expect(second.statusCode).toBe(422);
      expect(second.json().code).toBe('IDEMPOTENCY_KEY_REUSED');
      await server.close();
    });

    it('does not let two clients collide on the same key string', async () => {
      // `Idempotency-Key: 1` is what a developer testing by hand sends. On a
      // two-part key the second integrator receives the first one's verdict.
      const server = await app();
      const mine = await post(server, submission(), '1');
      const { rows } = await onClient((client) =>
        client.query<{ count: string }>(`SELECT count(*) FROM idempotency_keys WHERE key = '1'`),
      );
      expect(mine.statusCode).toBe(201);
      expect(rows[0]?.count).toBe('1');
      await server.close();
    });

    it('creates one application under N concurrent requests with one key', async () => {
      const server = await app();
      const responses = await Promise.all(Array.from({ length: 8 }, async () => post(server, submission(), 'race')));

      const created = responses.filter((r) => r.statusCode === 201);
      const conflicted = responses.filter((r) => r.statusCode === 409);
      expect(created.length + conflicted.length).toBe(8);

      const { rows } = await onClient((client) => client.query<{ count: string }>('SELECT count(*) FROM applications'));
      expect(rows[0]?.count).toBe('1');
      // A 409 that tells a client to retry immediately sends it into a second
      // 409: the in-flight worst case is ~2.5 s.
      if (conflicted[0] !== undefined) expect(conflicted[0].headers['retry-after']).toBe('3');
      await server.close();
    });
  });

  describe('bureau deduplication — layer 3, the one the brief is about', () => {
    it('reuses a report for a second application from the same person', async () => {
      const server = await app();
      const first = await post(server, submission(), 'a');
      const second = await post(server, submission({ requestedAmountMinor: 1_500_000 }), 'b');

      expect(first.json().preDecision.bureauReportReused).toBe(false);
      expect(second.json().preDecision.bureauReportReused).toBe(true);
      expect(second.json().preDecision.bureauReportId).toBe(first.json().preDecision.bureauReportId);

      const { rows } = await onClient((client) => client.query<{ count: string }>('SELECT count(*) FROM bureau_reports'));
      expect(rows[0]?.count, 'one enquiry, two applications').toBe('1');
      await server.close();
    });

    it('treats three spellings of one identifier as one subject', async () => {
      // Without canonicalisation the central requirement is defeated by a
      // hyphen: three spellings, three subject keys, three marks on one file.
      const server = await app();
      for (const [index, spelling] of ['900-55-0601', '900 55 0601', '900550601'].entries()) {
        await post(server, submission({ applicant: { ...submission().applicant, nationalId: spelling } }), `s-${String(index)}`);
      }
      const { rows } = await onClient((client) => client.query<{ count: string }>('SELECT count(*) FROM bureau_reports'));
      expect(rows[0]?.count).toBe('1');
      await server.close();
    });

    it('places one enquiry for N concurrent applications from one subject', async () => {
      // The hard half. Reuse alone only stops duplicates separated in time;
      // these all miss the lookup in the same instant.
      const server = await app();
      await Promise.all(
        Array.from({ length: 6 }, async (_unused, index) => post(server, submission(), `c-${String(index)}`)),
      );

      const { rows } = await onClient((client) => client.query<{ count: string }>('SELECT count(*) FROM bureau_reports'));
      expect(rows[0]?.count, 'six applications, one hard enquiry').toBe('1');

      const applications = await onClient((client) =>
        client.query<{ count: string }>('SELECT count(*) FROM applications'),
      );
      expect(applications.rows[0]?.count, 'and six applications, all decided').toBe('6');
      await server.close();
    });

    it('reuses a NO_HIT, because "no file" is an answer with a timestamp', async () => {
      const server = await app();
      const body = submission({ applicant: { ...submission().applicant, nationalId: '900-55-0300' } });
      const first = await post(server, body, 'n-1');
      const second = await post(server, body, 'n-2');

      expect(first.json().preDecision.reasonCodes).toEqual(['NO_CREDIT_FILE']);
      expect(second.json().preDecision.bureauReportReused).toBe(true);
      const { rows } = await onClient((client) =>
        client.query<{ count: string }>(`SELECT count(*) FROM bureau_reports WHERE outcome = 'NO_HIT'`),
      );
      expect(rows[0]?.count).toBe('1');
      await server.close();
    });

    it('stores nothing when the bureau does not answer, and still persists the application', async () => {
      const server = await app();
      const response = await post(
        server,
        submission({ applicant: { ...submission().applicant, nationalId: '900-55-9001' } }),
        'u-1',
      );

      const body = response.json();
      expect(body.preDecision.verdict).toBe('MANUAL_REVIEW');
      expect(body.preDecision.reasonCodes).toEqual(['BUREAU_UNAVAILABLE']);
      expect(body.preDecision.bureauReportId).toBeNull();
      expect(body.preDecision.lookupFailureCause).toBe('RETRIES_EXHAUSTED');

      const { rows } = await onClient((client) => client.query<{ count: string }>('SELECT count(*) FROM applications'));
      expect(rows[0]?.count, 'the application exists regardless').toBe('1');
      await server.close();
    }, 20_000);
  });

  describe('audit and review', () => {
    it('writes an intact chain and can verify it', async () => {
      const server = await app();
      const { applicationId } = (await post(server, submission())).json();

      const chain = await server.inject({
        method: 'GET',
        url: `/v1/audit/applications/${applicationId}/chain`,
        headers: { authorization: `Bearer ${TOKENS.auditor}` },
      });
      expect(chain.json()).toMatchObject({ chainIntact: true, events: 4, brokenAtIndex: null });
      await server.close();
    });

    it('refuses an update to the trail, in the database rather than in code', async () => {
      const server = await app();
      const { applicationId } = (await post(server, submission())).json();
      await expect(
        onClient((client) =>
          client.query(`UPDATE audit_events SET actor = 'someone' WHERE application_id = $1`, [applicationId]),
        ),
      ).rejects.toThrow(/append-only/);
      await server.close();
    });

    it('replays a decision and matches', async () => {
      const server = await app();
      const { applicationId } = (await post(server, submission())).json();

      const replay = await server.inject({
        method: 'POST',
        url: `/v1/audit/pre-decisions/${applicationId}/replay`,
        headers: { authorization: `Bearer ${TOKENS.auditor}` },
      });
      expect(replay.json()).toMatchObject({ match: true, differences: [] });
      await server.close();
    });

    it('records a human outcome without touching the engine verdict', async () => {
      // ADR-0006. Replay compares against the ENGINE's verdict, so a legitimate
      // override cannot look like tampering.
      const server = await app();
      const submitted = await post(
        server,
        submission({ applicant: { ...submission().applicant, nationalId: '900-55-9001' } }),
        'r-1',
      );
      const { applicationId } = submitted.json();

      const closed = await server.inject({
        method: 'POST',
        url: `/v1/reviews/${applicationId}/close`,
        headers: { authorization: `Bearer ${TOKENS.reviewer}` },
        payload: { outcome: 'APPROVED', approvedAmountMinor: 900_000, rationale: 'File pulled manually; income verified.' },
      });

      expect(closed.statusCode).toBe(200);
      expect(closed.json().preDecision.verdict).toBe('MANUAL_REVIEW');
      expect(closed.json().outcome).toMatchObject({ verdict: 'APPROVED', source: 'REVIEWER' });

      const replay = await server.inject({
        method: 'POST',
        url: `/v1/audit/pre-decisions/${applicationId}/replay`,
        headers: { authorization: `Bearer ${TOKENS.auditor}` },
      });
      expect(replay.json().match, 'a human override is not tampering').toBe(true);
      await server.close();
    }, 20_000);

    it('refuses a second close', async () => {
      const server = await app();
      const { applicationId } = (
        await post(server, submission({ applicant: { ...submission().applicant, nationalId: '900-55-0300' } }), 'r-2')
      ).json();

      const close = async () =>
        server.inject({
          method: 'POST',
          url: `/v1/reviews/${applicationId}/close`,
          headers: { authorization: `Bearer ${TOKENS.reviewer}` },
          payload: { outcome: 'DECLINED', rationale: 'Insufficient file.' },
        });

      expect((await close()).statusCode).toBe(200);
      const second = await close();
      expect(second.statusCode).toBe(409);
      expect(second.json().code).toBe('REVIEW_ALREADY_CLOSED');
      await server.close();
    });
  });

  describe('reads are owner-scoped', () => {
    it('answers an unknown id and someone else\'s id identically', async () => {
      // Distinguishing them turns the endpoint into an oracle confirming which
      // application ids are real.
      const server = await app();
      const { applicationId } = (await post(server, submission())).json();

      await onClient((client) =>
        client.query(`UPDATE applications SET client_id = 'someone-else' WHERE id = $1`, [applicationId]),
      );

      const theirs = await server.inject({
        method: 'GET',
        url: `/v1/applications/${applicationId}`,
        headers: { authorization: `Bearer ${TOKENS.submission}` },
      });
      const unknown = await server.inject({
        method: 'GET',
        url: '/v1/applications/00000000-0000-4000-8000-000000000000',
        headers: { authorization: `Bearer ${TOKENS.submission}` },
      });

      expect(theirs.statusCode).toBe(404);
      expect(unknown.statusCode).toBe(404);
      const strip = (payload: string): string => payload.replace(/"correlationId":"[^"]*"/, '');
      expect(strip(theirs.payload)).toBe(strip(unknown.payload));
      await server.close();
    });

    it('refuses an auditor token on a submission route and says why', async () => {
      const server = await app();
      const response = await post(server, submission(), 'x', TOKENS.auditor);
      expect(response.statusCode).toBe(403);
      await server.close();
    });
  });
});
