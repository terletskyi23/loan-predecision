import { createHash } from 'node:crypto';
import { canonicaliseNationalId } from '../domain/identifier.js';
import type { BureauReport, DelinquencyGrade } from '../domain/bureau-lookup.js';

/**
 * The mock bureau's catalogue. docs/08-mock-bureau.md §4 and §5.
 *
 * Three properties have to hold, and each is a requirement rather than a
 * preference:
 *
 *   DETERMINISTIC — the same identifier yields the same report on every machine
 *   and every run, or no test proves anything and the documented outcomes
 *   cannot be reproduced against the deployed instance. No `Math.random()`, no
 *   clock, no counter anywhere in this file.
 *
 *   KEYED ON THE CANONICALISED IDENTIFIER, exactly as a real bureau is keyed on
 *   the real one. Not on the subject key: no provider can search by our HMAC,
 *   and keying on it would make the profiles depend on SUBJECT_KEY_PEPPER and
 *   therefore differ between deployments.
 *
 *   OWNED BY THE MOCK. The value lists below are the mock's, never the policy's.
 *   If they were drawn from the policy's band tables, every profile would shift
 *   the moment a risk owner edited a threshold, and the score table in docs/08
 *   §4 would stop being a check of anything.
 *
 * The two failure identifiers are NOT here. They produce no report at all, and
 * belong to the provider that decides how to fail (docs/08 §6).
 */

/** Reachable deliberately: a reviewer can produce every documented outcome with curl. */
export type ProfileName =
  | 'CLEAN_MODERATE'
  | 'ADVERSE_HISTORY'
  | 'PRIME'
  | 'REFERRAL_BAND'
  | 'THIN'
  | 'NAME_MISMATCH'
  | 'RECENT_BANKRUPTCY'
  | 'NO_FILE';

/** Everything a report carries except `provider` and `pulledAt`, which the provider supplies. */
export type ProfileAttributes = Omit<BureauReport, 'provider' | 'pulledAt'>;

const attributes = (
  overrides: Partial<ProfileAttributes> & Pick<ProfileAttributes, 'worstDelinquencyLast24m' | 'revolvingUtilizationPct' | 'oldestAccountAgeMonths' | 'hardInquiriesLast6m' | 'distinctAccountTypes' | 'totalAccounts' | 'monthlyObligationsMinor'>,
): ProfileAttributes => ({
  subjectMatch: { nameMatches: true, dateOfBirthMatches: true },
  hasActiveDelinquency: false,
  monthsSinceBankruptcy: null,
  monthsSinceChargeOff: null,
  ...overrides,
});

/**
 * docs/08 §4. Every number here is load-bearing for a documented outcome, so a
 * change to one is a change to the documentation and to the test that re-derives
 * the score table.
 */
