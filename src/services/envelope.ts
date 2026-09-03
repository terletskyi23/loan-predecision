import type { z } from 'zod';
import type { ApplicationRecord } from '../db/applications.js';
import { findPreDecision, type PreDecisionRecord } from '../db/pre-decisions.js';
import type { Queryable } from '../db/pool.js';
import { findReview, type ReviewRecord } from '../db/reviews.js';
import type { EngineApplication } from '../domain/engine.js';
import type { PolicyStore } from '../policy/loader.js';
import type { statusResponseSchema, submissionResponseSchema } from '../http/schemas.js';

/**
 * The response envelope, built from STORED ROWS rather than from whatever the
 * request happened to be holding.
 *
 * Not ceremony: the submission response and the status response must describe
 * the same application, and reconstructing one of them from in-memory values is
 * exactly how the two drift.
 *
 * The two shapes are the zod schemas' own inferred types, so a field added to
 * the contract and forgotten here fails the build rather than the reviewer.
 */
export type Envelope = z.infer<typeof submissionResponseSchema>;
export type StatusEnvelope = z.infer<typeof statusResponseSchema>;

/** The engine reads a narrow projection: no name, no email, no identifier. */
export const engineApplicationFrom = (record: ApplicationRecord): EngineApplication => ({
  productCode: record.productCode,
  requestedAmountMinor: record.requestedAmountMinor,
  termMonths: record.termMonths,
  dateOfBirth: record.applicant.dateOfBirth,
  monthlyIncomeMinor: record.finances.monthlyIncomeMinor,
  declaredMonthlyObligationsMinor: record.finances.declaredMonthlyObligationsMinor,
});

interface Bands {
  readonly autoApproveFrom: number;
  readonly referralFrom: number;
  readonly maxScore: number;
  readonly annualRatePct: number;
}

/**
 * The bands come from the policy version RECORDED ON THE PRE-DECISION, never
 * from today's.
 *
 * A decision made under September's rules keeps describing itself in September's
 * terms. Rendering a stored score of 68 against October's bands would print
 * `AUTO_APPROVE` beside a verdict of `MANUAL_REVIEW`, and the envelope would
 * contradict itself for no reason a reader could ever find. Replay follows the
 * same rule; this is that rule applied to presentation.
 */
const bandsFor = async (policies: PolicyStore, policyVersion: string, productCode: string): Promise<Bands> => {
  const policy = await policies.get(policyVersion);
  return {
    autoApproveFrom: policy.bands.autoApproveFrom,
    referralFrom: policy.bands.referralFrom,
    maxScore: policy.scorecard.maxPoints,
    annualRatePct: policy.products[productCode]?.annualRatePct ?? 0,
  };
};

const bandFor = (score: number | null, bands: Bands): 'AUTO_APPROVE' | 'REFERRAL' | 'DECLINE' | null => {
  if (score === null) return null;
  if (score >= bands.autoApproveFrom) return 'AUTO_APPROVE';
  return score >= bands.referralFrom ? 'REFERRAL' : 'DECLINE';
};

const renderPreDecision = (
  decision: PreDecisionRecord,
  currency: string,
  termMonths: number,
  bands: Bands,
): Envelope['preDecision'] => ({
  verdict: decision.verdict,
  reasonCodes: [...decision.reasonCodes],
  offer:
    decision.approvedAmountMinor === null || decision.monthlyPaymentMinor === null || decision.offerExpiresAt === null
      ? null
      : {
          approvedAmountMinor: decision.approvedAmountMinor,
          currency,
          termMonths,
          annualRatePct: bands.annualRatePct,
          monthlyPaymentMinor: decision.monthlyPaymentMinor,
          expiresAt: decision.offerExpiresAt.toISOString(),
        },
  assessment: {
    score: decision.score,
    maxScore: bands.maxScore,
    band: bandFor(decision.score, bands),
    dti: decision.dti,
  },
  policyVersion: decision.policyVersion,
  engineVersion: decision.engineVersion,
  bureauReportId: decision.bureauReportId,
  bureauReportReused: decision.bureauReportReused,
  lookupFailureCause: decision.lookupFailureCause,
  decidedAt: decision.decidedAt.toISOString(),
});

const renderReview = (review: ReviewRecord | null): Envelope['review'] =>
  review === null
    ? null
    : {
        state: review.state,
        outcome: review.outcome,
        approvedAmountMinor: review.approvedAmountMinor,
        reviewerId: review.reviewerId,
        rationale: review.rationale,
        openedAt: review.openedAt.toISOString(),
        closedAt: review.closedAt?.toISOString() ?? null,
      };

export class EnvelopeWithoutDecisionError extends Error {
  constructor(applicationId: string) {
    // Building a response for an application that has no pre-decision is a
    // programming error, not a state a caller can reach: every path that
    // renders an envelope has just written one or has read one back.
    super(`application ${applicationId} has no pre-decision to render`);
    this.name = 'EnvelopeWithoutDecisionError';
  }
}

export const buildEnvelope = async (
  db: Queryable,
  policies: PolicyStore,
  application: ApplicationRecord,
  correlationId: string,
): Promise<Envelope> => {
  const decision = await findPreDecision(db, application.id);
  if (decision === null) throw new EnvelopeWithoutDecisionError(application.id);

  const bands = await bandsFor(policies, decision.policyVersion, application.productCode);
  const review = await findReview(db, application.id);

  return {
    applicationId: application.id,
    status: application.status,
    submittedAt: application.submittedAt.toISOString(),
    product: {
      code: application.productCode,
      requestedAmountMinor: application.requestedAmountMinor,
      currency: application.currency,
      termMonths: application.termMonths,
    },
    preDecision: renderPreDecision(decision, application.currency, application.termMonths, bands),
    review: renderReview(review),
    correlationId,
  };
};

/**
 * The composed answer, and the reason a synchronous API still needs a status
 * call.
 *
 * `preDecision` NEVER changes — it is what the engine concluded, and a human
 * disagreeing with it does not make it untrue. `outcome` is where the
 * disagreement is resolved, and it is GET-only because the stored idempotent
 * body would go stale the moment a reviewer closed the review: a replayed
 * submission would then contradict this endpoint about the same application.
 */
export const buildStatus = async (
  db: Queryable,
  policies: PolicyStore,
  application: ApplicationRecord,
  correlationId: string,
): Promise<StatusEnvelope> => {
  const envelope = await buildEnvelope(db, policies, application, correlationId);
  const review = await findReview(db, application.id);

  const closedOutcome = review?.state === 'CLOSED' ? review.outcome : null;
  return {
    ...envelope,
    outcome:
      closedOutcome === null
        ? {
            verdict: envelope.preDecision.verdict,
            source: 'ENGINE',
            decidedAt: envelope.preDecision.decidedAt,
          }
        : {
            verdict: closedOutcome,
            source: 'REVIEWER',
            decidedAt: (review?.closedAt ?? new Date()).toISOString(),
          },
  };
};
