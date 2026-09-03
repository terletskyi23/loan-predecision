# 06 — Failure modes and operations

What breaks, how we find out, what the system does about it, and what a person
has to do. Rows marked **named** are understood and deliberately not handled in
v1; they appear here rather than being discovered later.

Every row either maps to a test in `docs/07-testing.md` or is marked *named*.
That correspondence is maintained deliberately, so this table cannot drift into
optimism.

---

## External dependencies

| What breaks | How we notice | What the system does | What a human does |
|---|---|---|---|
| Bureau returns `5xx` or times out | `bureau_pulls_total{result="failure"}`, manual-review share rises | Jittered backoff, one retry, then `MANUAL_REVIEW` + `BUREAU_UNAVAILABLE`. The application is persisted either way | Underwriters work the review queue; on-call checks the provider status |
| Bureau is slow but succeeding | `bureau_call_duration_seconds` p95 approaches the 800 ms timeout | Nothing automatic. Requests get slower, then start timing out into review | Raise the timeout or degrade deliberately; do not let it drift |
| Bureau returns `4xx` | Same counter, `result="client_error"` | **Zero retries.** A `400` is our bug and retrying only burns budget | Fix the request contract |
| Bureau is down for hours | Manual-review share near 100% | Backoff and the attempt cap protect us, but we keep calling a dead service | **named** — no circuit breaker in v1. `docs/02-idempotency.md` §8 |
| Bureau has no file for this person | `predecision_outcomes_total` shows `NO_CREDIT_FILE` referrals | Stored as a `NO_HIT` report, reused inside the TTL, referred with `NO_CREDIT_FILE` | Underwriter assesses a thin/no-file applicant. **Not** an outage, and the code says so |
| Bureau returns a report missing a required attribute | `predecision_outcomes_total` shows `BUREAU_DATA_INCOMPLETE` | `MANUAL_REVIEW`. Never scores the gap as zero — that would decline someone for our data defect | Investigate the provider contract |
| Bureau returns a well-formed but nonsense report | Nothing catches it | The scorecard consumes it as fact | **named** — no plausibility checks on bureau attributes |

## Database

| What breaks | How we notice | What the system does | What a human does |
|---|---|---|---|
| Postgres unreachable | `/health/ready` fails, `http_errors_total{class="5xx"}` | `503` to callers; liveness still passes, so the platform does **not** restart the container into a crash loop while the dependency is down. With more than one instance a load balancer would also stop routing here; at v1's single instance the restart-loop prevention is the whole benefit | Restore the database. No application data is lost — nothing was accepted |
| Connection pool exhausted | Latency climbs, then acquisition timeouts | Requests fail with `503` | Raise `DATABASE_POOL_MAX`, or find the query holding connections |
| Failure between the pre-decision insert and the audit insert | Would be invisible — that is the point | Cannot happen: one transaction. Neither row exists, and the idempotency key is not marked complete | Nothing. The client retries with the same key |
| Migration fails on boot | The process exits, deploy fails | Refuses to start rather than serving against a half-migrated schema | Fix forward. Down-migrations are **named**, not exercised |
| Two instances boot and both migrate | Would race and corrupt | Migration runs inside a Postgres advisory lock; the second instance waits, then finds nothing to do | Nothing |

## Duplicates, concurrency and crashes

