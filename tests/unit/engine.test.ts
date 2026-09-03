import { beforeAll, describe, expect, it } from 'vitest';
import { decide, screen, UnknownProductError, type PreDecision } from '../../src/domain/engine.js';
import type { Policy } from '../../src/domain/policy.js';
import { createFilePolicyStore } from '../../src/policy/loader.js';
import { NOW, application, found, noHit, reportFrom, unavailable } from '../support/engine-fixtures.js';

/**
 * docs/07-testing.md §3. Not coverage — a list of proven properties, each
 * answering "what breaks in production if this is missing".
 *
 * Every case runs against the SHIPPED policy file rather than a fixture policy,
 * so a threshold edited by a risk owner fails these tests rather than silently
 * changing what the documents promise.
 */

let policy: Policy;
beforeAll(async () => {
  policy = await createFilePolicyStore('./policies').get('2026.09.1');
});

const run = (app = application(), lookup = found('CLEAN_MODERATE')): PreDecision =>
  decide(app, lookup, policy, NOW);

describe('S1 — the knockouts that cost no enquiry', () => {
  it('lets a clean application through', () => {
    expect(screen(application(), policy, NOW)).toBeNull();
  });

  it.each([
    ['a minor', { dateOfBirth: '2014-01-01' }, 'AGE_BELOW_MINIMUM'],
    ['too old at the final instalment', { dateOfBirth: '1949-01-01' }, 'AGE_ABOVE_MAXIMUM_AT_MATURITY'],
    ['more than the product allows', { requestedAmountMinor: 9_000_000 }, 'AMOUNT_OUTSIDE_PRODUCT_LIMITS'],
    ['less than the product allows', { requestedAmountMinor: 100 }, 'AMOUNT_OUTSIDE_PRODUCT_LIMITS'],
    ['a term past the maximum', { termMonths: 84 }, 'TERM_OUTSIDE_PRODUCT_LIMITS'],
    ['income below the floor', { monthlyIncomeMinor: 100_000 }, 'INCOME_BELOW_MINIMUM'],
  ])('declines %s', (_label, overrides, code) => {
    const knockout = screen(application(overrides), policy, NOW);
    expect(knockout?.verdict).toBe('DECLINED');
    expect(knockout?.reasonCodes).toContain(code);
  });

  it('discloses every knockout that applies, not just the first', () => {
    // Telling an applicant one problem, watching them fix it and then telling
    // them the next is a worse experience and a worse adverse action notice.
    const knockout = screen(application({ requestedAmountMinor: 9_000_000, termMonths: 84 }), policy, NOW);
    expect(knockout?.reasonCodes).toEqual(
      expect.arrayContaining(['AMOUNT_OUTSIDE_PRODUCT_LIMITS', 'TERM_OUTSIDE_PRODUCT_LIMITS']),
    );
  });

  it('turns 18 on the birthday and not the day before', () => {
    const eighteenth = application({ dateOfBirth: '2008-09-02' });
    expect(screen(eighteenth, policy, new Date('2026-09-01T00:00:00Z'))?.reasonCodes).toContain('AGE_BELOW_MINIMUM');
    expect(screen(eighteenth, policy, new Date('2026-09-02T00:00:00Z'))).toBeNull();
  });

  it('refuses a product the policy does not define rather than declining it', () => {
    // A decline would create an application and an audit trail for a product
    // that does not exist. This is a malformed request, caught at the edge.
    expect(() => screen(application({ productCode: 'NOPE' }), policy, NOW)).toThrow(UnknownProductError);
  });
});

