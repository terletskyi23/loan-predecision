import type { BureauLookup, BureauReport } from './bureau-lookup.js';
import { Decimal, annuityPaymentMinor, debtToIncome, maxPrincipalForPaymentMinor } from './money.js';
import type { Policy, PolicyProduct } from './policy.js';
import { discloseReasonCodes } from './reason-codes.js';
import { missingInputs, score, type Scorecard } from './scorecard.js';

/**
 * The engine. Two pure functions, no clock, no database, no network.
 *
 *   screen(application, policy, now)          -> Knockout | null
 *   decide(application, lookup, policy, now)  -> PreDecision
 *
 * Everything they need arrives as an argument, which is what makes a
 * pre-decision replayable years later from stored inputs — and therefore what
 * makes the audit claim true rather than aspirational (ADR-0004, ADR-0008).
 *
 * THE PIPELINE, and the first rule that produces a verdict wins:
 *
 *   S1  Eligibility knockouts .................. DECLINED
 *   ---------------- the bureau is called here ----------------
 *   D1  Lookup gate ............................ MANUAL_REVIEW
 *   D2  Bureau knockouts ....................... DECLINED
 *   D3  Scorecard computed (never terminal on its own)
 *   D4  Referral triggers ...................... MANUAL_REVIEW
 *   D5  Score below the referral floor ......... DECLINED
 *   D6  Score inside the referral band ......... MANUAL_REVIEW
 *   D7  Affordability .......... APPROVED · counter-offer · DECLINED
 *
 * WHY TWO FUNCTIONS AND NOT ONE WITH A FLAG. S1 runs before the pull. An
 * applicant who is under 18, or asking for twice the product ceiling, is
 * declined either way — and pulling their file first would leave a hard enquiry
 * on the credit record of someone whose application was never going to succeed.
 * A single evaluate() called after the report cannot express that ordering, and
 * the ethical claim in docs/03 §2 would be prose with nothing enforcing it.
 */

export interface EngineApplication {
  readonly productCode: string;
  readonly requestedAmountMinor: number;
  readonly termMonths: number;
  /** ISO `YYYY-MM-DD`. Age is derived against `now`, never stored as a number. */
  readonly dateOfBirth: string;
  readonly monthlyIncomeMinor: number;
  /** What the applicant declared. The bureau's figure wins at D7 when it exists. */
  readonly declaredMonthlyObligationsMinor: number;
}

export type Verdict = 'APPROVED' | 'DECLINED' | 'MANUAL_REVIEW';

/** Which rule produced the verdict. Stored on the audit event so "why" is answerable without re-running anything. */
export type DecisionStage = 'S1' | 'D1' | 'D2' | 'D4' | 'D5' | 'D6' | 'D7';

export interface Knockout {
  readonly verdict: 'DECLINED';
  readonly stage: 'S1';
  readonly reasonCodes: readonly string[];
}

export interface PreDecision {
  readonly verdict: Verdict;
  readonly stage: DecisionStage;
  readonly reasonCodes: readonly string[];
  readonly approvedAmountMinor: number | null;
  readonly monthlyPaymentMinor: number | null;
  readonly offerExpiresAt: Date | null;
  /** Null whenever the pipeline terminated before D3 — an S1 or D2 knockout, or a D1 referral. */
  readonly score: number | null;
  readonly dti: number | null;
  /** The per-factor evidence behind `score`. Null for the same cases. */
  readonly scorecard: Scorecard | null;
}

export class UnknownProductError extends Error {
  constructor(readonly productCode: string) {
    super(`No product "${productCode}" in this policy.`);
    this.name = 'UnknownProductError';
  }
}

const product = (application: EngineApplication, policy: Policy): PolicyProduct => {
  const found = policy.products[application.productCode];
  // A product the policy does not define is a malformed REQUEST, not a policy
  // rejection: it is caught at the edge as 422 and never reaches here. Throwing
  // rather than declining keeps that boundary honest — a decline would create an
  // application and an audit trail for a product that does not exist.
  if (found === undefined) throw new UnknownProductError(application.productCode);
  return found;
};

/** Whole years completed at `at`. Month and day are compared, so a birthday tomorrow is not a year today. */
export const ageAt = (dateOfBirth: string, at: Date): number => {
  const born = new Date(`${dateOfBirth}T00:00:00.000Z`);
  if (Number.isNaN(born.getTime())) throw new RangeError(`dateOfBirth "${dateOfBirth}" is not a date`);

  let age = at.getUTCFullYear() - born.getUTCFullYear();
  const monthDelta = at.getUTCMonth() - born.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && at.getUTCDate() < born.getUTCDate())) age -= 1;
  return age;
};

const addMonths = (from: Date, months: number): Date => {
  const result = new Date(from.getTime());
  result.setUTCMonth(result.getUTCMonth() + months);
  return result;
};

const addDays = (from: Date, days: number): Date => new Date(from.getTime() + days * 86_400_000);

