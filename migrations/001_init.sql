-- 001_init.sql
--
-- Seven tables. The comments name what each constraint prevents, because the
-- correctness argument of this service is that the guarantees are constraints in
-- the database rather than checks in application code: "the logic verifies it"
-- is a race, "the database will not allow it" is a proof.
--
-- docs/01-architecture.md §3 is the authority for this file. One row of that
-- table is deliberately weaker than the rest and says so: bureau_pull_claims is
-- a lease, not a constraint.

-- ---------------------------------------------------------------- applications
CREATE TABLE applications (
  id                     uuid        PRIMARY KEY,
  client_id              text        NOT NULL,
  status                 text        NOT NULL,
  product_code           text        NOT NULL,
  requested_amount_minor bigint      NOT NULL,
  term_months            integer     NOT NULL,
  currency               char(3)     NOT NULL,
  purpose                text        NOT NULL,
  channel                text        NOT NULL,

  -- Identifying fields only, and erasable. A future pseudonymisation job clears
  -- this column; docs/04-audit.md §5 depends on nothing the engine reads living
  -- here.
  applicant              jsonb       NOT NULL,

  -- What the engine reads: income, obligations, employment. Deliberately NOT in
  -- `applicant`, because monthly income is the denominator of DTI and the
  -- threshold at S1 — a pre-decision cannot be replayed without it.
  finances               jsonb       NOT NULL,

  -- HMAC-SHA256 of the canonicalised national identifier. 64 hex characters.
  -- The identifier itself is never stored.
  subject_key            char(64)    NOT NULL,

  customer_id            text,
  consent_attested       boolean     NOT NULL,
  consent_accepted_at    timestamptz NOT NULL,
  submitted_at           timestamptz NOT NULL,

  CONSTRAINT applications_status_known CHECK (
    status IN ('RECEIVED', 'PRE_DECIDED', 'IN_REVIEW', 'REVIEW_CLOSED', 'ABANDONED')
  ),
  CONSTRAINT applications_amount_positive CHECK (requested_amount_minor > 0),
  CONSTRAINT applications_term_positive   CHECK (term_months > 0),

  -- An application with consent_attested = false cannot exist. ADR-0007 makes
  -- the attestation mandatory at the edge; this makes it impossible to bypass
  -- the edge and insert one anyway.
  CONSTRAINT applications_consent_required CHECK (consent_attested)
);

CREATE INDEX applications_subject_key_idx ON applications (subject_key, submitted_at DESC);
CREATE INDEX applications_client_id_idx   ON applications (client_id, submitted_at DESC);

-- Resolves an orphan sweep without scanning the table: only RECEIVED rows are
-- ever candidates, and they are a vanishing fraction of the whole.
CREATE INDEX applications_orphan_sweep_idx ON applications (submitted_at)
  WHERE status = 'RECEIVED';

-- -------------------------------------------------------------- bureau_reports
-- Immutable evidence. Written once, never updated. `expires_at` governs whether
-- a row may still back a NEW pre-decision; it has nothing to do with deletion,
-- and no job ever deletes by it — that would break every replay of every
-- decision that used it.
CREATE TABLE bureau_reports (
  id                       uuid        PRIMARY KEY,
  subject_key              char(64)    NOT NULL,
  provider                 text        NOT NULL,
  outcome                  text        NOT NULL,
  payload                  jsonb       NOT NULL,

  -- Whose consent attestation caused this enquiry. Reuse crosses client
  -- boundaries by design (ADR-0002), so the client deciding on a report is
  -- frequently not the client whose attestation caused it. Without these two
  -- columns the audit question "who told us this person authorised an enquiry"
  -- is answered with the wrong client's name on every reused report.
  attested_by_client_id    text        NOT NULL,
  caused_by_application_id uuid        NOT NULL REFERENCES applications (id),

  pulled_at                timestamptz NOT NULL,
  expires_at               timestamptz NOT NULL,

  CONSTRAINT bureau_reports_outcome_known CHECK (outcome IN ('FOUND', 'NO_HIT')),
  CONSTRAINT bureau_reports_expiry_after_pull CHECK (expires_at > pulled_at)
);

-- Guarantees nothing; makes the reuse lookup cheap. Ordered on pulled_at
-- because that is what the query orders on — indexing expires_at instead is
-- equivalent only while the TTL is one global constant, which
-- docs/02-idempotency.md §8 names as something that may not stay true.
CREATE INDEX bureau_reports_reuse_idx ON bureau_reports (subject_key, provider, pulled_at DESC);

