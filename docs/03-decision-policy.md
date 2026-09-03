# 03 — Decision policy

How the pre-decision is produced, why the rules are shaped this way, and how it
stays explainable after the rules change.

The engine is two pure functions:

```
screen(application, policy, now)          -> Knockout | null
decide(application, lookup, policy, now)  -> PreDecision
```

No clock, no database, no network. Everything they need arrives as an argument,
which is what makes a pre-decision replayable years later from stored inputs.

This document describes an **automated pre-decision**. Where an application is
referred, the final credit decision is made by a person using criteria this
service does not model; that outcome is a separate record. See ADR-0006.

---

## 1. Validation is not policy

Two different rejections, deliberately kept apart:

| | Meaning | Response | Recorded? |
|---|---|---|---|
| **Validation** | The request is malformed — a missing field, a negative term, a stale consent timestamp | `422 VALIDATION_FAILED` | No application is created |
| **Policy** | The request is well-formed and we say no — amount above the product ceiling, applicant too young | `DECLINED` with reason codes | Application and pre-decision are both persisted |

Collapsing these is a common mistake, and an expensive one: a policy rejection
returned as a validation error never reaches the funnel, the audit trail, or the
applicant's right to a reason.

---

## 2. The pipeline

Two phases separated by the bureau call, and inside the second phase a strict
precedence. **The first rule that produces a verdict wins, and evaluation
stops.**

```
screen(...)          no bureau data required
  S1  Eligibility knockouts .................. DECLINED

──────────────── bureau lookup happens here ────────────────

decide(...)
  D1  Lookup gate ............................ MANUAL_REVIEW
  D2  Bureau knockouts ....................... DECLINED
  D3  Scorecard is computed (never terminal on its own)
  D4  Referral triggers ...................... MANUAL_REVIEW
  D5  Score below the referral floor ......... DECLINED
  D6  Score inside the referral band ......... MANUAL_REVIEW
  D7  Affordability .......... APPROVED · counter-offer · DECLINED
```

### Why the order is exactly this

**S1 runs before the pull, and that is the whole point of splitting the engine
in two.** An applicant who is under 18, or asking for more than the product
allows, costs us nothing to reject — and pulling their file first would leave a
hard enquiry on the credit record of someone whose application was never going
to succeed. A single `evaluate(...)` called after the report cannot express
this, which is why there are two functions rather than one with a flag.

**D3 computes the scorecard but never decides on its own.** Scoring is
arithmetic over stored attributes, and its output is evidence worth recording
even when a later rule determines the verdict. Making it a terminal *stage* was
what produced the previous version's contradiction, where the referral band
appeared in two places and one of them was unreachable.

Note the boundary precisely, because it is easy to overstate: D3 runs for
everything that reaches it, so `score` is populated for referrals and for
affordability declines alike. It does **not** run for anything that terminated
earlier — an S1 knockout, a lookup-gate referral, or a D2 bureau knockout. A
bankruptcy decline therefore carries `score: null` even though bureau data was
available, and `docs/08-mock-bureau.md` §4 omits `RECENT_BANKRUPTCY` from its
score table for exactly that reason.

**D4 precedes D5 and D6.** A thin file or an identity mismatch means the score
is not trustworthy, so it must outrank both the decline floor and the referral
band. Put the score first and a thin-file applicant scoring 73 with a DTI over
the limit satisfies two rules at once with nothing to break the tie — which is
exactly the undefined behaviour this ordering removes.

**D7 is last and terminal.** Nothing runs after affordability. The worked example
in §5 stops there.

### S1 — Eligibility knockouts → `DECLINED`

| Condition | Reason code |
|---|---|
| Age below `eligibility.minAge` | `AGE_BELOW_MINIMUM` |
| Age at final instalment above `maxAgeAtMaturity` | `AGE_ABOVE_MAXIMUM_AT_MATURITY` |
| Amount outside the product's min/max | `AMOUNT_OUTSIDE_PRODUCT_LIMITS` |
| Term outside the product's min/max | `TERM_OUTSIDE_PRODUCT_LIMITS` |
| Declared income below `minMonthlyIncomeMinor` | `INCOME_BELOW_MINIMUM` |

### D1 — The lookup gate → `MANUAL_REVIEW`

