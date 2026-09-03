# How to test this service

Written for whoever is reviewing this submission. Nothing here needs to be
invented: every command is copy-paste, and every one says what a correct answer
looks like and why it is the interesting one.

**Live:** <https://loan-predecision.onrender.com> · **Reference:** [`/docs`](https://loan-predecision.onrender.com/docs)

The three bearer tokens are in the submission email. Paste them once:

```bash
export BASE_URL=https://loan-predecision.onrender.com
export SUBMISSION_TOKEN=...      # creates applications, reads its own
export REVIEWER_TOKEN=...        # records a human outcome
export AUDITOR_TOKEN=...         # reads everything, writes nothing
```

---

## The thirty-second version

```bash
git clone <repo> && cd loan-predecision
BASE_URL=$BASE_URL SUBMISSION_TOKEN=$SUBMISSION_TOKEN \
REVIEWER_TOKEN=$REVIEWER_TOKEN AUDITOR_TOKEN=$AUDITOR_TOKEN ./demo.sh
```

Forty assertions across every path below, including the ugly ones. Expect
`40 passed, 0 failed`. If you would rather see it by hand, the rest of this file
is the same walk, one case at a time.

**First request is slow, twice.** This runs on free tiers: Render suspends the
instance after 15 minutes and takes ~1 minute to wake, and Neon suspends its
compute after 5. Warm both before timing anything:

```bash
curl -sS "$BASE_URL/health/ready"          # {"status":"ready"}
```

---

## What drives the outcomes

The bureau is a mock, and it is **deterministic**: the applicant's national
identifier selects the credit file. Same identifier, same report, every time,
on any deployment. That is what makes every case below reproducible rather than
illustrative.

| `nationalId` | What you get |
|---|---|
| `900-55-0601` | Clean file, score 100 → **approved in full** |
| `900-55-0142` | Score 75, DTI over the limit → **counter-offer** |
| `900-55-0221` | Score 22 → **declined** |
| `900-55-0701` | Score 59 → referred, inside the score band |
| `900-55-0301` | Score 73 but one account → referred, thin file |
| `900-55-0402` | Score 94, name disagrees → referred, identity |
| `900-55-0501` | Bankruptcy 8 months ago → **declined** before scoring |
| `900-55-0300` | No credit file → referred (**not** an outage) |
| `900-55-9001` | Bureau returns errors → referred, unavailable |
| `900-55-9002` | Bureau hangs past the timeout → referred, unavailable |
| anything else | Derived from the identifier, deterministic, unremarkable |

Full table with the attribute values: [`docs/08-mock-bureau.md`](docs/08-mock-bureau.md) §4.

A helper, so the cases below stay short:

```bash
submit() {   # submit <nationalId> <amountMinor> <termMonths> <incomeMinor> <obligationsMinor> <dob> <idempotency-key>
  curl -sS -X POST "$BASE_URL/v1/applications" \
    -H "Authorization: Bearer $SUBMISSION_TOKEN" \
    -H "Idempotency-Key: $7" -H 'Content-Type: application/json' \
    -d "{\"productCode\":\"PERSONAL_UNSECURED_V1\",\"requestedAmountMinor\":$2,\"currency\":\"USD\",
         \"termMonths\":$3,\"purpose\":\"DEBT_CONSOLIDATION\",
         \"consent\":{\"attestedByCaller\":true,\"acceptedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"},
         \"applicant\":{\"firstName\":\"Ada\",\"lastName\":\"Lovelace\",\"dateOfBirth\":\"$6\",
                        \"nationalId\":\"$1\",\"email\":\"ada@example.com\",\"residenceCountry\":\"US\"},
         \"finances\":{\"monthlyIncomeMinor\":$4,\"employmentStatus\":\"EMPLOYED\",
                       \"declaredMonthlyObligationsMinor\":$5}}"
}
```

Pipe anything through `| jq` if you have it. Every response is JSON either way.

---

## 1 · An approval — and it carries **no** reason codes

```bash
submit 900-55-0601 1800000 36 620000 90000 1988-02-19 "r-$RANDOM"
```

Look for:

```json
"verdict": "APPROVED",
"reasonCodes": [],
"offer": { "approvedAmountMinor": 1800000, "monthlyPaymentMinor": 60562, ... },
"assessment": { "score": 100, "maxScore": 100, "band": "AUTO_APPROVE", "dti": 0.2428 }
```

**`reasonCodes: []` is the correct answer, not a missing one.** An approval on
the terms applied for is not adverse action, so no reason is owed — inventing a
code to fill the field would put an unfalsifiable statement into a record built
to be replayed. It is the only case where the list is empty, and the database
refuses an empty list for every other verdict.
See [ADR-0010](docs/adr/0010-an-approval-on-the-requested-terms-carries-no-reason-codes.md).

---

