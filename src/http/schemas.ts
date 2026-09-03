import { z } from 'zod';

/**
 * The wire contract. One zod schema per route produces three things at once:
 * request validation, TypeScript types, and the OpenAPI document served at
 * `/docs` — so the specification cannot drift from the code (ADR-0009).
 *
 * MONEY IS AN INTEGER IN MINOR UNITS, EVERYWHERE. `2690000` is $26,900.00. A
 * decimal on the wire invites a float on the other side, and a float is the
 * wrong type for money in a system whose whole claim is that a decision can be
 * reproduced years later.
 */

const minorUnits = z.number().int().nonnegative().describe('Minor units, e.g. cents. 2690000 is $26,900.00');

export const PURPOSES = ['DEBT_CONSOLIDATION', 'HOME_IMPROVEMENT', 'MEDICAL', 'MAJOR_PURCHASE', 'VEHICLE', 'EDUCATION', 'OTHER'] as const;
export const CHANNELS = ['WEB', 'MOBILE', 'PARTNER', 'BRANCH'] as const;
export const EMPLOYMENT = ['EMPLOYED', 'SELF_EMPLOYED', 'RETIRED', 'STUDENT', 'UNEMPLOYED', 'OTHER'] as const;

export const submitApplicationSchema = z
  .object({
    productCode: z.string().min(1),
    requestedAmountMinor: z.number().int().positive(),
    currency: z.string().length(3),
    termMonths: z.number().int().min(1).max(600),
    purpose: z.enum(PURPOSES),

    consent: z.object({
      /**
       * Must be `true`. The caller asserts it captured the applicant's
       * authorisation for a credit enquiry; we record WHO asserted it (from the
       * token, not the body) and WHEN. This is not proof the applicant
       * consented — under FCRA the permissible purpose belongs to the party
       * performing the pull, and it can be pushed to an integrator by contract
       * but not delegated away by API design. ADR-0007.
       */
      // A boolean rather than `z.literal(true)`, so `false` reaches the service
      // and returns CONSENT_REQUIRED. Under the literal, zod rejected it as a
      // generic VALIDATION_FAILED and a documented error code in a catalogue
      // that calls itself closed was unreachable — the inverse of the failure
      // problem.ts opens by warning about.
      attestedByCaller: z.boolean(),
      acceptedAt: z.string().datetime(),
    }),

    applicant: z.object({
      firstName: z.string().min(1).max(100),
      lastName: z.string().min(1).max(100),
      dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
      /** Passed to the bureau, hashed into the subject key, and never persisted or logged. */
      nationalId: z.string().min(1).max(64),
      email: z.string().email(),
      phone: z.string().max(32).optional(),
      residenceCountry: z.string().length(2),
    }),

    finances: z.object({
      monthlyIncomeMinor: minorUnits,
      employmentStatus: z.enum(EMPLOYMENT),
      employmentMonths: z.number().int().nonnegative().optional(),
      declaredMonthlyObligationsMinor: minorUnits.default(0),
    }),

    /** Correlation only. Never a key and never a deduplication input — see docs/05 §3. */
    customerId: z.string().max(128).optional(),
    channel: z.enum(CHANNELS).default('WEB'),
  })
  .meta({ id: 'SubmitApplication' });

export type SubmitApplicationBody = z.infer<typeof submitApplicationSchema>;

const offerSchema = z.object({
  approvedAmountMinor: minorUnits,
  currency: z.string().length(3),
  termMonths: z.number().int(),
  annualRatePct: z.number(),
  monthlyPaymentMinor: minorUnits,
  expiresAt: z.string(),
});

const assessmentSchema = z.object({
  /** Null whenever the pipeline terminated before the scorecard ran: an S1 or D2 knockout, or a D1 referral. */
  score: z.number().int().nullable(),
  maxScore: z.number().int(),
  band: z.enum(['AUTO_APPROVE', 'REFERRAL', 'DECLINE']).nullable(),
  dti: z.number().nullable(),
});

export const preDecisionSchema = z.object({
  verdict: z.enum(['APPROVED', 'DECLINED', 'MANUAL_REVIEW']),
  /**
   * Ordered: decisive and referral codes first in registry order, then scorecard
   * factors by points lost. At most four. **Empty is valid and only for an
   * approval on the requested terms** — that is not adverse action and owes the
   * applicant no explanation (ADR-0010). Always present; read `length === 0`
   * rather than treating it as absent.
   */
  reasonCodes: z.array(z.string()),
  offer: offerSchema.nullable(),
  assessment: assessmentSchema,
  policyVersion: z.string(),
  engineVersion: z.string(),
  bureauReportId: z.string().nullable(),
  bureauReportReused: z.boolean(),
  /** TIMEOUT, SERVER_ERROR, RETRIES_EXHAUSTED or WAIT_EXPIRED. Null unless the lookup failed. */
  lookupFailureCause: z.string().nullable(),
  decidedAt: z.string(),
});

