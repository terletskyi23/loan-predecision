# 02 — Duplicate submissions and bureau work

> *"Duplicate submits must not create duplicate bureau work — design and
> document your approach."*

This is the only requirement in the brief that came with an instruction to
design and document it, so it gets its own document.

---

## 1. Why this is a product requirement, not an optimisation

A credit bureau enquiry comes in two kinds. A **soft pull** is invisible to other
lenders and does not affect the applicant's score. A **hard pull** — the kind
used to make a lending decision — is recorded on the person's file, is visible to
every other lender who looks, and can lower their score. Several hard pulls in a
short window read to the market as somebody desperately shopping for credit, and
make the next lender's answer worse.

So a duplicated pull does two things:

1. It costs the lender money, per enquiry.
2. **It damages the credit profile of the applicant**, who did nothing wrong.

The second is why this is not a caching problem. Read as "avoid redundant API
calls", the requirement gets solved with an idempotent endpoint and stops there.
Read as "do not harm the applicant", it has to hold even when the caller sends
no idempotency key and the two submissions are genuinely different applications.

Everything below follows from that reading.

---

## 2. Four different problems wearing one name

"Make it idempotent" is not one problem here. It is four, they occur at different
places, and each needs its own mechanism.

| # | Problem | When it happens | Mechanism | Layer |
|---|---|---|---|---|
| 1 | The same HTTP request arrives twice | Network retry, double click, partner replaying a webhook | `Idempotency-Key` + unique constraint, stored response replayed | Transport |
| 2 | The same application submitted twice with no key | Client forgot the header; user refreshed a hung page | *(deliberately not implemented — see §5)* | Domain |
| 3 | Two **genuinely different** applications from one person | Declined at $32k, reapplies at $20k. Aggregator submitting to several lenders | Report reuse + single-flight claim | External effect |
| 4 | Our own retry of an outbound call | The bureau timed out and we try again | One stable request id per logical pull, not per attempt | Delivery |

Naming these separately is the point. Collapsing them into "we made it
idempotent" is what produces a solution that passes a demo and fails the actual
requirement, because problem 3 is untouched by an idempotency key.

---

## 3. Layer 1 — the transport gate

A row keyed by `(client_id, scope, key)`, holding a fingerprint of the canonical
request body, the id of the application it created, and, once finished, the
exact response that was sent.

`scope` is the operation the key belongs to — `applications.submit` is the only
value in v1. It exists so that a client reusing one key string across two
different idempotent operations does not have the second collide with the first.
With one idempotent endpoint it is inert, and it is in the key rather than
waiting to be added later because widening a primary key after the fact is a
migration and a re-key of live rows.

```sql
INSERT INTO idempotency_keys
  (client_id, scope, key, request_fingerprint, state, lease_expires_at)
VALUES ($1, $2, $3, $4, 'IN_PROGRESS', $5)
ON CONFLICT (client_id, scope, key) DO NOTHING
RETURNING *;
```

### `client_id` is not decoration

The key is chosen by the caller and may be any string. Two integrators both
sending `Idempotency-Key: 1` — which is exactly what a developer testing by hand
sends — would collide on a two-part key, and the second one would receive **the
stored response body of the first one's application**: someone else's verdict,
someone else's application id, someone else's reason codes.

In a service whose entire justification for authentication is "you must not be
able to touch a stranger's file", that is the sharpest possible own goal. The
client identity is derived from the bearer token, never from the request body,
so a caller cannot claim to be someone else.

### Branching on an existing row

| Existing row | Response |
|---|---|
| Same fingerprint, `COMPLETED` | The stored body, byte for byte, plus `Idempotency-Replayed: true` |
| Same fingerprint, `IN_PROGRESS`, lease valid | `409` with `Retry-After: 3` — the worst-case in-flight request is ~2.5 s, so `Retry-After: 1` would send a compliant client straight into a second `409` |
| Same fingerprint, `IN_PROGRESS`, lease expired, `application_id` set | **Resume that application.** Do not create a second one |
| Same fingerprint, `IN_PROGRESS`, lease expired, no `application_id` | The previous holder died before inserting anything. Take over and start |
| Same fingerprint, `ABANDONED` | The orphan sweeper already retired both the application and this key. Treated as a fresh submission — a new application, and no second bureau pull, because layer 3 still holds |
| Different fingerprint | `422 IDEMPOTENCY_KEY_REUSED` |

The third row is the one an earlier version of this design got wrong. Without
`application_id` on the key row, a takeover had nothing to find and inserted a
fresh application — which quietly falsified the property "the same key twice
produces exactly one application" in precisely the case the lease exists to
handle. The column is written in the same statement as the application insert.

Three details that are easy to get wrong:

**The fingerprint is of canonical JSON.** Keys sorted at every level, `undefined`
dropped, array order preserved. Without canonicalisation, `{a:1,b:2}` and
`{b:2,a:1}` hash differently and a legitimate retry is rejected as a conflict.

**The stored response is returned verbatim**, including the original
`correlationId` and `decidedAt`. Regenerating it would mean the replay could
differ from the original, which defeats the purpose.

**The completion is written in the same transaction as the pre-decision.**
Marking the key complete separately creates a window where a client replays a
response for a decision that was rolled back.

---

## 4. Layer 3 — the one the requirement is actually about

Two guards, in order, because they catch different things.

### 4.1 Reuse — for duplicates separated in time

```sql
SELECT * FROM bureau_reports
WHERE subject_key = $1 AND provider = $2 AND expires_at > $now
ORDER BY pulled_at DESC LIMIT 1;
```

Served by `bureau_reports (subject_key, provider, pulled_at DESC)`. The index is
ordered on the column the query orders on; indexing `expires_at` instead is
equivalent only while the TTL is one global constant, which §8 names as
something that may not stay true.

A hit means no network call, no cost, no mark on the file. This covers the
common human case: a person who was declined and immediately tries a smaller
amount, or who submits through two channels.

**Reuse crosses client boundaries on purpose**, and that has an audit
consequence. The report carries `attested_by_client_id` and
`caused_by_application_id`, so "who told us this person authorised an enquiry"
is answered from the report rather than from the application being decided —
which, on a reused report, belongs to a different client. ADR-0002 states the
exposure this makes visible.

**A `NO_HIT` report is stored and reused like any other.** "The bureau answered,
and this person has no file" is a fact with a timestamp, and re-asking twelve
minutes later is a second enquiry for the same non-answer. Only `UNAVAILABLE`
writes nothing, because we learned nothing.

The TTL is a **risk decision, not a technical one**. Fifteen minutes is safe: a
person's financial position does not change in fifteen minutes. Twenty-four
hours is not obviously safe: they could have taken a loan elsewhere that
morning, and we would decide on stale data. The default is 15 minutes and it is
configurable, and the right owner of that number is a risk manager, not an
engineer.

### 4.2 The claim — for duplicates that arrive together

Reuse alone only stops *sequential* duplicates. Two requests arriving in the
same instant both miss the lookup and both would call out. That is the harder
half, and it needs a lock.

```sql
INSERT INTO bureau_pull_claims (pull_key, state, lease_expires_at)
VALUES ($1, 'IN_FLIGHT', $now + $lease)
ON CONFLICT (pull_key) DO UPDATE
   SET state = 'IN_FLIGHT', lease_expires_at = $now + $lease
 WHERE bureau_pull_claims.state = 'FAILED'
    OR bureau_pull_claims.lease_expires_at < $now
RETURNING *;
```

- **A row comes back** — this request owns the pull. Call the bureau, write the
  immutable report, mark the claim `DONE` with `report_id`, or `FAILED`.
- **Nothing comes back** — somebody else owns it. Wait, bounded (§4.3).

The `WHERE` clause is the lease. Without it, a process that crashes mid-pull
leaves a claim that blocks that person forever.

The claim row is **not deleted on close**. It carries `DONE`/`FAILED` and
`report_id` precisely so that a waiter can read the winner's result rather than
infer it from absence — see §4.3. It is cleared by the same sweep that retires
idempotency keys, well after any waiter could care, which is what
`docs/04-audit.md` §5 means by classifying it as coordination rather than
evidence. The takeover predicate does not mention `DONE` because a `DONE` claim
whose lease has not yet expired is harmless: the reuse check in §4.1 runs first
and finds the report it points at.

**This weakens on purpose, and the weakening is documented rather than
implied.** The claim stops two callers holding it at once; it does not make two
pulls impossible. A holder that is alive but stalled past the lease loses it
without knowing, and its report write is not fenced.
`docs/01-architecture.md` §3 sets out what fencing would cost, why v1 does not
pay it, and the one extra hard enquiry that is the residual harm.

### 4.3 The bounded wait, and how it ends

A loser polls **the claim row and the report together** every
`BUREAU_WAIT_POLL_MS`, for at most `BUREAU_WAIT_MS`. Polling the report alone is
the mistake, and it is subtle enough to be worth spelling out:

| Claim state seen | What the waiter does |
|---|---|
| `DONE` | Read the report it points at. Done — typically well before the deadline |
| `FAILED` | **Stop immediately** and adopt the winner's real cause — `TIMEOUT`, `SERVER_ERROR` or `RETRIES_EXHAUSTED` |
| still `IN_FLIGHT` at the deadline | Re-read once, then give up with `cause: "WAIT_EXPIRED"` |

