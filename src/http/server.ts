import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import Fastify from 'fastify';
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Logger } from 'pino';
import { z, ZodError } from 'zod';
import type { Config } from '../config.js';
import type { Database } from '../db/pool.js';
import type { Metrics } from '../metrics.js';
import { requireScope } from './auth.js';
import { registerRoutes, type Services } from './routes.js';
import { liveSchema, openapiDocument, problemSchema, readySchema } from './openapi.js';
import { CORRELATION_HEADER, correlationIdFrom } from './correlation.js';
import { AppError, toProblem } from './problem.js';

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
  }
}

export interface ServerDependencies {
  readonly config: Config;
  readonly logger: Logger;
  /**
   * Injected rather than imported so the HTTP layer never reaches for `pg`
   * itself, and so the readiness probe can be tested against a database that is
   * genuinely unreachable rather than a mock that pretends to be.
   */
  readonly database: Database;
  readonly metrics: Metrics;
  /**
   * The application, review and audit services. Built by the composition root
   * and handed in, so the HTTP layer constructs nothing and a test can drive a
   * route against a service with a stubbed database.
   */
  readonly services: Services;
}

/**
 * The return type is inferred rather than annotated as FastifyInstance: passing
 * a concrete pino Logger narrows Fastify's logger generic, and widening it back
 * to the default would discard the typing on request.log.
 */
