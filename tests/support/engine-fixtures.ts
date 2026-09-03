import type { BureauLookup, BureauReport } from '../../src/domain/bureau-lookup.js';
import type { EngineApplication } from '../../src/domain/engine.js';
import { PROFILES, type ProfileName } from '../../src/bureau/profiles.js';

/** A fixed instant. Nothing in the engine reads a clock, so every test pins one. */
export const NOW = new Date('2026-09-02T09:14:22.418Z');

export const PULLED_AT = new Date('2026-09-02T09:14:23.000Z');

/** The applicant from the worked example in docs/03 §5: age 35 at NOW. */
export const application = (overrides: Partial<EngineApplication> = {}): EngineApplication => ({
  productCode: 'PERSONAL_UNSECURED_V1',
  requestedAmountMinor: 3_200_000,
  termMonths: 48,
  dateOfBirth: '1991-04-12',
  monthlyIncomeMinor: 540_000,
  declaredMonthlyObligationsMinor: 160_000,
  ...overrides,
});

export const reportFrom = (
  profile: Exclude<ProfileName, 'NO_FILE'>,
  overrides: Partial<BureauReport> = {},
): BureauReport => ({
  provider: 'MOCKBUREAU',
  pulledAt: PULLED_AT,
  ...PROFILES[profile],
  ...overrides,
});

export const found = (profile: Exclude<ProfileName, 'NO_FILE'>, overrides: Partial<BureauReport> = {}): BureauLookup => ({
  outcome: 'FOUND',
  report: reportFrom(profile, overrides),
});

export const noHit = (): BureauLookup => ({ outcome: 'NO_HIT', provider: 'MOCKBUREAU', pulledAt: PULLED_AT });

export const unavailable = (): BureauLookup => ({ outcome: 'UNAVAILABLE', provider: 'MOCKBUREAU', cause: 'RETRIES_EXHAUSTED' });
