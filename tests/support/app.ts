import { pino } from 'pino';
import { loadConfig, type Config } from '../../src/config.js';
import type { Database } from '../../src/db/pool.js';
import { createMetrics } from '../../src/metrics.js';
import { buildServer } from '../../src/http/server.js';
import { createServices } from '../../src/services/index.js';
import { createFilePolicyStore } from '../../src/policy/loader.js';
import type { BureauGateway } from '../../src/bureau/gateway.js';

export const testConfig = (overrides: NodeJS.ProcessEnv = {}): Config =>
  loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    SUBJECT_KEY_PEPPER: 'x'.repeat(32),
    API_TOKENS: 'acme-web:submission-secret',
    REVIEWER_TOKENS: 'underwriting:reviewer-secret',
    AUDITOR_TOKENS: 'compliance:auditor-secret',
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
    ...overrides,
  });

/**
 * A database that answers nothing but the probe.
 *
 * `query` and `transaction` throw rather than returning empty results: a test
 * that reaches the database through this stub has escaped its own scope, and a
 * silent empty result would let it pass while proving nothing.
 */
const unreachable = (): never => {
  throw new Error('this test stubs the database; nothing here should run a statement');
};

export const healthyDatabase = (): Database => ({
  ping: async () => {},
  close: async () => {},
  query: unreachable,
  transaction: unreachable,
});

/** Silent by default: a test suite that prints its own logs hides its failures. */
export const testApp = async (
  options: { config?: Config; database?: Database; gateway?: BureauGateway } = {},
) => {
  const config = options.config ?? testConfig();
  const database = options.database ?? healthyDatabase();
  const metrics = createMetrics();
  const logger = pino({ level: 'silent' });

  return buildServer({
    config,
    logger,
    database,
    // A fresh registry per app: a shared one would carry counts between tests
    // and make an assertion about "the counter moved" depend on run order.
    metrics,
    services: createServices({
      config,
      database,
      policies: createFilePolicyStore('./policies'),
      metrics,
      logger,
      ...(options.gateway === undefined ? {} : { gateway: options.gateway }),
    }),
  });
};

/** The tokens testConfig() hands out, so tests do not restate them. */
export const TOKENS = {
  submission: 'submission-secret',
  reviewer: 'reviewer-secret',
  auditor: 'auditor-secret',
} as const;
