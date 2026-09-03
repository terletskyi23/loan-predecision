-- 002_reason_codes_depend_on_verdict.sql
--
-- 001 encoded one rule for all three verdicts:
--
--     CHECK (cardinality(reason_codes) BETWEEN 1 AND 4)
--
-- with the comment "a verdict always carries at least one reason". That is true
-- of DECLINED and of MANUAL_REVIEW. It is false of an approval on the requested
-- terms, which is not adverse action and therefore owes nobody a reason. Under
-- policy 2026.09.1 the case is reachable and documented: profile PRIME
-- (900-55-0601) scores 100, loses no material points, needs no counter-offer,
-- and so produces an empty code list. The engine would be correct and the
-- INSERT would fail.
--
-- The rule was under-specified, not wrong. This migration states the part
-- that depends on the verdict, and adds the column the interesting half of it
-- needs in order to be a constraint at all.
--
-- 001_init.sql is NOT edited. src/db/migrate.ts checksums every applied file and
-- refuses to boot when one has changed, so amending it in place would take the
-- deployed service down rather than fix anything.

-- ------------------------------------------------------------------- the column
-- A CHECK cannot reference another table, so "did we offer less than was asked"
-- is not expressible from pre_decisions alone — the requested amount lives in
-- applications. Copying it here is duplication, but of the benign kind: both
-- rows are written once and never updated, so the two copies cannot drift.
--
-- What it buys is that the counter-offer invariant becomes something the
-- database refuses rather than something the engine happens to get right. That
-- is the doctrine of 001 and this is what honouring it costs.
ALTER TABLE pre_decisions ADD COLUMN requested_amount_minor bigint;

UPDATE pre_decisions p
   SET requested_amount_minor = a.requested_amount_minor
  FROM applications a
 WHERE a.id = p.application_id;

ALTER TABLE pre_decisions ALTER COLUMN requested_amount_minor SET NOT NULL;

ALTER TABLE pre_decisions
  ADD CONSTRAINT pre_decisions_requested_amount_positive
  CHECK (requested_amount_minor > 0);

-- ------------------------------------------------------- the rule, split in two
ALTER TABLE pre_decisions DROP CONSTRAINT pre_decisions_reason_codes_capped;

-- Unchanged in substance: Regulation B's guidance that more than four reasons is
-- unlikely to help the applicant. It applies to every verdict.
ALTER TABLE pre_decisions
  ADD CONSTRAINT pre_decisions_reason_codes_capped
  CHECK (cardinality(reason_codes) <= 4);

-- Adverse action always has reasons. A DECLINED or a MANUAL_REVIEW with an empty
-- list is a decision nobody can be told about, and that was the true half of the
-- rule 001 wrote.
ALTER TABLE pre_decisions
  ADD CONSTRAINT pre_decisions_adverse_action_has_reasons
  CHECK (verdict = 'APPROVED' OR cardinality(reason_codes) >= 1);

-- The half that needed the column. Under Regulation B, credit offered on terms
-- other than those applied for is a counteroffer, and it becomes adverse action
-- the moment the applicant declines it — so the notice has to be available, and
-- an approval at a reduced amount must carry at least AMOUNT_REDUCED_TO_FIT_DTI.
--
-- Written as >= rather than = so that a future policy which approves MORE than
-- was requested is not silently forced to invent reasons. Up-selling is not
-- modelled in v1; this is about which direction the constraint is asleep in.
ALTER TABLE pre_decisions
  ADD CONSTRAINT pre_decisions_counter_offer_has_reasons
  CHECK (
    verdict <> 'APPROVED'
    OR approved_amount_minor >= requested_amount_minor
    OR cardinality(reason_codes) >= 1
  );
