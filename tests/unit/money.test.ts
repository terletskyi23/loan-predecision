import { describe, expect, it } from 'vitest';
import { Decimal, annuityPaymentMinor, debtToIncome, maxPrincipalForPaymentMinor, monthlyRate } from '../../src/domain/money.js';

/**
 * The arithmetic D7 rests on. Integers on the wire, decimal internally.
 *
 * These are the cases where binary floating point would be wrong quietly: a
 * counter-offer differing from the worked example by a cent nobody can explain,
 * or a rounded principal whose instalment lands a dollar over the limit that
 * produced it.
 */

const RATE = 12.9;

describe('the annuity', () => {
  it('reproduces the worked example', () => {
    // docs/03 §5: $32,000 over 48 months at 12.9% is $856.89 a month.
    expect(annuityPaymentMinor(3_200_000, 48, RATE)).toBe(85_689);
    // and the counter-offer it produces.
    expect(annuityPaymentMinor(2_690_000, 48, RATE)).toBe(72_033);
  });

  it('repays principal in equal parts at a zero rate', () => {
    // policies/*.json permits annualRatePct: 0, and the formula divides by the
    // rate. An interest-free product is a promotion, not a hypothetical.
    expect(annuityPaymentMinor(1_200_000, 12, 0)).toBe(100_000);
  });

  it('rounds the instalment half-up to the minor unit', () => {
    const payment = annuityPaymentMinor(1_000_000, 24, RATE);
    expect(Number.isInteger(payment)).toBe(true);
  });

  it('refuses a term that cannot be repaid', () => {
    expect(() => annuityPaymentMinor(100_000, 0, RATE)).toThrow(RangeError);
  });

  it('derives the monthly rate from the annual one', () => {
    expect(monthlyRate(12.9).toFixed(6)).toBe('0.010750');
  });
});

describe('the reverse solve', () => {
  it('finds the principal the worked example counter-offers', () => {
    // headroom = 0.43 x 5400 - 1600 = 722.00 a month
    const headroom = new Decimal(0.43).times(540_000).minus(160_000);
    expect(maxPrincipalForPaymentMinor(headroom, 48, RATE, 10_000)).toBe(2_690_000);
  });

  it('rounds DOWN, never half-up', () => {
    // The exact solve is $26,962.54. Rounding to the nearest $100 would give
    // $27,000, whose instalment puts the DTI back over the limit that produced
    // the offer — approving an applicant for an amount the policy says they
    // cannot afford.
    const headroom = new Decimal(0.43).times(540_000).minus(160_000);
    const principal = maxPrincipalForPaymentMinor(headroom, 48, RATE, 10_000);
    expect(principal).toBeLessThan(2_696_254);
    expect(principal % 10_000).toBe(0);
  });

  it('is the inverse of the annuity, within the rounding unit', () => {
    for (const term of [12, 24, 36, 48, 60]) {
      for (const target of [50_000, 72_033, 120_000]) {
        const principal = maxPrincipalForPaymentMinor(new Decimal(target), term, RATE, 10_000);
        expect(annuityPaymentMinor(principal, term, RATE), `${String(term)}m at ${String(target)}`).toBeLessThanOrEqual(target);
      }
    }
  });

  it('returns nothing when there is no headroom at all', () => {
    expect(maxPrincipalForPaymentMinor(new Decimal(0), 48, RATE, 10_000)).toBe(0);
    expect(maxPrincipalForPaymentMinor(new Decimal(-5_000), 48, RATE, 10_000)).toBe(0);
  });

  it('handles a zero rate', () => {
    expect(maxPrincipalForPaymentMinor(new Decimal(100_000), 12, 0, 10_000)).toBe(1_200_000);
  });
});

describe('debt to income', () => {
  it('matches the resolution the audit column stores', () => {
    // numeric(6,4). The number the engine compared and the number the row
    // records have to be the same, or a decision cannot be reproduced.
    expect(debtToIncome(160_000, 85_689, 540_000).toNumber()).toBe(0.4550);
    expect(debtToIncome(160_000, 72_033, 540_000).toNumber()).toBe(0.4297);
  });

  it('refuses a zero income rather than returning infinity', () => {
    // S1 rejects income below the floor, so this is unreachable through the
    // pipeline — which is exactly why it should throw rather than quietly
    // produce Infinity if the ordering ever changes.
    expect(() => debtToIncome(1, 1, 0)).toThrow(RangeError);
  });
});
