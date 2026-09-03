import type { BureauProviderFailure, BureauProviderResult } from '../domain/bureau-lookup.js';
import type { Config } from '../config.js';
import { lookupCatalogue } from './profiles.js';

/**
 * The mock credit bureau. docs/08-mock-bureau.md.
 *
 * WHAT THIS RECEIVES, AND WHAT IT DOES NOT. It takes the national identifier
 * and nothing else. A real credit file is looked up by the real identifier — no
 * provider can search by our HMAC — and the subject key is ours, for the reuse
 * lookup, the pull claim and the audit correlation. Getting this backwards
 * produces a design that can never be pointed at a real bureau, so the subject
 * key is not a parameter here at all rather than being a parameter this
 * implementation happens to ignore.
 *
 * The identifier is held for the duration of the call and never persisted and
 * never logged. It is not "discarded the moment the subject key is derived" —
 * it survives until the pull completes, because the pull needs it.
 */

/**
 * Named `failure` rather than `cause`: `Error.cause` conventionally holds the
 * underlying error object, and shadowing it with a string enum makes every
 * `error.cause` in this codebase mean one of two different things.
 */
export class BureauTransportError extends Error {
  constructor(readonly failure: BureauProviderFailure) {
    super(`bureau transport failed: ${failure}`);
    this.name = 'BureauTransportError';
  }
}

export interface BureauProvider {
  readonly name: string;
  /** Throws `BureauTransportError` on a transport failure; the resilience wrapper decides what that means. */
  pull(nationalId: string): Promise<BureauProviderResult>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Long enough that any sane BUREAU_TIMEOUT_MS fires first, short enough not to hold a test open. */
const PAST_ANY_TIMEOUT_MS = 30_000;

export interface MockBureauOptions {
  readonly provider: string;
  readonly failureMode: Config['MOCK_BUREAU_FAILURE_MODE'];
  readonly latencyMs: number;
  readonly failuresBeforeSuccess: number;
  readonly now: () => Date;
}

/**
 * Two independent failure triggers, because they serve different audiences.
 *
 * BY IDENTIFIER — 900-55-9001 and 900-55-9002. No configuration and no restart,
 * so the failure path is demonstrable on the deployed instance with a single
 * curl. This is the one a reviewer will use.
 *
 * BY CONFIGURATION — MOCK_BUREAU_FAILURE_MODE. `flaky` fails the first N
 * attempts and then succeeds, which is what proves the retry actually retries
 * rather than merely existing.
 */
export const createMockBureau = (options: MockBureauOptions): BureauProvider => {
  // Per-process, per-subject. A counter shared across subjects would make one
  // applicant's retry consume another's budget and the flaky mode untestable.
  const attemptsBySubject = new Map<string, number>();

  return {
    name: options.provider,

    async pull(nationalId: string): Promise<BureauProviderResult> {
      const entry = lookupCatalogue(nationalId);

      if (entry.kind === 'FAILURE') {
        if (entry.cause === 'TIMEOUT') {
          await sleep(PAST_ANY_TIMEOUT_MS);
          throw new BureauTransportError('TIMEOUT');
        }
        throw new BureauTransportError('SERVER_ERROR');
      }

      if (options.failureMode !== 'none') {
        const seen = (attemptsBySubject.get(nationalId) ?? 0) + 1;
        attemptsBySubject.set(nationalId, seen);
        const shouldFail = options.failureMode !== 'flaky' || seen <= options.failuresBeforeSuccess;

        if (shouldFail) {
          if (options.failureMode === 'timeout') {
            await sleep(PAST_ANY_TIMEOUT_MS);
            throw new BureauTransportError('TIMEOUT');
          }
          throw new BureauTransportError('SERVER_ERROR');
        }
      }

      if (options.latencyMs > 0) await sleep(options.latencyMs);

      if (entry.kind === 'NO_FILE') {
        // The bureau ANSWERED, and there is no file. Stored, reusable, and
        // referred as NO_CREDIT_FILE — never as an outage.
        return { outcome: 'NO_HIT', provider: options.provider, pulledAt: options.now() };
      }

      return {
        outcome: 'FOUND',
        report: { provider: options.provider, pulledAt: options.now(), ...entry.attributes },
      };
    },
  };
};
