-- 004_the_lookup_failure_cause_is_a_closed_set.sql
--
-- `pre_decisions.lookup_failure_cause` is an ENGINE INPUT: replaying a
-- BUREAU_UNAVAILABLE referral reconstructs the lookup from it (docs/04 §4). A
-- replay is only as trustworthy as the inputs it reads back, and this column had
-- no constraint at all — while `bureau_pull_claims.failure_cause`, its mirror,
-- got one in 003 with a paragraph explaining why it mattered.
--
-- The tell was in the code: the orchestrator wrote this column through a cast,
-- `lookupFailureCause: failureCause as never`, because the value had been
-- widened to `string` on the way through. A cast past the type system into an
-- unconstrained column is exactly the "convention in the engine" that
-- 001_init.sql opens by refusing.
--
-- WAIT_EXPIRED belongs here and does NOT belong on the claim. It is what our own
-- waiter concluded about its own patience — a fact about this decision, not
-- about the provider — which is why the two columns have different value sets
-- rather than one shared one.

ALTER TABLE pre_decisions
  ADD CONSTRAINT pre_decisions_lookup_failure_cause_known
  CHECK (
    lookup_failure_cause IS NULL
    OR lookup_failure_cause IN ('TIMEOUT', 'SERVER_ERROR', 'RETRIES_EXHAUSTED', 'WAIT_EXPIRED')
  );

-- A cause without a failure is a contradiction the replay would have to guess
-- its way past: it reconstructs an UNAVAILABLE lookup when there is no report,
-- so a cause sitting beside an attached report describes nothing.
ALTER TABLE pre_decisions
  ADD CONSTRAINT pre_decisions_cause_implies_no_report
  CHECK (lookup_failure_cause IS NULL OR bureau_report_id IS NULL);
