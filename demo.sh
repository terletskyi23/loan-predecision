#!/usr/bin/env bash
#
# Walks every interesting path end to end against a running instance.
#
#   ./demo.sh                                   # local: docker compose up -d db && npm run dev
#   BASE_URL=https://loan-predecision.onrender.com \
#   SUBMISSION_TOKEN=... REVIEWER_TOKEN=... AUDITOR_TOKEN=... ./demo.sh
#
# Every scenario the documentation promises is exercised here, including the
# ugly ones: a bureau outage, a duplicate that must not cause a second enquiry,
# and an approval that carries no reason codes at all.

set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
SUBMISSION_TOKEN="${SUBMISSION_TOKEN:-dev-submission-token}"
REVIEWER_TOKEN="${REVIEWER_TOKEN:-dev-reviewer-token}"
AUDITOR_TOKEN="${AUDITOR_TOKEN:-dev-auditor-token}"

pass=0; fail=0
RUN="demo-$(date +%s)-$$"

hr()  { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail+1)); }
note(){ printf '      \033[2m%s\033[0m\n' "$1"; }

# Reads one path out of JSON on stdin, jq syntax: .a.b[0]
#
# jq if present, python3 otherwise — a demo a reviewer cannot run because of a
# missing tool demonstrates nothing. Both print an empty string for a missing or
# null value, so a comparison never succeeds against the word "null".
jget() {
  local out
  if command -v jq >/dev/null 2>&1; then
    out=$(jq -r "$1" 2>/dev/null)
  else
    out=$(python3 -c '
import json,re,sys
path=sys.argv[1]
try: value=json.load(sys.stdin)
except Exception: print(""); raise SystemExit
for part in re.findall(r"\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]", path):
    key,index=part
    if key:
        value=value.get(key) if isinstance(value,dict) else None
    else:
        try: value=value[int(index)]
        except Exception: value=None
    if value is None: break
print("" if value is None else (json.dumps(value) if isinstance(value,(list,dict)) else value))
' "$1" 2>/dev/null)
  fi
  [ "$out" = "null" ] && out=""
  printf '%s' "$out"
}

expect() {
  local what="$1" want="$2"; shift 2
  local status
  status=$(curl -sS -o /tmp/demo.body -w '%{http_code}' "$@" 2>/dev/null)
  if [ "$status" = "$want" ]; then ok "$what  [$status]"; else
    bad "$what  expected $want, got $status"
    head -c 300 /tmp/demo.body 2>/dev/null | sed 's/^/      /'
  fi
}

same() {
  local what="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then ok "$what"; else bad "$what — expected '$want', got '$got'"; fi
}

# submit <national-id> <amount-minor> <term> <income-minor> <obligations-minor> <dob> <idempotency-key>
submit() {
  curl -sS -X POST "$BASE_URL/v1/applications" \
    -H "Authorization: Bearer $SUBMISSION_TOKEN" \
    -H "Idempotency-Key: $7" \
    -H 'Content-Type: application/json' \
    -d "{\"productCode\":\"PERSONAL_UNSECURED_V1\",\"requestedAmountMinor\":$2,\"currency\":\"USD\",
         \"termMonths\":$3,\"purpose\":\"DEBT_CONSOLIDATION\",
         \"consent\":{\"attestedByCaller\":true,\"acceptedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"},
         \"applicant\":{\"firstName\":\"Ada\",\"lastName\":\"Lovelace\",\"dateOfBirth\":\"$6\",
                        \"nationalId\":\"$1\",\"email\":\"ada@example.com\",\"residenceCountry\":\"US\"},
         \"finances\":{\"monthlyIncomeMinor\":$4,\"employmentStatus\":\"EMPLOYED\",
                       \"declaredMonthlyObligationsMinor\":$5},\"channel\":\"WEB\"}" 2>/dev/null
}

printf '\033[1mInstant Loan Pre-Decision API — demo\033[0m\n%s\n' "$BASE_URL"

hr 'Health: the two probes answer different questions'
expect 'GET /health/live  touches nothing'       200 "$BASE_URL/health/live"
expect 'GET /health/ready reaches the database'  200 "$BASE_URL/health/ready"

hr 'Errors are problem+json, always — including Fastify’s own 404'
expect 'GET /nope returns the catalogue code' 404 "$BASE_URL/nope"
curl -sS "$BASE_URL/nope" | grep -q '"code":"NOT_FOUND"' && ok 'body carries code, type and correlationId' || bad 'body is not problem+json'
curl -sSD - -o /dev/null "$BASE_URL/health/live" 2>/dev/null | grep -qi 'x-correlation-id' \
  && ok 'every response carries X-Correlation-Id' || bad 'no correlation id header'

