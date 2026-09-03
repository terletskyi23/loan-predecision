import Decimal from 'decimal.js';

/**
 * The arithmetic behind D7.
 *
 * Money is integers on the wire and a decimal internally. Binary floating point
 * is the wrong type for money not because it is imprecise in the abstract but
 * because of exactly this kind of line: `26962.539999999997` rounded down to the
 * nearest $100 is $26,900 and so is `26962.54`, until one day it is not and a
 * counter-offer differs from the worked example by a cent that nobody can
 * explain to an applicant.
 *
 * 28 significant digits, which is decimal.js's default and far more than a loan
 * needs; the point is that the rounding is stated rather than inherited from the
 * hardware.
 */
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

/** Monthly rate from an annual percentage. 12.9% -> 0.010750. */
export const monthlyRate = (annualRatePct: number): Decimal =>
  new Decimal(annualRatePct).div(100).div(12);

/**
 * The annuity factor `1 - (1 + r)^-n`, which appears in the payment formula and
 * again, inverted, in the reverse solve. Naming it once is what keeps the two
 * directions consistent: a counter-offer computed with a slightly different
 * factor than the payment it is meant to fit produces a DTI just over the limit.
 */
const annuityFactor = (rate: Decimal, termMonths: number): Decimal =>
  new Decimal(1).minus(new Decimal(1).plus(rate).pow(-termMonths));

/**
 * The monthly instalment for a principal, in minor units, rounded half-up.
 *
 * A zero rate is not a hypothetical to be ignored: `policies/*.json` allows
 * `annualRatePct: 0`, and the formula divides by the rate. An interest-free loan
 * repays principal in equal parts.
 */
export const annuityPaymentMinor = (
  principalMinor: number,
  termMonths: number,
  annualRatePct: number,
): number => {
  if (termMonths <= 0) throw new RangeError('termMonths must be positive');

  const principal = new Decimal(principalMinor);
  if (annualRatePct === 0) return principal.div(termMonths).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();

  const rate = monthlyRate(annualRatePct);
  const payment = principal.times(rate).div(annuityFactor(rate, termMonths));
  return payment.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
};

/**
 * The reverse solve: the largest principal whose instalment does not exceed
 * `maxPaymentMinor`, rounded DOWN to `roundingMinor`.
 *
 * Down, never half-up. Rounding a counter-offer up by a dollar can put the DTI
 * back over the limit it was computed to satisfy, which would make the offer
 * violate the rule that produced it — and the applicant would be approved for an
 * amount the policy says they cannot afford.
 */
export const maxPrincipalForPaymentMinor = (
  maxPaymentMinor: Decimal,
  termMonths: number,
  annualRatePct: number,
  roundingMinor: number,
): number => {
  if (termMonths <= 0) throw new RangeError('termMonths must be positive');
  if (roundingMinor <= 0) throw new RangeError('roundingMinor must be positive');
  if (maxPaymentMinor.lessThanOrEqualTo(0)) return 0;

  const exact =
    annualRatePct === 0
      ? maxPaymentMinor.times(termMonths)
      : maxPaymentMinor.times(annuityFactor(monthlyRate(annualRatePct), termMonths)).div(monthlyRate(annualRatePct));

  const rounded = exact.div(roundingMinor).floor().times(roundingMinor);
  return Decimal.max(rounded, 0).toNumber();
};

/**
 * Debt-to-income, kept as a Decimal so the comparison against `maxDti` is exact.
 *
 * Stored as `numeric(6,4)`, so four decimal places is the resolution the audit
 * has; rounding here rather than at the repository keeps the number the engine
 * compared and the number the row records identical. A DTI that reads 0.4300 in
 * the audit and was 0.43004 in the comparison is a decision nobody can reproduce.
 */
export const debtToIncome = (
  obligationsMinor: number,
  paymentMinor: number,
  monthlyIncomeMinor: number,
): Decimal => {
  if (monthlyIncomeMinor <= 0) throw new RangeError('monthlyIncomeMinor must be positive');
  return new Decimal(obligationsMinor)
    .plus(paymentMinor)
    .div(monthlyIncomeMinor)
    .toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
};

export { Decimal };