| What breaks | How we notice | What the system does | What a human does |
|---|---|---|---|
| Same request retried after a network blip | `idempotency_replays_total` rises | Stored response replayed byte for byte. No second pre-decision, no second pull | Nothing |
| Client reuses one key for different bodies | `idempotency_conflicts_total` rises | `422 IDEMPOTENCY_KEY_REUSED` | Tell the integrator — this is a client bug and the counter is how you find it |
| Two integrators pick the same key string | Would leak one's response to the other | Cannot happen: the key is `(client_id, scope, key)` and `client_id` comes from the token | Nothing |
| Two concurrent applications for one person | `bureau_claim_contention_total` rises | The claim collapses them into one pull; the loser waits for the winner's report | Nothing |
| The winner's pull fails while a loser is waiting | `bureau_pulls_total{result="failure"}` | The loser sees the claim go `FAILED` and **stops immediately**, adopting the winner's real cause. It does not sit out the full wait and it does not record `WAIT_EXPIRED` | Treat as the bureau failure it is |
| The loser's wait expires with the claim still `IN_FLIGHT` | **`bureau_wait_expired_total`** rises | Re-reads once, uses a late-landing report if there is one, otherwise refers with `cause: WAIT_EXPIRED` | The winner is alive and slower than our patience. Usually the wait is too short for the retry budget — this counter means that and only that, now that a failed claim short-circuits the wait |
| Claim holder crashes mid-pull | Latency spike for that one subject | The 5-second lease expires; the next request takes the claim over | Nothing |
| **Process dies mid-pull, client never retries** | `applications_abandoned_total` rises | The application sits in `RECEIVED` with no pre-decision. The sweeper moves it to `ABANDONED`, retires the idempotency key in the same transaction, and appends an audit event. The `BUREAU_PULL_REQUESTED` event written before the call survives, so the record that this file was marked is not lost with the crash | Non-zero means crashes. Look at why the process died |
| Client retries hours after the sweep retired the key | `idempotency_replays_total` does not move | Treated as a fresh submission. Not a resume — the original is terminal — and not a second bureau pull, because layer 3 still holds | Nothing |
| A slow-but-alive claim holder loses its lease | `bureau_claim_contention_total` | A second pull happens. The write is not fenced, and no constraint objects | **named** — the one place a guarantee is a lease rather than a constraint. `docs/01-architecture.md` §3 names the fix, the cost and the trigger |
| Process dies mid-pull, client retries the same key | Latency spike | The lease expires and the taker **resumes the original application** via `idempotency_keys.application_id` — it does not create a second one | Nothing |
| Deduplication silently stops working | **`bureau_reuse_ratio` falls** | Nothing automatic | Investigate immediately. No other signal would reveal this — errors stay at zero while costs and applicant harm rise |
| Client submits twice with no idempotency key | Two applications, one pull | Accepted by design — `docs/02-idempotency.md` §5 | Nothing, unless funnel data shows it is noisy |
| Two reviewers close one case at the same time | `409` in the reviewer's client | Conditional update: one write wins, the other gets `REVIEW_ALREADY_CLOSED` | Nothing |

## Policy and decisions

| What breaks | How we notice | What the system does | What a human does |
|---|---|---|---|
| A policy change shifts outcomes unexpectedly | `predecision_outcomes_total{verdict}` mix moves | Nothing automatic | Compare against the previous `policy_version`; roll the policy file back via git and redeploy — see §Deployment for what that costs |
| Manual-review queue grows faster than it is worked | Manual-review share, plus `review_outcomes_total` lagging | Nothing automatic | Either staff the queue or revisit the referral band. Both are risk decisions |
| An old policy file is deleted | Replay of decisions under that version fails | Replay returns an error rather than a wrong answer | Restore the file. The policy directory is append-only by rule |
| Engine change alters an old verdict | `match: false` on replay | Nothing automatic — replay is on demand | Treat as an incident: either evidence was altered or reproducibility broke |
| A human overrides the engine | `outcome.source = REVIEWER`; `review_outcomes_total` | Nothing. Replay still reports `match: true`, because it compares the engine's verdict | Nothing. This is the normal case, and the schema is shaped so it cannot be mistaken for tampering |
| Thresholds drift from what risk intended | Nothing catches it | Nothing | **named** — no automated policy backtesting in v1 |

## Security and data

