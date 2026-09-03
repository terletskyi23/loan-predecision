import { z } from 'zod';

/**
 * Configuration is validated once, at boot, before the server binds a port.
 *
 * The alternative — reading process.env where it is needed — turns a typo into
 * a runtime failure under load, on the least convenient path, hours after the
 * deploy that caused it. See docs/01-architecture.md §6.
 *
 * Two rules this file exists to enforce, both of which a plain schema misses:
 *
 *   1. Secrets have no defaults, and in production empty token lists refuse to
 *      start. Auth that is documented as mandatory and defaults to off is worse
 *      than no auth, because it reads as protected.
 *
 *   2. The bureau timing budget is internally consistent. docs/02-idempotency
 *      §4.4 derives five numbers that only work together; an earlier version of
 *      the design paired a 2-second per-attempt timeout with three attempts
 *      against a 2-second end-to-end budget, and nothing anywhere objected.
 *      Now it objects, at boot.
 */

const csv = (value: string): string[] =>
  value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);

/** `clientId:secret` pairs. The client id is what lands in applications.client_id. */
const tokenList = z.string().transform((value, ctx) => {
  const byToken = new Map<string, string>();
  const seenClients = new Set<string>();

  for (const entry of csv(value)) {
    const separator = entry.indexOf(':');
    if (separator <= 0 || separator === entry.length - 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `expected "clientId:secret", got "${entry}"` });
      return z.NEVER;
    }
    const clientId = entry.slice(0, separator);
    const secret = entry.slice(separator + 1);

    if (seenClients.has(clientId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate client id "${clientId}"` });
      return z.NEVER;
    }
    if (byToken.has(secret)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'two clients share one secret' });
      return z.NEVER;
    }
    seenClients.add(clientId);
    byToken.set(secret, clientId);
  }
  return byToken;
});

/**
 * NOT z.coerce.boolean(). That coerces with JavaScript truthiness, so the
 * string 'false' — the most likely value anyone ever writes — becomes `true`,
 * and MIGRATE_ON_BOOT=false is silently ignored. An environment variable is
 * always a string, so the mapping has to be spelled out, and an unrecognised
 * value must be an error rather than a guess.
 */
const bool = z
  .string()
  .transform((value, ctx) => {
    const normalised = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalised)) return true;
    if (['false', '0', 'no', 'off', ''].includes(normalised)) return false;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `expected a boolean, got "${value}"` });
    return z.NEVER;
  });

const int = (min: number, max?: number) =>
  max === undefined ? z.coerce.number().int().min(min) : z.coerce.number().int().min(min).max(max);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: int(1, 65535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    // Application traffic uses the pooled connection string. Migrations must use
    // the direct one: advisory locks are session-scoped and a transaction-mode
    // pooler (Neon's pgBouncer) does not preserve them. Defaults to DATABASE_URL
    // for local Docker, where there is no pooler and the two are the same thing.
    DATABASE_URL: z.string().url(),
    DATABASE_DIRECT_URL: z.string().url().optional(),
    DATABASE_POOL_MAX: int(1, 100).default(10),
    MIGRATE_ON_BOOT: bool.default(true),

    // No default, by design. A defaulted pepper would be a shared secret baked
    // into the image, and every deployment would derive the same subject keys
    // from the same identifiers.
    SUBJECT_KEY_PEPPER: z.string().min(32, 'must be at least 32 characters'),

    API_TOKENS: tokenList,
    REVIEWER_TOKENS: tokenList,
    AUDITOR_TOKENS: tokenList,

    POLICY_VERSION: z.string().min(1),
    POLICY_DIR: z.string().default('./policies'),
    ENGINE_VERSION: z.string().min(1),

    BUREAU_PROVIDER: z.string().min(1).default('MOCKBUREAU'),
    BUREAU_REPORT_TTL_MINUTES: int(1),
    BUREAU_TIMEOUT_MS: int(1),
    BUREAU_MAX_ATTEMPTS: int(1, 10),
    BUREAU_BACKOFF_BASE_MS: int(0),
    BUREAU_CLAIM_LEASE_MS: int(1),
    BUREAU_WAIT_MS: int(1),
    BUREAU_WAIT_POLL_MS: int(1),

    MOCK_BUREAU_FAILURE_MODE: z.enum(['none', 'error', 'timeout', 'flaky']).default('none'),
    MOCK_BUREAU_LATENCY_MS: int(0).default(120),
    MOCK_BUREAU_FAILURES_BEFORE_SUCCESS: int(0).default(2),

    IDEMPOTENCY_RETENTION_HOURS: int(1),
    IDEMPOTENCY_LEASE_SECONDS: int(1),

    ORPHAN_SWEEP_AFTER_MINUTES: int(1),
    ORPHAN_SWEEP_INTERVAL_MINUTES: int(1),
  })
  .superRefine((env, ctx) => {
    const requireTokens = (key: 'API_TOKENS' | 'REVIEWER_TOKENS' | 'AUDITOR_TOKENS'): void => {
      if (env.NODE_ENV === 'production' && env[key].size === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message:
            'must not be empty in production. An empty REVIEWER_TOKENS boots cleanly and turns ' +
            '"the party that submits cannot approve" into "nobody can approve", with every ' +
            'referred application stuck in IN_REVIEW and no error anywhere.',
        });
      }
    };
    requireTokens('API_TOKENS');
    requireTokens('REVIEWER_TOKENS');
    requireTokens('AUDITOR_TOKENS');

    // docs/02-idempotency.md §4.4. The winner's worst case is every attempt
    // timing out, with backoff in between.
    const attempts = env.BUREAU_MAX_ATTEMPTS;
    const worstCaseMs = attempts * env.BUREAU_TIMEOUT_MS + (attempts - 1) * env.BUREAU_BACKOFF_BASE_MS;

    if (env.BUREAU_WAIT_MS <= worstCaseMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BUREAU_WAIT_MS'],
        message:
          `must exceed the winner's worst case (${worstCaseMs} ms). A shorter wait means a ` +
          'losing request gives up while the winner is still succeeding, and reports the bureau ' +
          'unavailable when a good report is about to exist.',
      });
    }
    if (env.BUREAU_CLAIM_LEASE_MS <= worstCaseMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BUREAU_CLAIM_LEASE_MS'],
        message:
          `must exceed the winner's worst case (${worstCaseMs} ms), or a live holder loses its ` +
          'claim mid-pull and a second hard enquiry lands on the applicant.',
      });
    }
    if (env.BUREAU_WAIT_POLL_MS >= env.BUREAU_WAIT_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BUREAU_WAIT_POLL_MS'],
        message: 'must be shorter than BUREAU_WAIT_MS, or the wait polls once and gives up.',
      });
    }
    if (env.ORPHAN_SWEEP_INTERVAL_MINUTES > env.ORPHAN_SWEEP_AFTER_MINUTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ORPHAN_SWEEP_INTERVAL_MINUTES'],
        message: 'sweeping less often than the orphan threshold leaves orphans unresolved for up to two thresholds.',
      });
    }
  });

export type Config = Readonly<z.infer<typeof envSchema>> & { readonly databaseMigrationUrl: string };

/** Pure: takes an environment, returns a config or throws. Testable without a process. */
export const loadConfig = (raw: NodeJS.ProcessEnv): Config => {
  const parsed = envSchema.parse(raw);
  return Object.freeze({
    ...parsed,
    databaseMigrationUrl: parsed.DATABASE_DIRECT_URL ?? parsed.DATABASE_URL,
  });
};

/**
 * Boot entry point. Writes to stderr rather than a logger because the logger is
 * configured from the config that just failed, and exits before anything binds.
 */
export const loadConfigOrExit = (raw: NodeJS.ProcessEnv = process.env): Config => {
  try {
    return loadConfig(raw);
  } catch (error) {
    if (error instanceof z.ZodError) {
      process.stderr.write('Configuration is invalid. The service will not start.\n\n');
      for (const issue of error.issues) {
        const name = issue.path.join('.') || '(root)';
        process.stderr.write(`  ${name}: ${issue.message}\n`);
      }
      process.stderr.write('\nSee .env.example for every variable and the reasoning behind the ones that carry risk.\n');
      process.exit(1);
    }
    throw error;
  }
};
