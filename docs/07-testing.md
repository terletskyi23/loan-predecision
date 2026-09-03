# 07 — Testing strategy

What is proven, how, and — where it matters — what is deliberately not proven.

The organising rule: **a test earns its place by naming something that would
break in production if it were missing.** Line coverage is not a goal and is not
reported. The completeness criterion used instead is stated at the end.

---

## 1. Three layers, and what each is for

| Layer | Runs against | Speed | Proves |
|---|---|---|---|
| `tests/unit/` | Nothing external. Pure functions only | ms | The rules are right |
| `tests/integration/` | Real Postgres, fake bureau | tens of ms | The constraints and transactions are right |
| `tests/api/` | Real Postgres, fake bureau, Fastify `inject()` | tens of ms | The contract is right end to end |

No HTTP mocking library, and no mocking of our own modules. The bureau sits
behind an interface with a fake implementation that counts calls and can be told
to fail, be slow, return `NO_HIT`, or return a named profile.

**Postgres is real, not simulated.** An in-memory substitute cannot enforce a
unique index, cannot roll back a transaction the way Postgres does, and cannot
lose a race. The tests that matter most in this service are exactly the ones
such a substitute would pass while proving nothing.

---

## 2. Fixtures and mechanics

**The clock is injected.** `FixedClock` starts at a fixed instant and moves only
when told. TTL expiry, lease expiry, offer expiry, consent staleness and the
orphan sweeper are tested by advancing it, never by sleeping. A `Date.now()`
anywhere in the domain layer would make these tests impossible, which is why the
rule exists.

**Builders, not literals.** `anApplication({ requestedAmountMinor: 3_200_000 })`
and `aBureauReport({ revolvingUtilizationPct: 34 })` return valid defaults with
only the interesting field overridden. A test that spells out twenty fields
hides which one it is actually about.

**Isolation.** Integration tests share one database and `TRUNCATE … RESTART
IDENTITY CASCADE` between cases. `fileParallelism` is off in `vitest.config.ts`
so one file's truncate cannot wipe another file's fixtures mid-run. Concurrency
inside a single test is explicit and intended.

**A dedicated policy fixture.** Unit tests load `policies/test.json` with round
numbers, so an assertion never depends on a production threshold that risk may
change tomorrow. The real policy files get their own validation test instead.

---

## 3. What the unit tests prove

The engine is two pure functions, so these are table-driven and fast.

**Screening, and that it happens first**

- Every eligibility knockout produces its exact reason code and `DECLINED`.
- **A screened-out application produces zero bureau calls.** Asserted against the
  fake bureau's counter, in an integration test rather than a unit one, because
  it is a claim about orchestration. It is the test that keeps the ethical claim
  in `docs/03-decision-policy.md` §2 honest, and the previous design — a single
  `evaluate(...)` after the pull — would have failed it.

**Precedence**

- A thin file with a score above the auto-approve floor and a DTI over the limit
  produces `MANUAL_REVIEW` with `THIN_FILE`, not an approval and not a decline.
  This is the case that was undefined before D4 was ordered ahead of D5 and D6.
- A thin file with a score below the referral floor produces `MANUAL_REVIEW`, not
  `DECLINED`: an unreliable score does not become reliable by being low.
- `SCORE_IN_REFERRAL_BAND` is emitted from exactly one place. Asserted by
  searching the recorded outcomes of the whole suite for the code and checking
  every occurrence carries a score inside the band.

**The lookup gate**

- `UNAVAILABLE` → `MANUAL_REVIEW` + `BUREAU_UNAVAILABLE`, never `DECLINED`.
- `NO_HIT` → `MANUAL_REVIEW` + `NO_CREDIT_FILE`, with a stored report id. The
  test asserts the two codes are **not** interchangeable, because collapsing them
  is the tempting simplification and it tells a first-time borrower our vendor
  was down.
- `FOUND` with a required attribute missing → `MANUAL_REVIEW` +
  `BUREAU_DATA_INCOMPLETE`, never a score computed from a defaulted zero.

**Scorecard**

