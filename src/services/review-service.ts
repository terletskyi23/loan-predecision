import { appendAuditEvent } from '../db/audit.js';
import { setApplicationStatus, findApplicationForAudit } from '../db/applications.js';
import type { Database } from '../db/pool.js';
import { closeReview, findReview } from '../db/reviews.js';
import { AppError } from '../http/problem.js';
import type { PolicyStore } from '../policy/loader.js';
import { buildStatus, type StatusEnvelope } from './envelope.js';

/**
 * Records what a PERSON concluded. Deliberately not a manual-review workflow.
 *
 * There is no queue, no assignment, no SLA and no reviewer UI — those are out of
 * scope and stay out. This exists because without it the audit chain has a
 * `REVIEW_CLOSED` event nothing can emit, and a referred application has no
 * terminal state. The workflow belongs to another system; the record of what it
 * decided belongs here.
 */

export interface CloseReviewCommand {
  readonly applicationId: string;
  readonly outcome: 'APPROVED' | 'DECLINED';
  readonly approvedAmountMinor?: number;
  readonly rationale: string;
  /** From the bearer token, never from the body. A reviewer id a caller can choose is not an attribution. */
  readonly reviewerId: string;
  readonly correlationId: string;
}

export const createReviewService = (options: { database: Database; policies: PolicyStore; now?: () => Date }) => {
  const { database, policies } = options;
  const clock = options.now ?? ((): Date => new Date());

  return {
    async close(command: CloseReviewCommand): Promise<StatusEnvelope | null> {
      const application = await findApplicationForAudit(database, command.applicationId);
      if (application === null) return null;

      const existing = await findReview(database, command.applicationId);
      // No review row means the engine never referred this application. Closing
      // a review that was never opened would fabricate a human decision on an
      // automated verdict.
      if (existing === null) return null;

      const closedAt = clock();

      return database.transaction(async (tx) => {
        const closed = await closeReview(tx, {
          applicationId: command.applicationId,
          outcome: command.outcome,
          approvedAmountMinor: command.approvedAmountMinor ?? null,
          reviewerId: command.reviewerId,
          rationale: command.rationale,
          closedAt,
        });

        // The conditional update matched nothing, which means someone else
        // closed it first. Two humans, two opinions — and the second must not
        // silently overwrite the first, so it is told.
        if (closed === null) {
          throw new AppError('REVIEW_ALREADY_CLOSED', 'This review has already been closed. A closed review is never reopened.');
        }

        await setApplicationStatus(tx, command.applicationId, 'REVIEW_CLOSED');
        await appendAuditEvent(tx, {
          applicationId: command.applicationId,
          eventType: 'REVIEW_CLOSED',
          actor: `reviewer:${command.reviewerId}`,
          payload: {
            outcome: command.outcome,
            approvedAmountMinor: command.approvedAmountMinor ?? null,
            rationale: command.rationale,
          },
          occurredAt: closedAt,
        });

        return buildStatus(tx, policies, { ...application, status: 'REVIEW_CLOSED' }, command.correlationId);
      });
    },
  };
};

export type ReviewService = ReturnType<typeof createReviewService>;