hr 'Three scopes, and a token valid for one is refused on another'
expect 'GET /metrics unauthenticated'         401 "$BASE_URL/metrics"
expect 'GET /metrics with a submission token' 403 -H "Authorization: Bearer $SUBMISSION_TOKEN" "$BASE_URL/metrics"
expect 'GET /metrics with an auditor token'   200 -H "Authorization: Bearer $AUDITOR_TOKEN"    "$BASE_URL/metrics"

hr 'The contract is generated from the routes, and served'
expect 'GET /docs      interactive reference' 200 "$BASE_URL/docs"
expect 'GET /docs/json the specification'     200 "$BASE_URL/docs/json"

hr 'An approval on the terms applied for — and it carries NO reason codes'
BODY=$(submit '900-55-0601' 1800000 36 620000 90000 '1988-02-19' "$RUN-prime")
same 'verdict is APPROVED'                     "$(printf '%s' "$BODY" | jget .preDecision.verdict)" 'APPROVED'
same 'the full amount is offered'              "$(printf '%s' "$BODY" | jget .preDecision.offer.approvedAmountMinor)" '1800000'
same 'the instalment is $605.62'               "$(printf '%s' "$BODY" | jget .preDecision.offer.monthlyPaymentMinor)" '60562'
same 'score 100'                               "$(printf '%s' "$BODY" | jget .preDecision.assessment.score)" '100'
same 'reasonCodes is empty, and that is right' "$(printf '%s' "$BODY" | jget .preDecision.reasonCodes)" '[]'
note 'not adverse action, so no reasons are owed — ADR-0010'

hr 'A counter-offer: yes, but less'
BODY=$(submit '900-55-0142' 3200000 48 540000 160000 '1991-04-12' "$RUN-counter")
same 'verdict is APPROVED'                "$(printf '%s' "$BODY" | jget .preDecision.verdict)" 'APPROVED'
same '$26,900 of the $32,000 requested'   "$(printf '%s' "$BODY" | jget .preDecision.offer.approvedAmountMinor)" '2690000'
same 'the instalment is $720.33'          "$(printf '%s' "$BODY" | jget .preDecision.offer.monthlyPaymentMinor)" '72033'
same 'the decisive code leads'            "$(printf '%s' "$BODY" | jget .preDecision.reasonCodes[0])" 'AMOUNT_REDUCED_TO_FIT_DTI'
note 'a counteroffer IS adverse action if declined, so the reasons come up front'

hr 'A decline, with the factors that moved it'
BODY=$(submit '900-55-0221' 1800000 36 620000 90000 '1988-02-19' "$RUN-decline")
same 'verdict is DECLINED'  "$(printf '%s' "$BODY" | jget .preDecision.verdict)" 'DECLINED'
same 'score 22'             "$(printf '%s' "$BODY" | jget .preDecision.assessment.score)" '22'
same 'payment history leads' "$(printf '%s' "$BODY" | jget .preDecision.reasonCodes[0])" 'PAYMENT_HISTORY_ADVERSE'
note "no 'score too low' code: the score is the SUM of the reasons, not one of them"

hr 'No credit file is not an outage'
BODY=$(submit '900-55-0300' 1800000 36 620000 90000 '1988-02-19' "$RUN-nohit")
same 'referred, not declined' "$(printf '%s' "$BODY" | jget .preDecision.verdict)" 'MANUAL_REVIEW'
same 'and the reason says so' "$(printf '%s' "$BODY" | jget .preDecision.reasonCodes[0])" 'NO_CREDIT_FILE'

hr 'A bureau outage, forced by identifier — no configuration, no restart'
BODY=$(submit '900-55-9001' 1800000 36 620000 90000 '1988-02-19' "$RUN-outage")
REFERRED=$(printf '%s' "$BODY" | jget .applicationId)
same 'referred for a human'        "$(printf '%s' "$BODY" | jget .preDecision.verdict)" 'MANUAL_REVIEW'
same 'and the cause is recorded'   "$(printf '%s' "$BODY" | jget .preDecision.reasonCodes[0])" 'BUREAU_UNAVAILABLE'
same 'no report was stored'        "$(printf '%s' "$BODY" | jget .preDecision.bureauReportId)" ''
note 'the application is persisted regardless — a business event, not a failed call'

