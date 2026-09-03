import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { BureauGateway } from '../bureau/gateway.js';
import { deriveSubjectKey } from '../bureau/subject-key.js';
import type { Config } from '../config.js';
import { appendAuditEvent } from '../db/audit.js';
import {
  findApplication,
  insertApplication,
  setApplicationStatus,
  type ApplicationRecord,
} from '../db/applications.js';
import { SUBMIT_SCOPE, claimKey, completeKey, fingerprint } from '../db/idempotency.js';
import { findPreDecision, insertPreDecision } from '../db/pre-decisions.js';
import type { Database, Queryable } from '../db/pool.js';
import { findReview, openReview } from '../db/reviews.js';
import type { LookupFailureCause } from '../domain/bureau-lookup.js';
import { decide, screen, UnknownProductError, type EngineApplication } from '../domain/engine.js';
import type { Policy } from '../domain/policy.js';
import type { Metrics } from '../metrics.js';
import type { PolicyStore } from '../policy/loader.js';
import { AppError } from '../http/problem.js';
import type { SubmitApplicationBody } from '../http/schemas.js';
import { buildEnvelope, buildStatus, engineApplicationFrom, type Envelope, type StatusEnvelope } from './envelope.js';

/**
 * The orchestrator. It assembles infrastructure results and hands them to a
 * domain that can reach nothing on its own.
 *
 * The ORDER of the five steps below is the design, and each is load-bearing:
 *
 *   1. Validation before anything is claimed. A malformed body, or a consent
 *      attestation older than the policy window, burns no idempotency key,
 *      creates no row and touches no bureau.
 *   2. The application is persisted BEFORE the bureau is called, and its id is
 *      written onto the key row in the same statement. An application is a
 *      business event: if the bureau then fails, the record still exists — and
 *      the id on the key row is what makes a lease takeover resume it.
 *   3. Screening before the pull. The cheapest guard is also the one with an
 *      ethical consequence.
 *   4. Reuse before the claim, so the common case takes no lock.
 *   5. The closing writes are ONE transaction. Split them and there are two
 *      silent failure windows: a decision with no trail, or a client replaying
 *      a response for a decision that was rolled back.
 */

