# 08 — The mock credit bureau

> *"call mock credit bureau (you implement)"*

An explicit build item of the brief, so it gets a specification rather than an
implementation detail. Three things have to be true of it: the attribute
contract must be complete enough for the policy to evaluate, the responses must
be **deterministic** or no test proves anything, and it must be able to **fail on
demand** or the failure path cannot be demonstrated on the deployed instance.

---

## 1. What the gateway passes to it, and why

```
pull({ nationalId, subjectKey, provider }) -> BureauLookup
```

The national identifier is passed **to the provider**; the subject key is not.
This is easy to get backwards, and getting it backwards produces a design that
cannot ever be pointed at a real bureau:

| Value | Who it is for | Where it lives afterwards |
|---|---|---|
| `nationalId` | The **bureau**. A real credit file is looked up by the real identifier; no provider can search by our HMAC | Nowhere. Held for the duration of the call, never persisted, never logged |
| `subjectKey` | **Us**. The reuse lookup, the pull claim, the audit correlation | `applications.subject_key`, `bureau_reports.subject_key` |

So the identifier is not "discarded from memory" the moment the subject key is
derived — it survives until the pull completes, because the pull needs it. That
is the honest statement, and `docs/05-api.md` §3 says it that way.

The mock keys its catalogue on the **canonicalised identifier**, exactly as a
real bureau would, which is also what makes the profiles below reproducible on
any deployment regardless of `SUBJECT_KEY_PEPPER`.

### Canonicalisation

Before hashing *and* before catalogue lookup, the identifier is reduced to its
alphanumeric characters, uppercased. `900-55-0142`, `900 55 0142` and
`900550142` are one subject. Without this, three spellings produce three subject
keys, three pulls and three marks on one credit file — the central requirement
defeated by a hyphen.

---

## 2. Three outcomes, not two

```
BureauLookup =
  | { outcome: "FOUND",       report: BureauReport }
  | { outcome: "NO_HIT" }
  | { outcome: "UNAVAILABLE", cause: "TIMEOUT" | "SERVER_ERROR" | "RETRIES_EXHAUSTED" }
```

The third state is the one that is easy to omit, and omitting it produces a real
product defect. "This person has no credit file" and "our vendor was down" are
completely different facts:

| Outcome | Meaning | Verdict | Reason code | Report stored? |
|---|---|---|---|---|
| `FOUND` | A file exists | scorecard runs | derived | yes |
| `NO_HIT` | The bureau answered, and there is no file | `MANUAL_REVIEW` | `NO_CREDIT_FILE` | yes, as an empty-file snapshot |
| `UNAVAILABLE` | The bureau did not answer | `MANUAL_REVIEW` | `BUREAU_UNAVAILABLE` | no |

A `NO_HIT` **is stored** as a report row with `outcome: "NO_HIT"` and no
attributes. That matters twice: it is evidence of what the bureau actually said,
and it is reusable — a second application from the same person inside the TTL
must not trigger a second enquiry just because the first one found nothing.

`NO_CREDIT_FILE` is a referral, not a decline, for the same reason `THIN_FILE`
is: an absence of evidence is not evidence of bad credit, and a first-time
borrower is a population a lender wants, not one it rejects by accident.

---

## 3. The attribute contract

Everything the policy can reference, and nothing it cannot. If a required
attribute is missing from a `FOUND` report, the engine returns `MANUAL_REVIEW`
with `BUREAU_DATA_INCOMPLETE` — it never scores the gap as zero, because that
would decline a person for our own data defect.

| Attribute | Type | Consumed by |
|---|---|---|
| `provider` | string | Reuse lookup, pull key |
| `pulledAt` | timestamp | Evidence, TTL |
| `outcome` | `FOUND` \| `NO_HIT` | Engine entry branch |
| `subjectMatch.nameMatches` | boolean | Referral · `IDENTITY_MISMATCH` |
| `subjectMatch.dateOfBirthMatches` | boolean | Referral · `IDENTITY_MISMATCH` |
| `hasActiveDelinquency` | boolean | Bureau knockout · `ACTIVE_DELINQUENCY` |
| `monthsSinceBankruptcy` | integer \| null | Bureau knockout · `BANKRUPTCY_ON_FILE` |
| `monthsSinceChargeOff` | integer \| null | Bureau knockout · `CHARGE_OFF_ON_FILE` |
| `worstDelinquencyLast24m` | `NONE` \| `DPD_30` \| `DPD_60` \| `DPD_90_PLUS` \| `CHARGE_OFF` | Scorecard · payment history |
| `revolvingUtilizationPct` | integer, 0–100 | Scorecard · amounts owed |
| `oldestAccountAgeMonths` | integer | Scorecard · history length · thin file |
| `hardInquiriesLast6m` | integer | Scorecard · new credit |
| `distinctAccountTypes` | integer | Scorecard · credit mix |
| `totalAccounts` | integer | Thin file |
| `monthlyObligationsMinor` | integer | Affordability · DTI |

