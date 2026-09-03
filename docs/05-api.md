# 05 — API reference

Everything a caller needs: the contract, every field, worked request/response
pairs for each outcome, the error catalogue, and the endpoints an auditor uses
to verify a pre-decision rather than take our word for it.

All examples use synthetic data. Identifiers in the examples come from the
`900-xx-xxxx` range, which is not issued as a US Social Security number. It is
well-formed as an ITIN, so these are synthetic **by convention**, not by proof —
the guarantee is that no real bureau is contacted, not that the string could
never belong to anyone.

---

## 1. Conventions

| | |
|---|---|
| Base URL | `https://<host>/v1` |
| Content type | `application/json`; errors use `application/problem+json` |
| Money | Stored and transmitted as integer **minor units**. `2690000` is $26,900.00 |
| Rounding | The annuity needs `(1+i)⁻ⁿ`, which is irrational, so it is evaluated in decimal at 28 significant digits and the result **rounded half-up to whole minor units**. The counter-offer principal is rounded **down** to `counterOfferRoundingMinor`, never up. `dti` is truncated to 4 decimal places for display and compared at full precision |
| Currency | ISO 4217, uppercase |
| Time | RFC 3339, always UTC, always with milliseconds |
| Identifiers | UUID v4, opaque to the caller |
| Correlation | Every response carries `X-Correlation-Id`; errors repeat it in the body. Quote it to support and the request can be found in the logs |

The rounding row is not pedantry. `monthlyPaymentMinor: 72033` in §3.1 is
reachable only by half-up — floor and truncation both give `72032` — and replay
compares that field. Two implementations of this specification that pick
different conventions disagree on every counter-offer, and the endpoint that
exists to detect tampering reports `match: false` on all of them. "No floats
anywhere near money" was the previous wording and it was not achievable: what is
true, and what is now written, is that money is *stored and transmitted* as
integers and the arithmetic in between happens at a stated precision with a
stated rounding step.

### Vocabulary

This service returns a **pre-decision**: an automated assessment of declared data
plus a bureau report. It is not the final credit decision. When an application is
referred, a person at the lender decides using criteria this service does not
model, and that outcome is a separate record with its own actor. The response
carries both, plus a single composed `outcome` — see §3.

### Authentication

Three bearer scopes, because three different jobs are being done:

| Scope | Token list | Grants |
|---|---|---|
| Submission | `API_TOKENS` | `POST /v1/applications`, `GET /v1/applications/{id}` |
| Review | `REVIEWER_TOKENS` | `POST /v1/reviews/{applicationId}/close` |
| Audit | `AUDITOR_TOKENS` | everything under `/v1/audit/*`, and `GET /metrics` |

A submitting client can create applications but cannot enumerate the decision
history or close a review; a reviewer can record an outcome but cannot submit;
an auditor can read everything and write nothing. Separating them costs three
lines of configuration and removes the case where a leaked front-end token
exposes the whole book — or lets the party that submitted an application also
approve it.

```
Authorization: Bearer <token>
```

The client identity is derived from the token, never from the request body. It
is written to `applications.client_id`, and it is part of the idempotency key —
see §1 idempotency below.

The public endpoint accepts a national identifier and, on a new subject, causes
a bureau pull. Left unauthenticated, it would let anyone submit other people's
identifiers and mark their credit files. That is the reason auth exists here, not
general good practice.

### Idempotency

`POST /v1/applications` accepts an `Idempotency-Key` header — any client-chosen
string up to 200 characters, unique per logical submission. Keys are retained for
`IDEMPOTENCY_RETENTION_HOURS` (default 24).

**Keys are scoped per client, not globally.** The stored row is keyed
`(client_id, scope, key)`. Two integrators both sending `Idempotency-Key: 1` —
which is what a developer testing by hand sends — do not collide, and neither
can receive the other's stored response body. On a two-part key they would.

| Key state | Response |
|---|---|
| Unseen | Processed normally |
| Seen, identical body, finished | The **stored** response, byte for byte, plus `Idempotency-Replayed: true` |
| Seen, identical body, still running | `409` with `Retry-After: 3` |
| Seen, identical body, holder died | The original application is **resumed**, not duplicated |
| Seen, different body | `422 IDEMPOTENCY_KEY_REUSED` |

The body comparison is a hash of the canonical JSON, so key ordering and
whitespace do not matter.

Sending no key is allowed. It is not encouraged: without one, a retry after a
network timeout creates a second application. It will not create a second bureau
pull — that is prevented separately — but it will create a second record.

---

