# Instant Loan Pre-Decision API

A backend service that accepts a loan application, returns an instant
**pre-decision** — `APPROVED`, `DECLINED` or `MANUAL_REVIEW` — with stable reason
codes, and keeps every pre-decision reproducible long after the rules have
changed.

Submitted as an offline technical task. Synthetic data only; no real credit
bureau is contacted.

**Author:** Vasyl Terletskyi
**Honest time spent:** _<fill in before sending — include the time spent
understanding the domain, not only the time spent typing>_
**Live service:** <https://loan-predecision.onrender.com>

---

## What makes this more than a CRUD endpoint

Four things carry the weight, and all four are documented rather than implied.

**A duplicate submission must not cause a duplicate bureau enquiry — and that is
a product requirement, not a caching one.** A hard credit enquiry costs money
*and* is recorded on the applicant's file, where it can lower their score. So
the guarantee has to hold even when the caller sends no idempotency key and the
two submissions are genuinely different applications. It is solved in layers, and
the layer that matters keys on the person, not on the request.
→ [`docs/02-idempotency.md`](docs/02-idempotency.md)

**"Auditable" means reproducible, not logged.** Every pre-decision stores its
inputs, an immutable snapshot of the bureau lookup it used, the policy version
and the engine version. `POST /v1/audit/pre-decisions/{id}/replay` re-runs the
engine against that stored evidence and reports whether the result still matches.
That is possible only because the engine performs no I/O.
→ [`docs/04-audit.md`](docs/04-audit.md)

**A pre-decision is not the final decision, and the schema knows it.** When an
application is referred, a person decides using criteria this service does not
model. That outcome is a separate record with its own actor — not an edit to the
engine's verdict. Which is what keeps replay meaningful: a legitimate human
override cannot be mistaken for evidence tampering.
→ [`docs/adr/0006-human-review-outcome-is-a-separate-entity.md`](docs/adr/0006-human-review-outcome-is-a-separate-entity.md)

**Reason codes are derived, not curated.** Each scorecard factor contributes
`pointsLost = max − awarded`; the disclosed codes are the largest losses, capped
at four. Regulation B's commentary requires that no factor which was a principal
reason be omitted, and identifies two benchmark methods for choosing those
reasons — plus any method producing results substantially similar *to them*.
Ranking by shortfall is offered here as that third option, with the limitation
stated rather than glossed: the benchmarks compare against an observed
population, and this scorecard compares against each factor's theoretical
maximum on bands that are not calibrated. Deriving the codes mechanically means
they cannot drift from what moved the outcome; it does not by itself make them
the sanctioned method.
→ [`docs/03-decision-policy.md`](docs/03-decision-policy.md)

---

## Run it

Requires Node 20+ and Docker.

```bash
git clone <repo> && cd loan-predecision
cp .env.example .env          # SUBJECT_KEY_PEPPER has no default; set one
docker compose up -d db       # Postgres 16
npm ci
npm run migrate               # forward-only, under an advisory lock
npm run dev
```

| Command | What it does |
|---|---|
| `npm test` | unit + integration + api. Integration needs Postgres and **skips** without it — CI sets `REQUIRE_DATABASE=1` so the skip is a hard error there |
| `npm run test:unit` | pure functions only; no database needed |
| `npm run test:integration` | the constraints and transactions, against real Postgres |
| `npm run test:api` | the contract, via Fastify `inject()` — no port, no socket |
| `npm run typecheck` | |
| `npm run lint` | guards one architectural invariant, not style — see ADR-0008 |
| `npm run migrate` | applies pending migrations; idempotent |
| `npm run openapi` | regenerates `openapi.json` from the route schemas |
| `npm run openapi:check` | fails if the committed spec has drifted from the code |
| `./demo.sh` | walks the interesting paths against a running instance |

The service listens on `http://localhost:3000`, and serves its own reference at
`/docs`. `./demo.sh` exercises what is built and prints `PENDING` for what is
not, so it never quietly covers half of what this documentation promises — and
each phase deletes one of those lines. Point it anywhere:

```bash
BASE_URL=https://loan-predecision.onrender.com \
SUBMISSION_TOKEN=... AUDITOR_TOKEN=... ./demo.sh
```

### Trying the deployed instance

**<https://loan-predecision.onrender.com/docs>** is the fastest way in: an
interactive reference generated from the route schemas, with an **Authorize**
button for the demo token. The page is public; every call it makes still needs
the token. `openapi.json` in the repository is the same contract, and CI fails
if it drifts from the code — see ADR-0009.

```bash
BASE_URL=https://loan-predecision.onrender.com

curl -sS "$BASE_URL/health/live"                                  # {"status":"ok"}
curl -sS "$BASE_URL/health/ready"                                 # {"status":"ready"} — reaches Neon
curl -sS "$BASE_URL/metrics" -H "Authorization: Bearer $AUDITOR_TOKEN"
```

