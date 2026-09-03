import { z } from 'zod';

/**
 * The shape of `policies/<version>.json`, and the validator that decides whether
 * a file is a policy at all.
 *
 * WHY THE SCHEMA LIVES IN THE DOMAIN AND THE LOADER DOES NOT. The engine
 * receives a `Policy` as an argument and may import nothing (ADR-0008), so the
 * type has to be defined here. Reading a file is I/O and lives in
 * `src/policy/loader.ts`, which imports this. `zod` is pure: no clock, no
 * filesystem, no network — it validates a value that is already in memory.
 *
 * WHY THE CHECKS BELOW ARE WORTH THEIR LENGTH. The next policy version is
 * written by a risk owner, not by the author of the evaluator (docs/03 §3). A
 * file that is well-formed JSON but incoherent — bands that award more than the
 * factor's maximum, a referral floor above the auto-approve floor, a scorecard
 * whose factors do not add up to 100 — would parse, boot, serve, and then
 * produce a wrong decision on a real application. Every refinement here turns
 * one of those into a failed boot, which is the same discipline `src/config.ts`
 * applies to the environment: a misconfiguration is a failed deploy, not a
 * service answering requests incorrectly.
 */

const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().min(0);

/**
 * A band awards points when its predicate holds. Exactly one predicate, because
 * `{ "gte": 48, "lt": 84 }` reads as a range and is not one — the evaluator is
 * `FIRST_MATCH_WINS` over an ordered list, so a second predicate would be
 * silently ignored and the file would not mean what its author intended.
 */
const bandSchema = z
  .object({
    lt: z.number().optional(),
    lte: z.number().optional(),
    gte: z.number().optional(),
    eq: z.union([z.number(), z.string()]).optional(),
    points: nonNegativeInt,
  })
  .superRefine((band, ctx) => {
    const present = (['lt', 'lte', 'gte', 'eq'] as const).filter((key) => band[key] !== undefined);
    if (present.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          present.length === 0
            ? 'a band needs exactly one of lt, lte, gte or eq; this one has none and can never match'
            : `a band needs exactly one of lt, lte, gte or eq; this one has ${present.join(', ')}. ` +
              'Bands are evaluated FIRST_MATCH_WINS in file order, so a range is written as two bands, not one.',
      });
    }
  });

const factorSchema = z
  .object({
    id: z.string().min(1),
    maxPoints: positiveInt,
    reasonCode: z.string().min(1),
    input: z.string().min(1),
    bands: z.array(bandSchema).min(1),
    /**
     * Awarded when no band matches. Unreachable in a file whose bands are
     * exhaustive — which `2026.09.1` happens to be — and specified anyway,
     * because totality is a property of one file rather than of the format
     * (docs/03 §2).
     */
    default: nonNegativeInt,
  })
  .superRefine((factor, ctx) => {
    for (const [index, band] of factor.bands.entries()) {
      if (band.points > factor.maxPoints) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['bands', index, 'points'],
          message: `awards ${band.points} of a ${factor.maxPoints}-point factor. Points lost would go negative and the reason-code ranking would invert.`,
        });
      }
    }
    if (factor.default > factor.maxPoints) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['default'],
        message: `awards ${factor.default} of a ${factor.maxPoints}-point factor.`,
      });
    }
  });

const scorecardSchema = z
  .object({
    maxPoints: positiveInt,
    /** The only supported semantics, and it is stated in the file so the file cannot be read two ways. */
    bandEvaluation: z.literal('FIRST_MATCH_WINS'),
    /** D1's completeness gate reads exactly this list. */
    requiredInputs: z.array(z.string().min(1)).min(1),
    factors: z.array(factorSchema).min(1),
  })
  .superRefine((scorecard, ctx) => {
    const total = scorecard.factors.reduce((sum, factor) => sum + factor.maxPoints, 0);
    if (total !== scorecard.maxPoints) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxPoints'],
        message:
          `the factors add up to ${total}, not ${scorecard.maxPoints}. Every band threshold and both ` +
          'score bands are expressed against this total, so the two disagreeing moves every verdict.',
      });
    }

    const ids = new Set<string>();
    for (const [index, factor] of scorecard.factors.entries()) {
      if (ids.has(factor.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['factors', index, 'id'], message: `duplicate factor id ${factor.id}` });
      }
      ids.add(factor.id);

      // A factor scored from an input D1 does not require is a factor that can
      // silently fall through to `default` on a report with a gap in it — which
      // is scoring our own data defect, the thing docs/03 §2 forbids.
      if (!scorecard.requiredInputs.includes(factor.input)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['factors', index, 'input'],
          message:
            `${factor.input} is scored but not listed in requiredInputs, so a report missing it would ` +
            'be scored rather than referred as BUREAU_DATA_INCOMPLETE.',
        });
      }
    }
  });

const registryEntrySchema = z.object({
  code: z.string().min(1),
  class: z.enum(['KNOCKOUT_ELIGIBILITY', 'KNOCKOUT_BUREAU', 'SCORECARD', 'DECISIVE', 'REFERRAL']),
  stage: z.enum(['SCREEN', 'DECIDE', 'AFFORDABILITY', 'SCORECARD', 'REFERRAL']),
  verdict: z.enum(['APPROVED', 'DECLINED', 'MANUAL_REVIEW', 'ANY']),
});

