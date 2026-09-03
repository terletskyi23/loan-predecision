# ADR-0010: An approval on the requested terms carries no reason codes

**Status:** accepted · 2026-09-03

## Context

`migrations/001_init.sql` states one rule for all three verdicts:

```sql
CONSTRAINT pre_decisions_reason_codes_capped CHECK (
  cardinality(reason_codes) BETWEEN 1 AND 4
)
```

and explains it as "the rule that a verdict always carries at least one reason.
A decision with no disclosed reason is not a decision anyone can be told about."

That sentence is true of `DECLINED` and of `MANUAL_REVIEW`. It is false of an
approval on the terms applied for, and the counter-example is documented rather
than hypothetical. `docs/08-mock-bureau.md` §4 binds profile `PRIME` to
identifier `900-55-0601` and promises "approved in full". Its scorecard is
100/100, so every factor loses zero points and none clears
`reasonCodes.materialPointsLost` (5). No counter-offer is made, so the only
`APPROVED`-verdict code in `reasonCodes.registry` —
`AMOUNT_REDUCED_TO_FIT_DTI` — does not apply. `decide(...)` therefore returns an
empty list, and the `INSERT` fails a check constraint while the engine is behaving
exactly as `docs/03-decision-policy.md` §3 specifies.

The defect was invisible for a reason worth recording: `docs/05-api.md` carries
six worked response examples and not one of them is a plain approval. Every
documented path had at least one reason code, so the constraint looked total.

Two further facts shaped the resolution rather than merely the diagnosis:

- **A CHECK cannot see another table.** The invariant that carries legal weight
  is not "an approval may be empty" but "an approval at a *reduced* amount may
  not be" — a counteroffer is adverse action under Regulation B the moment the
  applicant declines it. Deciding whether an amount was reduced needs
  `applications.requested_amount_minor`, which `pre_decisions` cannot reference.
- **`001_init.sql` cannot be amended.** `src/db/migrate.ts` records a SHA-256 of
  every applied file and refuses to proceed when one has changed, precisely so
  that environments cannot diverge. Editing 001 would fail the next deploy of
  the live service rather than fix the schema.

## Decision

The rule is verdict-dependent, and it is stated that way in
`migrations/002_reason_codes_depend_on_verdict.sql`:

| Constraint | Rule |
|---|---|
| `pre_decisions_reason_codes_capped` | At most four codes, for every verdict |
| `pre_decisions_adverse_action_has_reasons` | `DECLINED` and `MANUAL_REVIEW` carry at least one |
| `pre_decisions_counter_offer_has_reasons` | An `APPROVED` for less than was requested carries at least one |

`requested_amount_minor` is duplicated onto `pre_decisions` so the third one can
exist. Both rows are written once and never updated, so the copies cannot drift;
this is duplication for expressiveness, not for speed.

The engine's contract is unchanged: an approval on the requested terms returns
`reasonCodes: []`, and the API serialises the empty array rather than omitting
the field.

## Alternatives

**Introduce an `APPROVED_AS_REQUESTED` code of a new `INFORMATIONAL` class.**
Rejected. It is a reason assigned rather than derived, which is the hand-curated
list ADR-0004 exists to refuse; the code points at no stored fact an applicant
could check. It also discloses something to an applicant who is owed no
disclosure, and `docs/07-testing.md` §7 walks the registry to prove every code is
reachable — this one would need a hand-written exemption, which is the shape of
a rule that later gets broken quietly.

**Have `decide` disclose the top scorecard factors even when they are
immaterial.** Rejected, and it is the worst of the three. A "reason" that cost
zero points is a false statement inside an audit record designed to be replayed
and defended. It also converts `materialPointsLost` from a threshold into a
threshold-with-an-exception, and `docs/03-decision-policy.md` §3 would no longer
describe a mechanism.

**Relax the constraint to `<= 4` and stop there.** Rejected as insufficient
rather than wrong. It permits a counter-offer with no codes — the one case where
the disclosure is legally load-bearing. The current engine always emits
`AMOUNT_REDUCED_TO_FIT_DTI` there, so nothing would break today; but
`001_init.sql` opens by arguing that "the logic verifies it" is a race and "the
database will not allow it" is a proof, and this variant quietly moves the
counter-offer rule from the second category to the first.

**Leave the counter-offer half as a documented weakness, guarded by a unit
test.** Genuinely considered, because `docs/01-architecture.md` §3 already names
one guarantee — the pull claim's lease — as deliberately weaker than the rest,
and naming a limitation is better than hiding it. Rejected because the honesty
argument stops scaling at one. A schema with a single stated weakness reads as
judgement; a schema with two reads as a pattern, and the second one would sit on
the only invariant here with a statutory consequence. One column is a cheaper
answer than that paragraph.

## Consequences

- `pre_decisions` has five constraints where it had four.
  `docs/01-architecture.md` §3 is updated.
- `reasonCodes: []` is now a documented response shape. `docs/05-api.md` gains
  the full-approval example whose absence hid this, and `openapi.json` is
  regenerated.
- The engine may return an empty list. `screen` and `decide` are still to be
  written, so this lands as a specification rather than as a change.
- `requested_amount_minor` exists in two tables. A future writer of a
  pre-decision must copy it from the application rather than accept it from a
  caller; the audit listing endpoint (`docs/05-api.md` §6.4) gets to show
  requested against approved without a join, which is a side benefit and not the
  reason.
- If a later policy introduces up-selling, `pre_decisions_counter_offer_has_reasons`
  admits it without demanding invented reasons, and that decision gets its own ADR.
