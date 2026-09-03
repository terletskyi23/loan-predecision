import type { Logger } from 'pino';
import { createBureauGateway, type BureauGateway } from '../bureau/gateway.js';
import { createMockBureau } from '../bureau/provider.js';
import type { Config } from '../config.js';
import type { Database } from '../db/pool.js';
import type { Metrics } from '../metrics.js';
import type { PolicyStore } from '../policy/loader.js';
import type { Services } from '../http/routes.js';
import { createApplicationService } from './application-service.js';
import { createAuditService } from './audit-service.js';
import { createReviewService } from './review-service.js';

/**
 * One place that knows how the services are assembled, so the composition root,
 * the OpenAPI dump and the API tests all build the SAME object graph.
 *
 * Three copies of this wiring is how a route ends up documented differently
 * from how it behaves — which is the failure ADR-0009 exists to prevent, arriving
 * through the back door.
 */
export interface ServiceGraphOptions {
  readonly config: Config;
  readonly database: Database;
  readonly policies: PolicyStore;
  readonly metrics: Metrics;
  readonly logger: Logger;
  /** Overridable so a test can drive a gateway that never touches a network or a clock. */
  readonly gateway?: BureauGateway;
  readonly now?: () => Date;
}

export const createServices = (options: ServiceGraphOptions): Services => {
  const { config, database, policies, metrics, logger } = options;
  const clock = options.now ?? ((): Date => new Date());

  const gateway =
    options.gateway ??
    createBureauGateway({
      database,
      provider: createMockBureau({
        provider: config.BUREAU_PROVIDER,
        failureMode: config.MOCK_BUREAU_FAILURE_MODE,
        latencyMs: config.MOCK_BUREAU_LATENCY_MS,
        failuresBeforeSuccess: config.MOCK_BUREAU_FAILURES_BEFORE_SUCCESS,
        now: clock,
      }),
      metrics,
      reportTtlMinutes: config.BUREAU_REPORT_TTL_MINUTES,
      claimLeaseMs: config.BUREAU_CLAIM_LEASE_MS,
      waitMs: config.BUREAU_WAIT_MS,
      waitPollMs: config.BUREAU_WAIT_POLL_MS,
      timeoutMs: config.BUREAU_TIMEOUT_MS,
      maxAttempts: config.BUREAU_MAX_ATTEMPTS,
      backoffBaseMs: config.BUREAU_BACKOFF_BASE_MS,
    });

  return {
    applications: createApplicationService({ config, database, gateway, policies, metrics, logger, now: clock }),
    reviews: createReviewService({ database, policies, now: clock }),
    audit: createAuditService({ database, policies, config }),
  };
};