## 2. Endpoints

| Method | Path | Scope |
|---|---|---|
| `POST` | `/v1/applications` | submission |
| `GET` | `/v1/applications/{id}` | submission |
| `POST` | `/v1/reviews/{applicationId}/close` | review |
| `GET` | `/v1/audit/applications/{id}/events` | audit |
| `GET` | `/v1/audit/applications/{id}/chain` | audit |
| `GET` | `/v1/audit/pre-decisions` | audit |
| `POST` | `/v1/audit/pre-decisions/{applicationId}/replay` | audit |
| `GET` | `/health/live` | none |
| `GET` | `/health/ready` | none |
| `GET` | `/metrics` | audit |

`/metrics` is behind the auditor token rather than open. It was previously
marked "none — bind internally in production", which was a note about a
deployment shape this service does not have: one instance, one public URL, no
second bind. Left open, outcome mixes and pull volumes would be world-readable.

---

## 3. Submit an application

```
POST /v1/applications
Authorization: Bearer <submission token>
Idempotency-Key: 4b1f0c8e-9f2a-4b1d-8c31-2f0a7d5e9c14
Content-Type: application/json
```

### Request fields

| Field | Type | Req. | Rules |
|---|---|---|---|
| `productCode` | string | ✔ | Must exist in the active policy |
| `requestedAmountMinor` | integer | ✔ | > 0. Compared against product limits at S1 |
| `currency` | string(3) | ✔ | Must equal the product's currency |
| `termMonths` | integer | ✔ | 1–600. Product limits applied at S1 |
| `purpose` | enum | ✔ | `DEBT_CONSOLIDATION`, `HOME_IMPROVEMENT`, `MEDICAL`, `MAJOR_PURCHASE`, `VEHICLE`, `EDUCATION`, `OTHER` |
| `consent.attestedByCaller` | boolean | ✔ | Must be `true`. See below |
| `consent.acceptedAt` | timestamp | ✔ | In the past, within `consent.maxAgeHours` of now |
| `applicant.firstName` | string | ✔ | 1–100 chars |
| `applicant.lastName` | string | ✔ | 1–100 chars |
| `applicant.dateOfBirth` | date | ✔ | `YYYY-MM-DD`, in the past |
| `applicant.nationalId` | string | ✔ | Canonicalised to alphanumerics, then passed to the bureau and hashed. Never persisted, never logged |
| `applicant.email` | string | ✔ | Valid address |
| `applicant.phone` | string | — | E.164 |
| `applicant.residenceCountry` | string(2) | ✔ | ISO 3166-1 alpha-2 |
| `finances.monthlyIncomeMinor` | integer | ✔ | ≥ 0. Declared, not verified at this stage |
| `finances.employmentStatus` | enum | ✔ | `EMPLOYED`, `SELF_EMPLOYED`, `RETIRED`, `STUDENT`, `UNEMPLOYED`, `OTHER` |
| `finances.employmentMonths` | integer | — | ≥ 0 |
| `finances.declaredMonthlyObligationsMinor` | integer | — | Fallback when the bureau reports no obligations |
| `customerId` | string | — | The caller's own identifier for this person, if they already have an account. Correlation only — see below |
| `channel` | enum | — | `WEB`, `MOBILE`, `PARTNER`, `BRANCH`. Default `WEB` |

### On `nationalId` and where it goes

The identifier is **not** discarded the instant the subject key is derived,
because the bureau needs it: no provider can search a credit file by our HMAC.
It exists in process memory for the duration of the lookup, is passed to the
provider, and is never written to the database or the logs. JavaScript offers no
way to scrub a string from memory on demand, so "discarded" would be a claim we
cannot keep — the guarantee is about persistence and logging, and it is stated
that way deliberately.

### On `consent`

The caller asserts that it captured the applicant's authorisation for a credit
enquiry, and says when. We record **who asserted it and when** — the client
identity comes from the bearer token, not from the body.

What this does not do is prove the applicant consented. Under FCRA the
permissible purpose belongs to the party performing the pull; it can be pushed to
an integrator by contract, but not delegated away by API design. `acceptedAt`
must be in the past and no older than `consent.maxAgeHours`, otherwise the
attestation records nothing useful — a caller could otherwise send a timestamp
from 2019 and satisfy the field. ADR-0007 covers why this is an attestation
rather than a modelled consent service.

### Three identities, and why they must not be confused