- Every factor is tested **at its band boundaries** — utilisation at exactly 10,
  30, 50, 75, 90; oldest account at exactly 12, 24, 48, 84. Band tables are wrong
  at the edges far more often than in the middle.
- **Band order matters, and the test proves the engine honours it.** A factor
  whose bands are deliberately reordered produces a different award. Without this
  the `FIRST_MATCH_WINS` rule is a comment.
- A value present but outside every band awards the factor's `default`.
- Band mapping at 44/45 and 69/70.

**Reason codes**

- Exactly the factors losing at least `materialPointsLost` points appear, capped
  at four.
- Ordering: decisive and referral codes first in registry order, then points lost
  descending, then code alphabetically. The same inputs produce a byte-identical
  list on repeat calls.
- A factor that lost points but stayed under the threshold is absent.
- A decline below the referral floor discloses scorecard factors and no
  score-specific code.

**Affordability**

- DTI above the limit with room to reduce → `APPROVED` at a lower amount, with
  `AMOUNT_REDUCED_TO_FIT_DTI`.
- The reduced amount, put back through the annuity, lands at or below `maxDti`.
  Asserted as a computed invariant, not against a hardcoded number — otherwise
  the test only proves the number was copied from the implementation.
- Reduction falling below the product minimum → `DECLINED` with
  `DTI_ABOVE_LIMIT`.
- **A verdict settled before D7 carries `dti: null`**, and one settled before D3
  carries `score: null` — including a bureau knockout, where data was available
  and the scorecard still never ran. A populated field from a stage that did not
  execute is a number nothing produced.
- **`monthlyPaymentMinor` is asserted against the half-up convention**, with the
  floor and truncation results named in the test as the wrong answers. Replay
  compares this field, so an undocumented convention is a `match: false` on every
  counter-offer.
- Money stays in integer minor units end to end; no assertion uses a tolerance,
  because there is nothing to tolerate.

**The mock's own catalogue**

- Every profile in `docs/08-mock-bureau.md` §4 is re-scored from
  `policies/2026.09.1.json` and compared with the documented total. The
  documentation table cannot drift from the catalogue, and the two worked
  examples in `docs/03` and `docs/05` cannot drift from either.
- An unlisted identifier yields the same report twice, and the same report in a
  different process.
- Three spellings of one identifier canonicalise to one subject key.

**Determinism**

- The same inputs evaluated twice are deeply equal, including code order.
- Inputs are frozen before the call; the engine does not mutate them.

**Property test** (fast-check, if time allows): over generated valid inputs, the
verdict is always one of three values, `reasonCodes.length ≤ 4`, and
`verdict === 'APPROVED'` implies `dti ≤ maxDti`. That last implication is the
invariant worth having — it is the one a future refactor is most likely to break
quietly.

---

## 4. What the integration tests prove

### Idempotency

| Test | Proves |
|---|---|
| Same key, same body, twice | One application row; the second response is byte-identical and carries `Idempotency-Replayed` |
| Same key, different body | `422`, and the first application is untouched |
| Key still in flight | `409` with `Retry-After` |
| **Two clients, same key string** | **Two applications; neither client can see the other's stored body.** The test that would have failed against a two-part key |
| **Lease expired, `application_id` set** | **The original application is resumed. Exactly one application row exists for that key** |
| Lease expired, no `application_id` | Taken over cleanly, one application created |
| Key past retention | Treated as fresh |
| **N concurrent requests, same key** | **Exactly one application row** |

### Bureau deduplication

The requirement the brief singled out, so it gets the most tests. Assertions are
made against the fake bureau's call counter — the thing that costs money and
marks a person's file.

| Test | Expected calls |
|---|---|
| Two sequential applications, same person, inside the TTL | **1** |
| Two applications, same person, after the TTL expires | 2 |
| Two applications, two different people | 2 |
| Same person, first lookup was `NO_HIT`, second inside the TTL | **1** — a non-answer is an answer, and re-asking is a second enquiry |
| **N concurrent applications, same person** | **1** |
| Application screened out at S1 | **0** |
| Winner's pull fails, next request arrives | 2, and the second one succeeds — a failed claim must not block the subject |
| Claim holder dies, lease expires, new request arrives | 2 — the lease is what stops a crash from blocking a person forever |
| Loser's wait expires, winner commits immediately after | **1**, and the loser uses the late report rather than referring with `BUREAU_UNAVAILABLE` |

