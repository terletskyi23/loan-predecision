import { describe, expect, it } from 'vitest';
import { GENESIS_HASH, canonicalJson, hashEvent, type AuditEvent } from '../../src/db/audit.js';

/**
 * The chain arithmetic, without a database. The integration suite proves the
 * append is atomic and the trigger refuses an edit; this proves the maths.
 */

const event = (overrides: Partial<Omit<AuditEvent, 'hash' | 'prevHash'>> = {}): Omit<AuditEvent, 'hash' | 'prevHash'> => ({
  applicationId: '11111111-1111-4111-8111-111111111111',
  chainIndex: 0,
  eventType: 'APPLICATION_RECEIVED',
  actor: 'acme-web',
  payload: { consentAttested: true },
  occurredAt: new Date('2026-09-02T09:14:22.418Z'),
  ...overrides,
});

describe('canonical JSON', () => {
  it('sorts keys at every depth', () => {
    // JSON.stringify preserves insertion order, so two code paths that build the
    // same payload differently would hash differently. A chain that cries
    // tampering at a refactor stops being believed when it matters.
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(canonicalJson({ a: { c: 3, d: 2 }, b: 1 })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('preserves array order, which is meaning rather than layout', () => {
    // reason_codes is ordered by decisiveness. Sorting it would destroy the fact.
    expect(canonicalJson(['b', 'a'])).toBe('["b","a"]');
  });

  it('drops undefined rather than emitting it', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('renders a date as an instant, not as an object', () => {
    expect(canonicalJson(new Date('2026-09-02T09:14:22.418Z'))).toBe('"2026-09-02T09:14:22.418Z"');
  });
});

describe('the hash', () => {
  it('is stable for the same event', () => {
    expect(hashEvent(GENESIS_HASH, event())).toBe(hashEvent(GENESIS_HASH, event()));
  });

  it('changes when any field changes', () => {
    const base = hashEvent(GENESIS_HASH, event());
    expect(hashEvent(GENESIS_HASH, event({ actor: 'someone-else' }))).not.toBe(base);
    expect(hashEvent(GENESIS_HASH, event({ payload: { consentAttested: false } }))).not.toBe(base);
    expect(hashEvent(GENESIS_HASH, event({ occurredAt: new Date(0) }))).not.toBe(base);
    expect(hashEvent(GENESIS_HASH, event({ eventType: 'PRE_DECISION_MADE' }))).not.toBe(base);
  });

  it('binds the event to its application, so a chain cannot be transplanted', () => {
    // application_id and chain_index are hashed as part of the event rather than
    // merely stored beside it. docs/04 §3 states this because the formula does
    // not make it obvious.
    const mine = hashEvent(GENESIS_HASH, event());
    const yours = hashEvent(GENESIS_HASH, event({ applicationId: '22222222-2222-4222-8222-222222222222' }));
    expect(mine).not.toBe(yours);
  });

  it('binds the event to its position', () => {
    expect(hashEvent(GENESIS_HASH, event({ chainIndex: 1 }))).not.toBe(hashEvent(GENESIS_HASH, event()));
  });

  it('depends on the previous hash, which is what makes it a chain', () => {
    expect(hashEvent('a'.repeat(64), event())).not.toBe(hashEvent(GENESIS_HASH, event()));
  });

  it('is not affected by the order the payload was built in', () => {
    const one = hashEvent(GENESIS_HASH, event({ payload: { a: 1, b: 2 } }));
    const two = hashEvent(GENESIS_HASH, event({ payload: { b: 2, a: 1 } }));
    expect(one).toBe(two);
  });
});
