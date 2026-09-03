import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance, RawServerDefault } from 'fastify';
import type { Logger } from 'pino';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { ApplicationService } from '../services/application-service.js';
import type { AuditService } from '../services/audit-service.js';
import type { ReviewService } from '../services/review-service.js';
import type { Envelope } from '../services/envelope.js';
import { requireScope } from './auth.js';
import { problemSchema } from './openapi.js';
import { AppError } from './problem.js';
import {
  auditEventsSchema,
  chainSchema,
  closeReviewSchema,
  preDecisionListSchema,
  replaySchema,
  statusResponseSchema,
  submissionResponseSchema,
  submitApplicationSchema,
} from './schemas.js';

export interface Services {
  readonly applications: ApplicationService;
  readonly reviews: ReviewService;
  readonly audit: AuditService;
}

const uuidParams = z.object({ id: z.string().uuid() });
const applicationParams = z.object({ applicationId: z.string().uuid() });

/** `Retry-After: 3`. The worst-case in-flight submission is ~2.5 s, so `1` sends a compliant client straight into a second 409. */
const RETRY_AFTER_SECONDS = '3';

/**
 * Spelled out rather than left as the bare `FastifyInstance` default: the server
 * is built with a concrete pino logger, which narrows Fastify's logger generic,
 * and generics are invariant. Widening it back to the default here would make
 * this function reject the very instance it is written for.
 */
type App = FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse<IncomingMessage>, Logger>;