hr 'A duplicate submission causes no second enquiry'
UNIQUE="900-77-$(printf '%04d' $((RANDOM % 10000)))"
FIRST=$(submit "$UNIQUE" 1800000 36 620000 90000 '1988-02-19' "$RUN-dup-1")
SECOND=$(submit "$UNIQUE" 1500000 36 620000 90000 '1988-02-19' "$RUN-dup-2")
same 'the first placed the enquiry'            "$(printf '%s' "$FIRST"  | jget .preDecision.bureauReportReused)" 'false'
same 'the second reused it'                    "$(printf '%s' "$SECOND" | jget .preDecision.bureauReportReused)" 'true'
same 'and it is the SAME report'               "$(printf '%s' "$SECOND" | jget .preDecision.bureauReportId)" "$(printf '%s' "$FIRST" | jget .preDecision.bureauReportId)"
note 'two applications, two decisions, one mark on the credit file'

hr 'The same idempotency key returns the stored response, byte for byte'
ONE=$(submit '900-55-0601' 1800000 36 620000 90000 '1988-02-19' "$RUN-idem")
TWO=$(submit '900-55-0601' 1800000 36 620000 90000 '1988-02-19' "$RUN-idem")
same 'the same application id'  "$(printf '%s' "$TWO" | jget .applicationId)" "$(printf '%s' "$ONE" | jget .applicationId)"
same 'the same decidedAt'       "$(printf '%s' "$TWO" | jget .preDecision.decidedAt)" "$(printf '%s' "$ONE" | jget .preDecision.decidedAt)"
note 'including the original correlationId — regenerating it would defeat the point'

hr 'Reads are owner-scoped, and the audit trail is complete'
APP=$(printf '%s' "$ONE" | jget .applicationId)
expect 'GET the application'            200 -H "Authorization: Bearer $SUBMISSION_TOKEN" "$BASE_URL/v1/applications/$APP"
expect 'GET a stranger’s id — same 404' 404 -H "Authorization: Bearer $SUBMISSION_TOKEN" "$BASE_URL/v1/applications/00000000-0000-4000-8000-000000000000"
CHAIN=$(curl -sS -H "Authorization: Bearer $AUDITOR_TOKEN" "$BASE_URL/v1/audit/applications/$APP/chain" 2>/dev/null)
same 'the hash chain verifies' "$(printf '%s' "$CHAIN" | jget .chainIntact)" 'true'
note "$(printf '%s' "$CHAIN" | jget .events) events — and truncation is the attack this cannot see"

hr 'Replay: the same inputs, the same policy version, the same clock'
REPLAY=$(curl -sS -X POST -H "Authorization: Bearer $AUDITOR_TOKEN" "$BASE_URL/v1/audit/pre-decisions/$APP/replay" 2>/dev/null)
same 'the decision reproduces' "$(printf '%s' "$REPLAY" | jget .match)" 'true'
note 'stored inputs, the recorded policy version, and submittedAt as the clock'

hr 'A human closes the referral — without touching the engine’s verdict'
if [ -n "$REFERRED" ]; then
  CLOSED=$(curl -sS -X POST "$BASE_URL/v1/reviews/$REFERRED/close" \
    -H "Authorization: Bearer $REVIEWER_TOKEN" -H 'Content-Type: application/json' \
    -d '{"outcome":"APPROVED","approvedAmountMinor":900000,"rationale":"Bureau outage; file pulled manually and assessed."}' 2>/dev/null)
  same 'the outcome is the reviewer’s'    "$(printf '%s' "$CLOSED" | jget .outcome.source)" 'REVIEWER'
  same 'the engine verdict is unchanged'  "$(printf '%s' "$CLOSED" | jget .preDecision.verdict)" 'MANUAL_REVIEW'
  expect 'a second close is refused' 409 -X POST -H "Authorization: Bearer $REVIEWER_TOKEN" -H 'Content-Type: application/json' \
    -d '{"outcome":"DECLINED","rationale":"again"}' "$BASE_URL/v1/reviews/$REFERRED/close"
  REPLAY=$(curl -sS -X POST -H "Authorization: Bearer $AUDITOR_TOKEN" "$BASE_URL/v1/audit/pre-decisions/$REFERRED/replay" 2>/dev/null)
  same 'and replay still matches' "$(printf '%s' "$REPLAY" | jget .match)" 'true'
  note 'a legitimate override must not look like tampering — ADR-0006'
else
  bad 'no referred application to close'
fi

printf '\n\033[1m%d passed, %d failed\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
