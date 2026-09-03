# 09 — The engine, for someone who has to defend it

`docs/03-decision-policy.md` says what the rules are. This says **why each one
sits where it sits, and what breaks if it moves** — the questions a reviewer
actually asks, with the answers stated once, in order.

If you read one thing before a technical conversation about this service, read
this.

---

## 1. Why the engine is two functions and not one

```
screen(application, policy, now)          -> Knockout | null
decide(application, lookup, policy, now)  -> PreDecision
```

The obvious design is one `evaluate(application, lookup, policy)` called after
the bureau report arrives. It is wrong, and the reason is not architectural
taste.

An applicant who is 17, or asking for twice the product ceiling, is going to be
declined either way. Pulling their credit file first leaves a **hard enquiry**
on the record of a person whose application was never going to succeed — a small
but real harm, inflicted for no information we were going to use. A single
function called after the pull cannot express "do not pull for this person",
because by the time it runs the pull has happened.

So the split is where the ethical claim lives. Everything else about it — that
`screen` is cheap, that it needs no I/O — is a consequence, not the reason.

**If asked "why not a flag?"** — `evaluate(application, lookup | null, policy)`
with a null lookup is the same function doing two jobs, and nothing in the type
stops a caller from passing a report to a stage that must run before one exists.
Two signatures make the ordering unrepresentable-if-wrong rather than
documented-as-right.

---

## 2. The precedence, and the tie it removes

```
S1  Eligibility knockouts .................. DECLINED
──────────────── the bureau is called here ────────────────
D1  Lookup gate ............................ MANUAL_REVIEW
D2  Bureau knockouts ....................... DECLINED
D3  Scorecard computed (never terminal)
D4  Referral triggers ...................... MANUAL_REVIEW
D5  Score below the referral floor ......... DECLINED
D6  Score inside the referral band ......... MANUAL_REVIEW
D7  Affordability .......... APPROVED · counter-offer · DECLINED
```

**The first rule that produces a verdict wins, and evaluation stops.**

### D3 is not a stage

The scorecard is arithmetic over stored attributes. Its output is evidence worth
recording even when a later rule determines the verdict — a referral still
carries a score, and so does an affordability decline. Treating it as a terminal
stage is what produced this design's one real contradiction in an earlier draft:
the referral band appeared in two places and one of them was unreachable.

Note the boundary precisely, because it is easy to overstate. D3 runs for
everything that *reaches* it, so `score` is populated for D4, D5, D6 and D7
outcomes alike. It does **not** run for anything that terminated earlier. A
bankruptcy decline therefore carries `score: null` even though bureau data was
available — and that is why `docs/08` §4 omits `RECENT_BANKRUPTCY` from its score
table.

### D4 outranks D5 and D6, and this is the ordering worth defending hardest

A thin file or an identity mismatch means **the score is not trustworthy**. It
must therefore outrank a number derived from the same report.

The concrete case: profile `THIN` scores 73, comfortably above the 70
auto-approve floor, on a file with **one account**. Put the score first and this
applicant is auto-approved on almost no evidence. Profile `NAME_MISMATCH` scores
94 while the bureau says the name does not match — auto-approving that is
approving a loan for someone we may not have looked up.

And the tie: put the score first and a thin-file applicant scoring 73 with a DTI
over the limit satisfies two rules at once, with nothing in the design to say
which wins. That is undefined behaviour in a lending decision, and this ordering
is what removes it.

### D5 discloses factors, not the score

There is deliberately **no** "your score was too low" reason code. The score is
not a reason — it is the *sum* of the reasons, and Regulation B asks for the
factors. A code for the total would be exactly the hand-curated reason ADR-0004
rejects.

### D7 is last and terminal

Nothing runs after affordability. The worked example in `docs/03` §5 stops there.

---

## 3. The three bureau outcomes, and the one that is tempting to drop

```
FOUND | NO_HIT | UNAVAILABLE
```

`NO_HIT` and `UNAVAILABLE` both arrive as "no report". Collapsing them is the
single most tempting simplification in this whole service, and it produces a real
product defect: a genuine first-time borrower is told **our vendor was down**.