| Identity | What it identifies | Where it comes from | Used for |
|---|---|---|---|
| `subjectKey` | The **person** | Derived by us: keyed hash of the canonicalised national identifier | Bureau report reuse, decision history for a person |
| `customerId` | The caller's **account** for that person | The caller's identity system. Often absent | Correlation, analytics, linking back to a CRM |
| `Idempotency-Key` | **This submission attempt**, for one client | The caller | Replay of one request |

`customerId` is optional and never drives a decision or a deduplication. Three
reasons, in increasing order of severity:

1. **Most applicants do not have one.** An instant pre-decision sits at the top
   of the funnel, before onboarding. Keying anything on an account identifier
   would leave the largest population — prospects — with no deduplication at all.
2. **One person can hold two accounts.** A new email, a re-registration, a
   partner channel that mints its own ids: two `customerId`s, one human, two
   bureau pulls, two marks on their file.
3. **One account can be used by two people.** A shared household login, a broker
   submitting for clients. Reusing a bureau report across a `customerId` would
   mean **deciding one person's application on another person's credit file.**
   That is not a bug you recover from.

### Response shape

Two blocks on submission, three on read:

| Block | What it is | Present |
|---|---|---|
| `preDecision` | What **the engine** concluded, from data this service holds. Written once, never updated | Always, once decided |
| `review` | What **a person** concluded, using criteria this service does not model | Only when referred |
| `outcome` | The single composed answer: the review outcome when closed, otherwise the pre-decision verdict | **`GET` only** — see below |

`outcome` exists so that no caller has to compose it. That composition — "the
human's answer wins if there is one" — is written in exactly one function on the
server. Written three times, in a client, a dashboard query and a metrics
exporter, it drifts, and the three disagree about what the lender decided.

**`POST` does not return it, and that is what keeps it honest.** The submission
response is stored verbatim and replayed byte for byte for
`IDEMPOTENCY_RETENTION_HOURS` — far longer than a manual review takes to close.
A composed field inside that stored body would go stale the moment a reviewer
acted: a client polling by retrying the `POST` would be told `MANUAL_REVIEW`
while the case was approved hours earlier. There is nothing to compose at
submission anyway — no review can exist yet, so `outcome` would always have
equalled `preDecision.verdict`. Making it a read-only field removes the
contradiction instead of documenting it: the stored body stays exactly what was
sent, and the only field that claims to be current is only served by an endpoint
that computes it fresh.

| Field | Notes |
|---|---|
| `applicationId` | Use it for status, audit and replay |
| `status` | `PRE_DECIDED`, `IN_REVIEW`, `REVIEW_CLOSED` or `ABANDONED` |
| `preDecision.verdict` | `APPROVED`, `DECLINED`, `MANUAL_REVIEW` |
| `preDecision.reasonCodes` | Ordered: decisive and referral codes first in registry order, then scorecard factors by points lost. At most four |
| `preDecision.offer` | Present only on `APPROVED`. `null` otherwise |
| `preDecision.offer.approvedAmountMinor` | May be **lower** than requested — see the counter-offer rule |
| `preDecision.assessment` | Score, band and DTI. `score` is `null` when **the scorecard did not run** — no bureau data, or a knockout fired before D3; `dti` is `null` when affordability never ran. A bankruptcy decline has bureau data and still carries `score: null` |
| `preDecision.assessment.band` | `AUTO_APPROVE` (≥ `bands.autoApproveFrom`), `REFERRAL` (≥ `referralFrom`), `DECLINE` (below it), or `null` when no score was computed |
| `preDecision.policyVersion` / `engineVersion` | What it was evaluated under. Quote them in any dispute |
| `preDecision.bureauReportId` | Which stored report backed the verdict |
| `preDecision.bureauReportReused` | `true` when no new pull was made for this application |
| `review.state` | `PENDING` or `CLOSED` |
| `review.outcome` | `APPROVED` or `DECLINED`. `null` while pending |
| `outcome.verdict` | The composed answer. `GET` only |
| `outcome.source` | `ENGINE` or `REVIEWER` — so a caller can always tell which. `GET` only |

---

### 3.1 Approved, with a reduced amount

The worked example from `docs/03-decision-policy.md` §5. Bureau profile
`CLEAN_MODERATE`.

**Request**

