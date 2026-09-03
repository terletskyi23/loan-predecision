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
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
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
              group: ['**/db', '**/db/**', '**/http', '**/http/**', '**/bureau', '**/bureau/**', '**/services', '**/services/**'],
              message: 'The domain layer may call nothing. Everything it needs arrives as an argument — that is what makes a pre-decision replayable. See docs/01-architecture.md §1.',
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
