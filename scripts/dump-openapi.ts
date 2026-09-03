import { writeFile } from 'node:fs/promises';
import { pino } from 'pino';
import { loadConfig } from '../src/config.js';
import { createMetrics } from '../src/metrics.js';
import { buildServer } from '../src/http/server.js';
import type { Database } from '../src/db/pool.js'
import { createServices } from '../src/services/index.js';
import { createFilePolicyStore } from '../src/policy/loader.js';

/** The spec is generated from route schemas; no statement is ever run. */
const stubDatabase = (): Database => ({
  ping: async () => {},
  close: async () => {},
  query: () => {
    throw new Error('generating the specification runs no statements');
  },
  transaction: () => {
    throw new Error('generating the specification runs no statements');
  },
});

/**
 * Writes openapi.json from the live route definitions.
 *
 * The file is committed and CI regenerates it, so a route added without a
 * schema, or a schema changed without regenerating, fails the build. That is
 * the whole reason the specification exists: prose can drift from the code,
 * a generated artefact under a diff check cannot.
 *
 * The environment is fixed here rather than read from a developer's .env, so
 * the output depends only on the routes.
 */
const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  SUBJECT_KEY_PEPPER: 'x'.repeat(32),
  API_TOKENS: 'acme-web:s1',
  REVIEWER_TOKENS: 'underwriting:s2',
  AUDITOR_TOKENS: 'compliance:s3',
  POLICY_VERSION: '2026.09.1',
  ENGINE_VERSION: '1.0.0',
  BUREAU_REPORT_TTL_MINUTES: '15',
  BUREAU_TIMEOUT_MS: '800',
  BUREAU_MAX_ATTEMPTS: '2',
  BUREAU_BACKOFF_BASE_MS: '150',
  BUREAU_CLAIM_LEASE_MS: '5000',
  BUREAU_WAIT_MS: '2000',
  BUREAU_WAIT_POLL_MS: '100',
  IDEMPOTENCY_RETENTION_HOURS: '24',
  IDEMPOTENCY_LEASE_SECONDS: '30',
  ORPHAN_SWEEP_AFTER_MINUTES: '15',
  ORPHAN_SWEEP_INTERVAL_MINUTES: '5',
});

const app = await buildServer({
  config,
  logger: pino({ level: 'silent' }),
  database: stubDatabase(),
  metrics: createMetrics(),
  services: createServices({
    config,
    database: stubDatabase(),
    policies: createFilePolicyStore('./policies'),
    metrics: createMetrics(),
    logger: pino({ level: 'silent' }),
  }),
});

await app.ready();
await writeFile('openapi.json', `${JSON.stringify(app.swagger(), null, 2)}\n`, 'utf8');
await app.close();