**Why `FAILED` has to end the wait.** When the bureau is down, the winner fails
after ~1.75 s and writes **nothing** to `bureau_reports` — only `UNAVAILABLE`
writes nothing. A waiter watching only the report table therefore sees an empty
table for the full 2 s and records `WAIT_EXPIRED`: the code that means "the
bureau was fine, we timed out on ourselves", recorded during an actual outage,
while the winner recorded `SERVER_ERROR` for the same external fact in the same
second. Two applications, one subject, two contradictory causes, and the metric
advertised as separating a self-inflicted timeout from an outage fires *because
of* the outage. Reading the claim removes the case entirely and shortens the
loser's latency from 2000 ms to ~1750 ms.

**Re-read once after the deadline before giving up.** The winner may have
committed a millisecond after the last poll. Returning `BUREAU_UNAVAILABLE`
while a perfectly good report exists in the same database is the kind of bug
that never shows up in a test and always shows up in production.

**Do not lie about the cause.** With the claim polled, a genuine `WAIT_EXPIRED`
means the winner is still running and slower than our patience — the bureau was
not unavailable, *we* stopped waiting. The verdict is still `MANUAL_REVIEW` and
the reason code is still `BUREAU_UNAVAILABLE`, because that is what the
applicant's notice can honestly say, but the event carries the distinct cause and
increments `bureau_wait_expired_total`. That counter now means what `docs/06`
claims it means: the wait is too short for the retry budget, not that the bureau
is down.

### 4.4 The numbers, and why they are these numbers

| Setting | Value | Reasoning |
|---|---|---|
| `BUREAU_TIMEOUT_MS` | 800 | Per attempt. Chosen so the **whole retried path** — two attempts plus backoff, ~1.75 s — still lands inside A2's stated ~2.5 s ceiling with room for our own work. A2 excludes the retried pull from the 2-second *common-path* p95; it does not leave it unbounded, and this is the number that bounds it |
| `BUREAU_MAX_ATTEMPTS` | 2 | One retry. A third attempt cannot fit the budget, and a bureau that failed twice inside a second is not going to succeed on the third |
| `BUREAU_BACKOFF_BASE_MS` | 150 | Plus full jitter |
| `BUREAU_CLAIM_LEASE_MS` | 5000 | Must exceed the winner's worst case (≈1.8 s) with margin, and be short enough that a crashed holder delays one applicant by seconds rather than by half a minute |
| `BUREAU_WAIT_MS` | 2000 | Must exceed the winner's worst case, or a loser gives up while the winner is still succeeding — the bug §4.3 exists to prevent |
| `BUREAU_WAIT_POLL_MS` | 100 | |

The earlier version of this design paired a 2-second per-attempt timeout with
three attempts and a 30-second lease, against a stated p95 budget of 2 seconds.
One timed-out attempt consumed the entire budget. `docs/00-scope.md` A2 now
states the budget for the common path and names the concurrent-loser path as the
exception it is, rather than claiming a number the retry policy could not meet.

### 4.5 Why a claim table and not the obvious alternatives

| Alternative | Why not |
|---|---|
| In-process `Map` of in-flight promises | Works on one instance and silently stops working on two. The failure mode is invisible in testing and appears in production |
| `pg_advisory_xact_lock` on the subject key | Correct, and simpler — but it holds a pooled connection for the entire duration of an external HTTP call. Ten concurrent new subjects and the pool is gone |
| Redis lock | A second store, so the claim and the report are no longer written under one transaction; a distributed-transaction problem invented to avoid a table |
| No lock, accept the occasional double pull | Defensible if the pull were merely expensive. It is not — it marks a person's credit file |

### 4.6 Why the key is the person, not the account

The pull key is derived from the national identifier, not from `customerId` or
the application. Three reasons, worst last:

1. Most applicants at pre-decision have no account yet, so an account-based key
   would leave the biggest population undeduplicated.
2. One person can hold two accounts — a new email, a partner channel with its own
   ids — producing two pulls and two marks.
3. **One account can be used by two people.** Reusing a report across a shared
   login would mean deciding one person's application on another person's credit
   history.

The third is not a bug you recover from, and it settles the question.

**The identifier is canonicalised before it is hashed** — alphanumerics only,
uppercased. `900-55-0142` and `900550142` are one subject. Skipping this step
defeats the entire mechanism with a hyphen, and it is the kind of defect that
only ever appears once a second integrator formats identifiers differently from
the first.

Note the division of labour, which `docs/08-mock-bureau.md` §1 sets out in full:
the **bureau** is given the canonicalised identifier, because no provider can
search by our HMAC. The **subject key** is ours, and is what the reuse lookup and
the claim are keyed on.

---

## 5. Layer 2 — deliberately not built

A caller who sends no idempotency key and submits twice creates two
applications. There is no natural-key deduplication rejecting the second.

That is a choice, and the reasoning is:

- Two submissions without a key genuinely **are** two applications. The person
  may be trying a different amount, and silently returning the first verdict
  would be wrong.
