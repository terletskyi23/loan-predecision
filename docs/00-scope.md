# 00 — Scope, assumptions and boundaries

Instant Loan Pre-Decision API. Written during framing, before design or code,
and updated as decisions landed.

## 1. What this service does

Accepts a loan application, runs an instant **pre-decision**, and returns a
structured verdict (`APPROVED` / `DECLINED` / `MANUAL_REVIEW`) with stable reason
codes. Every pre-decision is persisted, reproducible and auditable. A duplicate
submission must not cause duplicate work at the credit bureau.

Flow: submit → validate → screen → call the mock credit bureau → decide →
persist and audit → return verdict.

**Pre-decision, not decision.** The verdict rests on data the applicant declared
about themselves plus a bureau report. Nothing has been verified: no documents,
no KYC, no income check. This is why an instant answer is possible at all, why
declared income is acceptable here, and why every approval carries an expiry.

The word is used consistently throughout: the engine produces a **pre-decision**,
and where an application is referred, a person at the lender makes the **final
decision** using criteria this service does not model. The two are different
records made by different actors, and the API returns both. See ADR-0006.

## 2. In scope

- `POST` submit an application, idempotent
- `GET` application status and verdict
- Mock credit bureau, implemented in this repository and specified in `docs/08`
- Versioned scorecard policy with derived reason codes
- Audit trail with replay and chain verification
- Deduplication of bureau work
- Recording the **outcome** of a manual review, so a referred application reaches
  a terminal state and the audit trail is complete
- Tests
- Deployed service over public HTTPS with health checks and metrics

## 3. Out of scope

Given by the brief: full origination, disbursement, KYC UI, real bureau
integrations, frontend.

Added deliberately:

| Not built | Why |
|---|---|
| Manual-review **workflow** — queue, assignment, SLA, reviewer UI | The workflow belongs to another system. What is built is the *record* of the outcome: without it a referred application has no terminal state and `REVIEW_CLOSED` is an audit event nothing can emit. The line between the two is drawn in `docs/05-api.md` §5 |
| Reopening a closed review | One review per application, closed once. A history table is the migration if this proves wrong (ADR-0006) |
| Consent capture — disclosure texts, versions, the record of what was shown | Happens in the frontend, which the brief excludes. We record an attestation and say plainly what it does not prove (ADR-0007) |
| Rate limiting | Named in failure modes, reserved as `429`. The highest-value addition after v1 |
| Circuit breaker on the bureau client | Backoff and a capped attempt budget cover the common case |
| Natural-key deduplication (layer 2) | See `docs/02-idempotency.md` §5 |
| Risk-based pricing | One product, one rate. The scorecard already produces the input a rate curve would need |
| Pseudonymisation and erasure jobs | The schema does not block them; the jobs are not written |
| External anchoring of the audit chain head | Named in `docs/04-audit.md` §3 |
| Authorisation on reads **beyond ownership** | Reads *are* owner-scoped: the repository compares `applications.client_id` against the identity on the bearer token and returns nothing on a mismatch. This row previously said "beyond an unguessable id", which under-claimed what the code does. What is genuinely absent is anything past ownership — no roles, no delegation, no per-application grants. `docs/05-api.md` §4 covers why an unknown id and another client's id return byte-identical `404`s |
| Tenant scoping on the **review close** | Any holder of a reviewer token can close any referred application, and `reviewerId` is taken from that token. Defensible — reviewers are internal staff and the three scopes already stop a submitter approving their own application — but it is a *write* and it does not have the ownership check the reads have. Named here rather than left to be found |

## 4. Decisions taken

### 4.1 The API is synchronous

`POST /v1/applications` returns the verdict in the response, which follows from
the word *instant*.

**Then why a status endpoint?** Because `MANUAL_REVIEW` is not terminal. An
application routed to a human is decided later and the client must be able to
come back for the outcome. The same endpoint also serves the idempotent re-read.

Cost, stated openly: the synchronous path holds a connection for the duration of
the bureau call. Fine at the assumed volume; first thing to change at ten times
it.

### 4.2 Duplicate submission is defined at two layers

Layer 1 (transport, `Idempotency-Key`, scoped per client) and layer 3 (external
effect, bureau reuse plus a single-flight claim). Layer 2 is deliberately
omitted. Full reasoning in `docs/02-idempotency.md` and ADR-0002.

### 4.3 The engine is split at the bureau call