The bureau returns one of three outcomes, and they are not interchangeable
(`docs/08-mock-bureau.md` §2):

| Lookup | Reason code | Why not a decline |
|---|---|---|
| `UNAVAILABLE` | `BUREAU_UNAVAILABLE` | A rejection caused by our own infrastructure is one we could not justify to the applicant, and under ECOA justifying it is an obligation |
| `NO_HIT` | `NO_CREDIT_FILE` | "No file" is an absence of evidence, not evidence of bad credit. A first-time borrower is a population a lender wants |
| `FOUND` but a required attribute is missing | `BUREAU_DATA_INCOMPLETE` | Scoring the gap as zero would decline a person for **our** data defect |

Conflating `NO_HIT` with `UNAVAILABLE` — the single most tempting simplification
here, since both arrive as "no report" — tells a genuine first-time borrower
that our vendor was down. Different fact, different code, different follow-up.

### D2 — Bureau knockouts → `DECLINED`

| Condition | Reason code |
|---|---|
| A delinquency currently active | `ACTIVE_DELINQUENCY` |
| Bankruptcy within `bankruptcyWithinMonths` | `BANKRUPTCY_ON_FILE` |
| Charge-off within `chargeOffWithinMonths` | `CHARGE_OFF_ON_FILE` |

`hasActiveDelinquency` and `worstDelinquencyLast24m` are separate attributes on
purpose. A cured 90-day delinquency costs points at D3; a live one ends the
application here.

### D3 — The scorecard

Five factors, 100 points in total. The weights mirror the publicly documented
composition of the FICO score, which is the closest thing US consumer lending
has to a shared vocabulary:

| Factor | Points | Bureau input |
|---|---|---|
| Payment history | 35 | `worstDelinquencyLast24m` |
| Amounts owed | 30 | `revolvingUtilizationPct` |
| Length of credit history | 15 | `oldestAccountAgeMonths` |
| New credit | 10 | `hardInquiriesLast6m` |
| Credit mix | 10 | `distinctAccountTypes` |

**How a band table is read.** `scorecard.bandEvaluation` is `FIRST_MATCH_WINS`:
bands are evaluated in file order and the first one whose predicate holds awards
its points. Order is therefore significant, and the tables are written so that
it is — `UTILIZATION` ascends through `lt`, `HISTORY_LENGTH` descends through
`gte`. If no band matches, the factor's `default` is awarded.

Leaving this unstated was a real defect and not a documentation nicety: with
mixed `lt`/`lte`/`gte`/`eq` predicates in one array, the same file evaluates
differently under "first match" and "last match", and boundary tests prove
nothing until the rule is fixed. A missing input never reaches `default` — it is
caught at D1 as `BUREAU_DATA_INCOMPLETE`, so `default` covers only a value that
is present and outside every band.

In `policies/2026.09.1.json` every factor's bands are in fact exhaustive over
its declared domain, so `default` is unreachable there. It is specified anyway,
and `tests/unit/policy.test.ts` exercises the fall-through against an inline
policy with a deliberate gap, because "the current file happens to be total" is
a property of one file rather than of the format — and the next policy version
is written by a risk owner, not by the author of the evaluator.

Bands live in `policies/<version>.json`; nothing is hardcoded in the engine.

### D4 — Referral triggers → `MANUAL_REVIEW`

| Condition | Reason code |
|---|---|
| `oldestAccountAgeMonths` below `thinFile.minOldestAccountMonths`, or `totalAccounts` below `minTotalAccounts` | `THIN_FILE` |
| Name or date of birth disagrees with the bureau | `IDENTITY_MISMATCH` |
| Requested amount above `autoApproveCeilingMinor` | `AMOUNT_ABOVE_AUTO_LIMIT` |

`THIN_FILE` is deliberately not a decline. A short file is not evidence of bad
credit; it is an absence of evidence, and the scorecard has nothing to work
with. A person is better placed to judge that than a band table.

### D5 and D6 — The score bands

| Total | Outcome |
|---|---|
| < `bands.referralFrom` (45) | `DECLINED` |
| 45 – 69 | `MANUAL_REVIEW`, reason `SCORE_IN_REFERRAL_BAND` |
| ≥ `bands.autoApproveFrom` (70) | Continue to D7 |