/**
 * S1 — the knockouts that need no bureau data at all.
 *
 * Every condition that holds is disclosed, not only the first. An applicant
 * asking for too much money over too long a term is told both things: telling
 * them one, watching them fix it and telling them the other is a worse
 * experience and a worse adverse action notice. The cap in
 * `discloseReasonCodes` still applies.
 */
export const screen = (application: EngineApplication, policy: Policy, now: Date): Knockout | null => {
  const definition = product(application, policy);
  const codes: string[] = [];

  const age = ageAt(application.dateOfBirth, now);
  if (age < policy.eligibility.minAge) codes.push('AGE_BELOW_MINIMUM');

  const ageAtMaturity = ageAt(application.dateOfBirth, addMonths(now, application.termMonths));
  if (ageAtMaturity > policy.eligibility.maxAgeAtMaturity) codes.push('AGE_ABOVE_MAXIMUM_AT_MATURITY');

  if (
    application.requestedAmountMinor < definition.minAmountMinor ||
    application.requestedAmountMinor > definition.maxAmountMinor
  ) {
    codes.push('AMOUNT_OUTSIDE_PRODUCT_LIMITS');
  }

  if (
    application.termMonths < definition.minTermMonths ||
    application.termMonths > definition.maxTermMonths
  ) {
    codes.push('TERM_OUTSIDE_PRODUCT_LIMITS');
  }

  if (application.monthlyIncomeMinor < policy.eligibility.minMonthlyIncomeMinor) {
    codes.push('INCOME_BELOW_MINIMUM');
  }

  if (codes.length === 0) return null;
  return { verdict: 'DECLINED', stage: 'S1', reasonCodes: discloseReasonCodes(codes, null, policy) };
};

const terminal = (
  verdict: Verdict,
  stage: DecisionStage,
  codes: readonly string[],
  policy: Policy,
  scorecard: Scorecard | null,
  dti: number | null = null,
): PreDecision => ({
  verdict,
  stage,
  reasonCodes: discloseReasonCodes(codes, scorecard, policy),
  approvedAmountMinor: null,
  monthlyPaymentMinor: null,
  offerExpiresAt: null,
  score: scorecard?.total ?? null,
  dti,
  scorecard,
});

/** D2. Every knockout that applies is disclosed, for the same reason S1 discloses all of its own. */
const bureauKnockouts = (report: BureauReport, policy: Policy): readonly string[] => {
  const codes: string[] = [];

  if (policy.knockouts.activeDelinquency && report.hasActiveDelinquency) codes.push('ACTIVE_DELINQUENCY');

  // `null` here means "none on file" — a fact the bureau reported, not a gap.
  // The distinction is load-bearing: treating null as 0 months would decline
  // every applicant who has never been bankrupt.
  if (report.monthsSinceBankruptcy !== null && report.monthsSinceBankruptcy <= policy.knockouts.bankruptcyWithinMonths) {
    codes.push('BANKRUPTCY_ON_FILE');
  }
  if (report.monthsSinceChargeOff !== null && report.monthsSinceChargeOff <= policy.knockouts.chargeOffWithinMonths) {
    codes.push('CHARGE_OFF_ON_FILE');
  }

  return codes;
};

/** D4. Referral triggers, all of them, before any score band is consulted. */
const referralTriggers = (
  application: EngineApplication,
  report: BureauReport,
  policy: Policy,
  definition: PolicyProduct,
): readonly string[] => {
  const codes: string[] = [];

  // Present by D1's guarantee; the checks keep the compiler honest without a cast.
  const oldest = report.oldestAccountAgeMonths;
  const accounts = report.totalAccounts;
  if (
    (oldest !== undefined && oldest < policy.thinFile.minOldestAccountMonths) ||
    (accounts !== undefined && accounts < policy.thinFile.minTotalAccounts)
  ) {
    codes.push('THIN_FILE');
  }

  if (!report.subjectMatch.nameMatches || !report.subjectMatch.dateOfBirthMatches) {
    codes.push('IDENTITY_MISMATCH');
  }

  if (application.requestedAmountMinor > definition.autoApproveCeilingMinor) {
    codes.push('AMOUNT_ABOVE_AUTO_LIMIT');
  }

  return codes;
};

