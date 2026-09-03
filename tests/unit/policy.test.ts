import { describe, expect, it } from 'vitest';
import { policySchema } from '../../src/domain/policy.js';
import { createFilePolicyStore, PolicyLoadError } from '../../src/policy/loader.js';

/**
 * The policy file is written by a risk owner, not by the author of the
 * evaluator. These tests are about the class of file that is well-formed JSON
 * and incoherent as a policy: it would parse, boot, serve, and then decide a
 * real application wrongly. Every case below is a failed boot instead.
 */

const store = createFilePolicyStore('./policies');

/** A minimal file that is valid, so each case below changes exactly one thing. */
const valid = (): Record<string, unknown> => ({
  version: 'test.1',
  effectiveFrom: '2026-01-01',
  currency: 'USD',
  products: {
    P: {
      displayName: 'P',
      minAmountMinor: 100,
      maxAmountMinor: 1000,
      minTermMonths: 6,
      maxTermMonths: 60,
      annualRatePct: 10,
      autoApproveCeilingMinor: 900,
    },
  },
  consent: { maxAgeHours: 24, allowedFutureSkewSeconds: 60 },
  eligibility: { minAge: 18, maxAgeAtMaturity: 75, minMonthlyIncomeMinor: 1000 },
  knockouts: { activeDelinquency: true, bankruptcyWithinMonths: 24, chargeOffWithinMonths: 24 },
  affordability: { maxDti: 0.43, counterOfferEnabled: true, counterOfferRoundingMinor: 100 },
  thinFile: { minOldestAccountMonths: 6, minTotalAccounts: 2, inputs: ['totalAccounts'] },
  scorecard: {
    maxPoints: 30,
    bandEvaluation: 'FIRST_MATCH_WINS',
    requiredInputs: ['revolvingUtilizationPct'],
    factors: [
      {
        id: 'UTILIZATION',
        maxPoints: 30,
        reasonCode: 'CREDIT_UTILIZATION_TOO_HIGH',
        input: 'revolvingUtilizationPct',
        bands: [{ lt: 30, points: 30 }, { gte: 30, points: 0 }],
        default: 0,
      },
    ],
  },
  bands: { autoApproveFrom: 20, referralFrom: 10 },
  reasonCodes: {
    maxDisclosed: 4,
    materialPointsLost: 5,
    registry: [{ code: 'CREDIT_UTILIZATION_TOO_HIGH', class: 'SCORECARD', stage: 'DECIDE', verdict: 'ANY' }],
  },
  offer: { validityDays: 30 },
});

/** Applies one mutation and returns the messages the schema produced. */
const reject = (mutate: (policy: Record<string, unknown>) => void): string => {
  const policy = valid();
  mutate(policy);
  const result = policySchema.safeParse(policy);
  expect(result.success, 'expected this policy to be refused, but it parsed').toBe(false);
  return result.success ? '' : result.error.issues.map((issue) => issue.message).join(' | ');
};

describe('the shipped policy', () => {
  it('parses, and is what the documents describe', async () => {
    const policy = await store.get('2026.09.1');

    expect(policy.version).toBe('2026.09.1');
    expect(policy.scorecard.bandEvaluation).toBe('FIRST_MATCH_WINS');

    // docs/03 §2: five factors on FICO's published weights, adding to 100.
    expect(policy.scorecard.factors.map((f) => f.maxPoints)).toEqual([35, 30, 15, 10, 10]);
    expect(policy.scorecard.factors.reduce((sum, f) => sum + f.maxPoints, 0)).toBe(policy.scorecard.maxPoints);

    // The cap the database also enforces (pre_decisions_reason_codes_capped).
    expect(policy.reasonCodes.maxDisclosed).toBe(4);
  });

  it('is cached rather than re-read, because a policy file is immutable', async () => {
    expect(await store.get('2026.09.1')).toBe(await store.get('2026.09.1'));
  });
});

describe('a version string is not a path', () => {
  it('refuses one that would escape the policy directory', async () => {
    await expect(store.get('../package')).rejects.toBeInstanceOf(PolicyLoadError);
  });

  it('reports a missing version as missing rather than as invalid', async () => {
    await expect(store.get('1999.01.1')).rejects.toThrow(/No policy file at/);
  });
});

describe('a file that is well-formed JSON and not a policy', () => {
  it('refuses a band with two predicates', () => {
    // FIRST_MATCH_WINS over an ordered list: { gte: 30, lt: 60 } reads as a
    // range and is not one. The second predicate would be silently ignored.
    expect(
      reject((p) => {
        const scorecard = p['scorecard'] as { factors: { bands: unknown[] }[] };
        scorecard.factors[0]!.bands[0] = { gte: 10, lt: 30, points: 30 };
      }),
    ).toMatch(/exactly one of lt, lte, gte or eq/);
  });

  it('refuses a band with no predicate at all', () => {
    expect(
      reject((p) => {
        const scorecard = p['scorecard'] as { factors: { bands: unknown[] }[] };
        scorecard.factors[0]!.bands[0] = { points: 30 };
      }),
    ).toMatch(/can never match/);
  });

  it('refuses factors that do not add up to the scorecard maximum', () => {
    expect(reject((p) => { (p['scorecard'] as { maxPoints: number }).maxPoints = 100; })).toMatch(
      /add up to 30, not 100/,
    );
  });

  it('refuses a band that awards more than its factor is worth', () => {
    expect(
      reject((p) => {
        const scorecard = p['scorecard'] as { factors: { bands: { points: number }[] }[] };
        scorecard.factors[0]!.bands[0]!.points = 45;
      }),
    ).toMatch(/awards 45 of a 30-point factor/);
  });

  it('refuses a scored input that D1 does not require', () => {
    // Otherwise a report missing that attribute falls through to `default` and
    // is scored, which declines a person for a gap in our own data.
    expect(reject((p) => { (p['scorecard'] as { requiredInputs: string[] }).requiredInputs = ['somethingElse']; })).toMatch(
      /not listed in requiredInputs/,
    );
  });

  it('refuses a referral floor at or above the auto-approve floor', () => {
    expect(reject((p) => { (p['bands'] as { referralFrom: number }).referralFrom = 20; })).toMatch(
      /makes MANUAL_REVIEW by score unreachable/,
    );
  });

  it('refuses an auto-approve floor no score can reach', () => {
    expect(reject((p) => { (p['bands'] as { autoApproveFrom: number }).autoApproveFrom = 101; })).toMatch(
      /nothing is ever auto-approved/,
    );
  });

  it('refuses a factor whose reason code is not in the registry', () => {
    expect(
      reject((p) => {
        (p['reasonCodes'] as { registry: unknown[] }).registry = [
          { code: 'SOMETHING_ELSE', class: 'SCORECARD', stage: 'DECIDE', verdict: 'ANY' },
        ];
      }),
    ).toMatch(/without ever being declared/);
  });

  it('refuses maxDisclosed above the four the database will store', () => {
    expect(reject((p) => { (p['reasonCodes'] as { maxDisclosed: number }).maxDisclosed = 6; })).toBeTruthy();
  });

  it('refuses an auto-approve ceiling below the product minimum', () => {
    expect(
      reject((p) => {
        (p['products'] as { P: { autoApproveCeilingMinor: number } }).P.autoApproveCeilingMinor = 50;
      }),
    ).toMatch(/nothing is ever approved automatically/);
  });
});