Plus the client's own behaviour: retries on timeout and `5xx`, **zero** retries
on `4xx`, and the same request identifier across every attempt of one logical
pull.

### Audit, review and atomicity

| Test | Proves |
|---|---|
| Every pre-decision has a chain, and the chain verifies | The trail exists and is consistent |
| `UPDATE` or `DELETE` on `audit_events` as the application role | Raises. Append-only is enforced by the database, not by discipline |
| An event payload altered directly in the database, **with the trigger disabled for the duration** | Chain verification reports broken, at the right index |
| Events truncated from the tail, trigger disabled | Chain verification reports `chainIntact: true`. **The test asserts the gap**, so the honest limit in `docs/04-audit.md` §3 cannot quietly become false |
| Failure injected between the pre-decision insert and the audit insert | **Neither row exists, and the idempotency key is not marked complete** |
| Replay after a newer policy version is added | Recomputed equals recorded — the old version was used, not today's |
| **Replay with the clock advanced past an age boundary** | **`match: true`.** Replay uses `submitted_at`, not `now()`. Without this, an applicant who was 74 at maturity replays as a knockout and the endpoint reports tampering that did not happen |
| Replay of an S1 decline (no bureau call) and of a `BUREAU_UNAVAILABLE` referral | Both defined and both `match: true`. Neither has a stored report, and neither may throw |
| **Replay of a referred application closed by a reviewer** | **`match: true`.** Replay compares the engine's verdict; a human override is not tampering. The previous design reported `match: false` here |
| Closing a review twice, concurrently | One write, one `409`. The conditional update is the guarantee |
| A closed review with no `reviewer_id` inserted directly | Raises. The `CHECK` constraint, not the handler, is what makes a human verdict attributable |
| `preDecision` after a review closes | Unchanged, byte for byte |
| Orphan swept after `ORPHAN_SWEEP_AFTER_MINUTES` | Status `ABANDONED`, key retired in the same transaction, `BUREAU_PULL_REQUESTED` still present, counter incremented |
| Retry with the original key after the sweep | A **new** application. Not a resume into a terminal state, and no second bureau pull |
| Two sweepers running concurrently | One winner, one no-op. No duplicate append at the same `chain_index` |

The two tamper tests would be mutually exclusive if written naively: the trigger
that makes the first pass prevents the second from performing its `UPDATE`. So
the tamper tests run `ALTER TABLE audit_events DISABLE TRIGGER` for their own
duration and re-enable it in a fixture teardown. Saying that out loud costs a
little of the "not left to discipline" framing and buys a test suite whose two
halves can both actually run — and it is what a reviewer would discover in the
first five minutes of reading the code.

The atomicity test covers the **closing** transaction. The chain as a whole spans
three (`docs/04-audit.md` §3), so there is a second test: kill the process
between `BUREAU_PULL_REQUESTED` and the closing commit, and assert the pull event
**survives**. That is the property that keeps a crash from erasing the record
that someone's credit file was marked, and it is the one an "everything is one
transaction" design would have failed.

### The honest note about concurrency tests

`Promise.all` in one Node process does not create true parallelism in JavaScript,
but the database work genuinely overlaps: each request holds its own pooled
connection and Postgres interleaves them. So the race is real — and
**non-deterministic**. A run that happens not to interleave badly still passes.

That is why each concurrency property gets **two** tests:

1. A probabilistic one at N = 10 asserting the invariant end to end.
2. A deterministic one at the schema level: insert the duplicate row directly and
   assert a unique-violation error code.

The second proves the constraint exists; the first proves the code path relies
on it. Claiming the first alone proves correctness would be overselling, and
saying so out loud is worth more than a green tick.