-- --------------------------------------------------------------- pre_decisions
-- What the ENGINE concluded. One row per application, written once inside the
-- submission transaction, never updated. A human's outcome is a different fact
-- by a different actor and lives in `reviews` (ADR-0006) — which is what keeps
-- replay meaningful, because replay compares against this verdict and a
-- legitimate override therefore cannot look like tampering.
CREATE TABLE pre_decisions (
  application_id        uuid          PRIMARY KEY REFERENCES applications (id),
  verdict               text          NOT NULL,
  reason_codes          text[]        NOT NULL,

  approved_amount_minor bigint,
  monthly_payment_minor bigint,
  offer_expires_at      timestamptz,

  score                 integer,
  dti                   numeric(6, 4),

  policy_version        text          NOT NULL,
  engine_version        text          NOT NULL,

  bureau_report_id      uuid          REFERENCES bureau_reports (id),
  bureau_report_reused  boolean       NOT NULL,

  -- TIMEOUT | SERVER_ERROR | RETRIES_EXHAUSTED | WAIT_EXPIRED. Stored on the
  -- pre-decision rather than only in an audit payload, because replay of a
  -- BUREAU_UNAVAILABLE referral needs it as an engine input (docs/04 §4).
  lookup_failure_cause  text,

  decided_at            timestamptz   NOT NULL,

  CONSTRAINT pre_decisions_verdict_known CHECK (verdict IN ('APPROVED', 'DECLINED', 'MANUAL_REVIEW')),

  -- Regulation B's four-reason cap, and the rule that a verdict always carries
  -- at least one reason. A decision with no disclosed reason is not a decision
  -- anyone can be told about.
  CONSTRAINT pre_decisions_reason_codes_capped CHECK (
    cardinality(reason_codes) BETWEEN 1 AND 4
  ),

  -- An approval has an offer; anything else does not. Written as an equivalence
  -- so neither direction can drift: an APPROVED with no amount and a DECLINED
  -- carrying one are both impossible.
  CONSTRAINT pre_decisions_offer_matches_verdict CHECK (
    (verdict = 'APPROVED') = (
      approved_amount_minor IS NOT NULL
      AND monthly_payment_minor IS NOT NULL
      AND offer_expires_at IS NOT NULL
    )
  ),

  CONSTRAINT pre_decisions_score_in_range CHECK (score IS NULL OR score BETWEEN 0 AND 100),

  -- A reused report must be a report. Catches the state where the flag says
  -- "reused" and no evidence is attached.
  CONSTRAINT pre_decisions_reused_implies_report CHECK (
    NOT bureau_report_reused OR bureau_report_id IS NOT NULL
  )
);

CREATE INDEX pre_decisions_audit_listing_idx ON pre_decisions (decided_at DESC, application_id);
CREATE INDEX pre_decisions_policy_version_idx ON pre_decisions (policy_version);

-- ---------------------------------------------------------- bureau_pull_claims
-- Mutable coordination: a lock with a lease. Changes constantly, carries no
-- history worth keeping. Kept apart from bureau_reports on purpose — folding
-- them into one table means a new pull overwrites the snapshot an old decision
-- depends on.
--
-- HONEST LIMIT, and the only one in this file. The primary key stops two callers
-- holding the claim SIMULTANEOUSLY. It does not stop two pulls: the takeover
-- predicate deliberately admits a second caller once the lease expires, the
-- winner does not verify it still holds the lease before writing, and there is
-- no uniqueness on (subject_key, provider). A holder that is alive but stalled
-- past its lease produces a second hard enquiry and nothing here objects.
-- docs/01-architecture.md §3 names the fencing that would fix it, why v1 does
-- not pay for it, and the trigger for revisiting.
CREATE TABLE bureau_pull_claims (
  pull_key         text        PRIMARY KEY,
  state            text        NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  report_id        uuid        REFERENCES bureau_reports (id),

  CONSTRAINT bureau_pull_claims_state_known CHECK (state IN ('IN_FLIGHT', 'DONE', 'FAILED')),

  -- A waiter reads this row to learn the winner's result rather than inferring
  -- it from an absent report. DONE with no report would make that read lie.
  CONSTRAINT bureau_pull_claims_done_has_report CHECK (state <> 'DONE' OR report_id IS NOT NULL)
);