A decline at D5 discloses the scorecard factors that lost the most points. There
is deliberately no separate "your score was too low" code: the score is not a
reason, it is the *sum* of the reasons, and Regulation B asks for the factors.
Adding a code for the total would be exactly the hand-curated reason ADR-0004
rejects.

### D7 — Affordability, and the counter-offer

```
monthlyPayment = annuity(amount, termMonths, product.annualRatePct)
dti            = (existingMonthlyObligations + monthlyPayment) / monthlyIncome
```

Existing obligations come from the bureau report when present, and fall back to
the declared figure otherwise — the bureau sees obligations the applicant may
forget or omit.

If `dti > maxDti`, we do **not** decline immediately. We solve the annuity
backwards for the largest principal that fits the limit, round it down to
`counterOfferRoundingMinor` (10000 minor units, i.e. $100), and:

- if that amount is still at or above the product minimum →
  `APPROVED` at the reduced amount, with `AMOUNT_REDUCED_TO_FIT_DTI`;
- otherwise → `DECLINED` with `DTI_ABOVE_LIMIT`.

A lender rarely says "no" when it can say "yes, but less". This is also why
`approvedAmountMinor` may differ from `requestedAmountMinor` in the response.

> **A counter-offer is legally not a plain approval.** Under Regulation B,
> offering credit on terms other than those applied for is a counteroffer, and
> it becomes adverse action if the applicant does not accept it. That is why a
> reduced-amount approval still carries reason codes: the notice has to be
> available if the offer is declined.

---

## 3. Reason codes fall out of the scorecard

This is the part worth reading twice.

For every factor we compute `pointsLost = maxPoints − awarded`. The disclosed
reason codes are the factors with the largest losses, capped at
`maxDisclosed` (4), and only those losing at least `materialPointsLost` (5)
points. Ordering is deterministic:

1. **Decisive and referral codes first**, in `reasonCodes.registry` order — which
   is why the registry is an ordered list in the policy file rather than a set.
2. Then scorecard factors by points lost, descending.
3. Ties broken by code, alphabetically.

The same inputs always produce the same list, which is what makes the audit
stable and the tests meaningful.

**The list can legitimately be empty, and only for one verdict.** If every
factor is inside its top band and the amount asked for is affordable, nothing
lost five points and no decisive code applies, so the derivation yields nothing.
That is the correct answer for an approval on the requested terms: it is not
adverse action, and there is no reason owed. Profile `PRIME`
(`docs/08-mock-bureau.md` §4) reaches it. For every other verdict an empty list
is a defect, and the database refuses it — the asymmetry, and why the
counter-offer case sits on the refusing side of it, is ADR-0010.

**Why this mechanism and not a hand-picked list.** The official commentary to
Regulation B describes acceptable methods for choosing the principal reasons in
a credit-scoring system: identifying the factors on which the applicant's score
fell furthest below the average of applicants who barely qualified, or below the
average of all applicants — or *"any other method that produces results
substantially similar"*. Ranking by points lost against each factor's maximum is
that third option in its simplest form. The commentary also notes that
disclosing more than four reasons is unlikely to help the applicant, which is
where the cap comes from.

**Where the cap and the completeness rule pull against each other.** The
commentary also insists that no factor which was a principal reason may be
omitted, and a cap of four can collide with that. Under *this* policy the
collision has a precise shape, established by exhaustive search over every
reachable award combination rather than by intuition:

| Where the verdict lands | Max material scorecard factors | Non-scorecard code also disclosed | Principal reasons dropped |
|---|---|---|---|
| Score ≥ 70 (D7, decisive code) | **3** | `AMOUNT_REDUCED_TO_FIT_DTI` or `DTI_ABOVE_LIMIT` | **none** |
| Score 45–69 (D6) | **5** | `SCORE_IN_REFERRAL_BAND` | up to **2** |
| Score < 45 (D5) | **5** | none | up to **1** |

So the case that first looks alarming — a decisive code eating a slot from four
material factors — **cannot occur**: the band granularity makes four material
factors impossible at a score of 70 or above, the cheapest such combination
costing 32 points. That is a property of the current bands, not a law, and a
future policy with finer bands could break it; the test suite asserts it so the
breakage is loud.

