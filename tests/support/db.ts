import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { Pool, type PoolClient } from 'pg';
import { runMigrations } from '../../src/db/migrate.js';
import { testConfig } from './app.js';

/**
 * A real Postgres or nothing. docs/07-testing.md §1: an in-memory substitute
 * cannot enforce a unique index, cannot roll back a transaction the way Postgres
 * does, and cannot lose a race — which makes it precisely useless for the tests
 * that matter most here.
 *
 * When no database is reachable these suites SKIP rather than fail, because the
 * unit and API layers must stay runnable without one. Skipping silently is the
 * failure mode that guidance warns about, so CI sets REQUIRE_DATABASE=1 and the
 * skip becomes a hard error there. A green CI therefore cannot mean "the
 * integration tests quietly did not run".
 */

const silent = pino({ level: 'silent' });

const connect = async (): Promise<Pool | null> => {
  // The env check comes first: building a config from an empty DATABASE_URL
  // fails schema validation, which would turn "no database here" into a crash
  // instead of a skip.
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === '') return refuseOrSkip('DATABASE_URL is not set');

  const pool = new Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 4_000 });
  try {
    const client = await pool.connect();
    client.release();
  } catch (error) {
    await pool.end().catch(() => undefined);
    return refuseOrSkip(`cannot reach ${redact(url)}: ${String(error)}`);
  }

  await runMigrations(testConfig({ DATABASE_URL: url }), silent);
  return pool;
};

const refuseOrSkip = (reason: string): null => {
  if (process.env.REQUIRE_DATABASE === '1') {
    throw new Error(
      `REQUIRE_DATABASE=1 but the integration suite has no database: ${reason}. ` +
        'Refusing to skip — a green run that skipped these tests proves nothing.',
    );
  }
  return null;
};

const redact = (url: string): string => url.replace(/:\/\/[^@]*@/, '://***@');

export const pool = await connect();

/** Every integration suite guards on this. */
export const withDatabase = pool !== null;

export const truncateAll = async (): Promise<void> => {
  if (!pool) return;
  await pool.query(
    'TRUNCATE audit_events, reviews, pre_decisions, bureau_pull_claims, idempotency_keys, bureau_reports, applications RESTART IDENTITY CASCADE',
  );
};

export const closePool = async (): Promise<void> => {
  if (pool) await pool.end();
};

/** Runs work on one client and always releases it. */
export const onClient = async <T>(work: (client: PoolClient) => Promise<T>): Promise<T> => {
  if (!pool) throw new Error('no database');
  const client = await pool.connect();
  try {
    return await work(client);
  } finally {
    client.release();
  }
};

export interface ApplicationRow {
  id: string;
  clientId: string;
  subjectKey: string;
}

/**
 * Valid defaults, one interesting field at a time. A fixture that spells out
 * every column hides which one the test is actually about.
 */
export const insertApplication = async (
  overrides: Partial<{ id: string; clientId: string; subjectKey: string; status: string; consentAttested: boolean }> = {},
): Promise<ApplicationRow> => {
  const row = {
    id: overrides.id ?? randomUUID(),
    clientId: overrides.clientId ?? 'acme-web',
    subjectKey: overrides.subjectKey ?? 'a'.repeat(64),
    status: overrides.status ?? 'RECEIVED',
    consentAttested: overrides.consentAttested ?? true,
  };

  await onClient((client) =>
    client.query(
      `INSERT INTO applications (
         id, client_id, status, product_code, requested_amount_minor, term_months, currency,
         purpose, channel, applicant, finances, subject_key, consent_attested,
         consent_accepted_at, submitted_at
       ) VALUES ($1, $2, $3, 'PERSONAL_UNSECURED_V1', 3200000, 48, 'USD',
                 'DEBT_CONSOLIDATION', 'WEB', '{}'::jsonb,
                 '{"monthlyIncomeMinor":540000}'::jsonb, $4, $5, now(), now())`,
      [row.id, row.clientId, row.status, row.subjectKey, row.consentAttested],
    ),
  );

  return { id: row.id, clientId: row.clientId, subjectKey: row.subjectKey };
};

export const insertBureauReport = async (application: ApplicationRow): Promise<string> => {
  const id = randomUUID();
  await onClient((client) =>
    client.query(
      `INSERT INTO bureau_reports (
         id, subject_key, provider, outcome, payload, attested_by_client_id,
         caused_by_application_id, pulled_at, expires_at
       ) VALUES ($1, $2, 'MOCKBUREAU', 'FOUND', '{}'::jsonb, $3, $4, now(), now() + interval '15 minutes')`,
      [id, application.subjectKey, application.clientId, application.id],
    ),
  );
  return id;
};

/** Postgres error codes the schema tests assert on. */
export const PG = {
  uniqueViolation: '23505',
  checkViolation: '23514',
  restrictViolation: '23001',
  notNullViolation: '23502',
} as const;

export const expectPgError = async (work: Promise<unknown>, code: string): Promise<void> => {
  try {
    await work;
  } catch (error) {
    const actual = (error as { code?: string }).code;
    if (actual !== code) {
      throw new Error(`expected Postgres error ${code}, got ${String(actual)}: ${String(error)}`);
    }
    return;
  }
  throw new Error(`expected Postgres error ${code}, but the statement succeeded`);
};