describe('D1 — three outcomes that are not interchangeable', () => {
  it('refers an unavailable bureau rather than declining', () => {
    const result = run(application(), unavailable());
    expect(result).toMatchObject({ verdict: 'MANUAL_REVIEW', stage: 'D1', reasonCodes: ['BUREAU_UNAVAILABLE'] });
    expect(result.score).toBeNull();
  });

  it('refers a no-hit as NO_CREDIT_FILE, never as an outage', () => {
    // Conflating these tells a genuine first-time borrower that our vendor was
    // down. Different fact, different code, different follow-up.
    expect(run(application(), noHit())).toMatchObject({
      verdict: 'MANUAL_REVIEW',
      stage: 'D1',
      reasonCodes: ['NO_CREDIT_FILE'],
    });
  });

  it('refers an incomplete report rather than scoring the gap as zero', () => {
    // Scoring a missing attribute as zero declines a person for OUR data defect.
    const gap = found('PRIME', { revolvingUtilizationPct: undefined });
    expect(run(application(), gap)).toMatchObject({
      verdict: 'MANUAL_REVIEW',
      stage: 'D1',
      reasonCodes: ['BUREAU_DATA_INCOMPLETE'],
    });
  });

  it('treats a missing thin-file input as incomplete too', () => {
    const gap = found('PRIME', { totalAccounts: undefined });
    expect(run(application(), gap).reasonCodes).toEqual(['BUREAU_DATA_INCOMPLETE']);
  });

  it.each([
    ['hasActiveDelinquency'],
    ['monthsSinceBankruptcy'],
    ['monthsSinceChargeOff'],
    ['subjectMatch'],
  ] as const)('refers rather than approving when %s is missing', (attribute) => {
    // The gate used to cover only the scorecard and thin-file inputs, so it
    // protected the applicant from being scored on our data gap and did nothing
    // in the other direction: a report without `hasActiveDelinquency` skipped
    // D2 entirely and was APPROVED, and one without `subjectMatch` threw a
    // TypeError on the way to D4. The mock always populates these, so only a
    // real provider omitting a section would ever have found it.
    const gap = found('PRIME', { [attribute]: undefined });
    expect(run(application(), gap)).toMatchObject({
      verdict: 'MANUAL_REVIEW',
      stage: 'D1',
      reasonCodes: ['BUREAU_DATA_INCOMPLETE'],
    });
  });

  it('does not confuse "no bankruptcy on file" with "we were not told"', () => {
    // null is a fact the bureau reported; undefined is our gap. Two absences,
    // two types, two verdicts.
    expect(run(application(), found('PRIME', { monthsSinceBankruptcy: null })).verdict).not.toBe('MANUAL_REVIEW');
  });

  it('refers on a subjectMatch that is present but half-filled', () => {
    const gap = found('PRIME', { subjectMatch: { nameMatches: true } as never });
    expect(run(application(), gap).reasonCodes).toEqual(['BUREAU_DATA_INCOMPLETE']);
  });

  it('does not treat missing obligations as incomplete, because D7 falls back', () => {
    const noObligations = found('PRIME', { monthlyObligationsMinor: undefined });
    expect(run(application({ requestedAmountMinor: 1_800_000, termMonths: 36 }), noObligations).verdict).toBe('APPROVED');
  });
});

describe('D2 — the knockouts that end it before the scorecard runs', () => {
  it('declines a recent bankruptcy and records no score', () => {
    const result = run(application(), found('RECENT_BANKRUPTCY'));
    expect(result).toMatchObject({ verdict: 'DECLINED', stage: 'D2', reasonCodes: ['BANKRUPTCY_ON_FILE'] });
    expect(result.score).toBeNull();
    expect(result.scorecard).toBeNull();
  });

  it('declines an active delinquency', () => {
    expect(run(application(), found('PRIME', { hasActiveDelinquency: true })).reasonCodes).toContain('ACTIVE_DELINQUENCY');
  });

  it('declines a recent charge-off', () => {
    expect(run(application(), found('PRIME', { monthsSinceChargeOff: 6 })).reasonCodes).toContain('CHARGE_OFF_ON_FILE');
  });

  it('does not knock out a cured delinquency', () => {
    // ADVERSE_HISTORY carries DPD_90_PLUS with hasActiveDelinquency false. If
    // the two attributes were collapsed this applicant would end here and the
    // scorecard would never be exercised by a documented example.
    const result = run(application(), found('ADVERSE_HISTORY'));
    expect(result.stage).not.toBe('D2');
    expect(result.score).toBe(22);
  });

  it('does not read "no bankruptcy on file" as a bankruptcy zero months ago', () => {
    expect(run(application(), found('PRIME')).reasonCodes).not.toContain('BANKRUPTCY_ON_FILE');
  });
});

describe('D3 — the scorecard reproduces the documented table', () => {
  it.each([
    ['CLEAN_MODERATE', 75],
    ['ADVERSE_HISTORY', 22],
    ['PRIME', 100],
    ['REFERRAL_BAND', 59],
    ['THIN', 73],
    ['NAME_MISMATCH', 94],
  ] as const)('%s scores %i', (profile, total) => {
    expect(run(application(), found(profile)).score).toBe(total);
  });

  it('awards the worked example exactly as docs/03 §5 sets it out', () => {
    const awards = run().scorecard?.awards ?? [];
    expect(awards.map((a) => [a.factorId, a.awarded, a.pointsLost])).toEqual([
      ['PAYMENT_HISTORY', 35, 0],
      ['UTILIZATION', 18, 12],
      ['HISTORY_LENGTH', 12, 3],
      ['RECENT_INQUIRIES', 6, 4],
      ['CREDIT_MIX', 4, 6],
    ]);
  });

  it('evaluates bands first-match-wins, so order in the file is meaningful', () => {
    // 30% utilisation sits on a boundary: `lt: 30` must not match and `lt: 50`
    // must. Under last-match the same file would award 0.
    const at30 = run(application(), found('PRIME', { revolvingUtilizationPct: 30 }));
    const at29 = run(application(), found('PRIME', { revolvingUtilizationPct: 29 }));
    const utilisation = (result: PreDecision): number | undefined =>
      result.scorecard?.awards.find((a) => a.factorId === 'UTILIZATION')?.awarded;
    expect(utilisation(at30)).toBe(18);
    expect(utilisation(at29)).toBe(26);
  });
});

