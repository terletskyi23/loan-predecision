import Fastify from 'fastify';
import type { Logger } from 'pino';
import { ZodError } from 'zod';
import type { Config } from '../config.js';
import type { Database } from '../db/pool.js';
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
}

/**
 * The return type is inferred rather than annotated as FastifyInstance: passing
 * a concrete pino Logger narrows Fastify's logger generic, and widening it back
 * to the default would discard the typing on request.log.
 */
export const buildServer = ({ config, logger, database }: ServerDependencies) => {
  const app = Fastify({
    loggerInstance: logger,
    // Behind Render's proxy, so the client address comes from the forwarded
    // headers rather than the socket.
    trustProxy: true,
    bodyLimit: 256 * 1024,
  });

  // Every response carries a correlation id, and every error body repeats it.
  // Assigned before anything else runs, so a failure in the very next hook is
  // still traceable. docs/05-api.md §1.
  app.addHook('onRequest', async (request, reply) => {
    request.correlationId = correlationIdFrom(request.headers[CORRELATION_HEADER]);
    reply.header(CORRELATION_HEADER, request.correlationId);
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

  app.get('/health/live', async () => {
    // Touches nothing on purpose. A failing liveness probe means "restart me",
    // and a probe that checks a dependency turns an outage into a restart loop.
    // docs/06-failure-modes.md, Operational.
    return { status: 'ok' };
  });

  app.get('/health/ready', async (request) => {
    // The split matters and is easy to get backwards. Readiness says "do not
    // send me traffic"; liveness says "restart me". A database outage must
    // produce the first and never the second, or the platform restarts healthy
    // containers for the duration of someone else's incident.
    try {
      await database.ping();
      return { status: 'ready' };
    } catch (error) {
      request.log.warn({ err: error, correlationId: request.correlationId }, 'readiness check failed');
      throw new AppError('DATABASE_UNAVAILABLE', 'The database is not reachable.');
    }
  });

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
