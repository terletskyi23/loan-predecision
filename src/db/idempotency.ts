import { createHash } from 'node:crypto';
import { canonicalJson } from './audit.js';
import type { Queryable } from './pool.js';

/**
 * Layer 1 of docs/02-idempotency.md: the transport gate.
 *
 * THE KEY IS `(client_id, scope, key)` AND THE CLIENT ID COMES FROM THE TOKEN,
 * never from the body. Two integrators both sending `Idempotency-Key: 1` — which
 * is what a developer testing by hand sends — would collide on a two-part key,
 * and the second would receive the first one's stored response: someone else's
 * verdict, someone else's application id.
 */

export const SUBMIT_SCOPE = 'applications.submit';

/**
 * The fingerprint is of CANONICAL json — keys sorted at every level, `undefined`
 * dropped, array order preserved. Without that, `{a:1,b:2}` and `{b:2,a:1}` hash
 * differently and an honest retry from a client that serialises its object in a
 * different order is rejected as a conflict.
 */
export const fingerprint = (body: unknown): string =>
  createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex');

export type KeyOutcome =
  /** Nobody has used this key. Proceed and create an application. */
  | { readonly kind: 'STARTED' }
  /** A previous holder died after inserting. Continue THAT application; do not create a second. */
  | { readonly kind: 'RESUMED'; readonly applicationId: string }
  /** Completed before. Return the stored body byte for byte. */
  | { readonly kind: 'REPLAY'; readonly body: unknown }
  /** Someone is working on it right now. 409 with Retry-After. */
  | { readonly kind: 'IN_PROGRESS' }
  /** Same key, different request. 422 — the client has a bug, and answering it with someone else's verdict would hide it. */
  | { readonly kind: 'FINGERPRINT_MISMATCH' };

interface KeyRow {
  request_fingerprint: string;
  state: 'IN_PROGRESS' | 'COMPLETED' | 'ABANDONED';
  response_body: unknown;
  application_id: string | null;
  lease_expires_at: Date;
}

export interface ClaimKeyInput {
  readonly clientId: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly now: Date;
  readonly leaseExpiresAt: Date;
  readonly retainUntil: Date;
}

/**
 * Claims the key, or reports why it could not be claimed.
 *
 * The insert and the takeover are ONE statement, so two requests arriving
 * together cannot both decide they are the takeover. What the returned row's
 * `application_id` says is the whole branch: non-null means a previous holder
 * had already created an application and this is a resume; null means a clean
 * start. That column is why the takeover case is correct — an earlier design
 * without it inserted a second application and quietly falsified "the same key
 * twice produces one application" in exactly the case the lease exists for.
 *
 * An `ABANDONED` key is a fresh submission: the orphan sweeper retired both the
 * application and the key, so `application_id` is cleared rather than resumed.
 * No second bureau pull follows, because layer 3 still holds.
 */
export const claimKey = async (db: Queryable, input: ClaimKeyInput): Promise<KeyOutcome> => {
  const { rows } = await db.query<{ application_id: string | null }>(
    `INSERT INTO idempotency_keys
       (client_id, scope, key, request_fingerprint, state, lease_expires_at, expires_at)
     VALUES ($1, $2, $3, $4, 'IN_PROGRESS', $5, $6)
     ON CONFLICT (client_id, scope, key) DO UPDATE
        SET state = 'IN_PROGRESS',
            lease_expires_at = $5,
            expires_at = $6,
            response_body = NULL,
            application_id = CASE
              WHEN idempotency_keys.state = 'ABANDONED' THEN NULL
              ELSE idempotency_keys.application_id
            END
      WHERE idempotency_keys.request_fingerprint = $4
        AND (idempotency_keys.state = 'ABANDONED'
             OR (idempotency_keys.state = 'IN_PROGRESS' AND idempotency_keys.lease_expires_at < $7))
     RETURNING application_id`,
    [input.clientId, SUBMIT_SCOPE, input.key, input.fingerprint, input.leaseExpiresAt, input.retainUntil, input.now],
  );

  const claimed = rows[0];
  if (claimed !== undefined) {
    return claimed.application_id === null
      ? { kind: 'STARTED' }
      : { kind: 'RESUMED', applicationId: claimed.application_id };
  }

  const existing = await db.query<KeyRow>(
    `SELECT request_fingerprint, state, response_body, application_id, lease_expires_at
       FROM idempotency_keys WHERE client_id = $1 AND scope = $2 AND key = $3`,
    [input.clientId, SUBMIT_SCOPE, input.key],
  );

  const row = existing.rows[0];
  // Unreachable in practice: the INSERT either claimed or conflicted. Reported
  // as a mismatch rather than asserted away, because the alternative is a crash
  // on a path that a race could in principle reach.
  if (row === undefined) return { kind: 'FINGERPRINT_MISMATCH' };

  if (row.request_fingerprint !== input.fingerprint) return { kind: 'FINGERPRINT_MISMATCH' };
  if (row.state === 'COMPLETED') return { kind: 'REPLAY', body: row.response_body };
  return { kind: 'IN_PROGRESS' };
};

/**
 * Written in the SAME transaction as the pre-decision.
 *
 * Marking the key complete separately opens a window in which a client replays a
 * stored response for a decision that was rolled back — a verdict the database
 * does not have, handed out as if it did.
 */
export const completeKey = async (
  tx: Queryable,
  input: { clientId: string; key: string; body: unknown },
): Promise<void> => {
  await tx.query(
    `UPDATE idempotency_keys
        SET state = 'COMPLETED', response_body = $4::jsonb
      WHERE client_id = $1 AND scope = $2 AND key = $3`,
    [input.clientId, SUBMIT_SCOPE, input.key, JSON.stringify(input.body)],
  );
};
