# ADR-0006: A human's review outcome is a separate record, not an edit to the pre-decision

**Status:** accepted · 2026-09-03

## Context

`MANUAL_REVIEW` is not terminal. A person at the lender eventually decides, and
that verdict has to be visible through the API and durable in the audit trail.

The previous design had one `decisions` row per application, keyed on
`application_id`, and three statements that could not all be true at once: the
decision is never edited; the decision block *changes* when a human closes the
case; and `REVIEW_CLOSED` is an audit event nothing could emit. There was also no
endpoint that closed a review, and `reviews` carried neither an outcome nor a
reviewer identity — so a human verdict had no attributable actor, which is
exactly the audit question "could anyone have altered a verdict after the fact?"

A fourth defect followed from the same root and is the sharpest one. Replay
compares a recomputed verdict against the stored verdict. With a human outcome
overwriting the engine's, **every referred application closed by an underwriter
would replay as `MANUAL_REVIEW` against a record saying `APPROVED`** and report
`match: false`. The endpoint whose entire purpose is to surface tampering would
have fired on the single most ordinary event in the business, and the two real
incidents it exists to catch would have been buried in that noise.

## Decision

`pre_decisions` holds what **the engine** concluded. One row per application,
written once inside the submission transaction, never updated.

`reviews` holds what **a person** concluded: `outcome`, `reviewer_id`,
`rationale`, `closed_at`. `reviewer_id` comes from the bearer token, never from
the request body. A `CHECK` constraint refuses a row in state `CLOSED` without
both an outcome and a reviewer.

The API returns both blocks plus a composed `outcome` — the review outcome when
closed, otherwise the engine verdict — computed in exactly one function on the
server, so no client, dashboard or exporter has to compose it and drift.

Replay compares against `pre_decisions.verdict` and nothing else.

Closing is a conditional update, `WHERE state = 'PENDING'`, so two concurrent
closes produce one write and one `409`.

## Alternatives

**A decision history table**, `(application_id, sequence)` append-only, with the
engine at sequence 0 and the human at sequence 1. Genuinely good, and the answer
if reviews could recur or be reopened. Rejected because it makes every reader
carry a `MAX(sequence)` and it puts two different kinds of fact in one table:
`score`, `policy_version` and `bureau_report_reused` are meaningless on the human
row, so half the columns would be null by construction. That is a schema saying
"these are two entities" while pretending they are one.

**Overwrite the verdict and keep the old one in the audit chain.** Simplest, and
what the previous design implied. Rejected for the replay failure above: the
chain would hold the history, but the table replay reads would be wrong, and
replay is the feature the audit claim rests on.

**Add `engine_verdict` and `final_verdict` columns to one row.** Cheap. Rejected
because a human verdict then has no room for the things that make it
attributable — who, when, on what grounds — and reviewer identity is not an
optional extra here, it is the answer to one of the five audit questions.

**Leave `MANUAL_REVIEW` terminal and model nothing.** Defensible against the
brief, which puts the manual-review workflow out of scope. Rejected because
"out of scope" was doing two jobs: the *workflow* is genuinely out of scope, but
without a record of the *outcome* the application never reaches a terminal state
and the audit trail has an event nothing emits.

## Consequences

- Replay stays meaningful: `match: false` means altered evidence or broken
  reproducibility, and a legitimate override is neither.
- `pre_decisions` is immutable, so the append-only story is uniform: evidence
  tables are written once, and the only mutable tables are coordination ones.
- Outcome metrics must be split. `predecision_outcomes_total` counts the engine;
  `review_outcomes_total` counts humans. Merging them would require revising a
  counter hours after the fact, which counters cannot do.
- One more token scope, `REVIEWER_TOKENS`, so the party that submits an
  application cannot also approve it.
- A review cannot be reopened in v1, and a review is one per application. Both
  are recorded as assumptions rather than designed around; a history table is the
  migration if either turns out to be wrong.
