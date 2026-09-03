import { readdir, readFile } from 'node:fs/promises';
import { Client } from 'pg';
import type { Logger } from 'pino';
import { loadConfigOrExit, type Config } from '../config.js';
import { createLogger } from '../logger.js';

/**
 * Forward-only migrations, applied under an advisory lock.
 *
 * Two decisions carry this file.
 *
 * THE DIRECT CONNECTION. Migrations use `config.databaseMigrationUrl`
 * (DATABASE_DIRECT_URL, falling back to DATABASE_URL), never the pooled string.
 * Advisory locks live on a session, and a transaction-mode pooler does not give
 * you a stable one — through the pooler the lock appears to be taken and is not,
 * which is the worst possible failure for a lock.
 *
 * THE LOCK ITSELF. `MIGRATE_ON_BOOT` with no lock is a race that only appears
 * the first time the platform starts two containers at once, and it corrupts
 * the schema when it does. `pg_advisory_xact_lock` is transaction-scoped, so it
 * is released by COMMIT or ROLLBACK and cannot be leaked by a process that
 * dies mid-migration.
 *
 * Everything happens in ONE transaction: take the lock, read what is applied,
 * apply what is not, record it, commit. All-or-nothing. A second instance
 * blocks on the lock, then wakes up and finds nothing to do.
 */

// Arbitrary but fixed. Any other advisory lock in this database must not reuse it.
const MIGRATION_LOCK_KEY = 8_675_309;

const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url);

const CREATE_LEDGER = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    text        PRIMARY KEY,
    checksum    char(64)    NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
  )
`;

const sha256 = async (input: string): Promise<string> => {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(input, 'utf8').digest('hex');
};

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: number;
}

export const runMigrations = async (config: Config, logger: Logger): Promise<MigrationResult> => {
  const filenames = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql')).sort();

  const client = new Client({
    connectionString: config.databaseMigrationUrl,
    ssl: /sslmode=(require|verify-ca|verify-full)/.test(config.databaseMigrationUrl)
      ? { rejectUnauthorized: true }
      : false,
    // A migration that cannot connect should fail the deploy quickly.
    connectionTimeoutMillis: 10_000,
  });

  await client.connect();
  const applied: string[] = [];

  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(CREATE_LEDGER);

    const ledger = await client.query<{ filename: string; checksum: string }>(
      'SELECT filename, checksum FROM schema_migrations',
    );
    const checksums = new Map(ledger.rows.map((row) => [row.filename, row.checksum]));

    for (const filename of filenames) {
      const sql = await readFile(new URL(filename, MIGRATIONS_DIR), 'utf8');
      const checksum = await sha256(sql);
      const recorded = checksums.get(filename);

      if (recorded !== undefined) {
        // An applied migration that has since been edited is a silent schema
        // divergence between environments. Refusing is the only safe answer:
        // the fix is a new migration, never a rewrite of an old one.
        if (recorded !== checksum) {
          throw new Error(
            `${filename} has already been applied but its contents have changed. ` +
              'Migrations are immutable once applied — add a new file instead.',
          );
        }
        continue;
      }

      logger.info({ filename }, 'applying migration');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [
        filename,
        checksum,
      ]);
      applied.push(filename);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }

  return { applied, alreadyApplied: filenames.length - applied.length };
};

/** CLI entry: `npm run migrate`. */
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfigOrExit();
  const logger = createLogger(config);
  try {
    const result = await runMigrations(config, logger);
    logger.info(result, result.applied.length > 0 ? 'migrations applied' : 'schema already current');
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'migration failed');
    process.exit(1);
  }
}
