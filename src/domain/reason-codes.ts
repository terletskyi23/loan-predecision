import type { Policy } from './policy.js';
import type { Scorecard } from './scorecard.js';

/**
 * Which reasons are disclosed, and in what order. docs/03 §3.
 *
 * WHY THIS IS DERIVED RATHER THAN HAND-PICKED. Regulation B's official
 * commentary describes acceptable methods for choosing the principal reasons in
 * a credit-scoring system: the factors on which the applicant's score fell
 * furthest below the average of applicants who barely qualified, below the
 * average of all applicants — or "any other method that produces results
 * substantially similar". Ranking by points lost against each factor's maximum
 * is that third option in its simplest form. The same commentary is where the
 * cap of four comes from: disclosing more is unlikely to help the applicant.
 *
 * The honest limitation, recorded rather than papered over: a production system
 * would calibrate against the observed population of marginally-approved
 * applicants rather than against each factor's theoretical maximum. That needs
 * data this service does not have.
 */

/**
 * Deterministic, and every level of the ordering earns its place:
 *
 *   1. Decisive and referral codes first, in `reasonCodes.registry` order —
 *      which is why the registry is an ordered list in the policy file and not a
 *      set. The code that actually determined the verdict leads.
 *   2. Then scorecard factors by points lost, descending. The applicant hears
 *      what moved the outcome most.
 *   3. Ties broken alphabetically by code, so two factors losing the same points
 *      do not swap places between runs and make the audit unstable.
 *
 * Same inputs, same list, forever — which is what makes replay comparable and
 * the tests meaningful.
 */
export const discloseReasonCodes = (
  decisive: readonly string[],
  scorecard: Scorecard | null,
  policy: Policy,
): readonly string[] => {
  const order = new Map(policy.reasonCodes.registry.map((entry, index) => [entry.code, index]));
  const rank = (code: string): number => order.get(code) ?? Number.MAX_SAFE_INTEGER;

  const leading = [...new Set(decisive)].sort((a, b) => rank(a) - rank(b));

  const material = (scorecard?.awards ?? [])
    .filter((entry) => entry.pointsLost >= policy.reasonCodes.materialPointsLost)
    .sort((a, b) => b.pointsLost - a.pointsLost || a.reasonCode.localeCompare(b.reasonCode))
    .map((entry) => entry.reasonCode);

  return [...new Set([...leading, ...material])].slice(0, policy.reasonCodes.maxDisclosed);
};
