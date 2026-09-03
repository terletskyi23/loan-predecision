# ADR-0009: The OpenAPI document is generated from the route schemas, and the UI is public

**Status:** accepted · 2026-09-03

## Context

`docs/05-api.md` is the API contract, and it is better documentation than
OpenAPI can be: it carries worked examples with real arithmetic, the reasoning
behind each error code, the three-identities table, and the argument for
returning `404` rather than `403` on another client's application. A schema
format carries none of that.

So "we need documentation for the endpoints" was not the reason to add this.
Two other things were:

**Prose drifts from code; a generated artefact under a diff check does not.**
This is the same argument the rest of the design rests on — a check in
application code is a convention, a constraint in the database is a proof — and
it applies to the contract as much as to the schema.

**A live URL deserves a client.** The brief asks for a deployed service. A
reviewer with an interactive page exercises it in a minute; a reviewer with a
markdown file writes `curl` commands or does not bother.

## Decision

One zod schema per route produces three things: request validation, TypeScript
types, and the OpenAPI document. `fastify-type-provider-zod` does the
conversion; `@fastify/swagger` collects the routes; `@fastify/swagger-ui` serves
the page at `/docs`.

`openapi.json` is **committed**, and `npm run openapi:check` regenerates it and
fails on any diff. A route added without a schema, or a schema changed without
regenerating, is a red build. A test additionally asserts that every path in the
document appears in `docs/05-api.md` §2 — a route nobody wrote down is the drift
that costs someone an afternoon.

That check runs in one direction only. `docs/05` describes the finished
contract, so it documents `/v1/applications` before it exists; asserting the
reverse would mean either deleting the design or writing stub routes to satisfy
a test.

**The UI is public; the API is not.** Anyone can read `/docs`. Every call it
makes still needs a bearer token, so the form can be filled and not submitted,
and the Authorize button plus the demo token in the submission email is how a
reviewer uses it.

The honest reason that is defensible rather than convenient: the data behind
this deployment is synthetic and the write path is token-gated, so an open
reference page exposes a contract that is already in a public repository. In a
production deployment the page ships behind the same authentication as the API,
or does not ship at all — publishing an interactive form for an endpoint that
triggers a hard credit enquiry is not something to do because it is convenient.

## Alternatives

**Nothing — `docs/05` plus `demo.sh`.** Cheapest, and it satisfies "keep the
implementation small" literally. Rejected because the contract then stays prose
that nothing verifies against the code, and because retrofitting schemas onto
finished routes in a later phase produces gaps: a schema written alongside a
route is complete, one written afterwards covers what the author remembers.

**Generate the specification, commit it, serve no UI.** Keeps the drift
protection and drops one dependency. Rejected because a reviewer then has to
import the file into something to use it, most will not, and the second reason
for doing this at all evaporates while the dependencies remain.

**Hand-written OpenAPI, checked in.** No type provider, no version coupling.
Rejected because a hand-written specification is exactly the prose problem with
extra syntax: it drifts, and nothing catches it.

**Serve the UI behind the auditor scope.** Safer, and the right answer in
production. Rejected here because a reviewer without a token sees a login wall
instead of a contract, which removes most of the value on a submission whose
whole point is that somebody can open the URL and look.

## Consequences

- The route schemas are now load-bearing in three ways. Writing a route without
  one is a build failure, which is the correct amount of friction.
- `zod` moved from 3 to 4, because the current provider requires it. The
  migration cost one line: `.default()` takes the output type in zod 4. The
  alternative was pinning the provider to an older major on the day of adopting
  it, which is a weak position to defend.
- Route typing is coupled to a third library's release cadence. The coupling is
  contained: it exists at the route layer only, the schemas themselves are plain
  zod, and the domain layer never sees any of it (ADR-0008).
- `API_VERSION` is separate from `ENGINE_VERSION`. The first changes when the
  shape of the API does; the second whenever the arithmetic changes, and it is
  stamped on every pre-decision for replay. Keeping them apart is also what
  makes the committed document deterministic enough to diff.
- Three more dependencies and roughly 2 MB of UI assets in the image, served
  from this origin rather than a CDN. A documentation page that fetches its own
  JavaScript from somebody else's domain is a supply chain the deployment does
  not control.