describe('precedence — the orderings that would otherwise be undefined', () => {
  it('refers a thin file even though its score clears the referral band', () => {
    // THIN scores 73, which is above autoApproveFrom. If D4 did not outrank D5
    // and D6 this applicant would be auto-approved on a file with one account.
    const result = run(application({ requestedAmountMinor: 1_800_000, termMonths: 36 }), found('THIN'));
    expect(result).toMatchObject({ verdict: 'MANUAL_REVIEW', stage: 'D4' });
    expect(result.reasonCodes).toContain('THIN_FILE');
    expect(result.score).toBe(73);
  });

  it('refers an identity mismatch even at a score of 94', () => {
    const result = run(application({ requestedAmountMinor: 1_800_000, termMonths: 36 }), found('NAME_MISMATCH'));
    expect(result).toMatchObject({ verdict: 'MANUAL_REVIEW', stage: 'D4' });
    expect(result.reasonCodes).toContain('IDENTITY_MISMATCH');
  });

  it('refers an amount above the auto-approve ceiling', () => {
    const result = run(application({ requestedAmountMinor: 4_000_000 }), found('PRIME'));
    expect(result.reasonCodes).toContain('AMOUNT_ABOVE_AUTO_LIMIT');
    expect(result.stage).toBe('D4');
  });

  it('declines below the referral floor without a "score too low" code', () => {
    // The score is not a reason, it is the sum of the reasons. Regulation B asks
    // for the factors, and a code for the total would be exactly the
    // hand-curated reason ADR-0004 rejects.
    const result = run(application(), found('ADVERSE_HISTORY'));
    expect(result).toMatchObject({ verdict: 'DECLINED', stage: 'D5' });
    expect(result.reasonCodes).not.toContain('SCORE_IN_REFERRAL_BAND');
    expect(result.reasonCodes).toContain('PAYMENT_HISTORY_ADVERSE');
  });

  it('refers inside the band', () => {
    const result = run(application({ requestedAmountMinor: 1_800_000, termMonths: 36 }), found('REFERRAL_BAND'));
    expect(result).toMatchObject({ verdict: 'MANUAL_REVIEW', stage: 'D6' });
    expect(result.reasonCodes).toContain('SCORE_IN_REFERRAL_BAND');
  });
});

describe('D7 — affordability, and the counter-offer', () => {
  it('reproduces the worked example to the minor unit', () => {
    // docs/03 §5 and docs/05 §3.2: $26,900 of $32,000, payment $720.33, DTI 43.0%.
    expect(run()).toMatchObject({
      verdict: 'APPROVED',
      stage: 'D7',
      approvedAmountMinor: 2_690_000,
      monthlyPaymentMinor: 72_033,
      dti: 0.4297,
      score: 75,
      reasonCodes: ['AMOUNT_REDUCED_TO_FIT_DTI', 'CREDIT_UTILIZATION_TOO_HIGH', 'LIMITED_CREDIT_MIX'],
    });
  });

  it('approves a clean file in full, with no reason codes at all', () => {
    // ADR-0010, and the exact request published as docs/05-api.md §3.1: PRIME at
    // $18,000 over 36 months on $6,200 a month. Nothing lost five points and no
    // counter-offer, so there is nothing to disclose and nothing is owed.
    const result = run(
      application({
        requestedAmountMinor: 1_800_000,
        termMonths: 36,
        dateOfBirth: '1988-02-19',
        monthlyIncomeMinor: 620_000,
        declaredMonthlyObligationsMinor: 90_000,
      }),
      found('PRIME'),
    );
    expect(result).toMatchObject({
      verdict: 'APPROVED',
      stage: 'D7',
      approvedAmountMinor: 1_800_000,
      monthlyPaymentMinor: 60_562,
      score: 100,
      reasonCodes: [],
    });
    expect(result.dti).toBeCloseTo(0.2428, 4);
  });

  it('sets an offer expiry from the policy and from `now`, never from a clock', () => {
    const result = run(application({ requestedAmountMinor: 1_800_000, termMonths: 36 }), found('PRIME'));
    expect(result.offerExpiresAt?.toISOString()).toBe('2026-10-02T09:14:22.418Z');
  });

  it('declines when even the smallest affordable principal is below the product minimum', () => {
    const stretched = application({ monthlyIncomeMinor: 210_000, requestedAmountMinor: 3_200_000 });
    const result = run(stretched, found('CLEAN_MODERATE'));
    expect(result).toMatchObject({ verdict: 'DECLINED', stage: 'D7' });
    expect(result.reasonCodes).toContain('DTI_ABOVE_LIMIT');
  });

  it('never counter-offers above the DTI limit it was computed to satisfy', () => {
    // The reason the reverse solve rounds DOWN. Rounding up by a dollar puts the
    // offer back over the limit that produced it.
    for (const income of [400_000, 460_000, 520_000, 580_000, 640_000]) {
      const result = run(application({ monthlyIncomeMinor: income }), found('CLEAN_MODERATE'));
      if (result.verdict === 'APPROVED' && result.dti !== null) {
        expect(result.dti, `income ${String(income)}`).toBeLessThanOrEqual(policy.affordability.maxDti);
      }
    }
  });

  it('prefers the bureau\'s obligations over the declared ones', () => {
    // The bureau sees obligations an applicant may forget or omit. Understating
    // them must not buy a larger loan.
    const understated = application({ declaredMonthlyObligationsMinor: 0 });
    expect(run(understated, found('CLEAN_MODERATE')).approvedAmountMinor).toBe(2_690_000);
  });
});