```json
{
  "productCode": "PERSONAL_UNSECURED_V1",
  "requestedAmountMinor": 3200000,
  "currency": "USD",
  "termMonths": 48,
  "purpose": "DEBT_CONSOLIDATION",
  "consent": {
    "attestedByCaller": true,
    "acceptedAt": "2026-09-02T09:13:58.002Z"
  },
  "applicant": {
    "firstName": "Maria",
    "lastName": "Delgado",
    "dateOfBirth": "1991-04-12",
    "nationalId": "900-55-0142",
    "email": "maria.delgado@example.com",
    "phone": "+12025550142",
    "residenceCountry": "US"
  },
  "finances": {
    "monthlyIncomeMinor": 540000,
    "employmentStatus": "EMPLOYED",
    "employmentMonths": 37,
    "declaredMonthlyObligationsMinor": 160000
  },
  "channel": "WEB"
}
```

**Response — `201 Created`**

```json
{
  "applicationId": "0b5f2a1e-6c47-4f0a-9b3d-7a1c48e2d905",
  "status": "PRE_DECIDED",
  "submittedAt": "2026-09-02T09:14:22.418Z",
  "product": {
    "code": "PERSONAL_UNSECURED_V1",
    "requestedAmountMinor": 3200000,
    "currency": "USD",
    "termMonths": 48
  },
  "preDecision": {
    "verdict": "APPROVED",
    "reasonCodes": [
      "AMOUNT_REDUCED_TO_FIT_DTI",
      "CREDIT_UTILIZATION_TOO_HIGH",
      "LIMITED_CREDIT_MIX"
    ],
    "offer": {
      "approvedAmountMinor": 2690000,
      "currency": "USD",
      "termMonths": 48,
      "annualRatePct": 12.9,
      "monthlyPaymentMinor": 72033,
      "expiresAt": "2026-10-02T09:14:22.418Z"
    },
    "assessment": {
      "score": 75,
      "maxScore": 100,
      "band": "AUTO_APPROVE",
      "dti": 0.4297
    },
    "policyVersion": "2026.09.1",
    "engineVersion": "1.0.0",
    "bureauReportId": "c17a9d40-2b58-4e6d-8f11-90ab3c7e4d22",
    "bureauReportReused": false,
    "decidedAt": "2026-09-02T09:14:23.106Z"
  },
  "review": null,
  "correlationId": "01J9R4X8QK7M2V0T5S3B6N8WQE"
}
```

The offer is $26,900 against $32,000 requested. `AMOUNT_REDUCED_TO_FIT_DTI` is
listed first because it is the decisive code; the two scorecard codes follow in
order of points lost. Under Regulation B this reduced offer is a counteroffer,
so the reasons are supplied up front rather than only if the applicant declines.

---

### 3.2 Declined

Bureau profile `ADVERSE_HISTORY`, identifier `900-55-0221`. The inputs are given
so the verdict can be checked against `policies/2026.09.1.json` the same way the
approval can:

| Attribute | Value | Factor | Awarded | Lost |
|---|---|---|---|---|
| `worstDelinquencyLast24m` | `DPD_90_PLUS` | Payment history | 3 / 35 | **32** |
| `revolvingUtilizationPct` | 82 | Amounts owed | 4 / 30 | **26** |
| `oldestAccountAgeMonths` | 30 | History length | 8 / 15 | **7** |
| `hardInquiriesLast6m` | 5 | New credit | 0 / 10 | **10** |
| `distinctAccountTypes` | 2 | Credit mix | 7 / 10 | 3 |
| | | **Total** | **22 / 100** | |

`hasActiveDelinquency` is `false`: the 90-day delinquency is historical and has
been cured, so it costs points at D3 rather than knocking the application out at
D2. Four factors lost five or more points, which is exactly the cap.

22 is below the referral floor of 45, so the verdict is settled at **D5** and
affordability never runs. `dti` is therefore `null` — a populated DTI on an
application that terminated before D7 would be a number no stage produced.

```json
{
  "applicationId": "3d9c6b02-88f4-41ae-a0d7-5e2b19c74f83",
  "status": "PRE_DECIDED",
  "submittedAt": "2026-09-02T10:02:51.774Z",
  "product": {
    "code": "PERSONAL_UNSECURED_V1",
    "requestedAmountMinor": 1500000,
    "currency": "USD",
    "termMonths": 36
  },
  "preDecision": {
    "verdict": "DECLINED",
    "reasonCodes": [
      "PAYMENT_HISTORY_ADVERSE",
      "CREDIT_UTILIZATION_TOO_HIGH",
      "TOO_MANY_RECENT_INQUIRIES",
      "INSUFFICIENT_CREDIT_HISTORY_LENGTH"
    ],
    "offer": null,
    "assessment": {
      "score": 22,
      "maxScore": 100,
      "band": "DECLINE",
      "dti": null
    },
    "policyVersion": "2026.09.1",
    "engineVersion": "1.0.0",
    "bureauReportId": "9f2e7c31-4a06-4b8e-b2d5-61cf80a3e714",
    "bureauReportReused": true,
    "decidedAt": "2026-09-02T10:02:51.998Z"
  },
  "review": null,
  "correlationId": "01J9R6M2ZC4H8P1D7Y0F3K5TAB"
}
```