export const decide = (
  application: EngineApplication,
  lookup: BureauLookup,
  policy: Policy,
  now: Date,
): PreDecision => {
  const definition = product(application, policy);

  // ---------------------------------------------------------------- D1
  // Three outcomes that are not interchangeable. A rejection caused by our own
  // infrastructure is one we could not justify to the applicant, and under ECOA
  // justifying it is an obligation; "no file" is an absence of evidence rather
  // than evidence of bad credit, and a first-time borrower is a population a
  // lender wants. Collapsing the two — the single most tempting simplification
  // here, since both arrive as "no report" — tells a genuine first-time borrower
  // that our vendor was down.
  if (lookup.outcome === 'UNAVAILABLE') return terminal('MANUAL_REVIEW', 'D1', ['BUREAU_UNAVAILABLE'], policy, null);
  if (lookup.outcome === 'NO_HIT') return terminal('MANUAL_REVIEW', 'D1', ['NO_CREDIT_FILE'], policy, null);

  const report = lookup.report;
  if (missingInputs(report, policy).length > 0) {
    // Scoring the gap as zero would decline a person for OUR data defect.
    return terminal('MANUAL_REVIEW', 'D1', ['BUREAU_DATA_INCOMPLETE'], policy, null);
  }

  // ---------------------------------------------------------------- D2
  const knockouts = bureauKnockouts(report, policy);
  // Terminates before D3, so `score` stays null on a bankruptcy decline even
  // though bureau data was available — which is why docs/08 §4 omits
  // RECENT_BANKRUPTCY from its score table.
  if (knockouts.length > 0) return terminal('DECLINED', 'D2', knockouts, policy, null);

  // ---------------------------------------------------------------- D3
  // Computed for everything that reaches here, and terminal for nothing. The
  // points are evidence worth recording even when a later rule decides.
  const scorecard = score(report, policy);

  // ---------------------------------------------------------------- D4
  // Ahead of both score bands on purpose. A thin file or an identity mismatch
  // means the score is not trustworthy, so it must outrank a number derived from
  // the same report. Put the score first and a thin-file applicant scoring 73
  // with a DTI over the limit satisfies two rules at once with nothing to break
  // the tie.
  const referrals = referralTriggers(application, report, policy, definition);
  if (referrals.length > 0) return terminal('MANUAL_REVIEW', 'D4', referrals, policy, scorecard);

  // ------------------------------------------------------------- D5, D6
  // No "your score was too low" code, deliberately: the score is not a reason,
  // it is the sum of the reasons, and Regulation B asks for the factors. A
  // decline here discloses the factors that lost the most points.
  if (scorecard.total < policy.bands.referralFrom) return terminal('DECLINED', 'D5', [], policy, scorecard);
  if (scorecard.total < policy.bands.autoApproveFrom) {
    return terminal('MANUAL_REVIEW', 'D6', ['SCORE_IN_REFERRAL_BAND'], policy, scorecard);
  }

  // ---------------------------------------------------------------- D7
  // Last and terminal. Nothing runs after affordability.
  //
  // Obligations come from the bureau when present and fall back to the declared
  // figure otherwise: the bureau sees obligations an applicant may forget or omit.
  const obligations = report.monthlyObligationsMinor ?? application.declaredMonthlyObligationsMinor;
  const payment = annuityPaymentMinor(application.requestedAmountMinor, application.termMonths, definition.annualRatePct);
  const dti = debtToIncome(obligations, payment, application.monthlyIncomeMinor);
  const limit = new Decimal(policy.affordability.maxDti);

  if (dti.lessThanOrEqualTo(limit)) {
    return {
      verdict: 'APPROVED',
      stage: 'D7',
      // Empty for a clean file approved on the terms applied for. Not adverse
      // action, no reasons owed, and an invented code would be an unfalsifiable
      // statement inside a record built to be replayed (ADR-0010).
      reasonCodes: discloseReasonCodes([], scorecard, policy),
      approvedAmountMinor: application.requestedAmountMinor,
      monthlyPaymentMinor: payment,
      offerExpiresAt: addDays(now, policy.offer.validityDays),
      score: scorecard.total,
      dti: dti.toNumber(),
      scorecard,
    };
  }

  // A lender rarely says "no" when it can say "yes, but less".
  if (policy.affordability.counterOfferEnabled) {
    const headroom = limit.times(application.monthlyIncomeMinor).minus(obligations);
    const principal = maxPrincipalForPaymentMinor(
      headroom,
      application.termMonths,
      definition.annualRatePct,
      policy.affordability.counterOfferRoundingMinor,
    );

    if (principal >= definition.minAmountMinor) {
      const reducedPayment = annuityPaymentMinor(principal, application.termMonths, definition.annualRatePct);
      return {
        verdict: 'APPROVED',
        stage: 'D7',
        // A counteroffer becomes adverse action the moment the applicant
        // declines it, so the reasons are supplied up front rather than only if
        // they say no (docs/03 §2, and the constraint in migration 002).
        reasonCodes: discloseReasonCodes(['AMOUNT_REDUCED_TO_FIT_DTI'], scorecard, policy),
        approvedAmountMinor: principal,
        monthlyPaymentMinor: reducedPayment,
        offerExpiresAt: addDays(now, policy.offer.validityDays),
        score: scorecard.total,
        dti: debtToIncome(obligations, reducedPayment, application.monthlyIncomeMinor).toNumber(),
        scorecard,
      };
    }
  }

  return terminal('DECLINED', 'D7', ['DTI_ABOVE_LIMIT'], policy, scorecard, dti.toNumber());
};
