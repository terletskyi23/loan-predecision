# ADR-0008: The layer boundary is enforced by a lint rule, not a DI container

**Status:** accepted · 2026-09-03

## Context

`docs/01-architecture.md` §1 states that the domain layer "may call nothing",
and three of the design's strongest claims rest on it: rules testable without a
database, decisions replayable years later from stored inputs, and nothing in
the rules able to depend on wall-clock time or arrival order. ADR-0004 makes the
same point from the other side.

A sentence in a document is not an enforcement mechanism. The first `import` of
`pg` into a scorecard file — added in a hurry, to fetch "just one thing" —
silently converts the audit claim from true to aspirational, and nothing fails.

## Decision

The boundary is an ESLint `no-restricted-imports` block scoped to
`src/domain/**`. It refuses imports of `pg`, `fastify`, `pino`, `prom-client`,
anything under `src/db`, `src/http`, `src/bureau`, `src/services`, and every
`node:*` builtin — the last so that a clock, a filesystem read or a hash cannot
appear in a function whose testability depends on receiving them as arguments.

Each restriction carries the message that names the document it protects, so a
developer who hits it is told why rather than merely stopped.

Composition happens in one place: a root that builds the infrastructure, wires
it into the services, and passes plain values into the domain.

`npm run lint` therefore exists and runs in CI, which `docs/07-testing.md` §8
previously said it would not. Lint here is not a style step; it guards exactly
one architectural invariant, and that is the whole reason it earns a place in
the build.

## Alternatives

**NestJS, with its DI container.** Genuinely attractive: the container makes the
layering structural, guards map cleanly onto the three auth scopes, and the
author is fluent in it. Rejected on two grounds. First, the brief says "Keep the
implementation small", and a DI container, module graph and decorators are a lot
of structure for a service with two write endpoints — the reading a reviewer
would give it is over-engineering, and that reading would be fair. Second, and
more decisive: a container *permits* the boundary to be respected; it does not
prevent a domain file from importing `pg` directly. It buys less of the thing
being protected than the lint rule does, at considerably higher cost.

**A separate package or workspace for the domain, with no dependency on the
rest.** The strongest possible enforcement — the import would not resolve.
Rejected because a package boundary inside a repository this small means a build
step, a second `package.json` and a publish story for one directory, and the
reviewer has to understand the workspace before reading any code.

**Convention plus code review.** What most projects do. Rejected because it is
what the previous version of this design already had, and the whole point of
writing the rule down was that documents drift and builds do not.

**Nothing — trust the tests.** No test can catch it. A domain function that
opens its own connection still returns the right answer in unit tests; it fails
only later, in replay, years after the decision it made.

## Consequences

- The claim "the domain calls nothing" is checkable in about a second, by
  anyone, without reading the code.
- Adding a legitimate domain dependency now requires editing
  `eslint.config.js` — a deliberate act, visible in the diff, and the right
  amount of friction.

  **Amended in phase 3, because as first written this consequence was not
  true.** The rule was a denylist: it named `pg`, `fastify`, `pino`,
  `prom-client`, four directories and `node:*`. Everything it had not thought of
  was permitted, so `import axios from 'axios'` in a scorecard file passed
  silently — and an HTTP client in the domain is the exact failure the boundary
  exists to prevent. It now forbids every bare package import and names the two
  the domain may have: `zod`, which validates a value already in memory, and
  `decimal.js`, which is arithmetic. Neither reads a clock, a file or a socket,
  which is the only property being protected. The change also closed
  `src/config.ts`, `src/logger.ts` and `src/metrics.ts`, which the directory
  patterns had missed: a domain function that reads configuration has taken a
  dependency on the environment it runs in and is no longer replayable from
  stored inputs.

  Recorded here rather than quietly fixed, because the gap is the more
  instructive artefact: a rule written to enforce a boundary enforced a list.
- A lint step exists in CI. `docs/07-testing.md` §8 is updated accordingly.
- The composition root is hand-written. That is a small ongoing cost paid every
  time a new dependency is introduced, and it is the cost NestJS would have
  removed.
