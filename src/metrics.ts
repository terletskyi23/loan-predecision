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

  /** How a lookup was satisfied. `reused` over the total is the dedup signal. */
  readonly bureauLookups: Counter<'result'>;
  /** Enquiries actually placed with the provider. The number a finance question is answered from. */
  readonly bureauPulls: Counter<'outcome'>;
  /** A loser gave up while the winner was still running. Means the wait is too short, NOT that the bureau is down. */
  readonly bureauWaitExpired: Counter;
  /** A request lost the claim and had to wait. Rising contention is the trigger for paying for fencing. */
  readonly bureauClaimContention: Counter;
  /** An orphan the sweeper closed. Invisible without a counter, because nobody is waiting on it. */
  readonly applicationsAbandoned: Counter;
  readonly preDecisions: Counter<'verdict'>;
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

  // docs/02-idempotency.md §7. bureau_reuse_ratio is the PRIMARY dedup signal and
  // not a proof: a low reuse ratio is also what a service with no duplicate
  // traffic looks like. The two counters beneath it exist because both failures
  // are otherwise completely invisible — nobody is waiting on an abandoned
  // application, and a wait that expired still returns a plausible verdict.
  const bureauLookups = new Counter({
    name: 'bureau_lookups_total',
    help: 'Bureau lookups by how they were satisfied: reused, pulled, waited or unavailable.',
    labelNames: ['result'] as const,
    registers: [registry],
  });

  const bureauPulls = new Counter({
    name: 'bureau_pulls_total',
    help: 'Enquiries actually placed with the provider, by outcome.',
    labelNames: ['outcome'] as const,
    registers: [registry],
  });

  const bureauWaitExpired = new Counter({
    name: 'bureau_wait_expired_total',
    help: 'Waits that ran out while the winner was still running. The wait is too short for the retry budget.',
    registers: [registry],
  });

  const bureauClaimContention = new Counter({
    name: 'bureau_claim_contention_total',
    help: 'Requests that lost a pull claim and waited. The trigger for fencing the lease.',
    registers: [registry],
  });

  const applicationsAbandoned = new Counter({
    name: 'applications_abandoned_total',
    help: 'Orphaned applications retired by the sweeper.',
    registers: [registry],
  });

  const preDecisions = new Counter({
    name: 'pre_decisions_total',
    help: 'Engine verdicts by outcome.',
    labelNames: ['verdict'] as const,
    registers: [registry],
  });

  return {
    registry,
    httpRequests,
    httpErrors,
    httpDuration,
    bureauLookups,
    bureauPulls,
    bureauWaitExpired,
    bureauClaimContention,
    applicationsAbandoned,
    preDecisions,
  };
};
