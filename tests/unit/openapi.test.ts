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

describe('the document is internally resolvable', () => {
  it('has no $ref that points at nothing', async () => {
    // THIS IS THE TEST THAT WAS MISSING, and its absence shipped a broken
    // reference page. Schemas given an `id` through `.meta()` are emitted as
    // `$ref`s into components/schemas, and the swagger plugin only writes those
    // definitions when a transformObject is registered. Without it the paths
    // referenced eighteen components and the components block was empty: every
    // pointer dangled, and Swagger UI rendered no request body at all.
    //
    // Nothing caught it because every other assertion here reads paths, and a
    // dangling ref is perfectly well-formed JSON.
    const document = await spec();
    const defined = new Set(Object.keys((document as unknown as { components?: { schemas?: Record<string, unknown> } }).components?.schemas ?? {}));

    const refs = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node === null || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (key === '$ref' && typeof value === 'string') refs.add(value);
        else walk(value);
      }
    };
    walk(document);

    expect(refs.size, 'the document should reference its components').toBeGreaterThan(0);
    const dangling = [...refs].filter((ref) => !defined.has(ref.replace('#/components/schemas/', '')));
    expect(dangling).toEqual([]);
  });

  it('prefills the interactive reference with a request a reviewer can send', async () => {
    const document = await spec();
    const schemas = (document as unknown as { components: { schemas: Record<string, { example?: unknown }> } }).components.schemas;
    expect(schemas['SubmitApplicationInput']?.example).toBeDefined();
  });
});
