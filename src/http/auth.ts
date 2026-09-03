import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { AppError } from './problem.js';

/**
 * Three scopes, because three different jobs are being done and one leaked
 * token should not enable all of them (docs/00-scope.md §4.8):
 *
 *   submission  create applications, read your own
 *   review      record a human outcome
 *   audit       read everything, write nothing, and read /metrics
 *
 * Separating review from submission is the one that is easy to skip: without
 * it, the party that submits an application can also approve it.
 */
export type Scope = 'submission' | 'review' | 'audit';

export interface Caller {
  readonly clientId: string;
  readonly scope: Scope;
}

declare module 'fastify' {
  interface FastifyRequest {
    caller?: Caller;
  }
}

const BEARER = /^Bearer (.+)$/;

const tokensFor = (config: Config, scope: Scope): ReadonlyMap<string, string> =>
  scope === 'submission' ? config.API_TOKENS : scope === 'review' ? config.REVIEWER_TOKENS : config.AUDITOR_TOKENS;

/**
 * 401 and 403 mean different things and the difference is worth keeping:
 * 401 is "I do not know who you are", 403 is "I know, and this is not yours".
 * A valid submission token on an audit route is the second — telling the
 * integrator their token works but not here is more useful than a blanket 401,
 * and it leaks nothing they do not already know.
 *
 * Lookup is by exact token against a map, so there is no per-character
 * comparison loop of the kind a naive scan over a list would give. That is not
 * the same as a constant-time compare, and the honest description is that the
 * secrets are 128 bits of randomness rather than that the lookup is hardened.
 */
export const requireScope =
  (config: Config, scope: Scope) =>
  async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const header = request.headers.authorization;
    const match = header === undefined ? null : BEARER.exec(header);

    if (match?.[1] === undefined) {
      throw new AppError('UNAUTHENTICATED', 'Provide a bearer token in the Authorization header.');
    }

    const token = match[1];
    const clientId = tokensFor(config, scope).get(token);

    if (clientId === undefined) {
      const knownElsewhere = (['submission', 'review', 'audit'] as const).some(
        (other) => other !== scope && tokensFor(config, other).has(token),
      );
      if (knownElsewhere) {
        throw new AppError('FORBIDDEN', `This token is valid, but not for the ${scope} scope.`);
      }
      throw new AppError('UNAUTHENTICATED', 'The bearer token is not recognised.');
    }

    request.caller = { clientId, scope };
  };
