import { describe, expect, it } from 'vitest';
import { canonicaliseNationalId } from '../../src/domain/identifier.js';
import { CATALOGUE, CHOICE_LISTS, PROFILES, derivedAttributes, lookupCatalogue } from '../../src/bureau/profiles.js';
import { score } from '../../src/domain/scorecard.js';
import { createFilePolicyStore } from '../../src/policy/loader.js';

/**
 * docs/08-mock-bureau.md §4 and §5.
 *
 * The mock is a specification of the contract we would hold a real bureau to,
 * so the properties worth proving are the ones a reviewer relies on: the same
 * identifier yields the same file forever, three spellings are one subject, and
 * every documented outcome is reachable with the identifier the document names.
 *
 * The score table in docs/08 §4 is re-derived at the end of this file from the
 * profile attributes and the shipped policy's bands, so the document cannot
 * drift from the catalogue.
 */

describe('canonicalisation is what makes deduplication work', () => {
  it('reduces every spelling of one identifier to one subject', () => {
    const spellings = ['900-55-0142', '900 55 0142', '900550142', '900.55.0142'];
    const canonical = new Set(spellings.map(canonicaliseNationalId));
    expect(canonical).toEqual(new Set(['900550142']));
  });

  it('finds the same profile whichever spelling arrives', () => {
    // Without this the central requirement of the brief is defeated by a hyphen:
    // three spellings, three subject keys, three pulls, three marks on one file.
    for (const spelling of ['900-55-0601', '900 55 0601', '900550601']) {
      const entry = lookupCatalogue(spelling);
      expect(entry.kind === 'PROFILE' && entry.profile).toBe('PRIME');
    }
  });

  it('uppercases, so case is not an identity', () => {
    expect(canonicaliseNationalId('ab-12')).toBe('AB12');
    expect(canonicaliseNationalId('AB 12')).toBe('AB12');
  });
});

describe('every documented identifier reaches the documented outcome', () => {
  it.each([
    ['900-55-0142', 'CLEAN_MODERATE'],
    ['900-55-0221', 'ADVERSE_HISTORY'],
    ['900-55-0601', 'PRIME'],
    ['900-55-0701', 'REFERRAL_BAND'],
    ['900-55-0301', 'THIN'],
    ['900-55-0402', 'NAME_MISMATCH'],
    ['900-55-0501', 'RECENT_BANKRUPTCY'],
  ])('%s is %s', (identifier, profile) => {
    const entry = lookupCatalogue(identifier);
    expect(entry.kind === 'PROFILE' && entry.profile).toBe(profile);
  });

  it('900-55-0300 has no file, which is not the same as a failure', () => {
    expect(lookupCatalogue('900-55-0300').kind).toBe('NO_FILE');
  });

  it.each([
    ['900-55-9001', 'SERVER_ERROR'],
    ['900-55-9002', 'TIMEOUT'],
  ])('%s fails with %s, without configuration', (identifier, cause) => {
    // docs/08 §6: this is the trigger a reviewer uses, so the failure path is
    // demonstrable on the deployed instance with one curl and no restart.
    const entry = lookupCatalogue(identifier);
    expect(entry.kind === 'FAILURE' && entry.cause).toBe(cause);
  });
});

describe('the attribute pairs that look redundant and are not', () => {
  it('ADVERSE_HISTORY carries a 90-day delinquency that is not active', () => {
    // The profile exists to prove hasActiveDelinquency and
    // worstDelinquencyLast24m are different facts. Collapse them and this
    // applicant is knocked out at D2, and no documented example ever exercises
    // the scorecard.
    expect(PROFILES.ADVERSE_HISTORY.worstDelinquencyLast24m).toBe('DPD_90_PLUS');
    expect(PROFILES.ADVERSE_HISTORY.hasActiveDelinquency).toBe(false);
  });

  it('CLEAN_MODERATE has three accounts of one type', () => {
    // Three credit cards: above the thin-file floor, and still LIMITED_CREDIT_MIX.
    expect(PROFILES.CLEAN_MODERATE.totalAccounts).toBe(3);
    expect(PROFILES.CLEAN_MODERATE.distinctAccountTypes).toBe(1);
  });

  it('THIN is a referral for its file, not for its score', () => {
    // 73 points clears the referral band comfortably; one account does not clear
    // the thin-file floor. D4 has to outrank D5 and D6 or this is undefined.
    expect(PROFILES.THIN.totalAccounts).toBe(1);
  });

  it('RECENT_BANKRUPTCY is knocked out before the scorecard runs', () => {
    expect(PROFILES.RECENT_BANKRUPTCY.monthsSinceBankruptcy).toBe(8);
  });

  it('only NAME_MISMATCH disagrees on identity', () => {
    for (const [name, profile] of Object.entries(PROFILES)) {
      expect(profile.subjectMatch?.dateOfBirthMatches, name).toBe(true);
      expect(profile.subjectMatch?.nameMatches, name).toBe(name !== 'NAME_MISMATCH');
    }
  });

  it('every named profile supplies every attribute the scorecard reads', () => {
    // A profile with a gap would be referred as BUREAU_DATA_INCOMPLETE and its
    // documented outcome would be unreachable.
    for (const [name, profile] of Object.entries(PROFILES)) {
      expect(profile.worstDelinquencyLast24m, name).toBeDefined();
      expect(profile.revolvingUtilizationPct, name).toBeDefined();
      expect(profile.oldestAccountAgeMonths, name).toBeDefined();
      expect(profile.hardInquiriesLast6m, name).toBeDefined();
      expect(profile.distinctAccountTypes, name).toBeDefined();
      expect(profile.totalAccounts, name).toBeDefined();
      expect(profile.monthlyObligationsMinor, name).toBeDefined();
    }
  });
});

