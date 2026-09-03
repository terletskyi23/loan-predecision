# 04 — Audit and data retention

"Auditable" is not a logging requirement. It is the ability to answer specific
questions, from specific people, long after the code and the rules have changed.

---

## 1. The questions the audit has to answer

| Who asks | Question |
|---|---|
| The applicant | "Why was I declined?" — a right under ECOA, not a courtesy |
| A regulator | "Show how this pre-decision was reached in September" |
| A risk manager | "The new policy moved declines by 8%. What changed?" |
| Security | "Could anyone have altered a verdict after the fact?" |
| Support | "The customer says they applied twice. What do we see?" |
| Compliance | "Who told us this person authorised a credit enquiry, and when?" |

Every design choice below exists to answer one of those. A design that only
produces log lines answers the fifth one, badly, and none of the others.

---

## 2. What is stored, and why each piece is required

A pre-decision is reproducible only if all four are present:

| Stored | Without it |
|---|---|
| The application inputs, as submitted | You cannot recompute anything |
| An immutable snapshot of the bureau lookup | You cannot say what data the decision was based on — and with report reuse, you cannot even say *when* that data was pulled |
| The `policy_version` | After the rules change, the verdict becomes unexplainable: the codes no longer correspond to any live threshold |
| The `engine_version` | A code change that alters arithmetic becomes indistinguishable from tampering |

Only the last two are columns on `pre_decisions`. The inputs live on
`applications` — including the `finances` column, deliberately outside the
erasable `applicant` blob — and the snapshot lives on `bureau_reports`, reached
by `bureau_report_id`, because `docs/01-architecture.md` §3 keeps evidence and
coordination in separate tables on purpose.

The criterion is therefore **"every input the engine reads is stored somewhere
replay can reach"**, not "everything is a column on one table", and
`docs/07-testing.md` §7 checks it in that form. The stricter-sounding wording is
worse than useless: an earlier draft asserted all four were columns on
`pre_decisions`, which was false for two of them, and the check written against
that claim would have passed while the schema had no home for declared income at
all.

The second one is forced by the deduplication design. Once a report can be
reused across applications, "we stored the verdict and its reason codes" stops
being enough: a pre-decision may rest on data pulled twelve minutes earlier for a
different application, and nothing in the row would say so. Hence
`bureau_report_id` and `bureau_report_reused`.

### The consent record

`consent_attested` and `consent_accepted_at` sit on the application, and the
client that attested is `applications.client_id`. Together they answer the
compliance question above — **who claimed what, and when** — and nothing more.

**On a reused report the answer comes from the report, not the application.**
Reuse crosses client boundaries by design, so the client whose attestation caused
an enquiry is frequently not the client whose application is being decided —
`bureauReportReused: true` is the ordinary case, not an edge one. Hence
`bureau_reports.attested_by_client_id` and `caused_by_application_id`: the
enquiry was made under one client's asserted purpose, and a second client's
decision rests on it. Both facts are recorded, and ADR-0002 states the exposure
that recording them makes visible rather than removes.
`docs/00-scope.md` A11 states the residual gap plainly: an attestation is not
proof the applicant consented, only evidence of who asserted it. ADR-0007 covers
why this service records an attestation rather than modelling consent capture.

---

## 3. The event chain

Every application carries an append-only sequence of events:

```
hash[i] = sha256( hash[i-1] ‖ canonicalJson(event[i]) )
```

with `hash[-1]` a fixed genesis constant. Events are keyed
`(application_id, chain_index)`, so a concurrent double-append violates the
primary key rather than silently forking the chain.

| Event | Emitted when |
|---|---|
| `APPLICATION_RECEIVED` | The row is inserted, with the consent attestation in the payload |
| `SCREENING_FAILED` | An eligibility knockout fired **before** any bureau call |
| `BUREAU_PULL_REQUESTED` | A claim was won and a network call is about to happen |
| `BUREAU_REPORT_ATTACHED` | A report is bound to this application, with `reused` and `outcome`. Named *attached*, not *stored*: on the reuse path nothing is written, and an event that describes a write that did not happen is the beginning of an audit trail nobody trusts |
| `BUREAU_UNAVAILABLE` | The lookup failed, with `cause` ∈ `TIMEOUT`, `SERVER_ERROR`, `RETRIES_EXHAUSTED`, `WAIT_EXPIRED` |
| `PRE_DECISION_MADE` | The engine returned a verdict |
| `REVIEW_OPENED` | The verdict was `MANUAL_REVIEW` |
| `REVIEW_CLOSED` | A human recorded an outcome, with `reviewer_id` |
| `APPLICATION_ABANDONED` | The sweeper closed an orphan |

