import tseslint from 'typescript-eslint';

/**
 * The rule that matters here is the last block.
 *
 * docs/01-architecture.md §1 states that the domain layer "may call nothing".
 * That is the single most load-bearing sentence in the design: it is what makes
 * a pre-decision replayable years later, and therefore what makes the audit
 * claim true rather than aspirational.
 *
 * A sentence in a document is not an enforcement mechanism. ADR-0008 records
 * why this is a lint rule rather than a DI container: a container permits the
 * boundary to be respected, a lint rule refuses to compile it away. It runs in
 * CI in under a second and it fails the build.
 */
export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },

  ...tseslint.configs.recommended,

  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          // `const { omitted: _omitted, ...rest } = env` is how a test builds an
          // environment with one variable missing. The omitted binding is the
          // point of the expression, not an oversight.
          ignoreRestSiblings: true,
        },
      ],
      'no-console': 'error',
    },
  },

  {
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'pg', message: 'The domain layer performs no I/O. See docs/01-architecture.md §1 and ADR-0004.' },
            { name: 'fastify', message: 'The domain layer knows nothing about transport.' },
            { name: 'pino', message: 'The domain layer does not log. Return a result; let the caller record it.' },
            { name: 'prom-client', message: 'The domain layer does not observe itself.' },
          ],
          patterns: [
            {
              group: [
                '**/db', '**/db/**',
                '**/http', '**/http/**',
                '**/bureau', '**/bureau/**',
                '**/services', '**/services/**',
                // src/policy holds the ADAPTER that reads a policy off disk.
                // The policy TYPE lives in src/domain/policy.ts and is imported
                // as './policy.js', which this pattern does not match.
                '**/policy/**',
              ],
              message: 'The domain layer may call nothing. Everything it needs arrives as an argument — that is what makes a pre-decision replayable. See docs/01-architecture.md §1.',
            },
            {
              /**
               * THE ALLOWLIST, and the reason it exists.
               *
               * The four entries in `paths` above name packages that must not
               * reach the domain. That is a denylist, and ADR-0008 claimed
               * something stronger than a denylist can deliver: that adding a
               * domain dependency is "a deliberate act, visible in the diff".
               * It was not — `import axios from 'axios'` in a scorecard file
               * passed, because nothing had thought to forbid axios.
               *
               * This group forbids every bare package import and then names the
               * two the domain may have. Relative imports (`./x.js`, `../x.js`)
               * contain a slash and are not matched, so the domain's own files
               * are unaffected; `node:*` is handled below with its own message.
               *
               * zod validates a value already in memory. decimal.js is
               * arithmetic. Neither reads a clock, a file or a socket, which is
               * the only property the boundary is protecting.
               */
              // A regex rather than a glob group: `group` negations do not
              // exempt relative specifiers here, and a rule that also forbids
              // `./policy.js` forbids the domain from having files.
              //
              //   ^(?!\.)          leave the domain's own relative imports alone
              //   (?!node:)        handled below, with a message about clocks
              //   (?!zod$|decimal\.js$)   the two the domain may have
              //   (?!pg$|fastify$|pino$|prom-client$)  already named above, with better messages
              regex: '^(?!\\.)(?!node:)(?!zod$)(?!decimal\\.js$)(?!pg$)(?!fastify$)(?!pino$)(?!prom-client$).+',
              message:
                'The domain layer may depend on zod and decimal.js and nothing else. Adding a third is a deliberate edit to this file, reviewed like any other change to what a decision is allowed to depend on. See ADR-0008.',
            },
            {
              // The composition-root modules. Not a layer, but the same rule
              // applies for the same reason: a domain function that reads
              // `config` has taken a dependency on the environment it runs in
              // and is no longer replayable from stored inputs, and one that
              // reaches `logger` or `metrics` performs I/O. The original rule
              // listed the four directories and missed these three files.
              group: ['**/config.js', '**/logger.js', '**/metrics.js'],
              message:
                'The domain layer takes no configuration and performs no I/O. Thresholds arrive in the policy argument, the clock arrives as `now`. See docs/01-architecture.md §1 and ADR-0008.',
            },
            {
              group: ['node:*'],
              message: 'No node builtins in the domain layer: no clock, no filesystem, no crypto. The clock is injected (docs/07-testing.md §2).',
            },
          ],
        },
      ],
    },
  },
);