export const PROFILES: Readonly<Record<Exclude<ProfileName, 'NO_FILE'>, ProfileAttributes>> = Object.freeze({
  /** Score 75, DTI over the limit → counter-offer. Three cards: three accounts, one type. */
  CLEAN_MODERATE: attributes({
    worstDelinquencyLast24m: 'NONE',
    revolvingUtilizationPct: 34,
    oldestAccountAgeMonths: 60,
    hardInquiriesLast6m: 2,
    distinctAccountTypes: 1,
    totalAccounts: 3,
    monthlyObligationsMinor: 160000,
  }),

  /**
   * Score 22 → declined at the score floor. DPD_90_PLUS with
   * hasActiveDelinquency false ON PURPOSE: it is the profile that proves the two
   * attributes are not the same thing. Collapse them and this applicant is
   * knocked out at D2 and the scorecard is never exercised by any documented
   * example.
   */
  ADVERSE_HISTORY: attributes({
    worstDelinquencyLast24m: 'DPD_90_PLUS',
    revolvingUtilizationPct: 82,
    oldestAccountAgeMonths: 30,
    hardInquiriesLast6m: 5,
    distinctAccountTypes: 2,
    totalAccounts: 6,
    monthlyObligationsMinor: 210000,
  }),

  /** Score 100 → approved in full, and the case that carries no reason codes at all (ADR-0010). */
  PRIME: attributes({
    worstDelinquencyLast24m: 'NONE',
    revolvingUtilizationPct: 8,
    oldestAccountAgeMonths: 120,
    hardInquiriesLast6m: 0,
    distinctAccountTypes: 4,
    totalAccounts: 9,
    monthlyObligationsMinor: 90000,
  }),

  /** Score 59 → MANUAL_REVIEW · SCORE_IN_REFERRAL_BAND. */
  REFERRAL_BAND: attributes({
    worstDelinquencyLast24m: 'NONE',
    revolvingUtilizationPct: 55,
    oldestAccountAgeMonths: 20,
    hardInquiriesLast6m: 3,
    distinctAccountTypes: 2,
    totalAccounts: 4,
    monthlyObligationsMinor: 180000,
  }),

  /** Score 73 — comfortably above the referral band — but one account. D4 outranks D5 and D6. */
  THIN: attributes({
    worstDelinquencyLast24m: 'NONE',
    revolvingUtilizationPct: 15,
    oldestAccountAgeMonths: 4,
    hardInquiriesLast6m: 1,
    distinctAccountTypes: 1,
    totalAccounts: 1,
    monthlyObligationsMinor: 40000,
  }),

  /** Score 94, name disagrees → MANUAL_REVIEW · IDENTITY_MISMATCH. A high score must not outrank this. */
  NAME_MISMATCH: attributes({
    subjectMatch: { nameMatches: false, dateOfBirthMatches: true },
    worstDelinquencyLast24m: 'NONE',
    revolvingUtilizationPct: 20,
    oldestAccountAgeMonths: 90,
    hardInquiriesLast6m: 1,
    distinctAccountTypes: 3,
    totalAccounts: 7,
    monthlyObligationsMinor: 150000,
  }),

  /**
   * Bankruptcy 8 months ago → declined at D2, before the scorecard runs. Its
   * score is therefore never computed and `pre_decisions.score` stays null,
   * which is why docs/08 §4 omits this profile from the score table.
   */
  RECENT_BANKRUPTCY: attributes({
    monthsSinceBankruptcy: 8,
    worstDelinquencyLast24m: 'DPD_60',
    revolvingUtilizationPct: 70,
    oldestAccountAgeMonths: 44,
    hardInquiriesLast6m: 4,
    distinctAccountTypes: 2,
    totalAccounts: 5,
    monthlyObligationsMinor: 230000,
  }),
});

/** docs/08 §4. Canonicalised, because that is what the lookup is keyed on. */
export const CATALOGUE: ReadonlyMap<string, ProfileName> = new Map([
  ['900550142', 'CLEAN_MODERATE'],
  ['900550221', 'ADVERSE_HISTORY'],
  ['900550601', 'PRIME'],
  ['900550701', 'REFERRAL_BAND'],
  ['900550301', 'THIN'],
  ['900550300', 'NO_FILE'],
  ['900550402', 'NAME_MISMATCH'],
  ['900550501', 'RECENT_BANKRUPTCY'],
] as const);

/** docs/08 §6. Reachable with a single curl on the deployed instance, no configuration. */
export const FAILURE_IDENTIFIERS: ReadonlyMap<string, 'SERVER_ERROR' | 'TIMEOUT'> = new Map([
  ['900559001', 'SERVER_ERROR'],
  ['900559002', 'TIMEOUT'],
] as const);

/**
 * docs/08 §5. The fallback for an identifier a reviewer invents.
 *
 * Weighted towards ordinary files on purpose: an unlisted identifier should land
 * somewhere plausible, and the interesting cases are the named profiles above,
 * which a reviewer reaches deliberately. Each attribute draws from its own list
 * because one shared array cannot produce both an enum and a percentage.
 *
 * CHOICE_LISTS and FIXED_ORDER are versioned with the mock. Changing either changes
 * every unlisted identifier's report, which is a change made in a commit — not a
 * silent consequence of a policy edit.
 */
export const CHOICE_LISTS = {
  worstDelinquencyLast24m: ['NONE', 'NONE', 'NONE', 'DPD_30', 'DPD_60', 'DPD_90_PLUS'] as const,
  revolvingUtilizationPct: [5, 18, 27, 34, 48, 61, 72, 84, 93] as const,
  oldestAccountAgeMonths: [3, 9, 18, 30, 44, 60, 88, 120] as const,
  hardInquiriesLast6m: [0, 0, 1, 2, 3, 4, 6] as const,
  distinctAccountTypes: [1, 1, 2, 2, 3, 4] as const,
  totalAccounts: [1, 2, 3, 5, 7, 9] as const,
  monthlyObligationsMinor: [0, 40000, 90000, 150000, 210000, 300000] as const,
};

