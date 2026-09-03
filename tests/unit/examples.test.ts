import { beforeAll, describe, expect, it } from 'vitest';
import { decide, screen } from '../../src/domain/engine.js';
import type { Policy } from '../../src/domain/policy.js';
import { createFilePolicyStore } from '../../src/policy/loader.js';
import { lookupCatalogue } from '../../src/bureau/profiles.js';
import type { BureauLookup } from '../../src/domain/bureau-lookup.js';
import {
  EXPECTED,
  approvedInFullRequest,
  bureauOutageRequest,
  counterOfferRequest,
} from '../../src/http/examples.js';

/**
 * The examples served at `/docs` are promises about behaviour, and a promise
 * nothing checks goes stale. This runs the ENGINE over every documented request
 * and asserts the response documented beside it.
 *
 * It is deliberately not an HTTP test: what can drift is the arithmetic and the
 * reason codes, and those are the engine's. Ids, timestamps and correlation ids
 * in the published examples are illustrative and are not asserted — they differ
 * on every submission, and pretending otherwise would make this a fiction.
 */

let policy: Policy;
beforeAll(async () => {
  policy = await createFilePolicyStore('./policies').get('2026.09.1');
});

const NOW = new Date('2026-09-03T09:14:22.418Z');

/** Exactly what the gateway hands the engine for these identifiers. */
const lookupFor = (nationalId: string): BureauLookup => {
  const entry = lookupCatalogue(nationalId);
  if (entry.kind === 'FAILURE') return { outcome: 'UNAVAILABLE', provider: 'MOCKBUREAU', cause: 'RETRIES_EXHAUSTED' };
  if (entry.kind === 'NO_FILE') return { outcome: 'NO_HIT', provider: 'MOCKBUREAU', pulledAt: NOW };
  return { outcome: 'FOUND', report: { provider: 'MOCKBUREAU', pulledAt: NOW, ...entry.attributes } };
};

interface ExampleRequest {
  readonly productCode: string;
  readonly requestedAmountMinor: number;
  readonly termMonths: number;
  readonly applicant: { readonly dateOfBirth: string; readonly nationalId: string };
  readonly finances: { readonly monthlyIncomeMinor: number; readonly declaredMonthlyObligationsMinor: number };
}

const runExample = (request: ExampleRequest) => {
  const application = {
    productCode: request.productCode,
    requestedAmountMinor: request.requestedAmountMinor,
    termMonths: request.termMonths,
    dateOfBirth: request.applicant.dateOfBirth,
    monthlyIncomeMinor: request.finances.monthlyIncomeMinor,
    declaredMonthlyObligationsMinor: request.finances.declaredMonthlyObligationsMinor,
  };
  const knockout = screen(application, policy, NOW);
  return knockout ?? decide(application, lookupFor(request.applicant.nationalId), policy, NOW);
};

describe('every example in /docs is one the service actually produces', () => {
  it.each([
    ['an approval on the requested terms', approvedInFullRequest, EXPECTED.approvedInFull],
    ['a counter-offer', counterOfferRequest, EXPECTED.counterOffer],
    ['a bureau outage', bureauOutageRequest, EXPECTED.bureauOutage],
  ] as const)('%s', (_label, request, expected) => {
    const result = runExample(request);
    expect(result.verdict).toBe(expected.verdict);
    expect(result.reasonCodes).toEqual(expected.reasonCodes);
    expect('approvedAmountMinor' in result ? result.approvedAmountMinor : null).toBe(expected.approvedAmountMinor);
    expect('monthlyPaymentMinor' in result ? result.monthlyPaymentMinor : null).toBe(expected.monthlyPaymentMinor);
    expect('score' in result ? result.score : null).toBe(expected.score);
  });

  it('keeps the empty reason list in the published example, because it is the point', () => {
    // The approval example exists to show `reasonCodes: []` — a reviewer reading
    // /docs should meet that case before they meet it in a response and wonder
    // whether the field is broken.
    expect(EXPECTED.approvedInFull.reasonCodes).toEqual([]);
  });
});
