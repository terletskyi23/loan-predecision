import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',

    // Integration and API tests share one Postgres database and TRUNCATE
    // between cases. Running files in parallel would let one file's truncate
    // wipe another file's fixtures mid-run. Concurrency inside a single test
    // is explicit and intended; concurrency between files is not.
    // See docs/07-testing.md §2.
    fileParallelism: false,

    // A hung external call should fail the test, not the suite.
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
