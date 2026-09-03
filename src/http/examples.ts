/**
 * The worked examples served at `/docs`, in one place.
 *
 * WHY THEY LIVE IN THE SOURCE AND NOT IN THE SCHEMA LITERALS. An example is a
 * promise about behaviour, and a promise nothing checks is a promise that goes
 * stale — `docs/05-api.md` §3 carries the same three scenarios in prose, and
 * prose has already drifted from this code once. `tests/unit/examples.test.ts`
 * runs the engine over every request below and asserts the response beside it,
 * so an example in the interactive reference cannot describe an outcome the
 * service no longer produces.
 *
 * All three identifiers are from the mock's catalogue (docs/08 §4), so a
 * reviewer pressing "Try it out" against the deployed instance gets exactly the
 * documented answer rather than something derived and unremarkable.
 */

const CONSENT_AT = '2026-09-03T09:00:00.000Z';

/** `900-55-0601` · PRIME · score 100 · approved in full, and the reason list is EMPTY. */
export const approvedInFullRequest = {
  productCode: 'PERSONAL_UNSECURED_V1',
  requestedAmountMinor: 1800000,
  currency: 'USD',
  termMonths: 36,
  purpose: 'HOME_IMPROVEMENT',
  consent: { attestedByCaller: true, acceptedAt: CONSENT_AT },
  applicant: {
    firstName: 'Daniel',
    lastName: 'Okonkwo',
    dateOfBirth: '1988-02-19',
    nationalId: '900-55-0601',
    email: 'daniel.okonkwo@example.com',
    residenceCountry: 'US',
  },
  finances: {
    monthlyIncomeMinor: 620000,
    employmentStatus: 'EMPLOYED',
    employmentMonths: 94,
    declaredMonthlyObligationsMinor: 90000,
  },
  channel: 'WEB',
} as const;

/** `900-55-0142` · CLEAN_MODERATE · score 75 · DTI over the limit, so a counter-offer. */
export const counterOfferRequest = {
  ...approvedInFullRequest,
  requestedAmountMinor: 3200000,
  termMonths: 48,
  purpose: 'DEBT_CONSOLIDATION',
  applicant: {
    ...approvedInFullRequest.applicant,
    firstName: 'Maria',
    lastName: 'Delgado',
    dateOfBirth: '1991-04-12',
    nationalId: '900-55-0142',
    email: 'maria.delgado@example.com',
  },
  finances: {
    ...approvedInFullRequest.finances,
    monthlyIncomeMinor: 540000,
    declaredMonthlyObligationsMinor: 160000,
  },
} as const;

/** `900-55-9001` · the bureau refuses on every attempt, with no configuration and no restart. */
export const bureauOutageRequest = {
  ...approvedInFullRequest,
  applicant: { ...approvedInFullRequest.applicant, nationalId: '900-55-9001' },
} as const;

/**
 * The engine-derived half of each response — the fields
 * `tests/unit/examples.test.ts` recomputes. Ids, timestamps and correlation ids
 * are illustrative and are not asserted: they differ on every submission, and
 * pretending otherwise would make the test a fiction.
 */
export const EXPECTED = {
  approvedInFull: {
    verdict: 'APPROVED',
    reasonCodes: [] as readonly string[],
    approvedAmountMinor: 1800000,
    monthlyPaymentMinor: 60562,
    score: 100,
  },
  counterOffer: {
    verdict: 'APPROVED',
    reasonCodes: ['AMOUNT_REDUCED_TO_FIT_DTI', 'CREDIT_UTILIZATION_TOO_HIGH', 'LIMITED_CREDIT_MIX'] as readonly string[],
    approvedAmountMinor: 2690000,
    monthlyPaymentMinor: 72033,
    score: 75,
  },
  bureauOutage: {
    verdict: 'MANUAL_REVIEW',
    reasonCodes: ['BUREAU_UNAVAILABLE'] as readonly string[],
    approvedAmountMinor: null,
    monthlyPaymentMinor: null,
    score: null,
  },
} as const;

interface ExampleRequest {
  readonly productCode: string;
  readonly requestedAmountMinor: number;
  readonly currency: string;
  readonly termMonths: number;
}

const envelope = (
  applicationId: string,
  request: ExampleRequest,
  expected: (typeof EXPECTED)[keyof typeof EXPECTED],
  extra: Record<string, unknown>,
): Record<string, unknown> => ({
  applicationId,
  status: expected.verdict === 'MANUAL_REVIEW' ? 'IN_REVIEW' : 'PRE_DECIDED',
  submittedAt: '2026-09-03T09:14:22.418Z',
  product: {
    code: request.productCode,
    requestedAmountMinor: request.requestedAmountMinor,
    currency: request.currency,
    termMonths: request.termMonths,
  },
  preDecision: {
    verdict: expected.verdict,
    reasonCodes: expected.reasonCodes,
    offer:
      expected.approvedAmountMinor === null
        ? null
        : {
            approvedAmountMinor: expected.approvedAmountMinor,
            currency: request.currency,
            termMonths: request.termMonths,
            annualRatePct: 12.9,
            monthlyPaymentMinor: expected.monthlyPaymentMinor,
            expiresAt: '2026-10-03T09:14:22.418Z',
          },
    ...extra,
    policyVersion: '2026.09.1',
    engineVersion: '1.0.0',
    decidedAt: '2026-09-03T09:14:23.106Z',
  },
  review: expected.verdict === 'MANUAL_REVIEW' ? { state: 'PENDING', outcome: null, approvedAmountMinor: null, reviewerId: null, rationale: null, openedAt: '2026-09-03T09:14:23.106Z', closedAt: null } : null,
  correlationId: '01J9R4W2FT5H9C1P8K2A7Y3ZDM',
});

export const approvedInFullResponse = envelope('3f8c1b02-91d4-4a77-8e26-5c0b7ad34e19', approvedInFullRequest, EXPECTED.approvedInFull, {
  assessment: { score: 100, maxScore: 100, band: 'AUTO_APPROVE', dti: 0.2428 },
  bureauReportId: '9d1e7c65-40ab-4b3f-8a52-1f6d09c8b774',
  bureauReportReused: false,
  lookupFailureCause: null,
});

export const counterOfferResponse = envelope('0b5f2a1e-6c47-4f0a-9b3d-7a1c48e2d905', counterOfferRequest, EXPECTED.counterOffer, {
  assessment: { score: 75, maxScore: 100, band: 'AUTO_APPROVE', dti: 0.4297 },
  bureauReportId: 'c17a9d40-2b58-4e6d-8f11-90ab3c7e4d22',
  bureauReportReused: false,
  lookupFailureCause: null,
});

export const bureauOutageResponse = envelope('a742f1b8-05dc-4e93-8b60-cc1de5f2a390', bureauOutageRequest, EXPECTED.bureauOutage, {
  assessment: { score: null, maxScore: 100, band: null, dti: null },
  bureauReportId: null,
  bureauReportReused: false,
  lookupFailureCause: 'RETRIES_EXHAUSTED',
});

export const closeReviewRequest = {
  outcome: 'APPROVED',
  approvedAmountMinor: 900000,
  rationale: 'Bureau outage; file pulled manually and assessed. Income verified against payslips.',
} as const;

export const problemExample = {
  type: '/problems/idempotency-key-reused',
  title: 'Idempotency key reused',
  status: 422,
  detail: 'This idempotency key was used for a different request body.',
  code: 'IDEMPOTENCY_KEY_REUSED',
  correlationId: '01J9R4X8QK7M2V0T5S3B6N8WQE',
} as const;