Note `bureauReportReused: true` — this applicant had applied twelve minutes
earlier for a different amount. The second application is a real, separate
application with its own pre-decision, and it cost no second pull and left no
second mark on the applicant's file.

---

### 3.3 Referred, because the bureau did not answer

```json
{
  "applicationId": "a742f1b8-05dc-4e93-8b60-cc1de5f2a390",
  "status": "IN_REVIEW",
  "submittedAt": "2026-09-02T11:47:09.221Z",
  "product": {
    "code": "PERSONAL_UNSECURED_V1",
    "requestedAmountMinor": 900000,
    "currency": "USD",
    "termMonths": 24
  },
  "preDecision": {
    "verdict": "MANUAL_REVIEW",
    "reasonCodes": ["BUREAU_UNAVAILABLE"],
    "offer": null,
    "assessment": { "score": null, "maxScore": 100, "band": null, "dti": null },
    "policyVersion": "2026.09.1",
    "engineVersion": "1.0.0",
    "bureauReportId": null,
    "bureauReportReused": false,
    "decidedAt": "2026-09-02T11:47:11.640Z"
  },
  "review": {
    "state": "PENDING",
    "outcome": null,
    "openedAt": "2026-09-02T11:47:11.640Z",
    "closedAt": null
  },
  "correlationId": "01J9RB0V4E9J6Q2X8T1L5H7NCD"
}
```

The application is persisted even though the bureau failed. It is a business
event; discarding it would lose the applicant and leave no record that we had
already tried. The verdict is not `DECLINED`, because a rejection caused by our
own infrastructure is one we could not justify to the applicant — and under
ECOA, justifying a rejection is an obligation.

A **no-hit** looks similar but is a different fact and carries `NO_CREDIT_FILE`
with a non-null `bureauReportId`: the bureau answered, we stored what it said,
and the person simply has no file. Reporting that as `BUREAU_UNAVAILABLE` would
tell a genuine first-time borrower that our vendor was down.

---

### 3.4 Replayed submission

The same key, the same body, a second time:

```
HTTP/1.1 201 Created
Idempotency-Replayed: true
X-Correlation-Id: 01J9R4X8QK7M2V0T5S3B6N8WQE
```

The body is identical to the first response, including the original
`correlationId` and `decidedAt`. Nothing was re-evaluated, and no new row exists.

Because the body is stored and replayed verbatim, it reflects the moment of
submission and nothing later. If the application was referred and a reviewer has
since closed it, this replay still shows `review.state: "PENDING"`. That is
correct idempotency — the response to *this request* has not changed — and it is
why the composed `outcome` is not part of it. A client that needs the current
answer calls `GET /v1/applications/{id}`, which is the only endpoint that
computes one.

---

## 4. Read status

```
GET /v1/applications/0b5f2a1e-6c47-4f0a-9b3d-7a1c48e2d905
Authorization: Bearer <submission token>
```

Returns the submission envelope **plus the composed `outcome`**, reflecting
current state:

```json
{
  "applicationId": "a742f1b8-05dc-4e93-8b60-cc1de5f2a390",
  "status": "REVIEW_CLOSED",
  "preDecision": { "verdict": "MANUAL_REVIEW", "reasonCodes": ["BUREAU_UNAVAILABLE"], "...": "unchanged" },
  "review": {
    "state": "CLOSED",
    "outcome": "APPROVED",
    "approvedAmountMinor": 900000,
    "reviewerId": "underwriting:j.okafor",
    "openedAt": "2026-09-02T11:47:11.640Z",
    "closedAt": "2026-09-02T14:20:03.512Z"
  },
  "outcome": { "verdict": "APPROVED", "source": "REVIEWER", "decidedAt": "2026-09-02T14:20:03.512Z" }
}
```

This is the only endpoint that computes `outcome`, and it is the reason a
synchronous API still needs a status call. **`preDecision` does not change**,
ever: it is what the engine concluded, and a human disagreeing with it does not
make it untrue.

### `404` on someone else's application

Reads **are** owner-scoped: the handler compares `applications.client_id` with
the identity on the bearer token and refuses a mismatch. That is authorisation,
and an earlier draft under-claimed it — calling it "an unguessable id, not
authorisation" while describing a test that only passes if the check exists.