### Events are appended in three transactions, not one

`APPLICATION_RECEIVED` is appended with the application insert.
`BUREAU_PULL_REQUESTED` is appended **before** the network call. Everything from
`BUREAU_REPORT_ATTACHED` onward is appended in the closing transaction alongside
the pre-decision.

That split is deliberate. Deferring the pull event to the end would mean a
process dying mid-call leaves no record that this person's credit file was
marked — the exact harm `docs/02-idempotency.md` §1 exists to prevent, erased by
the crash that caused it. What is atomic is the pre-decision and its *closing*
trail, not the chain as a whole; `docs/06-failure-modes.md` states the
transaction boundary in those terms.

The chain is scoped **per application**, not globally. A global chain would
serialise every write in the service through one tail pointer; per-application
chains are independent, and all writes for one application already happen inside
that application's transaction.

### Enforcement

Three layers, and only the first two are real defences:

1. The application's database role holds no `UPDATE` or `DELETE` privilege on
   `audit_events`.
2. A trigger raises on either statement, so a migration run as a more privileged
   role does not quietly open the door.
3. The hash chain detects an alteration that got past both.

**Honest limits — three of them, and the cheapest attack is not the obvious one.**

1. **Consistent rewrite.** Someone with full database access can recompute every
   hash after an edit. The chain will verify.
2. **Tail truncation, which needs no recomputation at all.** Delete the last *k*
   events and what remains verifies perfectly. `GET /…/chain` returns
   `chainIntact: true` with a lower `events` count and nothing to compare that
   count against. Dropping `PRE_DECISION_MADE` and `REVIEW_CLOSED` is precisely
   the alteration an audit looks for, and it is strictly easier than a rewrite.
3. **Chain substitution.** `application_id` and `chain_index` are part of the
   row key but are hashed as part of the event payload, not merely alongside it,
   so one application's chain cannot be transplanted onto another's. Stated
   because the formula above does not make it obvious.

The mitigation for the first two is the same and is not built: an anchor outside
the database, publishing the head hash **and the event count** somewhere the
lender does not control. Naming only the rewrite, as an earlier draft did, made
the "honest limit" itself incomplete — and this is a section whose whole value is
that it is complete.

---

## 4. Replay: the part that makes it verifiable

`POST /v1/audit/pre-decisions/{applicationId}/replay` re-runs the engine against
the stored application, the stored bureau lookup, **the policy version recorded
on the pre-decision**, and **`applications.submitted_at` as `now`** — never
today's policy, never a fresh bureau call, and never today's clock.

The clock is not a detail. `screen()` derives age and age at maturity from `now`;
replayed with the wall clock years later, an applicant who was 74 at maturity
recomputes as `AGE_ABOVE_MAXIMUM_AT_MATURITY` and the endpoint reports tampering
where there is none. `submitted_at` is the instant the verdict was formed
against, so it is the instant replay must use.

Two outcome classes need their behaviour stated rather than inferred:

- **S1 declines.** No bureau call was made, so there is no lookup and `decide`
  never ran. Replay re-runs `screen` alone and compares the knockout.
- **`BUREAU_UNAVAILABLE` referrals.** `bureau_report_id` is null, so replay
  passes the recorded lookup failure — its `cause` is stored on the
  pre-decision, not only in an audit payload — and confirms the referral. It
  cannot confirm a score, because none was computed. ADR-0003 records this as
  expected rather than as a defect.

The response returns both, a `match` flag, and the full scorecard breakdown:
every factor, its input, points awarded and points lost. An auditor can follow
the arithmetic from raw bureau attributes to the final reason codes without
reading any source.

### What replay compares, and what it deliberately ignores

Replay compares the recomputed verdict against `pre_decisions.verdict` — **the
engine's verdict**. It never compares against a human's outcome.

This is not a detail. An earlier version of this design stored one verdict per
application and let a human's decision overwrite it, which meant every referred
application closed by an underwriter would replay as `MANUAL_REVIEW` against a
record saying `APPROVED`, and report `match: false`. The endpoint whose entire
job is to surface tampering would have fired on the single most ordinary event
in the business. ADR-0006 is the fix: the human outcome is a different row, made
by a different actor, on evidence this service does not hold.