describe('reason codes', () => {
  it('leads with the decisive code, then orders scorecard factors by points lost', () => {
    const result = run();
    expect(result.reasonCodes[0]).toBe('AMOUNT_REDUCED_TO_FIT_DTI');
    expect(result.reasonCodes.slice(1)).toEqual(['CREDIT_UTILIZATION_TOO_HIGH', 'LIMITED_CREDIT_MIX']);
  });

  it('drops factors that lost fewer than the material threshold', () => {
    // History length lost 3 and new credit lost 4 in the worked example. The
    // applicant gets the reasons that moved the outcome, not a list of
    // everything imperfect about their file.
    expect(run().reasonCodes).not.toContain('INSUFFICIENT_CREDIT_HISTORY_LENGTH');
    expect(run().reasonCodes).not.toContain('TOO_MANY_RECENT_INQUIRIES');
  });

  it('never discloses more than the policy cap', () => {
    // The claim "and the database agrees" used to be here, asserted twice
    // against the same in-memory array and never against a database. The
    // constraint is proven where it lives, in tests/integration/schema.test.ts;
    // this proves only what a unit test can.
    const result = run(application(), found('ADVERSE_HISTORY'));
    expect(result.reasonCodes.length).toBeLessThanOrEqual(policy.reasonCodes.maxDisclosed);
  });

  it('gives every verdict except a full approval at least one reason', () => {
    // The other half of migration 002's constraint, proven in the engine so the
    // INSERT never has to be the thing that discovers it.
    const cases: PreDecision[] = [
      run(application(), unavailable()),
      run(application(), noHit()),
      run(application(), found('RECENT_BANKRUPTCY')),
      run(application(), found('ADVERSE_HISTORY')),
      run(application({ requestedAmountMinor: 1_800_000, termMonths: 36 }), found('REFERRAL_BAND')),
      run(application({ requestedAmountMinor: 1_800_000, termMonths: 36 }), found('THIN')),
    ];
    for (const result of cases) {
      expect(result.reasonCodes.length, result.stage).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('the engine is a function of its arguments', () => {
  it('returns the same verdict for the same inputs', () => {
    expect(run()).toEqual(run());
  });

  it('moves the offer expiry when `now` moves, and nothing else', () => {
    const app = application({ requestedAmountMinor: 1_800_000, termMonths: 36 });
    const later = decide(app, found('PRIME'), policy, new Date('2027-01-01T00:00:00Z'));
    const earlier = decide(app, found('PRIME'), policy, NOW);
    expect(later.verdict).toBe(earlier.verdict);
    expect(later.score).toBe(earlier.score);
    expect(later.offerExpiresAt).not.toEqual(earlier.offerExpiresAt);
  });

  it('does not mutate the report it was given', () => {
    const report = reportFrom('CLEAN_MODERATE');
    const before = JSON.stringify(report);
    decide(application(), { outcome: 'FOUND', report }, policy, NOW);
    expect(JSON.stringify(report)).toBe(before);
  });
});
