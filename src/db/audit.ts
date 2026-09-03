import { createHash } from 'node:crypto';
import type { Queryable } from './pool.js';

/**
 * The per-application audit chain. docs/04-audit.md §3.
 *
 *   hash[i] = sha256( hash[i-1] ‖ canonicalJson(event[i]) )
 *
 * PER APPLICATION, NOT GLOBAL. A global chain serialises every write in the
 * service through one tail pointer. Per-application chains are independent, and
 * every write for one application already happens inside that application's
 * transaction, so the ordering is free.
 *
 * THE PRIMARY KEY IS THE CONCURRENCY GUARANTEE. `(application_id, chain_index)`
 * means a concurrent double-append violates a constraint rather than silently
 * forking the chain into two branches that both look valid.
 *
 * APPLICATION ID AND INDEX ARE HASHED AS PART OF THE EVENT, not merely stored
 * alongside it, so one application's chain cannot be transplanted onto
 * another's. The formula above does not make that obvious, which is why it is
 * stated here and in the migration.
 */

export const GENESIS_HASH = '0'.repeat(64);

export type AuditEventType =
  | 'APPLICATION_RECEIVED'
  | 'SCREENING_FAILED'
  | 'BUREAU_PULL_REQUESTED'
  | 'BUREAU_REPORT_ATTACHED'
  | 'BUREAU_UNAVAILABLE'
  | 'PRE_DECISION_MADE'
  | 'REVIEW_OPENED'
  | 'REVIEW_CLOSED'
  | 'APPLICATION_ABANDONED';

export interface AuditEventInput {
  readonly applicationId: string;
  readonly eventType: AuditEventType;
  /** A client id, a reviewer id, or `system` for the sweeper. Never a free-text label. */
  readonly actor: string;
  readonly payload: Record<string, unknown>;
  readonly occurredAt: Date;
}

export interface AuditEvent extends AuditEventInput {
  readonly chainIndex: number;
  readonly prevHash: string;
  readonly hash: string;
}

/**
 * Deterministic JSON: object keys sorted at every depth.
 *
 * `JSON.stringify` preserves insertion order, so two runs that build the same
 * payload by different code paths produce different bytes and therefore
 * different hashes. A chain that fails to verify because a key moved is worse
 * than no chain: it cries tampering at a refactor, and the real alarm stops
 * being believed.
 */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
};

export const hashEvent = (prevHash: string, event: Omit<AuditEvent, 'hash' | 'prevHash'>): string =>
  createHash('sha256')
    .update(prevHash, 'utf8')
    .update(
      canonicalJson({
        applicationId: event.applicationId,
        chainIndex: event.chainIndex,
        eventType: event.eventType,
        actor: event.actor,
        payload: event.payload,
        occurredAt: event.occurredAt.toISOString(),
      }),
      'utf8',
    )
    .digest('hex');

interface TailRow {
  next_index: string;
  head_hash: string | null;
}

/**
 * Appends one event at the next index.
 *
 * Reading the tail and inserting are two statements, and between them another
 * transaction could append at the same index. That race resolves in the primary
 * key, not here: the loser's INSERT fails and its whole transaction rolls back,
 * which is the correct outcome — a forked chain would be worse than a failed
 * write.
 */
export const appendAuditEvent = async (tx: Queryable, input: AuditEventInput): Promise<AuditEvent> => {
  const { rows } = await tx.query<TailRow>(
    `SELECT coalesce(max(chain_index) + 1, 0)::text AS next_index,
            (SELECT hash FROM audit_events
              WHERE application_id = $1
              ORDER BY chain_index DESC LIMIT 1) AS head_hash
       FROM audit_events
      WHERE application_id = $1`,
    [input.applicationId],
  );

  const tail = rows[0];
  const chainIndex = Number(tail?.next_index ?? '0');
  const prevHash = tail?.head_hash ?? GENESIS_HASH;
  const hash = hashEvent(prevHash, { ...input, chainIndex });

  await tx.query(
    `INSERT INTO audit_events
       (application_id, chain_index, event_type, actor, payload, occurred_at, prev_hash, hash)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
    [
      input.applicationId,
      chainIndex,
      input.eventType,
      input.actor,
      JSON.stringify(input.payload),
      input.occurredAt,
      prevHash,
      hash,
    ],
  );

  return { ...input, chainIndex, prevHash, hash };
};

interface AuditRow {
  chain_index: number;
  event_type: AuditEventType;
  actor: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  prev_hash: string;
  hash: string;
}

export const readAuditChain = async (db: Queryable, applicationId: string): Promise<readonly AuditEvent[]> => {
  const { rows } = await db.query<AuditRow>(
    `SELECT chain_index, event_type, actor, payload, occurred_at, prev_hash, hash
       FROM audit_events WHERE application_id = $1 ORDER BY chain_index`,
    [applicationId],
  );

  return rows.map((row) => ({
    applicationId,
    chainIndex: row.chain_index,
    eventType: row.event_type,
    actor: row.actor,
    payload: row.payload,
    occurredAt: row.occurred_at,
    prevHash: row.prev_hash,
    hash: row.hash,
  }));
};

export interface ChainVerification {
  readonly intact: boolean;
  readonly events: number;
  readonly headHash: string | null;
  /** The first index whose stored hash disagrees with a recomputation, if any. */
  readonly brokenAt: number | null;
}

/**
 * Recomputes every hash and compares.
 *
 * THE HONEST LIMITS, because a verifier that oversells itself is worse than
 * none. This detects an edit that got past the append-only trigger. It does NOT
 * detect a consistent rewrite by someone with full database access, and it does
 * not detect TAIL TRUNCATION at all — delete the last k events and what remains
 * verifies perfectly. Dropping PRE_DECISION_MADE and REVIEW_CLOSED is exactly
 * the alteration an audit looks for, and it is strictly easier than a rewrite.
 *
 * The mitigation for both is the same and is not built: an anchor outside this
 * database publishing the head hash AND the event count somewhere the lender
 * does not control. `events` is returned here so that anchor has something to
 * compare against when it exists.
 */
export const verifyAuditChain = async (db: Queryable, applicationId: string): Promise<ChainVerification> => {
  const events = await readAuditChain(db, applicationId);

  let expectedPrev = GENESIS_HASH;
  for (const [position, event] of events.entries()) {
    const recomputed = hashEvent(expectedPrev, event);
    if (event.prevHash !== expectedPrev || event.hash !== recomputed || event.chainIndex !== position) {
      return { intact: false, events: events.length, headHash: events.at(-1)?.hash ?? null, brokenAt: position };
    }
    expectedPrev = event.hash;
  }

  return { intact: true, events: events.length, headHash: events.at(-1)?.hash ?? null, brokenAt: null };
};