## 2 · A counter-offer — "yes, but less"

```bash
submit 900-55-0142 3200000 48 540000 160000 1991-04-12 "r-$RANDOM"
```

```json
"verdict": "APPROVED",
"reasonCodes": ["AMOUNT_REDUCED_TO_FIT_DTI", "CREDIT_UTILIZATION_TOO_HIGH", "LIMITED_CREDIT_MIX"],
"offer": { "approvedAmountMinor": 2690000, "monthlyPaymentMinor": 72033 },
"assessment": { "score": 75, "dti": 0.4297 }
```

$32,000 was asked for; $26,900 is offered, because the full amount put debt-to-income
at 45.5% against a 43% limit. The reverse solve rounds **down** to the nearest
$100 — rounding up by a dollar would put the offer back over the limit that
produced it.

**Reasons appear here and not in case 1 on purpose.** Under Regulation B, credit
offered on terms other than those applied for is a counteroffer, and it becomes
adverse action the moment the applicant declines it — so the reasons have to be
available up front. The arithmetic is worked through in
[`docs/03-decision-policy.md`](docs/03-decision-policy.md) §5.

---

## 3 · A decline, with the factors that moved it

```bash
submit 900-55-0221 1800000 36 620000 90000 1988-02-19 "r-$RANDOM"
```

```json
"verdict": "DECLINED",
"reasonCodes": ["PAYMENT_HISTORY_ADVERSE", "CREDIT_UTILIZATION_TOO_HIGH",
                "TOO_MANY_RECENT_INQUIRIES", "INSUFFICIENT_CREDIT_HISTORY_LENGTH"],
"assessment": { "score": 22 }
```

**There is no "your score was too low" code, deliberately.** The score is not a
reason — it is the *sum* of the reasons, and Regulation B asks for the factors.
The codes are derived by points lost against each factor's maximum, ordered by
loss, capped at four.

---

## 4 · No credit file is **not** an outage

```bash
submit 900-55-0300 1800000 36 620000 90000 1988-02-19 "r-$RANDOM"
```

```json
"verdict": "MANUAL_REVIEW",
"reasonCodes": ["NO_CREDIT_FILE"],
"bureauReportId": "…",           ← the no-hit IS stored
```

Both this and case 5 arrive as "no report", and collapsing them is the tempting
simplification. It would tell a genuine first-time borrower that our vendor was
down. Different fact, different code, different follow-up — and a first-time
borrower is a population a lender wants, not one it rejects by accident.

---

## 5 · A bureau outage, forced by identifier alone

```bash
submit 900-55-9001 1800000 36 620000 90000 1988-02-19 "r-$RANDOM"
```

```json
"verdict": "MANUAL_REVIEW",
"reasonCodes": ["BUREAU_UNAVAILABLE"],
"bureauReportId": null,          ← nothing stored, because nothing was learned
"lookupFailureCause": "RETRIES_EXHAUSTED"
```

No configuration, no restart, no feature flag — the failure path is reachable on
the live instance with one request. **Keep this application id**, case 10 uses it.

Note the application still exists (`GET` it in case 9). A submission is a
business event: if the bureau then fails, the record remains. And the verdict is
a referral rather than a decline, because a rejection caused by our own
infrastructure is one we could not justify to the applicant.

`900-55-9002` does the same via a hang past the timeout rather than an error.

---

## 6 · The headline requirement: a duplicate causes **no second enquiry**

This is what the assignment singled out. Use an identifier nobody else is using:

```bash
ID="900-77-$RANDOM"
submit "$ID" 1800000 36 620000 90000 1988-02-19 "d1-$RANDOM"   # first
submit "$ID" 1500000 36 620000 90000 1988-02-19 "d2-$RANDOM"   # second, different amount
```

Compare the two responses:

| | first | second |
|---|---|---|
| `applicationId` | `A` | `B` — **two applications** |
| `bureauReportReused` | `false` | **`true`** |
| `bureauReportId` | `R` | **`R`** — the same report |

Two separate applications, two separate decisions, **one mark on the credit
file**. A hard enquiry costs money *and* is recorded on the applicant's file
where it can lower their score, which is why this is a product requirement
rather than a caching optimisation — and why it holds even though these are
genuinely different applications with no idempotency key in common.

Three spellings are one subject, too. `900-77-1234`, `900 77 1234` and
`900771234` all reuse the same report: without canonicalising, the whole
guarantee is defeated by a hyphen.

Mechanism: [`docs/02-idempotency.md`](docs/02-idempotency.md) §4.

> **Expect reuse on a repeat run.** Reports are reusable for 15 minutes, so
> re-running cases 1–5 inside that window shows `bureauReportReused: true` on the
> later ones. That is the feature working, not an inconsistency.

---

## 7 · The same idempotency key returns the stored response

