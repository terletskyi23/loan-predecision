import type { BureauReport } from './bureau-lookup.js';
import type { Policy, ScorecardBand, ScorecardFactor } from './policy.js';

/**
 * D3. Arithmetic over stored attributes, and nothing else.
 *
 * The scorecard never decides on its own. It produces evidence — points awarded
 * per factor — that later rules read and that the audit stores whether or not it
 * determined the verdict. Making it a terminal stage was what produced the
 * previous design's contradiction, where the referral band appeared in two
 * places and one of them was unreachable (docs/03 §2).
 */

export interface FactorAward {
  readonly factorId: string;
  readonly input: string;
  readonly value: string | number;
  readonly awarded: number;
  readonly maxPoints: number;
  readonly pointsLost: number;
  readonly reasonCode: string;
  /** True when no band matched and the factor's `default` was awarded. */
  readonly fellThrough: boolean;
}

export interface Scorecard {
  readonly total: number;
  readonly maxPoints: number;
  readonly awards: readonly FactorAward[];
}

/**
 * FIRST_MATCH_WINS: bands are evaluated in file order and the first whose
 * predicate holds awards its points.
 *
 * Order is therefore significant, and the policy's tables are written so that it
 * is — UTILIZATION ascends through `lt`, HISTORY_LENGTH descends through `gte`.
 * Leaving this unstated was a real defect and not a documentation nicety: with
 * mixed predicates in one array the same file evaluates differently under "first
 * match" and "last match", and boundary tests prove nothing until the rule is
 * fixed. The schema refuses a band with two predicates for the same reason.
 */
const matches = (band: ScorecardBand, value: string | number): boolean => {
  if (band.eq !== undefined) return value === band.eq;
  if (typeof value !== 'number') return false;
  if (band.lt !== undefined) return value < band.lt;
  if (band.lte !== undefined) return value <= band.lte;
  if (band.gte !== undefined) return value >= band.gte;
  return false;
};

const readInput = (report: BureauReport, input: string): string | number | undefined => {
  switch (input) {
    case 'worstDelinquencyLast24m':
      return report.worstDelinquencyLast24m;
    case 'revolvingUtilizationPct':
      return report.revolvingUtilizationPct;
    case 'oldestAccountAgeMonths':
      return report.oldestAccountAgeMonths;
    case 'hardInquiriesLast6m':
      return report.hardInquiriesLast6m;
    case 'distinctAccountTypes':
      return report.distinctAccountTypes;
    case 'totalAccounts':
      return report.totalAccounts;
    case 'monthlyObligationsMinor':
      return report.monthlyObligationsMinor;
    default:
      return undefined;
  }
};

/**
 * Which attributes must be present before a report can be scored at all.
 *
 * The union of the scorecard's inputs and the thin-file test's, because both
 * produce a verdict and neither can be evaluated on a gap. `monthlyObligations`
 * is deliberately NOT in this set: D7 falls back to the declared figure when the
 * bureau does not supply one, so its absence is handled rather than fatal.
 *
 * The set comes from the policy file rather than from a constant here, so a
 * future policy that scores a new attribute makes that attribute required
 * without anybody remembering to edit this file.
 */
export const requiredInputs = (policy: Policy): readonly string[] => [
  ...new Set([...policy.scorecard.requiredInputs, ...policy.thinFile.inputs]),
];

/** The attributes the policy requires and this report does not carry. */
export const missingInputs = (report: BureauReport, policy: Policy): readonly string[] =>
  requiredInputs(policy).filter((input) => readInput(report, input) === undefined);

const award = (factor: ScorecardFactor, value: string | number): FactorAward => {
  const band = factor.bands.find((candidate) => matches(candidate, value));
  const awarded = band?.points ?? factor.default;
  return {
    factorId: factor.id,
    input: factor.input,
    value,
    awarded,
    maxPoints: factor.maxPoints,
    pointsLost: factor.maxPoints - awarded,
    reasonCode: factor.reasonCode,
    fellThrough: band === undefined,
  };
};

/**
 * Scores a report that has already passed the completeness gate. Calling this
 * with a missing input is a programming error rather than a policy outcome —
 * `missingInputs` is D1's job and runs first — so it throws rather than scoring
 * the gap as zero, which is the mistake the whole gate exists to prevent.
 */
export const score = (report: BureauReport, policy: Policy): Scorecard => {
  const awards = policy.scorecard.factors.map((factor) => {
    const value = readInput(report, factor.input);
    if (value === undefined) {
      throw new Error(
        `scorecard input ${factor.input} is missing; D1 must reject an incomplete report as BUREAU_DATA_INCOMPLETE before scoring`,
      );
    }
    return award(factor, value);
  });

  return {
    total: awards.reduce((sum, entry) => sum + entry.awarded, 0),
    maxPoints: policy.scorecard.maxPoints,
    awards,
  };
};