describe('an identifier nobody documented still gets a stable answer', () => {
  it('returns the same report twice', () => {
    expect(derivedAttributes('123456789')).toEqual(derivedAttributes('123456789'));
  });

  it('returns the same report it returned in a different process', () => {
    // Recorded from a separate run, so this locks the promise "the same report
    // forever" rather than merely re-checking that one function is a function.
    // It is a LOCK, not a validation: the values are the mock's business
    // (docs/08 §5). If CHOICES or FIXED_ORDER change, this fails loudly, which
    // is the point — that change is a deliberate commit, never a side effect.
    expect(derivedAttributes('123456789')).toEqual({
      subjectMatch: { nameMatches: true, dateOfBirthMatches: true },
      hasActiveDelinquency: false,
      monthsSinceBankruptcy: null,
      monthsSinceChargeOff: null,
      worstDelinquencyLast24m: 'DPD_30',
      revolvingUtilizationPct: 18,
      oldestAccountAgeMonths: 3,
      hardInquiriesLast6m: 0,
      distinctAccountTypes: 2,
      totalAccounts: 3,
      monthlyObligationsMinor: 40000,
    });
  });

  it('draws every value from the mock\'s own lists, never from the policy', () => {
    // If the derivation drew from the policy's band tables, every profile would
    // shift when a risk owner edited a threshold and the score table in
    // docs/08 §4 would stop being a check of anything.
    for (const seed of ['1', 'AB', '999999999', 'ZZZ-000', '900550143']) {
      const report = derivedAttributes(canonicaliseNationalId(seed));
      expect(CHOICE_LISTS.worstDelinquencyLast24m).toContain(report.worstDelinquencyLast24m);
      expect(CHOICE_LISTS.revolvingUtilizationPct).toContain(report.revolvingUtilizationPct);
      expect(CHOICE_LISTS.oldestAccountAgeMonths).toContain(report.oldestAccountAgeMonths);
      expect(CHOICE_LISTS.hardInquiriesLast6m).toContain(report.hardInquiriesLast6m);
      expect(CHOICE_LISTS.distinctAccountTypes).toContain(report.distinctAccountTypes);
      expect(CHOICE_LISTS.totalAccounts).toContain(report.totalAccounts);
      expect(CHOICE_LISTS.monthlyObligationsMinor).toContain(report.monthlyObligationsMinor);
    }
  });

  it('never invents adverse events outside the named profiles', () => {
    // docs/08 §5. A reviewer's invented identifier should land somewhere
    // plausible; a bankruptcy appearing at random would make the D2 knockouts
    // fire unpredictably and no demo would be reproducible.
    for (const seed of ['1', 'AB', '999999999', 'ZZZ-000', '424242']) {
      const report = derivedAttributes(canonicaliseNationalId(seed));
      expect(report.hasActiveDelinquency).toBe(false);
      expect(report.monthsSinceBankruptcy).toBeNull();
      expect(report.monthsSinceChargeOff).toBeNull();
      expect(report.subjectMatch).toEqual({ nameMatches: true, dateOfBirthMatches: true });
    }
  });

  it('does not shadow a documented identifier', () => {
    for (const identifier of CATALOGUE.keys()) {
      expect(lookupCatalogue(identifier).kind).not.toBe('DERIVED');
    }
  });
});

describe('the docs/08 §4 score table is re-derived, not asserted', () => {
  it.each([
    ['CLEAN_MODERATE', 75],
    ['ADVERSE_HISTORY', 22],
    ['PRIME', 100],
    ['REFERRAL_BAND', 59],
    ['THIN', 73],
    ['NAME_MISMATCH', 94],
  ] as const)('%s scores %i under the shipped policy', async (profile, total) => {
    // The table in the document cannot drift from the catalogue, because this
    // recomputes it from the profile's attributes and the policy's bands rather
    // than repeating a number somebody typed. RECENT_BANKRUPTCY is absent from
    // the table on purpose: it terminates at D2, before the scorecard runs.
    const policy = await createFilePolicyStore('./policies').get('2026.09.1');
    const report = { provider: 'MOCKBUREAU', pulledAt: new Date(0), ...PROFILES[profile] };
    expect(score(report, policy).total).toBe(total);
  });
});
