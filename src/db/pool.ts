import { Pool, type QueryResult, type QueryResultRow } from 'pg';
import type { Logger } from 'pino';
import type { Config } from '../config.js';

/**
 * One pool for application traffic. Migrations use a separate, direct
 * connection (src/db/migrate.ts) because advisory locks need a real session and
 * a transaction-mode pooler does not preserve one.
 */

/**
 * Anything a statement can be run against: the pool, or one client inside a
 * transaction.
 *
 * Repositories take this as their first argument rather than holding a
 * connection of their own, which is what lets the SAME function run inside the
 * closing transaction and outside it. A repository bound to a pool at
 * construction cannot participate in a transaction it did not open, and the
 * usual escape — a second "transactional" copy of every method — is where the
 * two copies drift.
 */
export interface Queryable {
  query<T extends QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<T>>;
}

export interface Database extends Queryable {
  /** Rejects if the database cannot answer. Used by the readiness probe. */
  ping(): Promise<void>;
  close(): Promise<void>;

  /**
   * BEGIN, run, COMMIT — or ROLLBACK on any throw.
   *
   * The closing writes of a submission are one transaction: the pre-decision,
   * the review row, the closing audit events and the idempotency key's
   * completion. Split them and there are two silent failure windows — a
   * decision with no trail, or a client replaying a stored response for a
   * decision that was rolled back.
   */
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
}

/**
 * TLS is decided by the connection string rather than by an environment flag.
 * A managed provider hands out `?sslmode=require`; local Docker does not offer
 * TLS at all. A boolean env var for this is the kind of knob that ends up
 * `false` in production exactly once.
 */
const sslFor = (connectionString: string): false | { rejectUnauthorized: true } =>
  /sslmode=(require|verify-ca|verify-full)/.test(connectionString) ? { rejectUnauthorized: true } : false;

const PING_DEADLINE_MS = 2_000;

/**
 * `pg` has no cancellation, so a deadline is a race. The underlying query is
 * left to finish and release its client; what is bounded is how long the caller
 * waits, which is the part the probe cares about.
 */
const withDeadline = async <T>(work: Promise<T>, ms: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`database did not answer within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export const createDatabase = (config: Config, logger: Logger): Database => {
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: config.DATABASE_POOL_MAX,
    ssl: sslFor(config.DATABASE_URL),

    // Without a connect timeout, a dependency that hangs rather than refusing
    // saturates the pool while the error rate stays clean — the failure mode
    // docs/02-review-lens calls out and the one that is hardest to see.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,

    // A query that outlives the request budget is not worth completing.
    statement_timeout: 10_000,
    query_timeout: 10_000,
  });

  // An idle client erroring out must not take the process with it: `pg` emits
  // this on the pool, and an unhandled 'error' event is a hard crash.
  pool.on('error', (error) => {
    logger.error({ err: error }, 'idle database client errored');
  });

  return {
    async query<T extends QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<T>> {
      return pool.query<T>(text, values as unknown[] | undefined);
    },

    async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work({
          query: async <R extends QueryResultRow>(text: string, values?: readonly unknown[]) =>
            client.query<R>(text, values as unknown[] | undefined),
        });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        // A rollback that itself fails must not replace the original error:
        // the second one is a symptom and the first one is the cause.
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async ping() {
      // Its own short deadline, enforced here rather than by the driver. A
      // readiness probe that hangs is worse than one that fails: the platform
      // sees a timeout instead of a 503, and cannot tell "database down" from
      // "instance wedged" — which are opposite problems with opposite fixes.
      await withDeadline(
        (async () => {
          const client = await pool.connect();
          try {
            await client.query('SELECT 1');
          } finally {
            client.release();
          }
        })(),
        PING_DEADLINE_MS,
      );
    },
    async close() {
      await pool.end();
    },
  };
};
