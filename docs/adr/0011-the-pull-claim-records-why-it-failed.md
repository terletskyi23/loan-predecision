# ADR-0011: The pull claim records why it failed

**Status:** accepted · 2026-09-03

## Context

`docs/02-idempotency.md` §4.3 specifies what a request that loses a pull claim
does while it waits:

| Claim state seen | What the waiter does |
|---|---|
| `DONE` | Read the report it points at |
| `FAILED` | **Stop immediately and adopt the winner's real cause** — `TIMEOUT`, `SERVER_ERROR` or `RETRIES_EXHAUSTED` |
| still `IN_FLIGHT` at the deadline | Re-read once, then give up with `WAIT_EXPIRED` |

The middle row could not be implemented. `bureau_pull_claims` as created by
`001_init.sql` carries `pull_key`, `state`, `lease_expires_at` and `report_id`,
and nothing else. There is nowhere for the winner to record *why* it failed, so
there is nothing for the waiter to adopt.

That leaves a waiter with two guesses, and the document already argues against
both.

**Guess `WAIT_EXPIRED`.** That code means "the bureau was fine, we ran out of
patience". Recorded during an actual outage — which is precisely when the winner
fails fast and the waiter sees `FAILED` — it is false. Worse, it is false in a
direction that breaks the thing it was invented for: `bureau_wait_expired_total`
exists to separate a self-inflicted timeout from a vendor outage, and under this
guess the counter fires *because of* the outage. Two applications for one subject
decided in the same second would carry contradictory explanations of one external
fact.

**Guess `RETRIES_EXHAUSTED` unconditionally.** Frequently right, and it is a
guess presented as evidence inside an audit record whose entire value is that it
is not guessing.

## Decision

`migrations/003_claim_carries_the_failure_cause.sql` adds `failure_cause` to
`bureau_pull_claims`. The winner records what actually happened; the waiter reads
it.

Two constraints make the read total rather than defensive:

```sql
CHECK (failure_cause IS NULL OR failure_cause IN ('TIMEOUT','SERVER_ERROR','RETRIES_EXHAUSTED'))
CHECK (state <> 'FAILED' OR failure_cause IS NOT NULL)
```

The second mirrors `bureau_pull_claims_done_has_report` and exists for the same
reason: a waiter reads this row to learn the winner's result rather than
inferring it from an absence, and a state that carries no result makes that read
lie.

`WAIT_EXPIRED` is deliberately **not** an accepted value. It is not something a
provider can do — it is a conclusion *our* waiter drew about *its own* patience,
and it belongs on the pre-decision that drew it. Allowing it here would let one
request's impatience be adopted as another request's evidence, which is the exact
confusion the column was added to remove.

## Alternatives

**Leave the column out and let the waiter report `WAIT_EXPIRED`.** Rejected
above: it corrupts the one metric that distinguishes our own slowness from a
vendor outage, and it does so specifically during outages.

**Leave the column out and let the waiter report `RETRIES_EXHAUSTED`.** Rejected
as the smaller version of the same problem. It is a plausible default recorded as
a fact, in a table read by people whose job is to distinguish the two.

**Have the waiter re-derive the cause by calling the bureau itself.** Rejected
outright, and worth stating because it is the "obvious" fix. It converts a
deduplication mechanism into a duplicate-enquiry mechanism at exactly the moment
the provider is unhealthy — the harm this whole subsystem exists to prevent,
inflicted by the code meant to prevent it.

**Store the cause in the audit event instead.** Rejected because the audit chain
is per application, and the waiter needs a fact recorded against a *different*
application's work. Reaching across applications through the audit trail would
make the trail a coordination channel, which is not what it is for and not what
its constraints protect.

## Consequences

- `bureau_pull_claims` grows one column and two constraints. It remains
  coordination rather than evidence: mutable, swept, and carrying no history.
- A loser during an outage now records the same cause as the winner, which is
  what makes `bureau_wait_expired_total` mean what `docs/06-failure-modes.md`
  claims it means.
- The defect is instructive and is left visible: the design document specified a
  behaviour, the schema was written from the same document, and neither review
  noticed the behaviour had no column to live in. It surfaced when the gateway
  was implemented — which is an argument for writing the code before calling the
  design finished, not for writing more design.
