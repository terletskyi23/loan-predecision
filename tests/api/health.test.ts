import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { createDatabase } from '../../src/db/pool.js';
import { testApp, testConfig } from '../support/app.js';

/**
 * The split between the two probes is the point of this file. Confusing them
 * means a platform either restarts a healthy container during someone else's
 * database incident, or keeps routing traffic to a broken one.
 */
describe('liveness and readiness are not the same question', () => {
  it('reports ready when the database answers', async () => {
    const response = await (await testApp()).inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready' });
  });

  it('reports 503 with the catalogue code when the database does not', async () => {
    const app = await testApp({
      database: {
        ping: async () => {
          throw new Error('connection refused');
        },
        close: async () => {},
      },
    });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({ code: 'DATABASE_UNAVAILABLE', status: 503 });
  });

  it('keeps liveness at 200 while readiness is failing', async () => {
    // The assertion that matters. If liveness followed the database, the
    // platform would restart this container instead of routing around it, and
    // the restart loop would outlast the outage that caused it.
    const app = await testApp({
      database: {
        ping: async () => {
          throw new Error('connection refused');
        },
        close: async () => {},
      },
    });

    const [live, ready] = await Promise.all([
      app.inject({ method: 'GET', url: '/health/live' }),
      app.inject({ method: 'GET', url: '/health/ready' }),
    ]);

    expect(live.statusCode).toBe(200);
    expect(ready.statusCode).toBe(503);
  });

  it('does not leak the database error to the caller', async () => {
    const app = await testApp({
      database: {
        ping: async () => {
          throw new Error('password authentication failed for user "postgres"');
        },
        close: async () => {},
      },
    });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.payload).not.toContain('password');
    expect(response.payload).not.toContain('postgres');
  });
});

describe('the real pool, against a port with nothing behind it', () => {
  // Not a mock. This exercises the actual pg pool and the deadline in
  // src/db/pool.ts, which is the code path a real outage takes.
  it('fails readiness rather than hanging', async () => {
    const config = testConfig({ DATABASE_URL: 'postgres://u:p@127.0.0.1:1/nothing' });
    const database = createDatabase(config, pino({ level: 'silent' }));
    const app = await testApp({ config, database });

    const started = Date.now();
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    const elapsed = Date.now() - started;

    expect(response.statusCode).toBe(503);
    // The bound is the assertion: a probe that eventually fails after 30s is
    // reported by the platform as a timeout, not as an unready instance.
    expect(elapsed).toBeLessThan(6_000);

    await database.close();
  });
});
