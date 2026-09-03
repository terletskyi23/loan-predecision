import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadConfig } from '../../src/config.js';

const valid = (): NodeJS.ProcessEnv => ({
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  SUBJECT_KEY_PEPPER: 'x'.repeat(32),
  API_TOKENS: 'acme-web:secret-a',
  REVIEWER_TOKENS: 'underwriting:secret-b',
  AUDITOR_TOKENS: 'compliance:secret-c',
  POLICY_VERSION: '2026.09.1',
  ENGINE_VERSION: '1.0.0',
  BUREAU_REPORT_TTL_MINUTES: '15',
  BUREAU_TIMEOUT_MS: '800',
  BUREAU_MAX_ATTEMPTS: '2',
  BUREAU_BACKOFF_BASE_MS: '150',
  BUREAU_CLAIM_LEASE_MS: '5000',
  BUREAU_WAIT_MS: '2000',
  BUREAU_WAIT_POLL_MS: '100',
  IDEMPOTENCY_RETENTION_HOURS: '24',
  IDEMPOTENCY_LEASE_SECONDS: '30',
  ORPHAN_SWEEP_AFTER_MINUTES: '15',
  ORPHAN_SWEEP_INTERVAL_MINUTES: '5',
});

const failsOn = (env: NodeJS.ProcessEnv, variable: string): string => {
  try {
    loadConfig(env);
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    const issue = error.issues.find((i) => i.path.join('.') === variable);
    expect(issue, `expected an issue on ${variable}, got: ${error.issues.map((i) => i.path.join('.')).join(', ')}`).toBeDefined();
    return issue!.message;
  }
  throw new Error(`expected loadConfig to reject on ${variable}, but it succeeded`);
};

describe('configuration', () => {
  it('accepts a complete environment', () => {
    const config = loadConfig(valid());
    expect(config.NODE_ENV).toBe('development');
    expect(config.PORT).toBe(3000);
  });

  describe('secrets have no defaults', () => {
    it('refuses a missing pepper, and names it', () => {
      const { SUBJECT_KEY_PEPPER: _omitted, ...rest } = valid();
      failsOn(rest, 'SUBJECT_KEY_PEPPER');
    });

    it('refuses a pepper short enough to brute force', () => {
      failsOn({ ...valid(), SUBJECT_KEY_PEPPER: 'short' }, 'SUBJECT_KEY_PEPPER');
    });
  });

  describe('production refuses to start without auth', () => {
    // Auth documented as mandatory that defaults to off is worse than no auth,
    // because it reads as protected. docs/01-architecture.md §6.
    it.each(['API_TOKENS', 'REVIEWER_TOKENS', 'AUDITOR_TOKENS'] as const)('refuses an empty %s', (variable) => {
      failsOn({ ...valid(), NODE_ENV: 'production', [variable]: '' }, variable);
    });

    it('allows an empty list outside production', () => {
      expect(() => loadConfig({ ...valid(), NODE_ENV: 'development', REVIEWER_TOKENS: '' })).not.toThrow();
    });
  });

  describe('token lists', () => {
    it('maps a secret to the client id that owns it', () => {
      const config = loadConfig({ ...valid(), API_TOKENS: 'acme-web:s1, partner-bank:s2' });
      expect(config.API_TOKENS.get('s1')).toBe('acme-web');
      expect(config.API_TOKENS.get('partner-bank')).toBeUndefined();
    });

    it('refuses two clients sharing one secret', () => {
      failsOn({ ...valid(), API_TOKENS: 'a:same,b:same' }, 'API_TOKENS');
    });

    it('refuses a duplicate client id', () => {
      failsOn({ ...valid(), API_TOKENS: 'a:s1,a:s2' }, 'API_TOKENS');
    });

    it.each(['no-separator', ':secret-only', 'client-only:'])('refuses the malformed entry %s', (entry) => {
      failsOn({ ...valid(), API_TOKENS: entry }, 'API_TOKENS');
    });
  });

  describe('the bureau timing budget must be internally consistent', () => {
    // The winner's worst case with the shipped numbers is
    // 2 attempts x 800 ms + 1 x 150 ms backoff = 1750 ms.
    it('refuses a wait that expires before the winner can finish', () => {
      const message = failsOn({ ...valid(), BUREAU_WAIT_MS: '1750' }, 'BUREAU_WAIT_MS');
      expect(message).toContain('1750');
    });

    it('refuses a lease shorter than the pull it protects', () => {
      failsOn({ ...valid(), BUREAU_CLAIM_LEASE_MS: '1000' }, 'BUREAU_CLAIM_LEASE_MS');
    });

    it('refuses a poll interval that polls once and gives up', () => {
      failsOn({ ...valid(), BUREAU_WAIT_POLL_MS: '2000' }, 'BUREAU_WAIT_POLL_MS');
    });

    it('rejects the combination an earlier draft of the design shipped', () => {
      // 3 attempts x 2000 ms against a 2-second budget: one timeout consumed it all.
      failsOn({ ...valid(), BUREAU_TIMEOUT_MS: '2000', BUREAU_MAX_ATTEMPTS: '3' }, 'BUREAU_WAIT_MS');
    });
  });

  describe('booleans are parsed, not coerced', () => {
    // z.coerce.boolean() uses JavaScript truthiness, so the string 'false'
    // becomes true — and MIGRATE_ON_BOOT=false would be silently ignored while
    // migrations ran anyway. An environment variable is always a string.
    it.each([
      ['false', false],
      ['0', false],
      ['no', false],
      ['off', false],
      ['', false],
      ['true', true],
      ['1', true],
      ['yes', true],
      ['TRUE', true],
    ])('reads MIGRATE_ON_BOOT=%s as %s', (raw, expected) => {
      expect(loadConfig({ ...valid(), MIGRATE_ON_BOOT: raw }).MIGRATE_ON_BOOT).toBe(expected);
    });

    it('defaults to true when unset', () => {
      expect(loadConfig(valid()).MIGRATE_ON_BOOT).toBe(true);
    });

    it('refuses a value it cannot interpret rather than guessing', () => {
      failsOn({ ...valid(), MIGRATE_ON_BOOT: 'maybe' }, 'MIGRATE_ON_BOOT');
    });
  });

  it('accepts the values shipped in .env.example', () => {
    // .env.example is documentation that people copy. If its numbers do not
    // satisfy the cross-field rules above, every new developer's first boot
    // fails and the file teaches the wrong thing.
    const env: NodeJS.ProcessEnv = {};
    for (const line of readFileSync('.env.example', 'utf8').split('\n')) {
      const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (match?.[1] !== undefined) env[match[1]] = match[2];
    }
    env.SUBJECT_KEY_PEPPER = 'x'.repeat(32); // the one value the file leaves blank on purpose
    delete env.DATABASE_DIRECT_URL;

    expect(() => loadConfig(env)).not.toThrow();
  });
});
