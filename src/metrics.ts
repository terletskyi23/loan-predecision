import { Registry, collectDefaultMetrics, Counter, Histogram } from 'prom-client';

/**
 * The metrics that exist today, and only those.
 *
 * docs/05-api.md §8 lists more — bureau_reuse_ratio, bureau_pulls_total,
 * bureau_wait_expired_total and the rest. They arrive with the code that moves
 * them. Registering a counter that nothing increments would put a permanent
 * zero on a dashboard and read as coverage, which is worse than an absent
 * metric: an absent one is obviously absent.
 *
 * None of this is scraped in v1. docs/06-failure-modes.md says so plainly:
 * the counters are exported, and there is no scraper, no alertmanager, no
 * retention and no dashboard.
 */
export interface Metrics {
  readonly registry: Registry;
  readonly httpRequests: Counter<'method' | 'route' | 'status'>;
  readonly httpErrors: Counter<'class'>;
  readonly httpDuration: Histogram<'method' | 'route'>;
}

export const createMetrics = (): Metrics => {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const httpRequests = new Counter({
    name: 'http_requests_total',
    help: 'HTTP requests by method, route and status code.',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [registry],
  });

  // 4xx and 5xx are counted separately on purpose. Mixed together, a buggy
  // integrator's 422s drown a real 5xx outage — which is also why the alert
  // list in docs/06 deliberately excludes a raw error count.
  const httpErrors = new Counter({
    name: 'http_errors_total',
    help: 'HTTP error responses by class.',
    labelNames: ['class'] as const,
    registers: [registry],
  });

  const httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'End-to-end request duration.',
    labelNames: ['method', 'route'] as const,
    // Bucketed around the p95 budget in docs/00-scope.md A2, not around the
    // library default: the question this histogram answers is "is instant still
    // true", and the interesting boundary is 2 seconds.
    buckets: [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2, 2.5, 5],
    registers: [registry],
  });

  return { registry, httpRequests, httpErrors, httpDuration };
};
