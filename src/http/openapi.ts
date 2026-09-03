import { z } from 'zod';
import { problemExample } from './examples.js';
import { PROBLEMS } from './problem.js';

/**
 * The OpenAPI document, and the schemas the routes are declared with.
 *
 * The point of this file is not documentation — docs/05-api.md is better
 * documentation than OpenAPI can be, because it carries worked examples and the
 * reasoning behind each error code, and a schema format carries neither. The
 * point is that a specification GENERATED FROM THE ROUTES cannot drift from the
 * code, while prose can. One zod schema per route produces three things at once:
 * request validation, TypeScript types, and this document.
 *
 * ADR-0009 records the decision, including what it costs.
 */

export const problemSchema = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    detail: z.string(),
    code: z.enum(Object.keys(PROBLEMS) as [string, ...string[]]),
    errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
    correlationId: z.string(),
  })
  .meta({
    id: 'Problem',
    description: 'RFC 7807. Every error this service returns has this shape, including 404s for unknown routes.',
    example: problemExample,
  });

export const liveSchema = z.object({ status: z.literal('ok') });
export const readySchema = z.object({ status: z.literal('ready') });

/**
 * The version of the API CONTRACT, not of the engine. ENGINE_VERSION changes
 * whenever the arithmetic changes and is stamped on every pre-decision for
 * replay; this changes only when the shape of the API does. Keeping them
 * separate also makes the committed openapi.json deterministic, which is what
 * lets CI diff it.
 */
export const API_VERSION = '1.0.0';

export const openapiDocument = () => ({
  openapi: '3.1.0',
  info: {
    title: 'Instant Loan Pre-Decision API',
    version: API_VERSION,
    description: [
      'Accepts a loan application and returns an automated **pre-decision** with stable reason codes.',
      '',
      'This is not the final credit decision. Where an application is referred, a person at the lender',
      'decides on criteria this service does not model, and that outcome is a separate record.',
      '',
      'The reasoning behind every field and error code is in `docs/05-api.md`; this document is the',
      'machine-readable half, generated from the route schemas so it cannot drift from the code.',
    ].join('\n'),
  },
  servers: [
    { url: 'https://loan-predecision.onrender.com', description: 'Deployed instance (free tier; first request after a quiet period is slow)' },
    { url: 'http://localhost:3000', description: 'Local' },
  ],
  tags: [
    { name: 'health', description: 'Liveness and readiness. They answer different questions.' },
    { name: 'operations', description: 'Metrics. Behind the auditor scope, not public.' },
    { name: 'applications', description: 'Submit an application and read its status.' },
    { name: 'reviews', description: 'Record the outcome of a manual review.' },
    { name: 'audit', description: 'Evidence: the event chain, and replay of a stored pre-decision.' },
  ],
  components: {
    securitySchemes: {
      // Three scopes, one scheme. Which token opens which route is stated per
      // route rather than here, because the whole point of splitting them is
      // that a submission token must not open an audit route.
      bearerAuth: {
        type: 'http' as const,
        scheme: 'bearer',
        description: [
          'A bearer token in the form the service was configured with.',
          '',
          'Three separate lists exist — submission, review and audit — and a token valid for one scope',
          'returns 403 on another. Use the **Authorize** button; the demo token is in the submission email.',
        ].join('\n'),
      },
    },
  },
});
