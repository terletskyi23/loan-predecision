import { describe, expect, it, vi } from 'vitest';
import { pullWithResilience } from '../../src/bureau/resilience.js';
import { BureauTransportError, createMockBureau, type MockBureau } from '../../src/bureau/provider.js';
import { deriveSubjectKey, pullKey, subjectKeysMatch } from '../../src/bureau/subject-key.js';

const PEPPER = 'a-pepper-that-is-at-least-32-characters';

const bureau = (overrides: Partial<Parameters<typeof createMockBureau>[0]> = {}): MockBureau =>
  createMockBureau({
    provider: 'MOCKBUREAU',
    failureMode: 'none',
    latencyMs: 0,
    failuresBeforeSuccess: 2,
    now: () => new Date('2026-09-02T09:00:00.000Z'),
    ...overrides,
  });

const fast = { timeoutMs: 50, maxAttempts: 2, backoffBaseMs: 1, random: () => 0 };

describe('the subject key', () => {
  it('is the same for every spelling of one identifier', () => {
    const a = deriveSubjectKey('900-55-0142', PEPPER);
    for (const spelling of ['900 55 0142', '900550142', '900.55.0142']) {
      expect(deriveSubjectKey(spelling, PEPPER)).toBe(a);
    }
  });

  it('differs under a different pepper, which is what keying buys', () => {
    // Without the pepper this is a plain hash of a nine-digit number, and nine
    // digits is a billion candidates — minutes of work. A leaked table of
    // unkeyed hashes is a leaked table of identifiers.
    expect(deriveSubjectKey('900550142', PEPPER)).not.toBe(deriveSubjectKey('900550142', `${PEPPER}x`));
  });

  it('is 64 hex characters, which is what the column stores', () => {
    expect(deriveSubjectKey('900550142', PEPPER)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses an identifier that canonicalises to nothing', () => {
    // Otherwise every applicant with an unusable identifier becomes one person
    // and they share a credit file.
    expect(() => deriveSubjectKey('---', PEPPER)).toThrow(RangeError);
  });

  it('compares without leaking a prefix through timing', () => {
    const key = deriveSubjectKey('900550142', PEPPER);
    expect(subjectKeysMatch(key, key)).toBe(true);
    expect(subjectKeysMatch(key, deriveSubjectKey('900550221', PEPPER))).toBe(false);
  });

  it('scopes the pull claim by provider, because two bureaux are two enquiries', () => {
    const key = deriveSubjectKey('900550142', PEPPER);
    expect(pullKey(key, 'A')).not.toBe(pullKey(key, 'B'));
  });
});

describe('the mock bureau', () => {
  it('returns the documented profile for a documented identifier', async () => {
    const result = await bureau().pull('900-55-0601', 'req-1');
    expect(result.outcome).toBe('FOUND');
    if (result.outcome === 'FOUND') expect(result.report.revolvingUtilizationPct).toBe(8);
  });

  it('answers NO_HIT for the no-file identifier, and that is an answer', async () => {
    const result = await bureau().pull('900-55-0300', 'req-1');
    expect(result.outcome).toBe('NO_HIT');
  });

  it('fails on demand by identifier, with no configuration', async () => {
    // docs/08 §6: this is what makes the failure path demonstrable on the
    // deployed instance with one curl and no restart.
    await expect(bureau().pull('900-55-9001', 'req-1')).rejects.toThrow(BureauTransportError);
  });

  it('never sees the subject key', async () => {
    // Not "ignores it" — it is not a parameter. A provider that could search by
    // our HMAC is a design that can never be pointed at a real bureau.
    //
    // Asserting `pull.length === 1` was the earlier version of this test and it
    // proved nothing: arity two passes just as well if the second argument IS
    // the subject key. This asserts what actually matters — the value crossing
    // the boundary is the identifier and an opaque call id, and the HMAC is
    // nowhere in either.
    const subjectKey = deriveSubjectKey('900-55-0601', PEPPER);
    const provider = bureau();
    await provider.pull('900-55-0601', 'req-opaque');
    expect(provider.seenRequestIds).toEqual(['req-opaque']);
    expect(provider.seenRequestIds.join()).not.toContain(subjectKey);
  });
});

describe('one logical pull is one enquiry, whatever happens underneath', () => {
  it('retries a failure and succeeds, which is what proves the retry retries', async () => {
    const provider = bureau({ failureMode: 'flaky', failuresBeforeSuccess: 1 });
    const result = await pullWithResilience(provider, '900-55-0601', fast);
    expect(result.outcome).toBe('FOUND');
  });

  it('carries ONE request id across every attempt of one pull', async () => {
    // Layer 4 of docs/02. A real bureau treats a repeated request id as the same
    // enquiry; minting a fresh one per retry turns the retry budget into a
    // multiplier on the applicant's credit file — the exact harm this service
    // exists to prevent, inflicted by our own resilience code.
    const provider = bureau({ failureMode: 'flaky', failuresBeforeSuccess: 2 });
    await pullWithResilience(provider, '900-55-0601', { ...fast, maxAttempts: 3 });
    expect(provider.seenRequestIds).toHaveLength(3);
    expect(new Set(provider.seenRequestIds).size, 'three attempts, one enquiry').toBe(1);
  });

  it('gives two different pulls two different ids', async () => {
    const provider = bureau();
    await pullWithResilience(provider, '900-55-0601', fast);
    await pullWithResilience(provider, '900-55-0601', fast);
    expect(new Set(provider.seenRequestIds).size).toBe(2);
  });

  it('does not launder our own bug into a bureau outage', async () => {
    // A TypeError in an adapter retried and then recorded as RETRIES_EXHAUSTED
    // is a false statement about a third party inside a record built to be
    // replayed. It must propagate, not be relabelled.
    const broken = {
      name: 'MOCKBUREAU',
      pull: async () => {
        throw new TypeError('cannot read properties of undefined');
      },
    };
    await expect(pullWithResilience(broken, '900-55-0601', fast)).rejects.toThrow(TypeError);
  });

  it('reports RETRIES_EXHAUSTED after more than one attempt', async () => {
    // "The last of three failures was a timeout" is a less useful fact than "we
    // tried three times and gave up", and the three are often different kinds.
    const result = await pullWithResilience(bureau({ failureMode: 'error' }), '900-55-0601', fast);
    expect(result).toMatchObject({ outcome: 'UNAVAILABLE', cause: 'RETRIES_EXHAUSTED' });
  });

  it('reports the actual cause when only one attempt was configured', async () => {
    const result = await pullWithResilience(bureau({ failureMode: 'error' }), '900-55-0601', { ...fast, maxAttempts: 1 });
    expect(result).toMatchObject({ outcome: 'UNAVAILABLE', cause: 'SERVER_ERROR' });
  });

  it('turns a hang into an error rather than holding the connection', async () => {
    // The failure mode that is hardest to see: the error rate stays clean while
    // every request holds a pool slot.
    const result = await pullWithResilience(bureau(), '900-55-9002', { ...fast, maxAttempts: 1 });
    expect(result).toMatchObject({ outcome: 'UNAVAILABLE', cause: 'TIMEOUT' });
  }, 10_000);

  it('does not retry a NO_HIT, because a no-hit is an answer', async () => {
    // Retrying one because it looks empty puts a second enquiry on the file of
    // someone who has none.
    const attempts = vi.fn();
    const result = await pullWithResilience(bureau(), '900-55-0300', { ...fast, onAttempt: attempts });
    expect(result.outcome).toBe('NO_HIT');
    expect(attempts).toHaveBeenCalledTimes(1);
  });

  it('spreads retries with jitter rather than resynchronising the herd', async () => {
    const random = vi.fn(() => 0.5);
    await pullWithResilience(bureau({ failureMode: 'error' }), '900-55-0601', { ...fast, random });
    expect(random).toHaveBeenCalled();
  });

  it('stops at maxAttempts and never more', async () => {
    const attempts = vi.fn();
    await pullWithResilience(bureau({ failureMode: 'error' }), '900-55-0601', {
      ...fast,
      maxAttempts: 3,
      onAttempt: attempts,
    });
    expect(attempts).toHaveBeenCalledTimes(3);
  });
});