What it is *not* is authorisation beyond ownership: there are no roles, no
delegation, and no per-application grants. A client sees its own applications
and nothing else.

A mismatch returns `404`, never `403`, and an unknown id returns the same body.
Distinguishing them turns the endpoint into an oracle that confirms which
application ids are real — and `403` on someone else's id confirms it exists.
The two responses are byte-identical on purpose, and `docs/07-testing.md` §5
asserts them together for that reason.

---

## 5. Close a review

```
POST /v1/reviews/{applicationId}/close
Authorization: Bearer <reviewer token>
```

```json
{
  "outcome": "APPROVED",
  "approvedAmountMinor": 900000,
  "rationale": "Bureau outage; file pulled manually and assessed. Income verified against payslips."
}
```

`reviewer_id` comes from the token, never from the body — a human verdict with no
attributable actor cannot answer the audit question "could anyone have altered a
verdict after the fact?", and letting the caller name themselves is the same hole
with extra steps.

The write is a conditional update — `WHERE state = 'PENDING'` — so two concurrent
close attempts produce one write and one `409 REVIEW_ALREADY_CLOSED`. A closed
review is never reopened in v1; a mistaken outcome is a new application. It
appends `REVIEW_CLOSED` to the audit chain in the same transaction.

**Response — `200 OK`**: the full application envelope, with `review.state`
`CLOSED` and `outcome.source` `REVIEWER`.

What this endpoint deliberately is not: a manual-review workflow. There is no
queue, no assignment, no SLA, no reviewer UI — `docs/00-scope.md` §3 puts those
out of scope and they stay out. This records the **outcome** because without it
the audit trail has a `REVIEW_CLOSED` event nothing can emit and a referred
application has no terminal state. The workflow belongs to another system; the
record of what it decided belongs here.

---

## 6. Audit

These endpoints are for the lender's own compliance and support staff, not for
applicants. An applicant sees their own reasons through the normal status
response; nobody outside the organisation can list pre-decisions or replay them.

### 6.1 The event trail

```
GET /v1/audit/applications/{id}/events
```

```json
{
  "applicationId": "0b5f2a1e-6c47-4f0a-9b3d-7a1c48e2d905",
  "events": [
    { "index": 0, "type": "APPLICATION_RECEIVED",   "at": "2026-09-02T09:14:22.418Z", "actor": "client:acme-web",
      "detail": { "consentAttestedAt": "2026-09-02T09:13:58.002Z" } },
    { "index": 1, "type": "BUREAU_PULL_REQUESTED",  "at": "2026-09-02T09:14:22.702Z", "actor": "system" },
    { "index": 2, "type": "BUREAU_REPORT_ATTACHED", "at": "2026-09-02T09:14:23.044Z", "actor": "system",
      "detail": { "bureauReportId": "c17a9d40-2b58-4e6d-8f11-90ab3c7e4d22", "outcome": "FOUND", "reused": false } },
    { "index": 3, "type": "PRE_DECISION_MADE",      "at": "2026-09-02T09:14:23.106Z", "actor": "engine",
      "detail": { "verdict": "APPROVED", "score": 75, "policyVersion": "2026.09.1", "engineVersion": "1.0.0" } }
  ]
}
```

Events are append-only. The application's own database role holds no `UPDATE` or
`DELETE` privilege on the table, and a trigger raises on either, so a bug cannot
quietly rewrite history.

The event at index 2 is named `ATTACHED` rather than `STORED` because on the
reuse path nothing is written — the report already existed. An audit trail that
records a write that did not happen is one nobody can rely on.

### 6.2 Verify the chain

```
GET /v1/audit/applications/{id}/chain
```

```json
{
  "applicationId": "0b5f2a1e-6c47-4f0a-9b3d-7a1c48e2d905",
  "events": 4,
  "chainIntact": true,
  "brokenAtIndex": null,
  "verifiedAt": "2026-09-02T14:31:07.550Z"
}
```

Honest limits: the chain detects an edit by anyone who does not also recompute
every subsequent hash. It does **not** detect **truncation** — deleting the last
*k* events leaves a chain that verifies perfectly, and `events` has nothing to be
compared against — and it does not stop a consistent rewrite by someone with full
database access. Both need the same unbuilt mitigation: an external anchor
publishing the head hash *and* the event count. `docs/04-audit.md` §3 sets out
all three limits; truncation is the cheapest attack and the one an earlier draft
did not name.

### 6.3 Replay a pre-decision