const productSchema = z
  .object({
    displayName: z.string().min(1),
    minAmountMinor: positiveInt,
    maxAmountMinor: positiveInt,
    minTermMonths: positiveInt,
    maxTermMonths: positiveInt,
    annualRatePct: z.number().min(0),
    autoApproveCeilingMinor: positiveInt,
  })
  .superRefine((product, ctx) => {
    if (product.minAmountMinor > product.maxAmountMinor) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['minAmountMinor'], message: 'exceeds maxAmountMinor: no amount is acceptable and every application is declined at S1.' });
    }
    if (product.minTermMonths > product.maxTermMonths) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['minTermMonths'], message: 'exceeds maxTermMonths.' });
    }
    if (product.autoApproveCeilingMinor < product.minAmountMinor) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['autoApproveCeilingMinor'],
        message: 'is below the product minimum, so every application is referred as AMOUNT_ABOVE_AUTO_LIMIT and nothing is ever approved automatically.',
      });
    }
  });

export const policySchema = z
  .object({
    version: z.string().min(1),
    effectiveFrom: z.string().min(1),
    currency: z.string().length(3),
    notes: z.string().optional(),

    products: z.record(z.string(), productSchema),

    consent: z.object({
      maxAgeHours: positiveInt,
      allowedFutureSkewSeconds: nonNegativeInt,
    }),

    eligibility: z.object({
      minAge: positiveInt,
      maxAgeAtMaturity: positiveInt,
      minMonthlyIncomeMinor: nonNegativeInt,
    }),

    knockouts: z.object({
      activeDelinquency: z.boolean(),
      bankruptcyWithinMonths: nonNegativeInt,
      chargeOffWithinMonths: nonNegativeInt,
    }),

    affordability: z.object({
      maxDti: z.number().gt(0).lt(1),
      counterOfferEnabled: z.boolean(),
      counterOfferRoundingMinor: positiveInt,
    }),

    thinFile: z.object({
      minOldestAccountMonths: nonNegativeInt,
      minTotalAccounts: nonNegativeInt,
      inputs: z.array(z.string().min(1)).min(1),
    }),

    scorecard: scorecardSchema,

    bands: z.object({
      autoApproveFrom: nonNegativeInt,
      referralFrom: nonNegativeInt,
    }),

    reasonCodes: z.object({
      /**
       * Four is Regulation B's guidance and also the ceiling
       * `pre_decisions_reason_codes_capped` enforces. A policy asking for more
       * would produce rows the database refuses — at decision time, on a real
       * application. Failing at boot is the cheaper place to find out.
       */
      maxDisclosed: z.number().int().min(1).max(4),
      materialPointsLost: nonNegativeInt,
      /** Ordered, not a set: this order is the first tie-break in docs/03 §3. */
      registry: z.array(registryEntrySchema).min(1),
    }),

    offer: z.object({ validityDays: positiveInt }),
  })
  .superRefine((policy, ctx) => {
    if (Object.keys(policy.products).length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['products'], message: 'a policy with no products can decide nothing.' });
    }

    if (policy.eligibility.minAge >= policy.eligibility.maxAgeAtMaturity) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['eligibility', 'maxAgeAtMaturity'], message: 'is at or below minAge: no applicant can pass both knockouts.' });
    }

    if (policy.bands.referralFrom >= policy.bands.autoApproveFrom) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bands', 'referralFrom'],
        message: 'is at or above autoApproveFrom, which leaves D6 with an empty band and makes MANUAL_REVIEW by score unreachable.',
      });
    }
    if (policy.bands.autoApproveFrom > policy.scorecard.maxPoints) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bands', 'autoApproveFrom'], message: `is above the maximum achievable score (${policy.scorecard.maxPoints}): nothing is ever auto-approved.` });
    }

    const codes = new Set<string>();
    for (const [index, entry] of policy.reasonCodes.registry.entries()) {
      if (codes.has(entry.code)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reasonCodes', 'registry', index, 'code'], message: `duplicate code ${entry.code}; registry order is a tie-break and a duplicate makes it ambiguous.` });
      }
      codes.add(entry.code);
    }

    // Every code a factor can emit must be declared. docs/07 §7 walks the
    // registry to prove no code is unreachable; a code missing FROM the registry
    // is the same defect from the other side, and that walk would not see it.
    for (const [index, factor] of policy.scorecard.factors.entries()) {
      if (!codes.has(factor.reasonCode)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['scorecard', 'factors', index, 'reasonCode'],
          message: `${factor.reasonCode} is not in reasonCodes.registry, so it could be disclosed on a decision without ever being declared.`,
        });
      }
    }
  });

export type Policy = z.infer<typeof policySchema>;
export type PolicyProduct = Policy['products'][string];
export type ScorecardFactor = Policy['scorecard']['factors'][number];
export type ScorecardBand = ScorecardFactor['bands'][number];
export type ReasonCodeRegistryEntry = Policy['reasonCodes']['registry'][number];