```bash
K="k-$RANDOM"
submit 900-55-0601 1800000 36 620000 90000 1988-02-19 "$K"
submit 900-55-0601 1800000 36 620000 90000 1988-02-19 "$K"    # again
```

The two bodies are identical — same `applicationId`, same `decidedAt`, same
`correlationId`. The second is the **stored** response replayed byte for byte;
regenerating it would let the replay differ from the original.

Add `-D -` to the curl to see `Idempotency-Replayed: true` on the second.

Now change the body under the same key:

```bash
submit 900-55-0601 2000000 36 620000 90000 1988-02-19 "$K"
```

```json
"status": 422, "code": "IDEMPOTENCY_KEY_REUSED"
```

Answering with the first request's verdict would hide the caller's bug and hand
them a decision about a different application.

---

## 8 · Three scopes, and a token valid for one is refused on another

```bash
curl -sS -o /dev/null -w '%{http_code}\n' "$BASE_URL/metrics"                                        # 401
curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $SUBMISSION_TOKEN" "$BASE_URL/metrics"  # 403
curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $AUDITOR_TOKEN"    "$BASE_URL/metrics"  # 200
```

`401` is "I do not know who you are"; `403` is "I know, and this is not yours".
Separating submission from review is the one that matters: without it, the party
that submits an application can also approve it.

---

## 9 · Reads are owner-scoped, and an unknown id is indistinguishable

```bash
APP=<applicationId from any case above>

curl -sS -H "Authorization: Bearer $SUBMISSION_TOKEN" "$BASE_URL/v1/applications/$APP"
curl -sS -H "Authorization: Bearer $SUBMISSION_TOKEN" \
     "$BASE_URL/v1/applications/00000000-0000-4000-8000-000000000000"
```

The second is `404 APPLICATION_NOT_FOUND`. So is an application belonging to
another client — **byte-identical**, apart from the correlation id. Returning
`403` for someone else's would confirm the id exists and turn the endpoint into
an oracle for which application ids are real.

The `GET` also carries `outcome`, which the submission response does not. That
is the reason a synchronous API still needs a status call: `MANUAL_REVIEW` is not
terminal.

---

## 10 · A human closes a referral — without touching the engine's verdict

Use the application from case 5.

```bash
REFERRED=<applicationId from case 5>

curl -sS -X POST "$BASE_URL/v1/reviews/$REFERRED/close" \
  -H "Authorization: Bearer $REVIEWER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"outcome":"APPROVED","approvedAmountMinor":900000,
       "rationale":"Bureau outage; file pulled manually and assessed."}'
```

```json
"preDecision": { "verdict": "MANUAL_REVIEW", ... }   ← unchanged, forever
"review":      { "state": "CLOSED", "outcome": "APPROVED", "reviewerId": "underwriting" }
"outcome":     { "verdict": "APPROVED", "source": "REVIEWER" }
```

The engine's verdict is **never edited**. A human disagreeing with it does not
make it untrue, and a design where the reviewer edits the pre-decision makes
override and tampering the same database operation. `reviewerId` comes from the
bearer token and never from the body.

Close it again:

```json
"status": 409, "code": "REVIEW_ALREADY_CLOSED"
```

Two reviewers cannot silently overwrite each other.

---

## 11 · The audit trail

```bash
curl -sS -H "Authorization: Bearer $AUDITOR_TOKEN" "$BASE_URL/v1/audit/applications/$APP/events"
```

An append-only chain. For an application that actually placed an enquiry:

```json
["APPLICATION_RECEIVED", "BUREAU_PULL_REQUESTED", "BUREAU_REPORT_ATTACHED", "PRE_DECISION_MADE"]
```

**And for one that reused an existing report, three:**

```json
["APPLICATION_RECEIVED", "BUREAU_REPORT_ATTACHED", "PRE_DECISION_MADE"]
```

That missing event is worth a second look, because it is the guarantee from
case 6 visible from the other side. `BUREAU_PULL_REQUESTED` is appended
*immediately before the network call*, by the request that actually places one —
so its absence is the audit trail stating that this application marked nobody's
credit file. Count the `BUREAU_PULL_REQUESTED` events across a subject and you
have counted the hard enquiries.

It is appended before the call rather than after it for a reason: a process
dying mid-pull must still leave a record that the file *was* marked, or the one
harm this service exists to prevent gets erased by the crash that caused it.

`ATTACHED` rather than `STORED` is deliberate for the same reason: on the reuse
path nothing is written, and a trail that records a write which did not happen is
one nobody can rely on.

```bash
curl -sS -H "Authorization: Bearer $AUDITOR_TOKEN" "$BASE_URL/v1/audit/applications/$APP/chain"
```

```json
{ "chainIntact": true, "events": 3, "brokenAtIndex": null }
```

