# ADR-0004: The decision engine is a pure function over a versioned policy

**Status:** accepted · 2026-09-02

## Context

Decisions must be auditable — meaning explainable a year later, after the rules
have changed and the code has moved on. The obvious implementation puts the
rules in a service that reads thresholds from configuration, queries the bureau
when it needs data, and stamps `new Date()` on the result.

That implementation cannot be replayed, and therefore cannot be audited in any
sense stronger than "we wrote down what we concluded".

## Decision

```
screen(application, policy, now)          -> Knockout | null
decide(application, lookup, policy, now)  -> PreDecision
```

No I/O, no clock, no ambient state. The split at the bureau call is ADR-0006's
sibling decision and is argued in `docs/01-architecture.md` §1: an eligibility
knockout that needs no bureau data must be able to fire *before* a hard enquiry
is recorded against the applicant's file, and a single `evaluate(...)` taken
after the pull cannot express that. The policy is a versioned document passed
in. Every pre-decision records the `policy_version`, the `engine_version` and the
`bureau_report_id` it was evaluated against.

Reason codes are **derived**, not curated: each scorecard factor contributes
`pointsLost = max − awarded`, and the disclosed codes are the largest losses,
capped at four.

## Alternatives

**A service class that fetches what it needs.** Conventional and comfortable.
Rejected because replay becomes impossible: re-running it would query today's
bureau and today's thresholds, so a mismatch would prove nothing.

**Thresholds as environment variables.** Simple. Rejected because a decision
would then reference a configuration state that is not recorded anywhere; two
decisions with the same "version" could have been made under different numbers.

**Hand-picked reason codes per rule.** What most implementations do. Rejected
because the disclosed reasons can then drift from the factors that actually
moved the outcome, and Regulation B's commentary requires that no factor which
was a principal reason be omitted. Deriving them by points lost is, in the
commentary's own framing, a method producing results substantially similar to
the sanctioned ones — and it cannot drift, because there is nothing to curate.

**A trained model.** Higher accuracy, and the direction the industry has gone.
Rejected for v1: it makes per-applicant explanation a research problem rather
than an arithmetic one, which is the opposite of what "auditable" asks for here.

## Consequences

- `POST /v1/audit/pre-decisions/{id}/replay` is possible, and it is the strongest
  evidence the service offers that its decisions are genuinely reproducible.
- Rule tests need no database and run in milliseconds.
- The engine cannot fetch anything it was not given, so the orchestration layer
  has to assemble the inputs. That is a small ongoing cost paid on every new rule.
- Old policy files must never be deleted, which ADR-0005 makes a rule.