Two pairs look redundant and are not:

- **`hasActiveDelinquency` vs `worstDelinquencyLast24m`.** The first is a
  knockout: something is delinquent *right now*. The second is history: the
  worst thing that happened in two years, which may since have been cured. A
  cured `DPD_90_PLUS` costs points; a live one ends the application.
- **`totalAccounts` vs `distinctAccountTypes`.** Three credit cards is three
  accounts and one type. The first answers "is there a file to score"; the
  second answers "is the mix informative".

---

## 4. The profile catalogue

Bound to identifiers so a reviewer can reproduce every documented outcome
against the deployed instance with nothing but `curl`. All identifiers are in the
`900-xx-xxxx` range, which is not issued as a US Social Security number — though
it is well-formed as an ITIN, so these are synthetic-by-convention, not
synthetic-by-proof.

| Identifier | Profile | Produces |
|---|---|---|
| `900-55-0142` | `CLEAN_MODERATE` | Score 75, DTI over the limit → **counter-offer** |
| `900-55-0221` | `ADVERSE_HISTORY` | Score 22 → **declined** |
| `900-55-0601` | `PRIME` | Score 100 → **approved in full** |
| `900-55-0701` | `REFERRAL_BAND` | Score 59 → `MANUAL_REVIEW` · `SCORE_IN_REFERRAL_BAND` |
| `900-55-0301` | `THIN` | Score 73, but 1 account → `MANUAL_REVIEW` · `THIN_FILE` |
| `900-55-0300` | `NO_FILE` | `NO_HIT` → `MANUAL_REVIEW` · `NO_CREDIT_FILE` |
| `900-55-0402` | `NAME_MISMATCH` | Score 94, name disagrees → `MANUAL_REVIEW` · `IDENTITY_MISMATCH` |
| `900-55-0501` | `RECENT_BANKRUPTCY` | Bankruptcy 8 months ago → **declined** at the bureau knockout |
| `900-55-9001` | — | `UNAVAILABLE` · `SERVER_ERROR` on every attempt |
| `900-55-9002` | — | Sleeps past the timeout on every attempt → `UNAVAILABLE` · `TIMEOUT` |
| anything else | derived | Deterministic from the identifier — see §5 |

### Attribute values

| | `CLEAN_MODERATE` | `ADVERSE_HISTORY` | `PRIME` | `REFERRAL_BAND` | `THIN` | `NAME_MISMATCH` | `RECENT_BANKRUPTCY` |
|---|---|---|---|---|---|---|---|
| `nameMatches` | ✔ | ✔ | ✔ | ✔ | ✔ | ✘ | ✔ |
| `dateOfBirthMatches` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `hasActiveDelinquency` | false | false | false | false | false | false | false |
| `monthsSinceBankruptcy` | null | null | null | null | null | null | **8** |
| `monthsSinceChargeOff` | null | null | null | null | null | null | null |
| `worstDelinquencyLast24m` | `NONE` | `DPD_90_PLUS` | `NONE` | `NONE` | `NONE` | `NONE` | `DPD_60` |
| `revolvingUtilizationPct` | 34 | 82 | 8 | 55 | 15 | 20 | 70 |
| `oldestAccountAgeMonths` | 60 | 30 | 120 | 20 | 4 | 90 | 44 |
| `hardInquiriesLast6m` | 2 | 5 | 0 | 3 | 1 | 1 | 4 |
| `distinctAccountTypes` | 1 | 2 | 4 | 2 | 1 | 3 | 2 |
| `totalAccounts` | 3 | 6 | 9 | 4 | **1** | 7 | 5 |
| `monthlyObligationsMinor` | 160000 | 210000 | 90000 | 180000 | 40000 | 150000 | 230000 |

`ADVERSE_HISTORY` carries a `DPD_90_PLUS` with `hasActiveDelinquency: false` on
purpose: it is the profile that proves the two attributes are not the same
thing. If they were collapsed, this applicant would be knocked out at the bureau
stage and the scorecard would never be exercised by the documented example.

`CLEAN_MODERATE` has three accounts of one type — three credit cards. That is
what produces `LIMITED_CREDIT_MIX` in the worked example while keeping the file
comfortably above the thin-file floor.

### Resulting scores

Every number below is recomputed from `policies/2026.09.1.json` rather than
asserted, and `tests/unit/mock-profiles.test.ts` re-derives them so this table
cannot drift from the catalogue.

