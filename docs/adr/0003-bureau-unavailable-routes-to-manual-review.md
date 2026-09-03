# ADR-0003: An unavailable bureau routes to manual review, and the application is always persisted

**Status:** accepted · 2026-09-02

## Context

The bureau can time out or be down. Something has to happen. The question is
really two questions, and they are easy to answer as one by accident:

1. Is the application persisted at all?
2. What verdict, if any, is returned?

## Decision

The application is **always** persisted, before the bureau is called. When the
bureau is unavailable, the verdict is `MANUAL_REVIEW` with the reason code
`BUREAU_UNAVAILABLE`, and `status` is `IN_REVIEW`.

## Alternatives

**`DECLINED`.** Fails safe from a credit-risk point of view: no data, no loan.
Rejected on legal and product grounds. Under ECOA a rejection requires a
specific principal reason, and "our vendor was down" is not a reason relating to
the applicant's creditworthiness. It is a rejection we could not justify to the
person it was served to, which makes it the worst of the options rather than the
most conservative.

**`503`, nothing persisted.** Honest in one respect — we did not decide, so we
should not pretend to have decided. Rejected because it answers the wrong
question: not deciding is defensible, discarding the application is not. An
application is a business event that marketing paid to acquire. Throwing it away
loses the funnel number, leaves support blind when the person calls, and removes
the record that we already tried — which the deduplication in ADR-0002 relies
on.

**Persist, and return `503` for the decision.** A coherent middle position, and
the one this decision borrows the persistence half from. Rejected for the
response because the brief asks for a verdict with reason codes, and
`BUREAU_UNAVAILABLE` is exactly the reason code that situation calls for. It
also leaves the applicant with nothing actionable, whereas a referral gives them
"we will come back to you today".

**Persist as `PENDING` and retry in the background.** The right answer at scale.
Rejected for v1 because it requires the asynchronous path the synchronous API
does not otherwise need, and the manual-review queue already provides a human
fallback.

## Consequences

- A bureau outage converts directly into underwriter workload. The manual-review
  share is therefore the primary alert, not the error rate.
- `MANUAL_REVIEW` must be a non-terminal state, which is what gives the status
  endpoint its purpose in an otherwise synchronous API.
- A pre-decision row exists with no `bureau_report_id`, so replay of it can
  confirm only the referral, not a score. Recorded as expected behaviour rather
  than a defect.
- This decision covers `UNAVAILABLE` only. A **no-hit** — the bureau answered and
  the person has no file — is a different fact, is stored as evidence, and
  carries `NO_CREDIT_FILE`. Collapsing the two would tell a genuine first-time
  borrower that our vendor was down. See `docs/08-mock-bureau.md` §2.