---

## 5. What the API tests prove

- No token → `401`. A submission token on `/v1/audit/*` → `403`. A submission
  token on `/v1/reviews/*/close` → `403`.
- Validation failure → `422` with field paths, **and no application row
  created**. The second half is the part worth asserting.
- Missing or false consent → `422 CONSENT_REQUIRED`; a future or stale
  `acceptedAt` → `422 CONSENT_STALE`. Both before any row or bureau call.
- Unknown product code → `422 UNKNOWN_PRODUCT`, not `500`.
- `GET` on an unknown id and `GET` on another client's id both → `404`, with
  identical bodies. Asserted together, because the point is that they are
  indistinguishable.
- `/health/live` stays `200` with the database pool stopped; `/health/ready`
  returns `503`. Confusing the two means a load balancer either kills a healthy
  container or keeps routing to a broken one.
- `/metrics` without an auditor token → `401`.
- `/metrics` exposes the named counters, and `bureau_reuse_ratio` actually moves
  after a reused pull.
- Every response carries `X-Correlation-Id`, and it appears in the error body.
- `outcome.source` flips from `ENGINE` to `REVIEWER` after a close, while
  `preDecision` is unchanged.

---

## 6. What is not tested, and why

Named rather than quietly skipped:

- **Load and latency.** No performance test. The p95 budget in
  `docs/00-scope.md` A2 is a design constraint that the timeout and retry numbers
  were chosen to fit, not a measured figure.
- **The real bureau.** There is none. `docs/08-mock-bureau.md` is the
  specification, and the mock implements it.
- **Migration rollback.** Forward migrations run in CI; down-migrations are not
  exercised.
- **Rate limiting.** Not implemented, so not tested.
- **External tamper resistance.** The hash chain is tested against row-level
  edits, not against an actor who rewrites the whole chain. Defeating that needs
  an external anchor, which is a roadmap item.
- **That consent was actually obtained.** Untestable here by construction: we
  test that an attestation is required, fresh and recorded, which is all the
  service knows.
- **The unfenced claim window.** A holder that is alive but stalled past its
  lease produces a second pull, and no test provokes it — doing so means pausing
  a process mid-transaction on a schedule, which is a test that fails
  intermittently for reasons unrelated to the property. `docs/01-architecture.md`
  §3 names it as a debt with a trigger instead.
- **Alerting.** Counters are asserted to exist and to move; nothing scrapes them
  in v1, so no alert is exercised.

---

## 7. The completeness criterion

Not a coverage percentage. Three checks instead, all mechanical:

1. **Every code in `policies/<version>.json` → `reasonCodes.registry` is produced
   by at least one test.** A code that no test can trigger is either dead or
   unreachable through a bug, and both are worth knowing. This check is the
   reason the registry exists as a list in the policy file: while the codes lived
   only in prose across `docs/03`, the criterion was unimplementable and the
   claim to have it was empty.
2. **Every row in `docs/06-failure-modes.md` appears in that document's coverage
   table**, against a test name or the literal `named`. This is a grep, not a
   judgement, which is the point: the previous version asked a reader to compare
   two documents with no shared identifier, and it had already drifted — ten rows
   claimed a correspondence that did not exist.
3. **Every input the engine reads is stored somewhere replay can reach.** The
   check enumerates the arguments of `screen` and `decide`, walks to the column
   or JSON path that holds each, and fails on anything unreachable. Stated this
   way rather than as "a column on `pre_decisions`", which was the previous
   wording: two of the four required pieces live on `applications` and
   `bureau_reports` by design, so the strict version was false — and, being
   false, it passed while the schema had no home for declared income at all and
   replay was impossible for every affordability outcome.

---

## 8. Running them

```bash
docker compose up -d db          # Postgres 16
cp .env.example .env
npm ci
npm run migrate
npm test                         # unit + integration + api
npm run test:unit                # pure, no database needed
```

CI runs the same three commands against a Postgres service container, plus
`npm run typecheck`. A red typecheck fails the build; there is no separate lint
step in v1.
