# ADR-0007: Consent is recorded as a caller attestation, not modelled as a service

**Status:** accepted · 2026-09-03

## Context

The whole design rests on performing a hard credit enquiry. Under FCRA a
consumer report requires a permissible purpose and, in practice, a captured
authorisation from the applicant. The earlier design had no consent field, no
consent event in the audit chain, and no mention of FCRA at all — while citing
ECOA five times.

That left a contradiction inside our own documents. The stated reason for
authenticating the submission endpoint is that an open one "would let anyone
submit other people's identifiers and mark their credit files". So the design
already claims to care about exactly this harm, while holding no artefact that
the applicant authorised the pull.

The brief puts the KYC UI and the frontend out of scope, so consent capture —
the disclosure text, the checkbox, the record of what was shown — genuinely
happens somewhere this service does not reach.

## Decision

The request carries a required `consent` block:

```
consent.attestedByCaller : boolean, must be true
consent.acceptedAt       : timestamp, in the past, no older than
                           policy.consent.maxAgeHours
```

Both are validated before any row is written or any bureau call is made. The
attesting party is `applications.client_id`, derived from the bearer token and
never from the body. `APPLICATION_RECEIVED` carries the attestation in its audit
payload.

What is recorded is **who claimed the applicant authorised this, and when**.
`docs/00-scope.md` A11 states the residual gap in those words.

## Alternatives

**A full consent model** — `disclosureVersion`, a catalogue of versioned
disclosure texts, a consent lifecycle. What a real lender needs. Rejected
because a version pointer implies a catalogue this service does not have and will
not build; the field would look like evidence and hold none. Inventing a model
with no product input is the over-engineering this design criticises elsewhere.

**A fake consent service, alongside the fake bureau.** Superficially consistent —
if we mock one dependency, why not the other? Rejected because the two are not
alike. The bureau is an explicit build item of the brief, and its **failure
modes shape the design**: timeouts, retries, deduplication, and the whole
`MANUAL_REVIEW` path exist because the bureau can fail. A consent service that
always answers "yes" has no interesting failure mode, changes no code path, and
tests nothing. It would be a stub built to look thorough.

**Declare consent entirely out of scope.** Cheapest and honest about the
boundary. Rejected because it leaves the contradiction with our own auth
rationale unresolved, and because the cost of the alternative is two fields.

**Treat the attestation as sufficient and say so.** Rejected on the substance:
under FCRA the permissible purpose belongs to the party performing the pull. It
can be pushed to an integrator by contract; it cannot be delegated away by API
design. Writing "the caller confirmed consent, so we are covered" would be the
kind of claim that reads as compliance theatre to anyone who knows the statute.

## Consequences

- Two required fields, one audit payload, one policy number. That is the entire
  cost.
- `acceptedAt` is bounded by a policy value rather than an environment variable,
  because how stale an authorisation may be is a risk decision, like the bureau
  reuse TTL — and it belongs beside it.
- The service can answer "who told us this person authorised an enquiry, and
  when" and cannot answer "did they". The second is recorded as a named gap in
  `docs/06-failure-modes.md`, not implied to be covered.
- If a real deployment ever needs the stronger artefact, the shape is a
  `disclosureVersion` plus a stored copy of what was shown — additive, and it
  does not disturb anything decided here.