The collision that *is* reachable sits in the referral band, where five material
factors can coexist with `SCORE_IN_REFERRAL_BAND` and the cap drops two of them.
It matters less than it sounds, because a referral is not adverse action: no
notice is owed until a human declines, and at that point the reasons are the
reviewer's, not ours. Below 45 the decline is real and up to one principal reason
can be dropped, which is the case a compliance owner should actually be shown.

We keep the cap, because the same commentary is the source of the number. If a
real deployment had to choose, the resolution is to disclose non-scorecard codes
*outside* the four rather than inside — a product and compliance decision, not an
engineering one.

Honest limitation: a production system would calibrate the comparison against
the observed population of marginally-approved applicants rather than against
each factor's theoretical maximum. That calibration needs data this service does
not have, and it is recorded as a known gap rather than pretended away.

Every code the engine can emit is listed in `policies/<version>.json` under
`reasonCodes.registry`, with its class, the stage that emits it and the verdict
it belongs to. That registry is what `docs/07-testing.md` §7 walks to prove no
code is unreachable — a criterion that could not be checked at all while the
codes existed only in this document's prose.

---

## 4. What the scorecard must never use

Under the Equal Credit Opportunity Act, a creditor may not discriminate on race,
colour, religion, national origin, sex, marital status, age, or because income
derives from public assistance. None of these appear as scoring factors.

Age appears **only** in the eligibility knockouts: legal capacity to contract at
one end, and age at final instalment at the other. It contributes no points.

Being straight about the exposure rather than claiming safety: ECOA treats age
specially, and a demonstrably sound scoring system may use it — but may not
assign a negative factor to applicants aged 62 or over. `maxAgeAtMaturity` is a
**decline** based on age, applied by an uncalibrated system, and that is the more
exposed of the two uses, not the safer one. Keeping age out of the scorecard
avoids the scoring question; it does not dispose of the knockout question. A
real deployment would need either demonstrable empirical justification for the
maturity limit or a different mechanism entirely, and that is a compliance
conversation this document cannot have on its own.

---

## 5. Worked example

A single application, followed all the way through. The bureau profile is
`CLEAN_MODERATE` from `docs/08-mock-bureau.md` §4, reachable on the deployed
instance with identifier `900-55-0142`.

**Request**

| Field | Value |
|---|---|
| Product | `PERSONAL_UNSECURED_V1` at 12.9% |
| Requested | $32,000 over 48 months |
| Declared monthly income | $5,400 |
| Date of birth | 1991-04-12 (age 35) |

**Bureau lookup — `FOUND`**

| Attribute | Value |
|---|---|
| `worstDelinquencyLast24m` | `NONE` |
| `hasActiveDelinquency` | false |
| `revolvingUtilizationPct` | 34 |
| `oldestAccountAgeMonths` | 60 |
| `hardInquiriesLast6m` | 2 |
| `distinctAccountTypes` | 1 |
| `totalAccounts` | 3 |
| `monthlyObligationsMinor` | 160000 |
| Identity | name ✓, DOB ✓ |

**S1.** No knockouts: age 35, age at maturity 39, amount and term inside product
limits, income above the floor. The bureau is called.

**D1–D2.** Lookup is `FOUND` and complete. No active delinquency, no bankruptcy,
no charge-off.

**D3 — scorecard**

| Factor | Input | Awarded | Lost |
|---|---|---|---|
| Payment history | `NONE` | 35 / 35 | 0 |
| Amounts owed | 34% | 18 / 30 | **12** |
| History length | 60 months | 12 / 15 | 3 |
| New credit | 2 inquiries | 6 / 10 | 4 |
| Credit mix | 1 type | 4 / 10 | **6** |
| **Total** | | **75 / 100** | |

**D4.** No referral triggers: 3 accounts and 60 months clear the thin-file floor,
identity matches, $32,000 is below the $35,000 auto-approve ceiling.

**D5–D6.** 75 ≥ 70, so neither band applies.

**D7 — affordability**

```
monthly rate = 0.129 / 12                       = 0.010750
payment      = 32000 × 0.010750 / (1 − 1.010750⁻⁴⁸)
             = 344.00 / 0.4014506              = 856.89
dti          = (1600 + 856.89) / 5400          = 0.45498  → 45.5%
```