So `match: false` means one of a **short, closed list**, and every item on it is
worth an incident:

- the stored evidence was altered;
- a code change broke reproducibility without bumping `engine_version`;
- a policy file was edited in place rather than superseded (`docs/03` §6 removes
  the exception that used to permit this);
- a convention the engine depends on but does not version changed — canonical
  JSON ordering, or the money rounding rule in `docs/05-api.md` §1.

A legitimate human override is **not** on that list and cannot be mistaken for
one: replay compares the engine's verdict, and the human's outcome lives in a
different table. That was the point of ADR-0006. The last two items are the ones
an earlier draft's "exactly one of two things" quietly excluded — both are real,
both produce `match: false`, and an auditor told there are only two causes will
chase the wrong one.

It works only because the engine performs no I/O. That is the practical payoff of
the layering rule in `docs/01-architecture.md` — the purity is not an aesthetic
preference, it is what buys verifiability.

### Who may call it

`/v1/audit/*` sits behind a separate `AUDITOR_TOKENS` scope. A submitting client
cannot enumerate pre-decisions; an auditor cannot submit applications.
Applicants never touch these endpoints — they receive their own reasons through
the normal status response.

Listed pre-decisions carry no names and no contact details: application id,
verdict, codes, score, policy version, and the subject key.

**The subject key is not anonymous, and the listing does not pretend otherwise.**
It is a keyed hash: stable, and therefore capable of linking every application by
one person across the whole book. That linkage is the point — "did this person
apply eleven times this week" is an audit question — but it makes the export
pseudonymous personal data, not de-identified data. It is scoped to the auditor
token and covered by the same retention rules as everything else, and calling it
"no personal data" would have been the comfortable and wrong description.

---

## 5. Retention: four classes, different rules

Conflating these is a common and expensive mistake.

| Class | Tables | Rule |
|---|---|---|
| **Evidence** | `applications`, `pre_decisions`, `bureau_reports`, `audit_events` | Written once. Never updated, never deleted in v1. The floor that actually applies to these records is Regulation B §1002.12(b) — **25 months** for consumer credit applications. Longer periods usually come from other obligations (tax, AML, litigation hold) rather than from ECOA, and the real number is set with compliance, not chosen here |
| **Outcome** | `reviews` | Written once, closed once. Same retention as evidence: a human's verdict on a credit application is exactly the record a regulator asks for |
| **Coordination** | `bureau_pull_claims` | Cleared as soon as the claim closes. No history worth keeping |
| **Operational** | `idempotency_keys` | Purged after `IDEMPOTENCY_RETENTION_HOURS` (default 24). Not audit data |

### `expires_at` governs reuse, not deletion

`bureau_reports.expires_at` means "too old to base a **new** pre-decision on".
The row itself lives forever, because it is the evidence for the decisions that
already used it. Deleting expired reports would silently break every replay that
depends on them — which is why the reuse lookup filters on `expires_at` and no
job ever deletes by it.

### A new application never supersedes an old one

One person may have many applications, each with its own pre-decision. There is
no "current state of the customer" anywhere in this service. Status is always
per-application-id.

### Room for pseudonymisation later

Personal fields (name, contacts) live in an `applicant` JSON column on
`applications`; the pre-decision, its codes and the bureau snapshot live
elsewhere. That separation means a future erasure or pseudonymisation job can
clear the identifying column **without destroying the auditability of the
decision**.

The national identifier is never stored — only the keyed hash derived from it.
It exists in memory for the duration of the bureau call, because the provider
needs the real identifier to find the file, and it is neither persisted nor
logged. Rotating `SUBJECT_KEY_PEPPER` makes previously stored subject keys
unlinkable to newly derived ones, so it is a long-lived secret, and rotating it
is a migration, not a config change.

Pseudonymisation is not implemented in v1. The point is that the schema does not
block it.

---

## 6. Logging, and what must never appear in it

Structured JSON via `pino`. Every line carries `correlationId`,
`applicationId`, `clientId`, `policyVersion`, and `subjectKeyPrefix` — the first
eight characters of the hash, enough to correlate, not enough to identify.

Never logged: the national identifier, full name, contact details, or the raw
bureau payload. Redaction is configured on the logger's serialisers, not left to
discipline at each call site — because sooner or later somebody logs the whole
object.

The correlation id is returned in the `X-Correlation-Id` header and repeated in
every error body, so a customer can quote it and support can find the request.
That closes the support question from §1 without giving anyone a reason to log
personal data to make it findable.
