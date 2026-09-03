import { describe, expect, it, vi } from 'vitest';
import { pullWithResilience } from '../../src/bureau/resilience.js';
import { BureauTransportError, createMockBureau, type BureauProvider } from '../../src/bureau/provider.js';
import { deriveSubjectKey, pullKey, subjectKeysMatch } from '../../src/bureau/subject-key.js';

const PEPPER = 'a-pepper-that-is-at-least-32-characters';

const bureau = (overrides: Partial<Parameters<typeof createMockBureau>[0]> = {}): BureauProvider =>
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
    const result = await bureau().pull('900-55-0601');
    expect(result.outcome).toBe('FOUND');
    if (result.outcome === 'FOUND') expect(result.report.revolvingUtilizationPct).toBe(8);
  });

  it('answers NO_HIT for the no-file identifier, and that is an answer', async () => {
    const result = await bureau().pull('900-55-0300');
    expect(result.outcome).toBe('NO_HIT');
  });

  it('fails on demand by identifier, with no configuration', async () => {
    // docs/08 §6: this is what makes the failure path demonstrable on the
    // deployed instance with one curl and no restart.
    await expect(bureau().pull('900-55-9001')).rejects.toThrow(BureauTransportError);
  });

  it('never sees the subject key', () => {
    // Not "ignores it" — it is not a parameter. A provider that could search by
    // our HMAC is a design that can never be pointed at a real bureau.
    expect(bureau().pull.length).toBe(1);
  });
});

describe('one logical pull is one enquiry, whatever happens underneath', () => {
  it('retries a failure and succeeds, which is what proves the retry retries', async () => {
    const provider = bureau({ failureMode: 'flaky', failuresBeforeSuccess: 1 });
    const result = await pullWithResilience(provider, '900-55-0601', fast);
    expect(result.outcome).toBe('FOUND');
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