```
POST /v1/audit/pre-decisions/{applicationId}/replay
Authorization: Bearer <auditor token>
```

Re-runs the engine against the **stored** application, the **stored** bureau
lookup, the **policy version recorded on the pre-decision**, and
**`submittedAt` as the clock** — never today's policy, never a fresh bureau call,
and never today's wall clock. The clock matters: `screen()` derives age and age
at maturity from it, so replaying with `now()` would turn an applicant who was
74 at maturity into an `AGE_ABOVE_MAXIMUM_AT_MATURITY` decline and report
tampering where there is none.

```json
{
  "applicationId": "0b5f2a1e-6c47-4f0a-9b3d-7a1c48e2d905",
  "match": true,
  "recorded": {
    "verdict": "APPROVED",
    "reasonCodes": ["AMOUNT_REDUCED_TO_FIT_DTI", "CREDIT_UTILIZATION_TOO_HIGH", "LIMITED_CREDIT_MIX"],
    "approvedAmountMinor": 2690000,
    "score": 75,
    "decidedAt": "2026-09-02T09:14:23.106Z"
  },
  "recomputed": {
    "verdict": "APPROVED",
    "reasonCodes": ["AMOUNT_REDUCED_TO_FIT_DTI", "CREDIT_UTILIZATION_TOO_HIGH", "LIMITED_CREDIT_MIX"],
    "approvedAmountMinor": 2690000,
    "score": 75
  },
  "evidence": {
    "policyVersion": "2026.09.1",
    "engineVersion": "1.0.0",
    "bureauReportId": "c17a9d40-2b58-4e6d-8f11-90ab3c7e4d22",
    "bureauReportOutcome": "FOUND",
    "bureauReportPulledAt": "2026-09-02T09:14:23.044Z",
    "bureauReportReused": false,
    "scorecard": [
      { "factor": "PAYMENT_HISTORY",  "input": "NONE", "awarded": 35, "max": 35, "lost": 0 },
      { "factor": "UTILIZATION",      "input": 34,     "awarded": 18, "max": 30, "lost": 12 },
      { "factor": "HISTORY_LENGTH",   "input": 60,     "awarded": 12, "max": 15, "lost": 3 },
      { "factor": "RECENT_INQUIRIES", "input": 2,      "awarded": 6,  "max": 10, "lost": 4 },
      { "factor": "CREDIT_MIX",       "input": 1,      "awarded": 4,  "max": 10, "lost": 6 }
    ],
    "affordability": {
      "monthlyIncomeMinor": 540000,
      "existingObligationsMinor": 160000,
      "monthlyPaymentMinor": 72033,
      "dti": 0.4297,
      "maxDti": 0.43
    }
  },
  "recomputedAt": "2026-09-02T14:31:12.884Z"
}
```

**Replay compares against the engine's verdict, never a human's.** A referred
application closed by a reviewer replays as `MANUAL_REVIEW` and still reports
`match: true`, because `pre_decisions.verdict` is what was recomputed. That is
the whole reason the human outcome is a separate row: with one mutable verdict
per application, every legitimate override would have reported `match: false` and
the endpoint that exists to detect tampering would have fired on the most
ordinary event in the business.

So `match: false` means one of a short, closed list — altered evidence; a code
change that broke reproducibility without bumping `engine_version`; a policy file
edited in place instead of superseded; or a change to a convention the engine
depends on but does not version, meaning canonical JSON ordering or the money
rounding rule in §1. All four are incidents. A human disagreeing with the engine
is on none of them. `docs/04-audit.md` §4 carries the same list.

This works only because the engine is a pure function.

### 6.4 List pre-decisions

```
GET /v1/audit/pre-decisions?from=2026-09-01&to=2026-09-30&verdict=APPROVED&limit=100&cursor=...
```

Keyset pagination on `(decidedAt, applicationId)`. Filters: `from`, `to`,
`verdict`, `policyVersion`, `reasonCode`, `outcomeSource`. The response carries
`nextCursor` when more rows exist.

Rows carry the application id, the verdict, the codes, the score, the policy
version and the subject key — never a name, contact details or a national
identifier. The subject key is a keyed hash and is **pseudonymous personal
data**, not anonymous: it links every application by one person, which is what an
auditor asking "did this person apply eleven times" needs. The export is scoped
to the auditor token and carries the same retention obligations as the rest of
the evidence.

---

## 7. Errors

`application/problem+json`, RFC 7807.

