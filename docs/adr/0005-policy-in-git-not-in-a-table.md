# ADR-0005: The lending policy lives in git, not in a database table

**Status:** accepted · 2026-09-02

## Context

Thresholds, scorecard bands and product limits have to be changeable without a
code change, and every decision has to be replayable against the exact version
it was made under.

## Decision

Policies are JSON documents in `policies/<version>.json`, validated by schema at
boot. The active version comes from configuration. Old versions are **never
deleted** — the directory is append-only by rule. The loader sits behind an
interface.

## Alternatives

**A `policies` table with a JSON column.** What a mature lender runs, and the
obvious "make it configurable" answer. Rejected for v1 because changing a
lending policy is a risk decision, not a configuration tweak, and a row can be
changed by anyone holding a connection string with no review and no attribution.
Git supplies review, authorship, history, diff and rollback for free — which is
exactly the approval workflow a production policy table has to be given
separately before it is safe.

**Environment variables.** Rejected in ADR-0004: a decision would reference a
configuration state recorded nowhere.

**A rules DSL or an engine like json-rules-engine.** More expressive. Rejected
because the expressiveness would be spent on rules we do not have, and because
a hand-written evaluator over a small band table is something a reviewer can
verify by reading it.

**Keeping only the current policy file.** Tempting, and wrong. Deleting an old
version silently breaks every replay that depends on it, and the breakage is
only discovered when an auditor asks about an old decision — the worst possible
moment.

## Consequences

- A policy change is a pull request, which is the correct amount of friction.
- Changing policy requires a deploy. Acceptable at this stage; the moment risk
  needs to move a threshold without engineering, the loader interface is
  swapped for a table adapter and an approval workflow is built on top.
- The policy directory grows without bound. This is intentional and cheap: the
  files are kilobytes, and each one is the only thing that can explain the
  decisions made under it.
- A test asserts that every historical policy file still parses and validates,
  so a schema change cannot quietly orphan old decisions.