export const reviewSchema = z.object({
  state: z.enum(['PENDING', 'CLOSED']),
  outcome: z.enum(['APPROVED', 'DECLINED']).nullable(),
  approvedAmountMinor: z.number().int().nullable(),
  reviewerId: z.string().nullable(),
  rationale: z.string().nullable(),
  openedAt: z.string(),
  closedAt: z.string().nullable(),
});

const envelope = {
  applicationId: z.string().uuid(),
  status: z.enum(['RECEIVED', 'PRE_DECIDED', 'IN_REVIEW', 'REVIEW_CLOSED', 'ABANDONED']),
  submittedAt: z.string(),
  product: z.object({
    code: z.string(),
    requestedAmountMinor: minorUnits,
    currency: z.string(),
    termMonths: z.number().int(),
  }),
  preDecision: preDecisionSchema,
  review: reviewSchema.nullable(),
  correlationId: z.string(),
};

export const submissionResponseSchema = z.object(envelope).meta({ id: 'Submission' });

export const statusResponseSchema = z
  .object({
    ...envelope,
    /**
     * Null for an application that has no pre-decision: `RECEIVED`, because the
     * process died between the insert and the verdict, and `ABANDONED` once the
     * sweeper has retired it. Both statuses are in the enum above, so a
     * non-nullable `preDecision` made two documented states unrenderable — and
     * the endpoint answered 500 for them.
     */
    preDecision: preDecisionSchema.nullable(),
    /**
     * The single composed answer: the reviewer's outcome once a review is
     * closed, otherwise the engine's verdict. GET only — the stored idempotent
     * body would go stale the moment a human closed the review, and a replayed
     * submission would then contradict the status endpoint.
     */
    outcome: z
      .object({
        verdict: z.enum(['APPROVED', 'DECLINED', 'MANUAL_REVIEW']),
        source: z.enum(['ENGINE', 'REVIEWER']),
        decidedAt: z.string(),
      })
      .nullable(),
  })
  .meta({ id: 'ApplicationStatus' });

export const closeReviewSchema = z
  .object({
    outcome: z.enum(['APPROVED', 'DECLINED']),
    approvedAmountMinor: minorUnits.optional(),
    rationale: z.string().min(1).max(2000),
  })
  .meta({ id: 'CloseReview' });

export const auditEventsSchema = z
  .object({
    applicationId: z.string().uuid(),
    events: z.array(
      z.object({
        index: z.number().int(),
        type: z.string(),
        at: z.string(),
        actor: z.string(),
        detail: z.record(z.string(), z.unknown()),
        hash: z.string(),
      }),
    ),
  })
  .meta({ id: 'AuditEvents' });

export const chainSchema = z
  .object({
    applicationId: z.string().uuid(),
    events: z.number().int(),
    chainIntact: z.boolean(),
    brokenAtIndex: z.number().int().nullable(),
    verifiedAt: z.string(),
  })
  .meta({ id: 'ChainVerification' });

export const replaySchema = z
  .object({
    applicationId: z.string().uuid(),
    match: z.boolean(),
    recorded: z.object({
      verdict: z.string(),
      reasonCodes: z.array(z.string()),
      requestedAmountMinor: z.number().int().nullable(),
      approvedAmountMinor: z.number().int().nullable(),
      monthlyPaymentMinor: z.number().int().nullable(),
      offerExpiresAt: z.string().nullable(),
      score: z.number().int().nullable(),
      dti: z.number().nullable(),
      policyVersion: z.string(),
      engineVersion: z.string(),
    }),
    recomputed: z.object({
      verdict: z.string(),
      reasonCodes: z.array(z.string()),
      requestedAmountMinor: z.number().int().nullable(),
      approvedAmountMinor: z.number().int().nullable(),
      monthlyPaymentMinor: z.number().int().nullable(),
      offerExpiresAt: z.string().nullable(),
      score: z.number().int().nullable(),
      dti: z.number().nullable(),
      policyVersion: z.string(),
      engineVersion: z.string(),
    }),
    differences: z.array(z.string()),
    replayedAt: z.string(),
  })
  .meta({ id: 'Replay' });

export const preDecisionListSchema = z
  .object({
    preDecisions: z.array(
      z.object({
        applicationId: z.string().uuid(),
        verdict: z.string(),
        reasonCodes: z.array(z.string()),
        score: z.number().int().nullable(),
        policyVersion: z.string(),
        bureauReportReused: z.boolean(),
        decidedAt: z.string(),
      }),
    ),
  })
  .meta({ id: 'PreDecisionList' });
