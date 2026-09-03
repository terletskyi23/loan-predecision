# ADR-0001: Postgres is the only datastore

**Status:** accepted · 2026-09-02

## Context

The service must guarantee that a duplicate submission produces no duplicate
bureau enquiry, that a decision and its audit trail are written together or not
at all, and that concurrent requests cannot both take the same action. It also
needs a lock with a lease, and a short-lived record of idempotency keys.

Those are four different jobs, and there is a standing temptation to reach for a
different tool for each: a cache for reuse, Redis for the lock, a broker for
async work, a document store for the audit trail.

## Decision

One Postgres database does all four: state, uniqueness, the audit chain, and the
coordination lease. One Node process talks to it. No cache, no broker, no second
store.

## Alternatives

**Redis for the pull lock.** Fast and idiomatic. Rejected because the claim and
the report it produces would then live in two systems with no shared
transaction — the exact distributed-transaction problem the design exists to
avoid. A lock that can succeed while the write it protects fails is not a lock.

**A message broker for the bureau call.** Would decouple the latency nicely, and
is the right answer eventually. Rejected for v1 because the brief asks for an
*instant* decision, and because introducing a broker before the synchronous path
stops fitting the latency budget is the textbook shape of premature
infrastructure.

**A document store for the audit trail.** Appealing for append-only data.
Rejected because the audit write has to be in the same transaction as the
decision write, and that forces them into the same store.

**SQLite.** Would let the repository run with no external service, which is
genuinely valuable for a reviewer. Rejected because the deployed instance would
then keep audit data on an ephemeral filesystem, and because the concurrency
tests that matter here need real connection-level concurrency. `docker compose`
covers the reviewer's convenience instead.

## Consequences

- Every correctness guarantee is a constraint in one place, and can be pointed at.
- The synchronous bureau call holds a pooled connection for its duration. At the
  assumed volume this is fine; it is the first thing that breaks at ten times
  the load, and `docs/01-architecture.md` §5 names the trigger for changing it.
- Running the test suite requires Postgres. `docker compose up -d db` is a
  prerequisite, documented in the README.