| Outcome | Meaning | Verdict | Code | Stored? |
|---|---|---|---|---|
| `FOUND` | A file exists | scorecard runs | derived | yes |
| `NO_HIT` | The bureau answered; there is no file | `MANUAL_REVIEW` | `NO_CREDIT_FILE` | **yes** |
| `UNAVAILABLE` | The bureau did not answer | `MANUAL_REVIEW` | `BUREAU_UNAVAILABLE` | no |

A `NO_HIT` is stored twice over: it is evidence of what the bureau actually said,
and it is **reusable** — a second application inside the TTL must not trigger a
second enquiry just because the first one found nothing.

Neither is a decline. `BUREAU_UNAVAILABLE` because a rejection caused by our own
infrastructure is one we could not justify to the applicant, and under ECOA
justifying it is an obligation. `NO_CREDIT_FILE` because an absence of evidence
is not evidence of bad credit, and a first-time borrower is a population a lender
wants.

**A fourth case hides inside `FOUND`.** A report missing a required attribute is
`BUREAU_DATA_INCOMPLETE`, not a zero. Scoring the gap as zero declines a person
for **our** data defect. This is enforced in the type system, not by discipline:
scorecard attributes are `T | undefined`, so the completeness gate cannot be
skipped without the compiler noticing. Bankruptcy and charge-off are `T | null`
instead, where `null` means *none on file* — a fact the bureau reported. Two
different absences, two different types.

---

## 4. Reason codes are derived, never chosen

For each factor, `pointsLost = maxPoints − awarded`. Disclosed codes are the
factors with the largest losses, capped at four, and only those losing at least
five points. Ordering:

1. decisive and referral codes first, in `reasonCodes.registry` order — which is
   why the registry is an ordered list in the policy file and not a set;
2. then scorecard factors by points lost, descending;
3. ties broken alphabetically, so the audit is stable across runs.

**Why derived rather than a hand-written list.** Regulation B's official
commentary describes acceptable methods for choosing the principal reasons in a
credit-scoring system — the factors on which the applicant fell furthest below
the average of applicants who barely qualified, or below the average of all
applicants, or *"any other method that produces results substantially similar"*.
Ranking by points lost against each factor's maximum is that third option in its
simplest form. The cap of four comes from the same commentary: more than four is
unlikely to help the applicant.

**The honest limitation.** A production system would calibrate against the
observed population of marginally-approved applicants, not against each factor's
theoretical maximum. That needs data this service does not have, and it is
recorded as a known gap rather than pretended away.

**Where the cap collides with completeness.** The commentary also insists that no
factor which *was* a principal reason may be omitted, and a cap of four can
collide with that. Under this policy the collision has a precise shape,
established by exhaustive search over reachable award combinations:

| Verdict lands | Max material factors | Non-scorecard code too | Dropped |
|---|---|---|---|
| Score ≥ 70 (D7) | 3 | `AMOUNT_REDUCED_TO_FIT_DTI` or `DTI_ABOVE_LIMIT` | **none** |
| Score 45–69 (D6) | 5 | `SCORE_IN_REFERRAL_BAND` | up to 2 |
| Score < 45 (D5) | 5 | none | up to 1 |

So the case that first looks alarming — a decisive code eating a slot from four
material factors — **cannot occur**: the band granularity makes four material
factors impossible at a score of 70 or above. That is a property of the current
bands, not a law, and the test suite asserts it so a future policy breaks loudly.

---

## 5. An approval on the requested terms carries no reason codes

`reasonCodes: []` is correct, and it is correct for exactly one case.

An approval on the terms applied for is **not adverse action**. There are no
reasons because none exist — not because we failed to find them. Inventing a code
to fill the field would put an unfalsifiable statement into a record built to be
replayed and defended.

A **counter-offer is different**: under Regulation B, credit offered on terms
other than those applied for is a counteroffer, and it becomes adverse action the
moment the applicant declines it. So a reduced-amount approval always carries at
least `AMOUNT_REDUCED_TO_FIT_DTI`.