**The honest limit, stated before you ask:** the chain detects an edit. It does
**not** detect truncation — delete the last *k* events and what remains verifies
perfectly — and it does not stop a consistent rewrite by someone with full
database access. `events` is returned so an external anchor could compare
against it. That anchor is not built. All three limits are in
[`docs/04-audit.md`](docs/04-audit.md) §3, and
`tests/integration/review-findings.test.ts` asserts that truncation is *not*
detected, because an undemonstrated limitation is only a claim.

---

## 12 · Replay — the part that makes it auditable rather than merely logged

```bash
curl -sS -X POST -H "Authorization: Bearer $AUDITOR_TOKEN" \
  "$BASE_URL/v1/audit/pre-decisions/$APP/replay"
```

```json
{ "match": true, "differences": [],
  "recorded":   { "verdict": "APPROVED", "monthlyPaymentMinor": 72033, ... },
  "recomputed": { "verdict": "APPROVED", "monthlyPaymentMinor": 72033, ... } }
```

Re-runs the engine against the **stored** application, the **stored** bureau
report, the **policy version recorded on the pre-decision**, and `submittedAt`
as the clock. Never today's policy, never a fresh bureau call, never today's
wall clock — each substitution produces a false accusation of tampering, and the
third one would also place a new hard enquiry on the applicant while trying to
protect them.

**Run it on the application you closed in case 10.** It still reports
`match: true`. Replay compares the *engine's* verdict, not the composed outcome,
so a legitimate human override cannot look like fraud.

---

## 13 · Requests that should be rejected

Each returns RFC 7807 `problem+json` with a `code` you can look up in
[`docs/05-api.md`](docs/05-api.md) §7.

```bash
# consent not attested → 422 CONSENT_REQUIRED
curl -sS -X POST "$BASE_URL/v1/applications" -H "Authorization: Bearer $SUBMISSION_TOKEN" \
  -H 'Content-Type: application/json' -d '{"productCode":"PERSONAL_UNSECURED_V1",
  "requestedAmountMinor":1800000,"currency":"USD","termMonths":36,"purpose":"MEDICAL",
  "consent":{"attestedByCaller":false,"acceptedAt":"2026-09-03T09:00:00Z"},
  "applicant":{"firstName":"A","lastName":"B","dateOfBirth":"1988-02-19","nationalId":"900-55-0601",
  "email":"a@example.com","residenceCountry":"US"},
  "finances":{"monthlyIncomeMinor":620000,"employmentStatus":"EMPLOYED"}}'

# an unknown product → 422 UNKNOWN_PRODUCT
# a consent timestamp older than 24h → 422 CONSENT_STALE
# a malformed body → 422 VALIDATION_FAILED, with a per-field list
# an unknown route → 404 NOT_FOUND, in the same problem+json shape
curl -sS "$BASE_URL/nope"
```

**A policy rejection is not a validation error.** Ask for more than the product
allows and you get `DECLINED` with `AMOUNT_OUTSIDE_PRODUCT_LIMITS` — an
application, a stored decision and an audit trail — not a `422`:

```bash
submit 900-55-0601 90000000 36 620000 90000 1988-02-19 "r-$RANDOM"
```

Collapsing the two is a common and expensive mistake: a policy rejection
returned as a validation error never reaches the funnel, the audit trail, or the
applicant's right to a reason.

---

## Running it locally instead

```bash
cp .env.example .env       # SUBJECT_KEY_PEPPER has no default; set anything 32+ chars
docker compose up -d db
npm ci && npm run migrate && npm run dev
./demo.sh                  # defaults to http://localhost:3000 and the .env.example tokens
```

The test suite is the other half of the evidence:

```bash
npm test           # 267 tests. Integration needs Postgres and skips without it
npm run test:unit  # pure functions, no database
```

CI sets `REQUIRE_DATABASE=1`, which turns that skip into a hard error — a green
run cannot mean the integration tests quietly did not run.

---

## If something looks wrong

- **A slow or failed first request** — free-tier cold start. `GET /health/ready`
  and retry.
- **`bureauReportReused: true` when you expected `false`** — a report for that
  identifier is inside its 15-minute TTL. Use a fresh `900-77-xxxx`.
- **`503` from `/health/ready`** — the database is unreachable. Liveness will
  still answer `200`: a readiness failure means "stop sending traffic", a
  liveness failure means "restart me", and a database outage must never produce
  the second.
- **Anything else** — every response carries `X-Correlation-Id`, and every error
  body repeats it.

## Where to read next

| | |
|---|---|
| [`README.md`](README.md) | What this is and how it is built |
| [`docs/09-engine.md`](docs/09-engine.md) | **The rules, and why each sits where it does.** Start here for the decision logic |
| [`docs/02-idempotency.md`](docs/02-idempotency.md) | The central problem: four kinds of duplicate |
| [`docs/00-scope.md`](docs/00-scope.md) | What was deliberately not built, and why |
