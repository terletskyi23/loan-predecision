import { readFileSync } from 'node:fs';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { buildServer } from '../../src/http/server.js';
import { createMetrics } from '../../src/metrics.js';
import { testConfig } from '../support/app.js';
import type { Database } from '../../src/db/pool.js'
import { createServices } from '../../src/services/index.js';
import { createFilePolicyStore } from '../../src/policy/loader.js';

/** The spec is generated from route schemas; no statement is ever run. */
const stubDatabase = (): Database => ({
  ping: async () => {},
  close: async () => {},
  query: () => {
    throw new Error('generating the specification runs no statements');
  },
  transaction: () => {
    throw new Error('generating the specification runs no statements');
  },
});

const spec = async () => {
  const app = await buildServer({
    config: testConfig(),
    logger: pino({ level: 'silent' }),
    database: stubDatabase(),
    metrics: createMetrics(),
    services: createServices({
      config: testConfig(),
      database: stubDatabase(),
      policies: createFilePolicyStore('./policies'),
      metrics: createMetrics(),
      logger: pino({ level: 'silent' }),
    }),
  });
  await app.ready();
  const document = app.swagger() as { paths: Record<string, Record<string, unknown>> };
  await app.close();
  return document;
};

describe('the specification is generated, and it is checked against the prose', () => {
  it('documents every route that exists', async () => {
    // One direction only, and deliberately so. Every route the service serves
    // must appear in docs/05-api.md §2 — a route nobody wrote down is the drift
    // that actually costs someone an afternoon.
    //
    // The reverse is expected to differ while the service is being built:
    // docs/05 describes the finished contract, and /v1/applications is
    // documented before it is implemented. Asserting that direction too would
    // mean either deleting the design or writing stub routes to satisfy a test,
    // and both are worse than the gap.
    const document = await spec();
    const prose = readFileSync('docs/05-api.md', 'utf8');

    const undocumented = Object.keys(document.paths).filter((path) => !prose.includes(path));

    expect(undocumented, `routes served but absent from docs/05-api.md §2: ${undocumented.join(', ')}`).toEqual([]);
  });

  it('matches the committed openapi.json', async () => {
    // The file is committed so a reviewer can read the contract without running
    // anything, and CI regenerates it — a route added without a schema, or a
    // schema changed without regenerating, fails the build.
    const document = await spec();
    const committed = JSON.parse(readFileSync('openapi.json', 'utf8'));

    expect(document).toEqual(committed);
  });

  it('declares bearer auth, and marks the routes that require it', async () => {
    const document = await spec() as unknown as {
      components: { securitySchemes: Record<string, unknown> };
      paths: Record<string, Record<string, { security?: unknown[] }>>;
    };

    expect(document.components.securitySchemes).toHaveProperty('bearerAuth');

    // Without this, Swagger UI shows no Authorize button, a reviewer clicks
    // "Try it out" on /metrics, gets 401 and concludes the service is broken.
    expect(document.paths['/metrics']?.get?.security).toBeDefined();
    expect(document.paths['/health/live']?.get?.security).toBeUndefined();
  });

  it('describes the error shape every failure uses', async () => {
    const document = await spec() as unknown as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    expect(Object.keys(document.paths['/metrics']!.get!.responses)).toEqual(
      expect.arrayContaining(['200', '401', '403']),
    );
    expect(Object.keys(document.paths['/health/ready']!.get!.responses)).toEqual(
      expect.arrayContaining(['200', '503']),
    );
  });
});