- Any natural-key rule needs a time window, and a window boundary is arbitrary
  in exactly the way that produces bad behaviour: two submissions a minute apart
  either side of a boundary get treated differently from two submissions twelve
  hours apart inside one.
- The thing that must not be duplicated — the bureau pull — is already prevented
  by layer 3, which holds regardless of what the client sends.

So the cost of not building it is bounded: an extra row, never an extra pull. If
this later proves noisy in the funnel data, the right fix is a soft "you already
applied a minute ago, is this intentional?" at the edge, not a hard constraint in
the core.

---

## 6. Layer 4 — retries of our own call

When the bureau times out, the retry must be recognisable as the *same* enquiry.
The request id is generated once per logical pull and reused across every
attempt.

Generating a fresh id per attempt turns each retry into a new enquiry from the
bureau's point of view — the same class of mistake as putting `Date.now()` into
a deduplication key.

Retry policy: jittered exponential backoff; retry timeouts, `5xx`, `429`, `408`;
**never** other `4xx`, because a `400` is our bug and retrying it only burns the
budget; honour `Retry-After`; cap the attempts and then treat the bureau as
unavailable.

---

## 7. How each layer is proven

Full detail in `docs/07-testing.md`. **Which of these is a test and which is a
mechanism nobody raced is stated per row**, because the difference matters most
in exactly this section: it is the one a reader consults to learn what is true
about the requirement the brief singled out.

| Property | Layer | Covered by |
|---|---|---|
| Same key twice → one application, byte-identical replay | 1 | `integration/vertical-slice` |
| Same key, different body → `422`, first application untouched | 1 | `integration/vertical-slice` |
| N concurrent requests, same key → exactly one application row | 1 | `integration/vertical-slice` — eight at once |
| Two clients, same key string → two applications, neither sees the other's body | 1 | `integration/review-findings` — two real clients |
| Expired lease with `application_id` set → the orphan is **resumed**, not duplicated | 1 | **not tested.** The resume path and the duplicate-verdict recovery beside it are exercised only by inspection |
| Two sequential applications, same person, inside TTL → **one** bureau call | 3 | `integration/vertical-slice` |
| Two applications after the TTL → two calls | 3 | **not tested.** Needs a clock the integration suite does not inject |
| Two applications, different people → two calls | 3 | **not tested** directly; implied by every other case pulling once per subject |
| Same person, first lookup was `NO_HIT`, inside TTL → **one** call | 3 | `integration/vertical-slice` |
| N concurrent applications, same person → **exactly one** bureau call | 3 | `integration/vertical-slice` — six at once |
| Claim holder fails → next request pulls successfully, is not blocked | 3 | **not tested.** `failClaim` makes the claim immediately reclaimable; no test races it |
| Expired lease is taken over | 3 | **not tested** beyond the schema-level constraint |
| Wait expires, report lands late → the late report is used, not `BUREAU_UNAVAILABLE` | 3 | **not tested.** The re-read exists in the gateway and no test races a winner against a waiter |
| Three spellings of one identifier → one subject key, one call | 3 | `integration/vertical-slice`, `unit/bureau-provider` |
| Two attempts of one pull carry the same request id | 4 | `unit/bureau-provider` |
| `4xx` from the bureau → zero retries | 4 | **not implementable.** `BureauProviderFailure` has no 4xx to express, so the rule in §6 is specified and unenforced |

Eight of sixteen are tests. The other eight are mechanisms that exist in the
code and that no test drives into the race they are written for — and the honest
reading of that is: the *deterministic* half of layer 3 is proven, the
*timing-dependent* half is argued. The two properties in bold are the assignment
itself, and both are tests: they hit real unique constraints, they are paired
with a schema-level test asserting the constraint exists, and against an
in-memory substitute they would pass while proving nothing.

**Why the untested eight were not written.** Every one of them needs either an
injected clock inside the integration suite or a deliberate mid-flight pause in
one request while another proceeds. Both are buildable; neither was built, and
saying so is cheaper than a table that reads as sixteen guarantees when it is
eight. An earlier version of this table listed all sixteen with no distinction —
and `docs/06`'s coverage table, which is the same claim from the other side, had
drifted into naming ten test files that did not exist.

---

## 8. What is still weak

- The bounded wait is a poll, not a notification. At this volume that is fine;
  `LISTEN/NOTIFY` would remove the polling and is not worth the complexity yet.
- There is no circuit breaker. Under a sustained bureau outage the backoff and
  the attempt cap protect us, but we keep calling a service that is down.
- The reuse window is global. A per-product or per-risk-segment TTL is plausible
  and is not implemented.
- Reuse is keyed per `provider`. With one provider this is inert; it exists so
  that adding a second bureau does not silently serve one provider's report
  where another's was expected.