-- ----------------------------------------------------------- idempotency_keys
CREATE TABLE idempotency_keys (
  -- client_id is derived from the bearer token, never from the request body.
  -- Without it in the key, two integrators both sending `Idempotency-Key: 1` —
  -- which is what a developer testing by hand sends — collide, and the second
  -- receives the stored response body of the first one's application: someone
  -- else's verdict, someone else's application id.
  client_id           text        NOT NULL,
  scope               text        NOT NULL,
  key                 text        NOT NULL,

  -- Written in the same statement as the application insert, so a lease
  -- takeover RESUMES that application instead of creating a second one. Without
  -- this column, takeover silently falsified the property "the same key twice
  -- produces one application" in exactly the case the lease exists to handle.
  application_id      uuid        REFERENCES applications (id),

  request_fingerprint char(64)    NOT NULL,
  state               text        NOT NULL,
  response_body       jsonb,
  lease_expires_at    timestamptz NOT NULL,
  expires_at          timestamptz NOT NULL,

  PRIMARY KEY (client_id, scope, key),

  CONSTRAINT idempotency_keys_state_known CHECK (state IN ('IN_PROGRESS', 'COMPLETED', 'ABANDONED')),

  -- A COMPLETED key is replayed byte for byte. One with no stored body would
  -- return an empty response to a retry and look like success.
  CONSTRAINT idempotency_keys_completed_has_body CHECK (
    state <> 'COMPLETED' OR response_body IS NOT NULL
  )
);

CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);

-- -------------------------------------------------------------- audit_events
CREATE TABLE audit_events (
  application_id uuid        NOT NULL REFERENCES applications (id),

  -- The primary key is the concurrency guarantee: a concurrent double-append
  -- violates it rather than silently forking the chain.
  chain_index    integer     NOT NULL,

  event_type     text        NOT NULL,
  actor          text        NOT NULL,
  payload        jsonb       NOT NULL,
  occurred_at    timestamptz NOT NULL,

  -- application_id and chain_index are part of the hashed content, not merely
  -- alongside it, so one application's chain cannot be transplanted onto
  -- another's. docs/04-audit.md §3.
  prev_hash      char(64)    NOT NULL,
  hash           char(64)    NOT NULL,

  PRIMARY KEY (application_id, chain_index),

  CONSTRAINT audit_events_index_non_negative CHECK (chain_index >= 0)
);

-- Append-only, enforced by the database rather than by discipline.
--
-- docs/04-audit.md §3 describes three layers and only the first two are real
-- defences. The FIRST — revoking UPDATE and DELETE from the application's role —
-- is NOT in this migration, and that is a deployment limitation rather than an
-- oversight: on the managed free tier this service connects as the database
-- owner, and a role cannot revoke privileges from itself in a way that binds
-- itself. It is named in docs/06-failure-modes.md as not done here.
--
-- So the trigger is the enforcement that exists. FOR EACH STATEMENT rather than
-- FOR EACH ROW, so it fires even on an UPDATE that would have matched no rows.
CREATE FUNCTION audit_events_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only; % is not permitted', tg_op
    USING errcode = 'restrict_violation';
END;
$fn$;

CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_append_only();

CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_append_only();

-- -------------------------------------------------------------------- reviews
-- What a PERSON concluded, on criteria this service does not model. A different
-- fact by a different actor, so a different row rather than an edit to
-- pre_decisions (ADR-0006).
CREATE TABLE reviews (
  application_id        uuid        PRIMARY KEY REFERENCES applications (id),
  state                 text        NOT NULL,
  outcome               text,
  approved_amount_minor bigint,

  -- Comes from the reviewer's bearer token, never from the request body.
  reviewer_id           text,
  rationale             text,

  opened_at             timestamptz NOT NULL,
  closed_at             timestamptz,

  CONSTRAINT reviews_state_known   CHECK (state IN ('PENDING', 'CLOSED')),
  CONSTRAINT reviews_outcome_known CHECK (outcome IS NULL OR outcome IN ('APPROVED', 'DECLINED')),

  -- The fifth guarantee, and the one that answers a specific audit question:
  -- "could anyone have altered a verdict after the fact?" A closed review with
  -- no outcome, or with no attributable human, cannot exist.
  CONSTRAINT reviews_closed_is_attributable CHECK (
    state <> 'CLOSED' OR (outcome IS NOT NULL AND reviewer_id IS NOT NULL AND closed_at IS NOT NULL)
  )
);

CREATE INDEX reviews_pending_idx ON reviews (opened_at) WHERE state = 'PENDING';