export const registerRoutes = (app: App, config: Config, services: Services): void => {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.post(
    '/v1/applications',
    {
      preHandler: requireScope(config, 'submission'),
      schema: {
        tags: ['applications'],
        summary: 'Submit an application and receive a pre-decision',
        description: [
          'Synchronous: validate, screen, look the applicant up at the bureau, decide, persist, answer.',
          '',
          '`Idempotency-Key` is optional but strongly recommended. Without one, a retry after a network',
          'timeout creates a second application — it will NOT create a second bureau enquiry, which is',
          'prevented separately, but it will create a second record. With one, an identical retry returns',
          'the stored response byte for byte and carries `Idempotency-Replayed: true`.',
          '',
          '`preDecision.reasonCodes` may be an empty array. That is correct and happens for exactly one',
          'case: an approval on the terms applied for, which is not adverse action and owes the applicant',
          'no explanation. Read `length === 0` rather than treating the field as absent.',
        ].join('\n'),
        security: [{ bearerAuth: [] }],
        headers: z.object({
          'idempotency-key': z.string().min(1).max(200).optional(),
        }),
        body: submitApplicationSchema,
        response: {
          201: submissionResponseSchema,
          401: problemSchema,
          403: problemSchema,
          409: problemSchema,
          422: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const caller = request.caller;
      if (caller === undefined) throw new AppError('UNAUTHENTICATED', 'No caller on the request.');

      const header = request.headers['idempotency-key'];
      // No key means "no replay protection", and the honest way to implement
      // that is a key nobody will ever send again rather than a second code
      // path through the whole submission. One path, one set of tests.
      const idempotencyKey = typeof header === 'string' && header.length > 0 ? header : `anonymous:${randomUUID()}`;

      const result = await services.applications.submit({
        body: request.body,
        clientId: caller.clientId,
        idempotencyKey,
        correlationId: request.correlationId,
      });

      if (result.kind === 'REPLAYED') {
        // Byte for byte, INCLUDING the original correlationId and decidedAt.
        // Regenerating any of it would let the replay differ from the original,
        // which defeats the point of storing it.
        void reply.header('Idempotency-Replayed', 'true');
        // The stored body was serialised from this very schema on the original
        // request; it is `unknown` here only because it made a round trip
        // through jsonb. Re-validating it would be worse than casting: a schema
        // that has since changed would reject a body we are contractually
        // obliged to return byte for byte.
        return reply.code(201).send(result.body as Envelope);
      }

      return reply.code(201).send(result.envelope);
    },
  );

  routes.get(
    '/v1/applications/:id',
    {
      preHandler: requireScope(config, 'submission'),
      schema: {
        tags: ['applications'],
        summary: 'Read an application and its composed outcome',
        description: [
          'The reason a synchronous API still needs a status call: `MANUAL_REVIEW` is not terminal.',
          '',
          '`preDecision` never changes — it is what the engine concluded, and a human disagreeing with it',
          'does not make it untrue. `outcome` is the composed answer and is the only field that moves.',
          '',
          'Reads are owner-scoped. An unknown id and another client\'s id return the same 404 body:',
          'distinguishing them would turn this endpoint into an oracle confirming which ids are real.',
        ].join('\n'),
        security: [{ bearerAuth: [] }],
        params: uuidParams,
        response: { 200: statusResponseSchema, 401: problemSchema, 403: problemSchema, 404: problemSchema },
      },
    },
    async (request) => {
      const caller = request.caller;
      if (caller === undefined) throw new AppError('UNAUTHENTICATED', 'No caller on the request.');

      const envelope = await services.applications.status(request.params.id, caller.clientId, request.correlationId);
      if (envelope === null) throw new AppError('APPLICATION_NOT_FOUND', 'No such application.');
      return envelope;
    },
  );

  routes.post(
    '/v1/reviews/:applicationId/close',
    {
      preHandler: requireScope(config, 'review'),
      schema: {
        tags: ['reviews'],
        summary: 'Record the outcome of a manual review',
        description: [
          'Records what a PERSON concluded, on criteria this service does not model. It is not a review',
          'workflow: no queue, no assignment, no SLA, no UI.',
          '',
          '`reviewerId` comes from the bearer token and never from the body — a human verdict with no',
          'attributable actor cannot answer "could anyone have altered a verdict after the fact?", and',
          'letting the caller name themselves is the same hole with extra steps.',
          '',
          'The write is conditional on the review still being PENDING, so two concurrent closes produce',
          'one write and one 409. A closed review is never reopened; a mistaken outcome is a new application.',
        ].join('\n'),
        security: [{ bearerAuth: [] }],
        params: applicationParams,
        body: closeReviewSchema,
        response: { 200: statusResponseSchema, 401: problemSchema, 403: problemSchema, 404: problemSchema, 409: problemSchema },
      },
    },
    async (request) => {
      const caller = request.caller;
      if (caller === undefined) throw new AppError('UNAUTHENTICATED', 'No caller on the request.');

      const envelope = await services.reviews.close({
        applicationId: request.params.applicationId,
        outcome: request.body.outcome,
        ...(request.body.approvedAmountMinor === undefined
          ? {}
          : { approvedAmountMinor: request.body.approvedAmountMinor }),
        rationale: request.body.rationale,
        reviewerId: caller.clientId,
        correlationId: request.correlationId,
      });

      if (envelope === null) throw new AppError('APPLICATION_NOT_FOUND', 'No application with a review to close.');
      return envelope;
    },
  );

  routes.get(
    '/v1/audit/applications/:id/events',
    {
      preHandler: requireScope(config, 'audit'),
      schema: {
        tags: ['audit'],
        summary: 'The append-only event trail for one application',
        description:
          'Index 2 is named BUREAU_REPORT_ATTACHED rather than STORED because on the reuse path nothing is written. An audit trail that records a write which did not happen is one nobody can rely on.',
        security: [{ bearerAuth: [] }],
        params: uuidParams,
        response: { 200: auditEventsSchema, 401: problemSchema, 403: problemSchema, 404: problemSchema },
      },
    },
    async (request) => {
      const events = await services.audit.events(request.params.id);
      if (events === null) throw new AppError('APPLICATION_NOT_FOUND', 'No such application.');
      return events;
    },
  );

  routes.get(
    '/v1/audit/applications/:id/chain',
    {
      preHandler: requireScope(config, 'audit'),
      schema: {
        tags: ['audit'],
        summary: 'Verify the hash chain',
        description: [
          'Recomputes every hash and compares. Honest limits, because a verifier that oversells itself is',
          'worse than none: this detects an edit that got past the append-only trigger. It does NOT detect',
          'a consistent rewrite by someone with full database access, and it does not detect TRUNCATION —',
          'delete the last k events and what remains verifies perfectly. `events` is returned so an',
          'external anchor publishing the head hash AND the count would have something to compare against.',
          'That anchor is not built.',
        ].join('\n'),
        security: [{ bearerAuth: [] }],
        params: uuidParams,
        response: { 200: chainSchema, 401: problemSchema, 403: problemSchema, 404: problemSchema },
      },
    },
    async (request) => {
      const chain = await services.audit.chain(request.params.id);
      if (chain === null) throw new AppError('APPLICATION_NOT_FOUND', 'No such application.');
      return chain;
    },
  );

  routes.get(
    '/v1/audit/pre-decisions',
    {
      preHandler: requireScope(config, 'audit'),
      schema: {
        tags: ['audit'],
        summary: 'List pre-decisions, newest first',
        description: 'For the lender\'s own compliance staff. Nobody outside the organisation can list or replay pre-decisions.',
        security: [{ bearerAuth: [] }],
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
        response: { 200: preDecisionListSchema, 401: problemSchema, 403: problemSchema },
      },
    },
    async (request) => services.audit.list(request.query.limit),
  );

  routes.post(
    '/v1/audit/pre-decisions/:applicationId/replay',
    {
      preHandler: requireScope(config, 'audit'),
      schema: {
        tags: ['audit'],
        summary: 'Re-run the engine against the stored inputs',
        description: [
          'Uses the STORED application, the STORED bureau lookup, the policy version RECORDED ON THE',
          'PRE-DECISION, and `submittedAt` as the clock — never today\'s policy, never a fresh bureau call,',
          'never today\'s wall clock. The clock matters: `screen` derives age at maturity from it, so',
          'replaying with now() would turn an applicant who was 74 at maturity into an age decline and',
          'report tampering where there is none.',
          '',
          'It compares the ENGINE\'s verdict, never the composed outcome. A human who overrode a referral',
          'did not tamper with anything, and flagging them would make every legitimate override look like',
          'fraud. An `engineVersion` difference is reported but does not make `match` false on its own —',
          'that is what the column is for.',
        ].join('\n'),
        security: [{ bearerAuth: [] }],
        params: applicationParams,
        response: { 200: replaySchema, 401: problemSchema, 403: problemSchema, 404: problemSchema },
      },
    },
    async (request) => {
      const result = await services.audit.replay(request.params.applicationId);
      if (result === null) throw new AppError('APPLICATION_NOT_FOUND', 'No pre-decision to replay.');
      return result;
    },
  );

  // 409 on an in-flight idempotency key carries Retry-After. Set here rather
  // than at the throw site because the header belongs to the response, and the
  // service layer does not know it is speaking HTTP.
  app.addHook('onSend', async (_request, reply, payload) => {
    if (reply.statusCode === 409 && !reply.hasHeader('Retry-After')) {
      void reply.header('Retry-After', RETRY_AFTER_SECONDS);
    }
    return payload;
  });
};