| What breaks | How we notice | What the system does | What a human does |
|---|---|---|---|
| Submission token leaks | Unusual volume from one `client_id` | Nothing automatic | Rotate the token. Tokens are a list, so rotation is not downtime |
| Reviewer token leaks | Review outcomes from an unexpected actor | Nothing automatic | Every close carries `reviewer_id` in the audit chain, so the blast radius is enumerable | 
| Someone edits an audit row directly | `chainIntact: false` on verification | Detected, not prevented | Incident. The chain names the broken index |
| Someone rewrites the whole chain consistently | Not detected | — | **named** — needs an external anchor for the head hash |
| `SUBJECT_KEY_PEPPER` rotated carelessly | Reuse ratio collapses; every subject looks new | Nothing automatic | Rotation is a migration, not a config change. Plan it |
| A caller attests consent it never captured | Nothing catches it | We record who attested and when, and nothing more | **named** — the attestation is evidence of a claim, not proof of consent. `docs/00-scope.md` A11, ADR-0007 |
| Personal data reaches the logs | Nothing catches it automatically | Redaction is on the logger serialisers, not per call site | **named** — no automated PII scan over log output |
| Flood of submissions from one caller | Volume metrics per `client_id` | Nothing — no rate limiting | **named**, reserved as `429 RATE_LIMITED`. The single highest-value addition after v1 |

## Operational

| What breaks | How we notice | What the system does | What a human does |
|---|---|---|---|
| Instance wedged but process alive | `/health/live` still passes | Nothing | **named** — liveness is deliberately shallow. A deep liveness probe restarts containers during a dependency outage, which is worse |
| Free-tier host sleeps the instance | First request takes tens of seconds | Cold start | Documented in the README so a reviewer is not confused |
| Clock skew between instances | Lease and TTL boundaries behave oddly | Leases are generous enough to absorb normal skew | **named** — no NTP monitoring |

---

## Deployment

The only deliverable that can fail for reasons unrelated to the code, so it is
described here rather than assumed.

**Shape.** One container image, one managed Postgres instance, one public HTTPS
URL. The image is multi-stage and runs as a non-root user. Nothing in the design
assumes a single instance — the correctness guarantees are database constraints,
not process-local state — but v1 is deployed as one.

**Release procedure.**

1. CI runs typecheck, unit, integration and API tests against a Postgres service
   container. A red build does not produce an image.
2. The image is built and deployed.
3. On boot the process validates its configuration against the schema and exits
   on any bad value, **before** binding a port. A missing `SUBJECT_KEY_PEPPER`,
   or empty token lists in production, is a failed deploy rather than a service
   that answers requests insecurely.
4. Migrations run on boot inside a Postgres advisory lock. Two instances booting
   together cannot both migrate: the second blocks until the first commits, then
   finds nothing to apply. Without the lock, `MIGRATE_ON_BOOT` is a race that
   only appears the first time the platform starts two containers at once.
5. `/health/ready` gates traffic. It answers `200` only once Postgres responds.

**Rollback.** Redeploy the previous image. Migrations are forward-only in v1, so
a rollback is safe exactly as long as the previous image tolerates the newer
schema — which additive migrations satisfy and destructive ones do not. The rule
that keeps this true: no migration in v1 drops or renames a column that a
released image reads. Down-migrations are **named, not exercised**.

**Rolling back a bad policy is a deploy, not a config change.** ADR-0005 accepts
that cost, and this is where the cost is stated: reverting the policy file and
redeploying is bounded by the CI and deploy time, in the order of ten minutes.
For a threshold that is actively approving loans it should not be approving, ten
minutes is a real number that a risk owner has to agree to in advance. The
alternative — a policy table with a kill switch — is the first thing to build if
that number is judged too slow.

**Secrets.** `SUBJECT_KEY_PEPPER`, `API_TOKENS`, `REVIEWER_TOKENS`,
`AUDITOR_TOKENS` and `DATABASE_URL` are set in the platform's secret store, never
in the image or the repository. `.env.example` lists every variable with its
default and, where a value carries risk, the reason it has none.

---