45.5% is above the 43% limit, so we solve backwards:

```
max payment   = 0.43 × 5400 − 1600             = 722.00
max principal = 722.00 × 0.4014506 / 0.010750  = 26,962.54
rounded down to the nearest $100               = 26,900.00
resulting dti = (1600 + 720.33) / 5400         = 0.42969 → 43.0% ✓
```

$26,900 is comfortably above the $2,000 product minimum, so this becomes a
counter-offer rather than a decline. **D7 is terminal; nothing runs after it.**

**Verdict**

```
APPROVED
approvedAmountMinor  2690000        ($26,900 of the $32,000 requested)
monthlyPaymentMinor  72033
reasonCodes          AMOUNT_REDUCED_TO_FIT_DTI     (decisive, first)
                     CREDIT_UTILIZATION_TOO_HIGH   (12 points lost)
                     LIMITED_CREDIT_MIX            (6 points lost)
policyVersion        2026.09.1
expiresAt            30 days out
```

Two factors lost fewer than five points — history length and new credit — so
they are not disclosed. The applicant gets the reasons that actually moved the
outcome, not a list of everything imperfect about their file.

A second worked example ending in a decline, with its bureau inputs, is in
`docs/05-api.md` §3.3.

---

## 6. Policy versioning

The policy is a JSON file in the repository, validated at boot, addressed by
version:

```
policies/2026.09.1.json
policies/2026.10.1.json    ← added, never replacing
```

**Why a file in git rather than a database table.** Changing a lending policy
is a risk decision, not a configuration tweak. Git gives review, authorship,
history and rollback for free; a database row can be changed by anyone with a
connection string and leaves no reviewable trail. Real lenders do keep policy in
a database — behind an approval workflow that git already provides here. The
loader sits behind an interface, so moving to a table later changes one adapter.

**Old versions are never deleted.** Every pre-decision records the
`policy_version` it was evaluated under, and replay loads *that* version, not
today's. This is what lets a decision made in September stay explainable after
October's rules ship. Deleting an old policy file silently breaks every replay
that depends on it — which is why the file set is append-only by rule.

There is no exception, and an earlier draft's "may be edited in place until the
first pre-decision" has been removed. It was a rule with no mechanism: nothing
records whether a version has ever decided anything, and the deployed demo
instance makes its first pre-decision the moment a reviewer runs the `curl` in
the README. A rule enforced by remembering is an invitation to break replay on
the one artefact that cannot be reconstructed.

A policy file is immutable from the commit that introduces it. Editing one
during design, before anything is deployed, is editing a draft; once it is on
`main` and a deploy exists, a change is a new version.

---

## 7. Assumptions

Recorded because the brief does not answer them, and because a reader deserves
to know which parts are borrowed and which are invented.

| # | Assumption |
|---|---|
| P1 | The market modelled is US consumer unsecured lending. Terminology, the reason-code discipline and the 43% DTI benchmark come from that context |
| P2 | Scorecard weights mirror the published composition of the FICO score (35/30/15/10/10). Band tables inside each factor are invented and not calibrated against real outcome data |
| P3 | Thresholds are illustrative. A real lender derives them from portfolio performance; none of these numbers should be read as underwriting advice |
| P4 | The bureau returns **attributes**, not a composite third-party score. See below |
| P5 | Declared income is not independently verified at this stage; verification belongs to the later, out-of-scope part of origination |
| P6 | A single product and a single interest rate. Risk-based pricing — a rate that varies with the score — is a natural next step and is not implemented |
| P7 | Regulatory references describe US practice as commonly implemented; a real deployment would confirm current requirements with compliance counsel rather than with this document |

**On P4 — why our own score instead of the bureau's.** A composite score from a
third party is a number we cannot explain. If the only thing driving a decline
is "their score was 612", the adverse action notice has to fall back on the
bureau's own factor codes, and our reason codes stop being traceable to facts we
hold. Deriving the score ourselves from disclosed attributes means every code
points at a stored number a person can check. The trade-off is real: a bureau
score encodes far more signal than five attributes, and a production lender
would use both. That is a roadmap item, not a v1 one.
