-- 003_claim_carries_the_failure_cause.sql
--
-- docs/02-idempotency.md §4.3 requires that a waiter which sees a FAILED claim
-- "stop immediately and adopt the winner's real cause — TIMEOUT, SERVER_ERROR or
-- RETRIES_EXHAUSTED". There was nowhere to read that from: bureau_pull_claims
-- carried pull_key, state, lease_expires_at and report_id, and nothing else.
--
-- Without the column the waiter can only invent a cause, and the two candidates
-- are both wrong in a way the document already argues against:
--
--   report WAIT_EXPIRED — the code meaning "the bureau was fine, we ran out of
--   patience" — recorded during an actual outage, while the winner recorded
--   SERVER_ERROR for the same external fact in the same second. Two
--   applications, one subject, two contradictory causes, and the metric that
--   exists to separate a self-inflicted timeout from an outage fires BECAUSE of
--   the outage.
--
--   or report RETRIES_EXHAUSTED unconditionally, which is a guess presented as
--   evidence in an audit record.
--
-- So the winner records what happened and the waiter reads it. The CHECK makes
-- that read total: a FAILED claim without a cause cannot exist, and the waiter
-- never has to handle a null it could only guess at.

ALTER TABLE bureau_pull_claims ADD COLUMN failure_cause text;

ALTER TABLE bureau_pull_claims
  ADD CONSTRAINT bureau_pull_claims_cause_known
  CHECK (failure_cause IS NULL OR failure_cause IN ('TIMEOUT', 'SERVER_ERROR', 'RETRIES_EXHAUSTED'));

-- The mirror of bureau_pull_claims_done_has_report, and for the same reason: a
-- waiter reads this row to learn the winner's result rather than inferring it
-- from an absence, and a state that carries no result makes that read lie.
ALTER TABLE bureau_pull_claims
  ADD CONSTRAINT bureau_pull_claims_failed_has_cause
  CHECK (state <> 'FAILED' OR failure_cause IS NOT NULL);

-- WAIT_EXPIRED is deliberately NOT an accepted value here. It is not something a
-- provider can do — it is what OUR waiter concluded about its own patience, and
-- it belongs on the pre-decision that recorded it, never on the claim. Allowing
-- it would let one request's impatience be adopted as another's evidence.
