# ADR-0002: Deduplication is layered, and the bureau pull is the layer that matters

**Status:** accepted · 2026-09-02

## Context

The brief says duplicate submissions must not create duplicate bureau work, and
is the only requirement carrying "design and document your approach". It does not
define "duplicate".

A hard credit enquiry costs money and is recorded on the applicant's file, where
other lenders can see it and where it can lower their score. So a duplicated
pull does not merely waste an API call; it harms a person who did nothing wrong.

## Decision

Treat this as four separate problems and solve them in different places:

1. **Transport** — the same HTTP request twice: `Idempotency-Key` with a unique
   constraint, replaying the stored response.
2. **Domain** — the same application twice with no key: *not implemented* (see
   Alternatives).
3. **External effect** — two genuinely different applications from one person:
   report reuse within a TTL, plus a claim row with a lease that collapses
   concurrent pulls into one.
4. **Delivery** — our own retry of an outbound call: one stable request id per
   logical pull, not per attempt.

Layer 3 is keyed on a hash of the **national identifier**, never on
`customerId` or the application.

## Alternatives

**One idempotent endpoint and stop there.** The common reading. Rejected because
it leaves layer 3 untouched: a person declined at $32,000 who reapplies at
$20,000 sends a different body with a different key, and would be pulled twice.
That case is the requirement.

**Natural-key deduplication (layer 2).** Same person, product, amount and term
inside a window. Rejected: two keyless submissions genuinely are two
applications, and any window boundary behaves arbitrarily — two submissions a
minute apart either side of a boundary get treated differently from two twelve
hours apart inside one. The cost of omitting it is bounded to an extra row,
never an extra pull.

**Keying reuse on `customerId`.** Rejected on three grounds, worst last: most
pre-decision applicants have no account; one person can hold two accounts; and
**one account can be shared by two people**, which would mean deciding one
person's application on another person's credit history.

**In-process map of in-flight pulls.** Works on one instance, silently stops
working on two, and the failure is invisible in testing.

**`pg_advisory_xact_lock`.** Correct and simpler, but holds a pooled connection
for the whole external call.

## Consequences

- The strongest guarantee holds even when the caller sends no idempotency key.
- **Reuse crosses client boundaries, and that is an open position rather than a
  closed one.** The aggregator case above is the reason layer 3 exists, so the
  client deciding on a report is frequently not the client whose consent
  attestation caused the enquiry. `bureau_reports.attested_by_client_id` and
  `caused_by_application_id` record which is which, so the audit question "who
  told us this person authorised an enquiry" has a correct answer on a reused
  report. What the columns do **not** do is resolve the underlying question: an
  enquiry made under integrator A's asserted permissible purpose is being used
  to decide integrator B's application. Scoping reuse per client would remove it
  and would also remove the aggregator saving this ADR exists to capture —
  duplicating the hard pull on the applicant's file to tidy the paperwork, which
  is the wrong trade in a design whose first principle is not harming the
  applicant. Recorded, made visible, and referred to compliance rather than
  settled here.
- The claim table is a **lease, not a constraint.** It prevents two callers
  holding the claim at once; it does not make two pulls impossible.
  `docs/01-architecture.md` §3 names what fencing would cost, why v1 does not pay
  it, and the residual harm.
- A claim table and a lease are extra machinery — roughly sixty lines — and a
  crashed holder delays exactly one applicant by the lease duration.
- the reuse ratio becomes a first-class signal — derived from
  `bureau_lookups_total{result}` rather than exported as a gauge, because a ratio
  is a query and exporting it would fix the denominator at scrape time. It is the
  only signal that
  would move if this stopped working.