const FIXED_ORDER = [
  'worstDelinquencyLast24m',
  'revolvingUtilizationPct',
  'oldestAccountAgeMonths',
  'hardInquiriesLast6m',
  'distinctAccountTypes',
  'totalAccounts',
  'monthlyObligationsMinor',
] as const;

const pick = <T>(list: readonly T[], byte: number): T => {
  const value = list[byte % list.length];
  // Unreachable: `byte % length` is always in range and every list is non-empty.
  // noUncheckedIndexedAccess makes the compiler ask anyway, and answering with a
  // throw rather than a `!` keeps the assertion honest if a list is ever emptied.
  if (value === undefined) throw new Error('empty CHOICE_LISTS entry');
  return value;
};

/**
 * Derived from the canonical identifier, NOT from the subject key: no pepper, so
 * the same identifier produces the same file on every deployment. That is what
 * makes the profiles reproducible in a reviewer's own environment.
 */
export const derivedAttributes = (canonicalId: string): ProfileAttributes => {
  const seed = createHash('sha256').update(canonicalId, 'utf8').digest();

  const byteAt = (index: number): number => {
    const byte = seed[index];
    if (byte === undefined) throw new Error('sha256 digest is shorter than FIXED_ORDER');
    return byte;
  };

  const at = (name: (typeof FIXED_ORDER)[number]): number => byteAt(FIXED_ORDER.indexOf(name));

  return {
    subjectMatch: { nameMatches: true, dateOfBirthMatches: true },
    hasActiveDelinquency: false,
    monthsSinceBankruptcy: null,
    monthsSinceChargeOff: null,
    worstDelinquencyLast24m: pick<DelinquencyGrade>(
      CHOICE_LISTS.worstDelinquencyLast24m,
      at('worstDelinquencyLast24m'),
    ),
    revolvingUtilizationPct: pick(CHOICE_LISTS.revolvingUtilizationPct, at('revolvingUtilizationPct')),
    oldestAccountAgeMonths: pick(CHOICE_LISTS.oldestAccountAgeMonths, at('oldestAccountAgeMonths')),
    hardInquiriesLast6m: pick(CHOICE_LISTS.hardInquiriesLast6m, at('hardInquiriesLast6m')),
    distinctAccountTypes: pick(CHOICE_LISTS.distinctAccountTypes, at('distinctAccountTypes')),
    totalAccounts: pick(CHOICE_LISTS.totalAccounts, at('totalAccounts')),
    monthlyObligationsMinor: pick(CHOICE_LISTS.monthlyObligationsMinor, at('monthlyObligationsMinor')),
  };
};

export type CatalogueEntry =
  | { readonly kind: 'PROFILE'; readonly profile: Exclude<ProfileName, 'NO_FILE'>; readonly attributes: ProfileAttributes }
  | { readonly kind: 'NO_FILE' }
  | { readonly kind: 'FAILURE'; readonly cause: 'SERVER_ERROR' | 'TIMEOUT' }
  | { readonly kind: 'DERIVED'; readonly attributes: ProfileAttributes };

/**
 * The single lookup the provider uses. Canonicalises first, exactly as a real
 * bureau would: `900-55-0142`, `900 55 0142` and `900550142` are one subject,
 * and without this the central requirement of the brief is defeated by a hyphen.
 */
export const lookupCatalogue = (nationalId: string): CatalogueEntry => {
  const canonical = canonicaliseNationalId(nationalId);

  const failure = FAILURE_IDENTIFIERS.get(canonical);
  if (failure !== undefined) return { kind: 'FAILURE', cause: failure };

  const profile = CATALOGUE.get(canonical);
  if (profile === 'NO_FILE') return { kind: 'NO_FILE' };
  if (profile !== undefined) return { kind: 'PROFILE', profile, attributes: PROFILES[profile] };

  return { kind: 'DERIVED', attributes: derivedAttributes(canonical) };
};