`screen(...)` runs the eligibility knockouts that need no bureau data, **before**
the pull. `decide(...)` runs everything else, after. An applicant who is under 18
or asking for twice the product ceiling therefore gets no hard enquiry recorded
against their file for an application that was never going to succeed.

### 4.4 A bureau failure produces `MANUAL_REVIEW`, and the application is always persisted

ADR-0003. A **no-hit** is a different fact and carries its own code,
`NO_CREDIT_FILE`.

### 4.5 The engine is pure; the policy is versioned and lives in git

ADR-0004 and ADR-0005.

### 4.6 The scorecard is ours, computed from bureau attributes

The bureau returns attributes rather than a composite third-party score. A
composite score is a number we cannot explain, and every reason code would then
rest on somebody else's black box. See `docs/03-decision-policy.md` §7.

### 4.7 Health checks are split

`/health/live` — the process is up, touches nothing. `/health/ready` — verifies
the database, returns `503` when it is unreachable so a load balancer stops
routing without the container being killed.

### 4.8 Three authentication scopes

Submission, review and audit. The endpoint accepts a national identifier and can
trigger a bureau enquiry; left open, it would let anyone submit other people's
identifiers and mark their credit files. Separating the audit scope means a
leaked front-end token does not expose the decision history. Separating the
review scope means the party that submits an application cannot also approve it.

### 4.9 `customerId` is context, never a key

Optional, recorded, never used for deduplication or decisions. `docs/05-api.md`
§3 has the three reasons.

### 4.10 Counter-offer instead of a flat decline on affordability

When DTI exceeds the limit, the largest affordable principal is offered instead
of refusing outright. Under Regulation B this is a counteroffer and therefore
carries reason codes.

### 4.11 A human's outcome is a separate record

Not an edit to the pre-decision. ADR-0006, and it is what keeps replay meaningful.

### 4.12 Consent is a caller attestation

Required, time-bounded, recorded with the attesting client — and explicitly not
a proof that the applicant consented. ADR-0007.

## 5. Assumptions

| # | Assumption | Why it matters |
|---|---|---|
| A1 | Tens of thousands of applications per day, peaks in the hundreds per minute | A synchronous bureau call is viable here; it is not at millions |
| A2 | Response budget: p95 under 2 seconds on the **common path** — a reused report, or a pull that succeeds on the first attempt. Two named exceptions sit above it: a retried pull costs ~1.8 s at the bureau alone, and a concurrent loser waits up to `BUREAU_WAIT_MS` for someone else's pull. Ceiling ~2.5 s. **Not measured** | Sets the bureau timeout and the retry budget. The earlier version of this assumption claimed a flat p95 under 2 s while configuring a 2-second per-attempt timeout with three attempts, which one timeout consumed entirely. `docs/02-idempotency.md` §4.4 derives the current numbers |
| A3 | Declared income is not independently verified at this stage | Affects which reason codes are honest to emit |
| A4 | A small fixed product catalogue, kept in the policy document | No product table in v1 |
| A5 | Write endpoints behind a bearer token; reads by opaque id | The brief is silent; an open endpoint would itself be a decision |
| A6 | Synthetic data only; no real bureau is contacted | Stated by the brief |
| A7 | Single deployed instance, but nothing in the design assumes it | Concurrency is handled by database constraints, not process-local state |
| A8 | The market modelled is US consumer unsecured lending | Terminology, the four-reason discipline and the 43% DTI benchmark come from there |
| A9 | Scorecard weights mirror the published composition of the FICO score; band tables are invented | Not calibrated against outcome data, and said so |
| A10 | Regulatory references describe US practice as commonly implemented | A real deployment confirms current requirements with compliance counsel, not with this document |
| A11 | A consent attestation records **who claimed the applicant authorised the enquiry, and when**. It is not proof the applicant did | Authentication says which organisation is asking; the attestation says when they claim authorisation was given; neither establishes the applicant's actual consent. Under FCRA the permissible purpose stays with the party performing the pull, and can be shifted to an integrator by contract but not by API design |
| A12 | One review per application, closed once, never reopened | ADR-0006 names the migration if this is wrong |
| A13 | An application left in `RECEIVED` by a crashed process is resolved by a sweeper, not by a human | Nothing else would ever move it out of a non-terminal state |

## 6. Hours

Recorded honestly in the README, including time spent understanding the domain.