| Profile | Payment | Utilisation | History | Inquiries | Mix | **Total** |
|---|---|---|---|---|---|---|
| `CLEAN_MODERATE` | 35 | 18 | 12 | 6 | 4 | **75** |
| `ADVERSE_HISTORY` | 3 | 4 | 8 | 0 | 7 | **22** |
| `PRIME` | 35 | 30 | 15 | 10 | 10 | **100** |
| `REFERRAL_BAND` | 35 | 10 | 4 | 3 | 7 | **59** |
| `THIN` | 35 | 26 | 0 | 8 | 4 | **73** |
| `NAME_MISMATCH` | 35 | 26 | 15 | 8 | 10 | **94** |

---

## 5. Unlisted identifiers

A reviewer who invents their own identifier must still get a stable answer, and
the same answer twice. The fallback derives attributes from the canonicalised
identifier itself:

The derivation uses a value list **owned by the mock**, never the policy's band
tables. That distinction is the whole point: if the mock drew from the policy,
every profile would shift when a risk owner edited a threshold, the §4 score
table would stop being a check of anything, and "the same report forever" would
be false.

```
seed = sha256(canonicalIdentifier)   // not the subject key: no pepper, so it is portable

CHOICES = {                          // mock-owned, fixed, versioned with the mock
  worstDelinquencyLast24m: ["NONE","NONE","NONE","DPD_30","DPD_60","DPD_90_PLUS"],
  revolvingUtilizationPct: [5, 18, 27, 34, 48, 61, 72, 84, 93],
  oldestAccountAgeMonths:  [3, 9, 18, 30, 44, 60, 88, 120],
  hardInquiriesLast6m:     [0, 0, 1, 2, 3, 4, 6],
  distinctAccountTypes:    [1, 1, 2, 2, 3, 4],
  totalAccounts:           [1, 2, 3, 5, 7, 9],
  monthlyObligationsMinor: [0, 40000, 90000, 150000, 210000, 300000],
}

for i, attribute in enumerate(FIXED_ORDER):
    list = CHOICES[attribute]
    report[attribute] = list[ seed[i] % len(list) ]

hasActiveDelinquency  = false        // never, outside the named profiles
monthsSinceBankruptcy = null
monthsSinceChargeOff  = null
subjectMatch          = both true
```

Each attribute draws from its own list, because one shared array cannot produce
both an enum and an integer percentage. The lists are weighted towards ordinary
files on purpose: an unlisted identifier should land somewhere plausible, and the
interesting cases are the named profiles a reviewer can reach deliberately.

No `Math.random()`, no clock, no counter. The same identifier yields the same
report on every machine, on every run, for as long as `CHOICES` and
`FIXED_ORDER` are unchanged — and changing them is a change to the mock, made in
a commit, not a silent consequence of a policy edit. `docs/07-testing.md` asserts
determinism across processes; it does not assert any particular value, because
the values are the mock's business.

---

## 6. Failing on demand

Two independent triggers, because they serve different audiences.

**By identifier** — `900-55-9001` and `900-55-9002`. Needs no configuration and
no restart, so the failure path is demonstrable on the deployed instance with a
single `curl`. This is the one a reviewer will use.

**By configuration** — `MOCK_BUREAU_FAILURE_MODE` ∈ `none | error | timeout |
flaky`, plus `MOCK_BUREAU_LATENCY_MS`. `flaky` fails the first
`MOCK_BUREAU_FAILURES_BEFORE_SUCCESS` attempts and then succeeds, which is what
proves the retry actually retries — and that every attempt of one logical pull
carries the same request id.

Both are honest about what they are: the mock is not pretending to be a bureau,
it is a **specification of the contract we would hold a real one to**, with the
failure modes made reachable. `docs/06-failure-modes.md` names each one and
points at the test that exercises it.

---

## 7. What the mock deliberately does not model

- **Latency distribution.** One configurable constant, not a realistic tail.
  The p95 budget in `docs/00-scope.md` A2 is therefore an assumption, not a
  measurement, and `docs/07-testing.md` §6 says so.
- **Partial reports.** A real bureau can return a file with some sections
  missing. Here a report is complete or it is `NO_HIT`. The engine still
  handles the incomplete case (`BUREAU_DATA_INCOMPLETE`) because the mock is not
  the only thing that could ever produce one.
- **Cost accounting.** Real enquiries are billed. `bureau_pulls_total` is the
  metric a finance question would be answered from; no price is modelled.
- **Soft pulls.** Everything here is a hard enquiry. A production system would
  soft-pull for pre-qualification and hard-pull only at decision — which is,
  incidentally, the single largest change that would reduce the harm this
  service's deduplication exists to prevent.
