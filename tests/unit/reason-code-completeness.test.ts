import { beforeAll, describe, expect, it } from 'vitest';
import { decide, screen } from '../../src/domain/engine.js';
import type { Policy } from '../../src/domain/policy.js';
import { createFilePolicyStore } from '../../src/policy/loader.js';
import { NOW, application, found, noHit, unavailable } from '../support/engine-fixtures.js';

/**
 * docs/07-testing.md §7 — the completeness criterion.
 *
 * Walk `reasonCodes.registry` and prove every code the policy declares is one
 * the engine can actually emit. A code that exists only in the file is a promise
 * to an applicant that nothing keeps; a code the engine emits that is not in the
 * registry would be disclosed on a decision without ever having been declared,
 * and the policy schema refuses that from the other side.
 *
 * This criterion could not be checked at all while the codes lived only in
 * prose, which is why the registry is a machine-readable ordered list.
 */

let policy: Policy;
beforeAll(async () => {
  policy = await createFilePolicyStore('./policies').get('2026.09.1');
});

const emitted = (): Set<string> => {
  const codes = new Set<string>();
  const collect = (list: readonly string[]): void => list.forEach((code) => codes.add(code));

  // S1 — one application per eligibility knockout.
  for (const overrides of [
    { dateOfBirth: '2014-01-01' },
    { dateOfBirth: '1949-01-01' },
    { requestedAmountMinor: 9_000_000 },
    { termMonths: 84 },
    { monthlyIncomeMinor: 100_000 },
  ]) {
    collect(screen(application(overrides), policy, NOW)?.reasonCodes ?? []);
  }

  const modest = application({ requestedAmountMinor: 1_800_000, termMonths: 36 });

  // D1, D2, D4, D5, D6, D7 — one lookup per branch.
  collect(decide(application(), unavailable(), policy, NOW).reasonCodes);
  collect(decide(application(), noHit(), policy, NOW).reasonCodes);
  collect(decide(application(), found('PRIME', { revolvingUtilizationPct: undefined }), policy, NOW).reasonCodes);
  collect(decide(application(), found('PRIME', { hasActiveDelinquency: true }), policy, NOW).reasonCodes);
  collect(decide(application(), found('RECENT_BANKRUPTCY'), policy, NOW).reasonCodes);
  collect(decide(application(), found('PRIME', { monthsSinceChargeOff: 6 }), policy, NOW).reasonCodes);
  collect(decide(modest, found('THIN'), policy, NOW).reasonCodes);
  collect(decide(modest, found('NAME_MISMATCH'), policy, NOW).reasonCodes);
  collect(decide(application({ requestedAmountMinor: 4_000_000 }), found('PRIME'), policy, NOW).reasonCodes);
  collect(decide(application(), found('ADVERSE_HISTORY'), policy, NOW).reasonCodes);
  collect(decide(modest, found('REFERRAL_BAND'), policy, NOW).reasonCodes);
  collect(decide(application(), found('CLEAN_MODERATE'), policy, NOW).reasonCodes);
  collect(decide(application({ monthlyIncomeMinor: 210_000 }), found('CLEAN_MODERATE'), policy, NOW).reasonCodes);

  return codes;
};

describe('every declared reason code is reachable', () => {
  it('emits all 22 of them', () => {
    const reachable = emitted();
    const declared = policy.reasonCodes.registry.map((entry) => entry.code);
    const unreachable = declared.filter((code) => !reachable.has(code));
    expect(unreachable, 'declared in the policy and never emitted by the engine').toEqual([]);
  });

  it('emits nothing the registry does not declare', () => {
    const declared = new Set(policy.reasonCodes.registry.map((entry) => entry.code));
    const undeclared = [...emitted()].filter((code) => !declared.has(code));
    expect(undeclared, 'emitted by the engine and absent from the policy registry').toEqual([]);
  });

  it('agrees with the registry about which verdict each code belongs to', () => {
    // A code declared APPROVED that only ever appears on a decline would make
    // the registry a description of something else.
    const byCode = new Map(policy.reasonCodes.registry.map((entry) => [entry.code, entry]));
    const cases = [
      decide(application(), found('CLEAN_MODERATE'), policy, NOW),
      decide(application(), found('ADVERSE_HISTORY'), policy, NOW),
      decide(application({ requestedAmountMinor: 1_800_000, termMonths: 36 }), found('REFERRAL_BAND'), policy, NOW),
    ];
    for (const result of cases) {
      for (const code of result.reasonCodes) {
        const entry = byCode.get(code);
        expect(entry, code).toBeDefined();
        if (entry !== undefined && entry.verdict !== 'ANY') {
          expect(entry.verdict, `${code} on a ${result.verdict}`).toBe(result.verdict);
        }
      }
    }
  });
});