export interface SubmitCommand {
  readonly body: SubmitApplicationBody;
  readonly clientId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

export type SubmitResult =
  | { readonly kind: 'DECIDED'; readonly envelope: Envelope }
  | { readonly kind: 'REPLAYED'; readonly body: unknown };

export interface ApplicationServiceOptions {
  readonly config: Config;
  readonly database: Database;
  readonly gateway: BureauGateway;
  readonly policies: PolicyStore;
  readonly metrics: Metrics;
  readonly logger: Logger;
  readonly now?: () => Date;
}

const MS_PER_HOUR = 3_600_000;

export const createApplicationService = (options: ApplicationServiceOptions) => {
  const { config, database, gateway, policies, metrics } = options;
  const clock = options.now ?? ((): Date => new Date());

  /**
   * Consent freshness is POLICY, but a stale attestation is a VALIDATION
   * failure rather than a decline: the request is malformed, no application
   * exists, and nothing is recorded. Collapsing the two would put "your
   * integrator sent a bad timestamp" into the applicant's adverse action trail.
   */
  const assertConsentIsUsable = (body: SubmitApplicationBody, policy: Policy, now: Date): void => {
    if (!body.consent.attestedByCaller) {
      // ADR-0007: the attestation is mandatory at the edge, and the CHECK on
      // `applications.consent_attested` makes it impossible to bypass the edge
      // and insert one anyway. This is the edge.
      throw new AppError('CONSENT_REQUIRED', 'consent.attestedByCaller must be true. No enquiry is made without it.');
    }

    const acceptedAt = new Date(body.consent.acceptedAt);
    const skewMs = policy.consent.allowedFutureSkewSeconds * 1_000;

    if (acceptedAt.getTime() > now.getTime() + skewMs) {
      throw new AppError('CONSENT_STALE', 'consent.acceptedAt is in the future.');
    }
    if (now.getTime() - acceptedAt.getTime() > policy.consent.maxAgeHours * MS_PER_HOUR) {
      throw new AppError(
        'CONSENT_STALE',
        `consent.acceptedAt is older than ${String(policy.consent.maxAgeHours)} hours. An attestation that old records nothing useful.`,
      );
    }
  };

  const assertProductIsKnown = (body: SubmitApplicationBody, policy: Policy): void => {
    const product = policy.products[body.productCode];
    if (product === undefined) {
      throw new AppError('UNKNOWN_PRODUCT', `No product "${body.productCode}" in policy ${policy.version}.`);
    }
    if (body.currency !== policy.currency) {
      throw new AppError('VALIDATION_FAILED', `This product is priced in ${policy.currency}.`);
    }
  };

  const persistApplication = async (
    body: SubmitApplicationBody,
    clientId: string,
    idempotencyKey: string,
    subjectKey: string,
    now: Date,
  ): Promise<ApplicationRecord> => {
    const record: ApplicationRecord = {
      id: randomUUID(),
      clientId,
      status: 'RECEIVED',
      productCode: body.productCode,
      requestedAmountMinor: body.requestedAmountMinor,
      termMonths: body.termMonths,
      currency: body.currency,
      purpose: body.purpose,
      channel: body.channel,
      applicant: {
        firstName: body.applicant.firstName,
        lastName: body.applicant.lastName,
        dateOfBirth: body.applicant.dateOfBirth,
        ...(body.applicant.email === undefined ? {} : { email: body.applicant.email }),
        ...(body.applicant.phone === undefined ? {} : { phone: body.applicant.phone }),
        residenceCountry: body.applicant.residenceCountry,
      },
      finances: {
        monthlyIncomeMinor: body.finances.monthlyIncomeMinor,
        employmentStatus: body.finances.employmentStatus,
        ...(body.finances.employmentMonths === undefined ? {} : { employmentMonths: body.finances.employmentMonths }),
        declaredMonthlyObligationsMinor: body.finances.declaredMonthlyObligationsMinor,
      },
      subjectKey,
      customerId: body.customerId ?? null,
      consentAttested: body.consent.attestedByCaller,
      consentAcceptedAt: new Date(body.consent.acceptedAt),
      submittedAt: now,
    };

    await database.transaction(async (tx) => {
      await insertApplication(tx, record, { clientId, scope: SUBMIT_SCOPE, key: idempotencyKey });
      await appendAuditEvent(tx, {
        applicationId: record.id,
        eventType: 'APPLICATION_RECEIVED',
        actor: `client:${clientId}`,
        payload: {
          consentAttestedAt: record.consentAcceptedAt.toISOString(),
          productCode: record.productCode,
          requestedAmountMinor: record.requestedAmountMinor,
          termMonths: record.termMonths,
          channel: record.channel,
        },
        occurredAt: now,
      });
    });

    return record;
  };

  return {
    async submit(command: SubmitCommand): Promise<SubmitResult> {
      const now = clock();
      const policy = await policies.get(config.POLICY_VERSION);

      // ------------------------------------------------------------ 1
      assertProductIsKnown(command.body, policy);
      assertConsentIsUsable(command.body, policy, now);

      const outcome = await claimKey(database, {
        clientId: command.clientId,
        key: command.idempotencyKey,
        fingerprint: fingerprint(command.body),
        now,
        leaseExpiresAt: new Date(now.getTime() + config.IDEMPOTENCY_LEASE_SECONDS * 1_000),
        retainUntil: new Date(now.getTime() + config.IDEMPOTENCY_RETENTION_HOURS * MS_PER_HOUR),
      });

      if (outcome.kind === 'REPLAY') return { kind: 'REPLAYED', body: outcome.body };
      if (outcome.kind === 'IN_PROGRESS') {
        throw new AppError('IDEMPOTENT_REQUEST_IN_PROGRESS', 'This idempotency key is being processed. Retry shortly.');
      }
      if (outcome.kind === 'FINGERPRINT_MISMATCH') {
        // Answering with the first request's verdict would hide the caller's
        // bug and hand them a decision about a different application.
        throw new AppError('IDEMPOTENCY_KEY_REUSED', 'This idempotency key was used for a different request body.');
      }

      // ------------------------------------------------------------ 2
      const subjectKey = deriveSubjectKey(command.body.applicant.nationalId, config.SUBJECT_KEY_PEPPER);

      let application: ApplicationRecord;
      if (outcome.kind === 'RESUMED') {
        const existing = await findApplication(database, outcome.applicationId, command.clientId);
        // The key row points at an application that vanished. Not reachable —
        // nothing deletes applications — so this is a corrupted-state signal
        // rather than a case to paper over with a fresh insert.
        if (existing === null) throw new AppError('INTERNAL_ERROR', 'The resumed application could not be read.');
        application = existing;

        const already = await findPreDecision(database, application.id);
        if (already !== null) {
          const envelope = await buildEnvelope(database, policies, application, command.correlationId);
          return { kind: 'DECIDED', envelope };
        }
      } else {
        application = await persistApplication(
          command.body,
          command.clientId,
          command.idempotencyKey,
          subjectKey,
          now,
        );
      }

      const engineApplication: EngineApplication = engineApplicationFrom(application);

      // ------------------------------------------------------------ 3
      let verdict;
      let reportId: string | null = null;
      let reused = false;
      // Typed, not `string`. It is an engine input on the replay path and a
      // constrained column since migration 004, and the cast that used to sit at
      // the insert was the tell that it had been widened on the way through.
      let failureCause: LookupFailureCause | null = null;
      let bureauOutcome: string | null = null;

      try {
        const knockout = screen(engineApplication, policy, application.submittedAt);

        if (knockout !== null) {
          // No bureau call. The whole point of splitting the engine in two.
          verdict = {
            verdict: knockout.verdict,
            stage: knockout.stage,
            reasonCodes: knockout.reasonCodes,
            approvedAmountMinor: null,
            monthlyPaymentMinor: null,
            offerExpiresAt: null,
            score: null,
            dti: null,
            scorecard: null,
          };
        } else {
          // ---------------------------------------------------------- 4
          const lookup = await gateway.getReport({
            nationalId: command.body.applicant.nationalId,
            subjectKey,
            applicationId: application.id,
            clientId: command.clientId,
            now,
            onPullRequested: async () => {
              // Its own transaction, appended BEFORE the network call. Deferring
              // it to the end would mean a process dying mid-pull leaves no
              // record that this person's credit file was marked — the one harm
              // the deduplication exists to prevent, erased by the crash that
              // caused it.
              await appendAuditEvent(database, {
                applicationId: application.id,
                eventType: 'BUREAU_PULL_REQUESTED',
                actor: 'system',
                payload: { provider: config.BUREAU_PROVIDER },
                occurredAt: clock(),
              });
            },
          });

          reportId = lookup.reportId;
          reused = lookup.reused;
          failureCause = lookup.failureCause;
          bureauOutcome = lookup.lookup.outcome;
          verdict = decide(engineApplication, lookup.lookup, policy, application.submittedAt);
        }
      } catch (error) {
        if (error instanceof UnknownProductError) {
          throw new AppError('UNKNOWN_PRODUCT', error.message);
        }
        throw error;
      }

      // ------------------------------------------------------------ 5
      const decidedAt = clock();
      const status = verdict.verdict === 'MANUAL_REVIEW' ? 'IN_REVIEW' : 'PRE_DECIDED';

      const closeSubmission = async (): Promise<Envelope> =>
        database.transaction(async (tx) => {
        await insertPreDecision(tx, {
          applicationId: application.id,
          verdict: verdict.verdict,
          reasonCodes: verdict.reasonCodes,
          requestedAmountMinor: application.requestedAmountMinor,
          approvedAmountMinor: verdict.approvedAmountMinor,
          monthlyPaymentMinor: verdict.monthlyPaymentMinor,
          offerExpiresAt: verdict.offerExpiresAt,
          score: verdict.score,
          dti: verdict.dti,
          policyVersion: policy.version,
          engineVersion: config.ENGINE_VERSION,
          bureauReportId: reportId,
          bureauReportReused: reused,
          lookupFailureCause: failureCause,
          decidedAt,
        });

        await setApplicationStatus(tx, application.id, status);
        await appendClosingTrail(tx, {
          applicationId: application.id,
          knockout: verdict.stage === 'S1',
          reasonCodes: verdict.reasonCodes,
          bureauOutcome,
          failureCause,
          reportId,
          reused,
          verdict: verdict.verdict,
          stage: verdict.stage,
          score: verdict.score,
          policyVersion: policy.version,
          engineVersion: config.ENGINE_VERSION,
          occurredAt: decidedAt,
        });

        if (verdict.verdict === 'MANUAL_REVIEW') {
          await openReview(tx, application.id, decidedAt);
          await appendAuditEvent(tx, {
            applicationId: application.id,
            eventType: 'REVIEW_OPENED',
            actor: 'system',
            payload: { reasonCodes: [...verdict.reasonCodes] },
            occurredAt: decidedAt,
          });
        }

        const built = await buildEnvelope(tx, policies, { ...application, status }, command.correlationId);

        // In the SAME transaction as the pre-decision. Marking the key complete
        // separately opens a window in which a client replays a response for a
        // decision that was rolled back.
        await completeKey(tx, { clientId: command.clientId, key: command.idempotencyKey, body: built });
        return built;
      });

      let envelope: Envelope;
      try {
        envelope = await closeSubmission();
      } catch (error) {
        // TWO REQUESTS DECIDED THE SAME APPLICATION AND THIS ONE COMMITTED
        // SECOND. It happens when an idempotency lease is taken over while the
        // original holder is still alive: both reach the closing transaction,
        // and `pre_decisions`'s primary key lets exactly one of them through.
        //
        // That constraint doing its job is the design working — one application,
        // one verdict, and layer 3 meant only one bureau enquiry either way. But
        // unwinding into an opaque 500 is not: whichever request committed second
        // gets it, which can be the one that did the real work. docs/02 §3
        // promises the caller a resumed application, so give them the decision
        // that exists rather than an internal error about the one that does not.
        if (!isDuplicatePreDecision(error)) throw error;

        const committed = await findPreDecision(database, application.id);
        if (committed === null) throw error;

        const settled = await findApplication(database, application.id, command.clientId);
        if (settled === null) throw error;

        return { kind: 'DECIDED', envelope: await buildEnvelope(database, policies, settled, command.correlationId) };
      }

      metrics.preDecisions.inc({ verdict: verdict.verdict });
      return { kind: 'DECIDED', envelope };
    },

    async status(applicationId: string, clientId: string, correlationId: string): Promise<StatusEnvelope | null> {
      const application = await findApplication(database, applicationId, clientId);
      // An unknown id and another client's id are byte-identical answers on
      // purpose. Distinguishing them turns the endpoint into an oracle that
      // confirms which application ids are real.
      if (application === null) return null;
      return buildStatus(database, policies, application, correlationId);
    },

    async reviewFor(applicationId: string) {
      return findReview(database, applicationId);
    },
  };
};

/** 23505 on `pre_decisions_pkey` — a second verdict for one application. */
const isDuplicatePreDecision = (error: unknown): boolean => {
  const pg = error as { code?: string; constraint?: string } | null;
  return pg?.code === '23505' && pg.constraint === 'pre_decisions_pkey';
};

interface ClosingTrail {
  applicationId: string;
  knockout: boolean;
  reasonCodes: readonly string[];
  bureauOutcome: string | null;
  failureCause: LookupFailureCause | null;
  reportId: string | null;
  reused: boolean;
  verdict: string;
  stage: string;
  score: number | null;
  policyVersion: string;
  engineVersion: string;
  occurredAt: Date;
}

/**
 * The events that describe what happened after the pull, appended alongside the
 * pre-decision.
 *
 * `BUREAU_REPORT_ATTACHED` is named *attached* and not *stored*: on the reuse
 * path nothing was written, and an audit trail that records a write which did
 * not happen is one nobody can rely on.
 */
const appendClosingTrail = async (tx: Queryable, trail: ClosingTrail): Promise<void> => {
  if (trail.knockout) {
    await appendAuditEvent(tx, {
      applicationId: trail.applicationId,
      eventType: 'SCREENING_FAILED',
      actor: 'engine',
      payload: { reasonCodes: [...trail.reasonCodes] },
      occurredAt: trail.occurredAt,
    });
  } else if (trail.bureauOutcome === 'UNAVAILABLE') {
    await appendAuditEvent(tx, {
      applicationId: trail.applicationId,
      eventType: 'BUREAU_UNAVAILABLE',
      actor: 'system',
      payload: { cause: trail.failureCause },
      occurredAt: trail.occurredAt,
    });
  } else if (trail.bureauOutcome !== null) {
    await appendAuditEvent(tx, {
      applicationId: trail.applicationId,
      eventType: 'BUREAU_REPORT_ATTACHED',
      actor: 'system',
      payload: { bureauReportId: trail.reportId, outcome: trail.bureauOutcome, reused: trail.reused },
      occurredAt: trail.occurredAt,
    });
  }

  await appendAuditEvent(tx, {
    applicationId: trail.applicationId,
    eventType: 'PRE_DECISION_MADE',
    actor: 'engine',
    payload: {
      verdict: trail.verdict,
      stage: trail.stage,
      reasonCodes: [...trail.reasonCodes],
      score: trail.score,
      policyVersion: trail.policyVersion,
      engineVersion: trail.engineVersion,
    },
    occurredAt: trail.occurredAt,
  });
};

export type ApplicationService = ReturnType<typeof createApplicationService>;
