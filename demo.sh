#!/usr/bin/env bash
#
# Walks the interesting paths end to end against a running instance.
#
#   ./demo.sh                                   # local, docker compose up -d db && npm run dev
#   BASE_URL=https://loan-predecision.onrender.com \
#   SUBMISSION_TOKEN=... AUDITOR_TOKEN=... ./demo.sh
#
# Scenarios not yet built announce themselves as PENDING rather than being
# absent. A demo script that silently covers half of what the documentation
# promises is worse than one that says which half.

set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
SUBMISSION_TOKEN="${SUBMISSION_TOKEN:-local-submission-token}"
AUDITOR_TOKEN="${AUDITOR_TOKEN:-local-auditor-token}"

pass=0; fail=0

hr()   { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail+1)); }
todo() { printf '  \033[33m·\033[0m PENDING — %s\n' "$1"; }

# expect <description> <expected-status> <curl args...>
expect() {
  local what="$1" want="$2"; shift 2
  local body status
  body=$(curl -sS -o /tmp/demo.body -w '%{http_code}' "$@" 2>/dev/null)
  status="$body"
  if [ "$status" = "$want" ]; then
    ok "$what  [$status]"
  else
    bad "$what  expected $want, got $status"
    head -c 300 /tmp/demo.body 2>/dev/null | sed 's/^/      /'
  fi
}

printf '\033[1mInstant Loan Pre-Decision API — demo\033[0m\n%s\n' "$BASE_URL"

hr 'Health: the two probes answer different questions'
expect 'GET /health/live  is up and touches nothing' 200 "$BASE_URL/health/live"
expect 'GET /health/ready reaches the database'      200 "$BASE_URL/health/ready"

hr 'Errors are problem+json, always — including Fastify’s own 404'
expect 'GET /nope returns the catalogue code' 404 "$BASE_URL/nope"
if curl -sS "$BASE_URL/nope" | grep -q '"code":"NOT_FOUND"'; then
  ok 'body carries code, type and correlationId'
else
  bad 'body is not problem+json'
fi
if curl -sSD - -o /dev/null "$BASE_URL/health/live" 2>/dev/null | grep -qi 'x-correlation-id'; then
  ok 'every response carries X-Correlation-Id'
else
  bad 'no correlation id header'
fi

hr 'Metrics are behind the auditor scope, not public'
expect 'GET /metrics unauthenticated'                401 "$BASE_URL/metrics"
expect 'GET /metrics with a submission token'        403 -H "Authorization: Bearer $SUBMISSION_TOKEN" "$BASE_URL/metrics"
expect 'GET /metrics with an auditor token'          200 -H "Authorization: Bearer $AUDITOR_TOKEN"    "$BASE_URL/metrics"

hr 'The lending paths'
todo 'a normal approval'
todo 'an approval reduced to fit DTI (the counter-offer)'
todo 'a decline with derived reason codes'
todo 'a duplicate submission that produces no second bureau call'
todo 'a no-hit, which is not a bureau outage'
todo 'a bureau outage, forced by identifier 900-55-9001'
todo 'an audit replay of a stored pre-decision'

printf '\n\033[1m%d passed, %d failed\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