## What to alert on

Not everything above deserves a page. Four signals, in order:

1. **Manual-review share** — catches a broken policy, a failing bureau and a bad
   deploy, all at once.
2. **Bureau failure rate.**
3. **`bureau_reuse_ratio` falling** — the only signal that the central
   requirement of this service has stopped working. It is a business ratio, so it
   moves with traffic composition too: it needs a baseline before it can be
   alerted on, and it is noisy. It stays first among the deduplication signals
   because nothing else moves at all when dedup breaks.
4. **`applications_abandoned_total` non-zero** — the service is crashing mid-pull.

A raw error count is deliberately not on that list: `4xx` from a buggy
integrator would drown a real `5xx` outage, which is why the two are counted
separately in the first place.


---

## Coverage table

Every row above, in order, against the test that covers it. `named` means
understood and deliberately not tested in v1 — the list is long on purpose, and
a short honest list beats a long optimistic one. `docs/07-testing.md` §7
criterion 2 is a check against this table, which is why it can be a grep.

| Row | Covered by |
|---|---|
| Bureau `5xx` / timeout | `integration/bureau-resilience` — retries then `MANUAL_REVIEW` |
| Bureau slow but succeeding | `named` — no latency test |
| Bureau `4xx` | `integration/bureau-resilience` — zero retries |
| Bureau down for hours | `named` — no circuit breaker |
| Bureau no file | `unit/lookup-gate`, `integration/dedup` — `NO_HIT` stored and reused |
| Report missing an attribute | `unit/lookup-gate` — `BUREAU_DATA_INCOMPLETE` |
| Nonsense but well-formed report | `named` — no plausibility checks |
| Postgres unreachable | `api/health` — ready `503`, live `200` |
| Pool exhausted | `named` |
| Failure between pre-decision and audit insert | `integration/atomicity` |
| Migration fails on boot | `named` — CI runs forward migrations only |
| Two instances both migrate | `named` — advisory lock not exercised in CI |
| Retry after a network blip | `integration/idempotency` — byte-identical replay |
| One key, different bodies | `integration/idempotency` — `422` |
| Two integrators, same key string | `integration/idempotency` — cross-client isolation |
| Two concurrent applications, one person | `integration/dedup` — exactly one pull |
| Winner fails while a loser waits | `integration/dedup` — loser adopts the real cause |
| Loser's wait expires | `integration/dedup` — late report is used |
| Claim holder crashes | `integration/dedup` — lease takeover |
| Process dies mid-pull, no retry | `integration/orphan-sweeper` |
| Retry after the sweep | `integration/orphan-sweeper` — fresh application, no second pull |
| Slow-but-alive holder loses its lease | `named` — unfenced by decision |
| Dedup silently stops working | `api/metrics` — `bureau_reuse_ratio` moves on reuse |
| Two submissions, no key | `integration/idempotency` — two applications, one pull |
| Two reviewers close at once | `integration/review` — one write, one `409` |
| Policy change shifts outcomes | `named` — no backtesting |
| Review queue grows | `named` — no queue in this service |
| Old policy file deleted | `unit/policy-loader` — historical files still parse |
| Engine change alters an old verdict | `integration/replay` — newer policy is not used |
| Human overrides the engine | `integration/replay` — still `match: true` |
| Thresholds drift | `named` |
| Submission token leaks | `named` |
| Reviewer token leaks | `named` |
| Audit row edited directly | `integration/audit-chain` — broken at the right index |
| Whole chain rewritten | `named` — needs an external anchor |
| Chain truncated | `named` — same anchor |
| Pepper rotated carelessly | `named` |
| Caller attests consent it never captured | `named` — unknowable here by construction |
| Personal data in logs | `named` — no automated PII scan |
| Flood from one caller | `named` — no rate limiting |
| Instance wedged, process alive | `named` — liveness deliberately shallow |
| Free-tier cold start | `named` |
| Clock skew | `named` |