```json
{
  "type": "https://<host>/problems/validation-failed",
  "title": "Validation failed",
  "status": 422,
  "detail": "requestedAmountMinor must be a positive integer",
  "code": "VALIDATION_FAILED",
  "errors": [
    { "path": "requestedAmountMinor", "message": "must be a positive integer" }
  ],
  "correlationId": "01J9RC7T5M0A3E9W2Q6X4Z8VDF"
}
```

| HTTP | `code` | When |
|---|---|---|
| `400` | `MALFORMED_JSON` | The body is not parseable JSON |
| `401` | `UNAUTHENTICATED` | Missing or unparseable bearer token |
| `403` | `FORBIDDEN` | Valid token, wrong scope — a submission token on `/v1/audit/*` |
| `404` | `APPLICATION_NOT_FOUND` | Unknown id, or another client's id. Deliberately indistinguishable |
| `409` | `IDEMPOTENT_REQUEST_IN_PROGRESS` | Same key still being processed. `Retry-After: 3` — the worst-case in-flight request is ~2.5 s, so `1` would send a compliant client into a second `409` |
| `409` | `REVIEW_ALREADY_CLOSED` | Two concurrent closes; one won |
| `422` | `VALIDATION_FAILED` | Schema or field-rule violation |
| `422` | `IDEMPOTENCY_KEY_REUSED` | Same key, different body |
| `422` | `UNKNOWN_PRODUCT` | `productCode` not in the active policy |
| `422` | `CONSENT_REQUIRED` | `consent.attestedByCaller` absent or false |
| `422` | `CONSENT_STALE` | `consent.acceptedAt` is in the future or older than `consent.maxAgeHours` |
| `429` | `RATE_LIMITED` | Reserved; not enforced in v1 |
| `500` | `INTERNAL_ERROR` | Never carries internal detail. Quote the correlation id |
| `503` | `DATABASE_UNAVAILABLE` | Postgres unreachable; `/health/ready` fails alongside |

A failing credit bureau does **not** appear in this table. It is not an API
error — it produces a `MANUAL_REVIEW` verdict with `BUREAU_UNAVAILABLE`, and the
application is persisted.

---

## 8. Operations

| Endpoint | Behaviour |
|---|---|
| `GET /health/live` | `200` while the process is running. Touches nothing. A failing liveness probe means "restart me" |
| `GET /health/ready` | `200` only when Postgres answers. `503` otherwise, so the load balancer stops routing here without the container being killed |
| `GET /metrics` | Prometheus text format, behind the auditor scope |

Metrics worth watching, in the order they matter:

| Metric | What it catches |
|---|---|
| `predecision_outcomes_total{verdict}` | The engine's outcome mix. A spike in `MANUAL_REVIEW` means the policy or the bureau broke |
| `review_outcomes_total{outcome}` | What humans decided. Counted **separately** — an engine counter cannot be revised hours later when a reviewer closes a case, so merging the two would make both wrong |
| `bureau_reuse_ratio` | The primary deduplication signal. **Not proof** — it is a business ratio driven partly by traffic composition, it needs a baseline, and at a mostly-unique applicant mix it sits low enough that a total failure is a small absolute move. `bureau_pulls_total` against distinct subjects seen per TTL window is the direct detector and is the better alert once there is a baseline |
| `bureau_pulls_total{result}` | Actual external calls, and their failures |
| `bureau_claim_contention_total` | How often two concurrent applications collapsed into one pull |
| `bureau_wait_expired_total` | Losers that gave up waiting. Invisible otherwise — it looks exactly like a bureau outage and has the opposite fix |
| `bureau_call_duration_seconds` | Histogram; p95 justifies the timeout |
| `predecision_duration_seconds` | Whether "instant" is still true end to end |
| `applications_abandoned_total` | Orphans the sweeper closed. Non-zero means crashes mid-pull |
| `idempotency_replays_total` / `idempotency_conflicts_total` | A rising conflict count is a client bug |
| `http_errors_total{class}` | `4xx` and `5xx` counted separately — mixed together, an outage hides behind client noise |

Alert on the manual-review share and the bureau failure rate. Do not alert on a
raw error count.

**None of this is deployed in v1.** The counters are exported at `/metrics` and
that is all: there is no scraper, no alertmanager, no retention and no
dashboard, and the endpoint sits behind `AUDITOR_TOKENS`, so even a scraper would
need credentialing that no document describes. The "how we notice" column
throughout `docs/06-failure-modes.md` describes intended operation, not shipped
capability. Saying so costs a sentence; not saying it is the one thing in an
otherwise careful failure-mode table that a reviewer would call out.