Both halves are database constraints, not conventions — `migrations/002`. The
second half is why `pre_decisions` duplicates `requested_amount_minor`: a CHECK
cannot reference another table, so without the column the rule could only be a
habit in the engine. ADR-0010 has the full argument and the three rejected
alternatives.

---

## 6. Money

Integers on the wire, decimal internally, and the reverse solve rounds **down**.

The rounding direction is the part to be able to explain. The exact solve in the
worked example is $26,962.54. Rounded to the nearest $100 that is $27,000 — whose
instalment puts the DTI back **over** the limit that produced the offer. The
applicant would be approved for an amount the policy says they cannot afford, by
the very rule meant to keep them under it. Down, always.

Binary floating point is the wrong type here not because it is imprecise in the
abstract but because `26962.539999999997` and `26962.54` round to the same $100
until one day they do not, and the difference is a cent nobody can explain to an
applicant.

---

## 7. Replay, and the four things it must not take from today

Replay re-runs the engine against stored inputs and compares. Each substitution
below is a trap, and three of the four produce **false accusations of tampering**:

| Take from today | What happens |
|---|---|
| Today's policy | Every September decision "fails" once October's rules ship |
| A fresh bureau call | A different report — and a new hard enquiry, placed by the step meant to protect the applicant |
| Today's clock | `screen` derives age at maturity from it; someone who was 74 at maturity becomes an `AGE_ABOVE_MAXIMUM_AT_MATURITY` decline |
| The composed outcome | Every legitimate human override looks like fraud |

So replay uses the stored application, the stored lookup, the policy version
**recorded on the pre-decision**, and `submittedAt` as the clock — and it compares
the **engine's** verdict, never the outcome a reviewer composed. That last one is
the reason ADR-0006 keeps the human's decision in its own table: a design where
the reviewer edits `pre_decisions` makes override and tampering the same database
operation.

An `engineVersion` difference is reported but does not make `match` false on its
own. That is what the column is for.

---

## 8. What the engine is not

- **Not calibrated.** The weights mirror FICO's published composition
  (35/30/15/10/10); the band tables inside each factor are invented. No number
  here is underwriting advice.
- **Not using a bureau score.** We derive our own from disclosed attributes so
  every code points at a stored number a person can check. A composite third-party
  score encodes far more signal, and a production lender would use both — but a
  decline driven by "their score was 612" is a decline we cannot explain in our
  own terms.
- **Not risk-based pricing.** One product, one rate. A rate that varies with the
  score is the natural next step and is not implemented.
- **Not verifying income.** Declared, not verified. Verification belongs to the
  later, out-of-scope part of origination.
- **Not free of ECOA exposure.** Age is kept out of the scorecard entirely, which
  avoids the scoring question. It does not dispose of the knockout question:
  `maxAgeAtMaturity` is a **decline based on age**, applied by an uncalibrated
  system, and that is the more exposed of the two uses rather than the safer one.
  A real deployment needs either demonstrable empirical justification or a
  different mechanism. `docs/03` §4 says so in the same words.

---

## 9. The three questions to expect, and the short answers

**"Why is the scorecard not just the bureau's score?"**
Because a number we cannot explain cannot produce reason codes traceable to facts
we hold. The trade-off is real and is written down: less signal, more
explainability, and a production system would carry both.

**"What happens when two applications for the same person arrive at the same
millisecond?"**
One places the enquiry, the other waits on a claim row and reads the winner's
report. Proven, not argued: six concurrent applications, one hard enquiry, in
`tests/integration/vertical-slice.test.ts`. The claim's weakness — a holder that
is alive but stalled past its lease loses it without knowing — is stated in
`docs/01` §3 along with the fencing that would fix it and the metric that is the
trigger for paying for it.

**"How do I know a decision was not altered afterwards?"**
Three layers, and only two are real defences: the append-only trigger, the hash
chain, and a database role restriction that this deployment cannot apply because
it connects as the database owner. The chain detects an edit; it does **not**
detect tail truncation — delete the last *k* events and what remains verifies
perfectly — and truncation is the cheaper attack and the one an audit looks for.
The mitigation is an external anchor publishing the head hash *and* the event
count, and it is not built. `docs/04` §3 says all of this before anyone asks.
