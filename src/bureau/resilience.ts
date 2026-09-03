import { randomUUID } from 'node:crypto';
import type { BureauLookup, BureauProviderFailure } from '../domain/bureau-lookup.js';
import { BureauTransportError, type BureauProvider } from './provider.js';

/**
 * Layer 4 of docs/02-idempotency.md: retries of OUR OWN call.
 *
 * A retry is a duplicate we create ourselves, and it is the one duplicate the
 * applicant can neither see nor prevent. Everything here exists to keep one
 * logical pull from becoming two enquiries on a credit file.
 *
 * WHY A TIMEOUT AT ALL. A dependency that hangs rather than refusing is the
 * failure mode that is hardest to see: the error rate stays clean while every
 * request holds a connection, and the pool saturates. `BUREAU_TIMEOUT_MS` turns
 * a hang into an error we can count.
 *
 * WHY JITTER. Without it, N requests that failed together retry together, and
 * the bureau receives the same thundering herd twice.
 */

export interface ResilienceOptions {
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly backoffBaseMs: number;
  /** Injected so a test can make backoff deterministic; production passes Math.random. */
  readonly random?: () => number;
  /** Supplied when the caller already has an id to correlate by; generated once per pull otherwise. */
  readonly requestId?: string;
  readonly onAttempt?: (attempt: number, failure: BureauProviderFailure | null) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const withTimeout = async <T>(work: Promise<T>, ms: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new BureauTransportError('TIMEOUT')), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/**
 * Wraps a provider so that one logical pull is one call to this function,
 * whatever happens underneath.
 *
 * THE CAUSE REPORTED IS NOT ALWAYS THE LAST ONE SEEN. A single attempt reports
 * what actually went wrong — TIMEOUT or SERVER_ERROR — because that is
 * actionable. More than one attempt reports RETRIES_EXHAUSTED, because "the
 * last of three failures was a timeout" is a less useful fact than "we tried
 * three times and gave up", and because the three failures were frequently not
 * the same kind.
 *
 * Nothing here is retried that should not be: a `FOUND` and a `NO_HIT` are both
 * ANSWERS, and the loop exits on either. Retrying a no-hit because it looks
 * empty would put a second enquiry on the file of someone who has none.
 */
export const pullWithResilience = async (
  provider: BureauProvider,
  nationalId: string,
  options: ResilienceOptions,
): Promise<BureauLookup> => {
  const random = options.random ?? Math.random;

  // ONE id for the whole logical pull, minted here and reused by every attempt
  // below. Minting it inside the loop would be the bug: each retry would look
  // like a separate enquiry to the provider, and the retry budget would become a
  // multiplier on the applicant's credit file.
  const requestId = options.requestId ?? randomUUID();
  let attempted = 0;
  let lastFailure: BureauProviderFailure = 'SERVER_ERROR';

  while (attempted < options.maxAttempts) {
    attempted += 1;
    try {
      const result = await withTimeout(provider.pull(nationalId, requestId), options.timeoutMs);
      options.onAttempt?.(attempted, null);
      return result;
    } catch (error) {
      // OUR bug is not the bureau's outage. A TypeError in an adapter relabelled
      // as SERVER_ERROR gets retried — a second outbound call on a real provider
      // — and is then recorded as RETRIES_EXHAUSTED on the pre-decision: a false
      // statement about a third party, inside a record built to be replayed and
      // defended. docs/02 §6 applies this instinct to the bureau's 4xx; it
      // applies at least as strongly to ours.
      if (!(error instanceof BureauTransportError)) throw error;

      lastFailure = error.failure;
      options.onAttempt?.(attempted, lastFailure);

      if (attempted >= options.maxAttempts) break;

      // Full jitter over the backoff window rather than a fixed delay plus a
      // little noise: it spreads a synchronised herd across the whole interval
      // instead of across the edges of it.
      await sleep(Math.floor(random() * options.backoffBaseMs));
    }
  }

  return {
    outcome: 'UNAVAILABLE',
    provider: provider.name,
    cause: attempted > 1 ? 'RETRIES_EXHAUSTED' : lastFailure,
  };
};