export const buildServer = async ({ config, logger, database, metrics, services }: ServerDependencies) => {
  const app = Fastify({
    loggerInstance: logger,
    // Behind Render's proxy, so the client address comes from the forwarded
    // headers rather than the socket.
    trustProxy: true,
    bodyLimit: 256 * 1024,
  });

  // zod compiles both the request validation and the OpenAPI document, so the
  // two cannot disagree — the schema is written once and read three times.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Registered before any route: @fastify/swagger collects routes through an
  // onRoute hook, and a hook cannot see a route that was declared first.
  await app.register(fastifySwagger, {
    openapi: openapiDocument(),
    transform: jsonSchemaTransform,
    // A schema given an `id` through `.meta()` is emitted as a `$ref` into
    // `components/schemas`, and WITHOUT this the components block stays empty
    // and every one of those refs dangles — Swagger UI renders an unresolvable
    // pointer instead of a body. The route transform alone is not enough; the
    // document transform is what writes the definitions the refs point at.
    transformObject: jsonSchemaTransformObject,
  });

  await app.register(fastifySwaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true, persistAuthorization: true },
    // Assets are served from this origin, not a CDN. A documentation page that
    // fetches its own JavaScript from someone else's domain is a supply chain
    // the deployment does not control.
    staticCSP: true,
  });

  const routes = app.withTypeProvider<ZodTypeProvider>();

  // Every response carries a correlation id, and every error body repeats it.
  // Assigned before anything else runs, so a failure in the very next hook is
  // still traceable. docs/05-api.md §1.
  app.addHook('onRequest', async (request, reply) => {
    request.correlationId = correlationIdFrom(request.headers[CORRELATION_HEADER]);
    reply.header(CORRELATION_HEADER, request.correlationId);
  });

  // Labelled by the ROUTE, never the URL: /v1/applications/{id} as a label
  // value would mint a new time series per application and make the metric
  // useless within a day.
  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? 'unmatched';
    const status = reply.statusCode;
    metrics.httpRequests.inc({ method: request.method, route, status });
    metrics.httpDuration.observe({ method: request.method, route }, reply.elapsedTime / 1000);
    if (status >= 400) {
      metrics.httpErrors.inc({ class: status >= 500 ? '5xx' : '4xx' });
    }
  });

  app.setNotFoundHandler((request, reply) => {
    const error = new AppError('NOT_FOUND', `No route for ${request.method} ${request.url}`);
    void reply.code(error.status).type('application/problem+json').send(toProblem(error, request.correlationId));
  });

  app.setErrorHandler((error, request, reply) => {
    const appError = translate(error);

    // 5xx is ours; log the real thing. 4xx is the caller's; logging every one at
    // error level makes a buggy integrator drown a genuine outage — the same
    // reason docs/05 §8 counts the two classes separately.
    if (appError.status >= 500) {
      request.log.error({ err: error, correlationId: request.correlationId }, 'unhandled error');
    } else {
      request.log.info({ code: appError.code, correlationId: request.correlationId }, 'request rejected');
    }

    void reply
      .code(appError.status)
      .type('application/problem+json')
      .send(toProblem(appError, request.correlationId));
  });

  routes.get(
    '/health/live',
    {
      schema: {
        tags: ['health'],
        summary: 'Liveness',
        description:
          'Touches nothing. A failing liveness probe means "restart me", so a probe that checked a dependency would turn a database outage into a container restart loop.',
        response: { 200: liveSchema },
      },
    },
    async () => {
      // docs/06-failure-modes.md, Operational.
      return { status: 'ok' } as const;
    },
  );

  // Behind the auditor scope rather than open. An earlier draft marked this
  // "none — bind internally in production", which described a deployment shape
  // this service does not have: one instance, one public URL, no second bind.
  // Left open, the outcome mix and pull volumes would be world-readable.
  routes.get(
    '/metrics',
    {
      preHandler: requireScope(config, 'audit'),
      schema: {
        tags: ['operations'],
        summary: 'Prometheus metrics',
        description:
          'Behind the auditor scope, not public: this instance has one public URL and no second bind, so an open endpoint would make the outcome mix and pull volumes world-readable. Nothing scrapes this in v1.',
        security: [{ bearerAuth: [] }],
        response: {
          200: z.string().describe('Prometheus text exposition format'),
          401: problemSchema,
          403: problemSchema,
        },
      },
    },
    async (_request, reply) => {
      void reply.type(metrics.registry.contentType);
      return metrics.registry.metrics();
    },
  );

  routes.get(
    '/health/ready',
    {
      schema: {
        tags: ['health'],
        summary: 'Readiness',
        description:
          'Verifies the database answers. Returns 503 when it does not, so a load balancer stops routing here without the container being killed.',
        response: { 200: readySchema, 503: problemSchema },
      },
    },
    async (request) => {
    // The split matters and is easy to get backwards. Readiness says "do not
    // send me traffic"; liveness says "restart me". A database outage must
    // produce the first and never the second, or the platform restarts healthy
    // containers for the duration of someone else's incident.
      try {
        await database.ping();
        return { status: 'ready' } as const;
      } catch (error) {
        request.log.warn({ err: error, correlationId: request.correlationId }, 'readiness check failed');
        throw new AppError('DATABASE_UNAVAILABLE', 'The database is not reachable.');
      }
    },
  );

  registerRoutes(app, config, services);

  app.log.info({ nodeEnv: config.NODE_ENV }, 'server built');
  return app;
};

export type AppServer = ReturnType<typeof buildServer>;

const translate = (error: unknown): AppError => {
  if (error instanceof AppError) return error;

  if (error instanceof ZodError) {
    return new AppError(
      'VALIDATION_FAILED',
      'The request body failed validation.',
      error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }

  const code = (error as { code?: string } | null)?.code;
  if (code === 'FST_ERR_CTP_EMPTY_JSON_BODY' || code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
    return new AppError('MALFORMED_JSON', 'The request body is not parseable JSON.');
  }
  if (typeof code === 'string' && code.startsWith('FST_ERR_VALIDATION')) {
    return new AppError('VALIDATION_FAILED', 'The request failed validation.');
  }
  if (error instanceof SyntaxError) {
    return new AppError('MALFORMED_JSON', 'The request body is not parseable JSON.');
  }

  // Deliberately opaque. An internal error never carries internal detail to the
  // caller; the correlation id is how support finds the real one in the logs.
  return new AppError('INTERNAL_ERROR', 'The request could not be completed. Quote the correlation id.');
};