`./demo.sh` runs every one of these and prints what is not built yet:

```bash
BASE_URL=https://loan-predecision.onrender.com \
SUBMISSION_TOKEN=... AUDITOR_TOKEN=... ./demo.sh
```

`DEMO_TOKEN` and `AUDITOR_TOKEN` are in the submission email — throwaway
credentials for the review environment only. The endpoints are authenticated on
purpose: this service accepts a national identifier and can trigger a bureau
enquiry, and an open endpoint would let anyone mark a stranger's credit file.

> **Not built yet.** `POST /v1/applications`, the status and review endpoints,
> and everything under `/v1/audit/` are documented in
> [`05-api.md`](docs/05-api.md) and are the subject of the next phase. This
> section only shows commands that work against the deployed instance today;
> `./demo.sh` lists the rest as `PENDING` rather than letting you discover them
> with a 404.

> **The first request after a quiet period is slow twice.** Render suspends a
> free instance after 15 minutes of inactivity and takes about a minute to wake;
> Neon suspends its compute after 5 and cannot be told not to on the free plan.
> Expect tens of seconds on the first call and single-digit milliseconds after.
> `GET /health/ready` is the cheapest way to warm both.

## Documentation

Read in this order. About twenty-five minutes end to end.

| Document | What it answers |
|---|---|
| [`00-scope.md`](docs/00-scope.md) | What is in, what is out, what was assumed, what was deliberately cut |
| [`01-architecture.md`](docs/01-architecture.md) | Layers, the request path, the data model, where the guarantees physically live |
| [`02-idempotency.md`](docs/02-idempotency.md) | **The central problem.** Four kinds of duplicate, four mechanisms |
| [`03-decision-policy.md`](docs/03-decision-policy.md) | The pipeline and its precedence, the scorecard, the counter-offer, how reason codes are derived, a worked example |
| [`04-audit.md`](docs/04-audit.md) | What is stored and why, the hash chain, replay, retention classes |
| [`05-api.md`](docs/05-api.md) | Every field, real request/response pairs, the error catalogue, the auditor endpoints |
| [`06-failure-modes.md`](docs/06-failure-modes.md) | What breaks, how we notice, what happens — and how this is deployed |
| [`07-testing.md`](docs/07-testing.md) | Which properties are proven, and which are honestly not |
| [`08-mock-bureau.md`](docs/08-mock-bureau.md) | The bureau contract, the three outcomes, the profile catalogue |
| [`adr/`](docs/adr/) | Eight decisions, each with the alternative that was rejected and why |

`policies/2026.09.1.json` is the live policy: thresholds, scorecard bands,
product limits, and the registry of every reason code the engine can emit. Old
versions are never deleted, because a pre-decision is replayed against the
version it was made under.

---

## The shape of it

```
src/
  http/            routes, request schemas, auth, error mapping
  services/        orchestration, idempotency, audit recording, review closing
  domain/          screen, decide, policy, reason codes   ← no I/O
  bureau/          gateway (reuse + single-flight), mock bureau, resilience
  db/              pool, migrations, repositories
policies/          versioned policy documents, append-only
docs/              the documentation above
tests/             unit (pure) · integration (real Postgres) · api
```

The domain layer calls nothing. Everything it needs arrives as an argument,
which is what makes pre-decisions testable without a database and replayable
years later.

---

## Known limits

Stated here rather than discovered later. Full list in
[`06-failure-modes.md`](docs/06-failure-modes.md).

- No rate limiting. Reserved as `429`; the first thing to add after v1.
- No circuit breaker. A sustained bureau outage means we keep calling a dead
  service, protected only by backoff and an attempt cap.
- The audit chain detects row-level tampering, not a consistent rewrite by
  someone with full database access. That needs an external anchor.
- Reads are owner-scoped: a client sees its own applications and nothing else.
  There are no roles, no delegation and no per-application grants beyond that.
- **The bureau pull claim is a lease, not a constraint.** It stops two callers
  holding it at once; it does not make two pulls impossible. A holder that is
  alive but stalled past the lease can produce a second hard enquiry, and nothing
  in the database objects. `docs/01-architecture.md` §3 names what fencing would
  cost, why v1 does not pay it, and the trigger for paying it. This is the one
  guarantee in the design that is weaker than it first looks, and it guards the
  requirement the brief singled out.
- Metrics are exported; **no scraping, alerting or dashboard is deployed.** The
  "how we notice" column in the failure-mode table is intended operation, not
  shipped capability.
- Consent is a caller attestation. It records who claimed the applicant
  authorised the enquiry and when; it does not prove they did.
- Scorecard bands are invented, not calibrated against outcome data.
- The p95 budget is a design constraint the timeout and retry numbers were chosen
  to fit, not a measured figure. There is no load test.
- The bureau is a mock. It is deterministic by design, so tests and demos are
  reproducible, and it can be made to fail on demand so the failure path is
  visible in the deployed instance.
