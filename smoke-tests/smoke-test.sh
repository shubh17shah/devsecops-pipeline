#!/usr/bin/env bash
#
# smoke-test.sh — post-deploy smoke tests for telemetry-service.
#
# Run by the `deploy-staging` job right after ArgoCD reports the
# application Synced/Healthy, and again against production after the
# manual approval gate. Exits non-zero on any failure so the calling
# workflow step fails the job (and, in deploy-prod, triggers the
# rollback job via `if: failure()`).
#
# Usage:
#   smoke-test.sh [base_url]
#
# Environment variables:
#   SMOKE_TEST_URL       Base URL of the deployed service.
#                          Defaults to http://localhost:8080, or to the
#                          positional argument if one is given.
#   EXPECTED_SERVICE      If set, GET / must report exactly this
#                          "service" value (src/config.js SERVICE_NAME).
#                          Useful when this script is pointed at a
#                          specific Application (e.g. telemetry-ingest)
#                          rather than the generic image default.
#   MAX_RETRIES            Number of attempts per endpoint (default: 10).
#   RETRY_DELAY_SECONDS    Delay between attempts (default: 3).
#
# Requires: curl. Uses grep/sed for JSON field extraction so it has no
# dependency on jq being present on the runner or in the container image.

set -uo pipefail

BASE_URL="${1:-${SMOKE_TEST_URL:-http://localhost:8080}}"
BASE_URL="${BASE_URL%/}"
EXPECTED_SERVICE="${EXPECTED_SERVICE:-}"
MAX_RETRIES="${MAX_RETRIES:-10}"
RETRY_DELAY_SECONDS="${RETRY_DELAY_SECONDS:-3}"

failures=0

log() {
    printf '[smoke-test] %s\n' "$1"
}

fail() {
    printf '[smoke-test] FAIL: %s\n' "$1" >&2
    failures=$((failures + 1))
}

# json_field <json> <field> — crude but dependency-free extraction of a
# top-level string value from a small flat JSON object, e.g.
# json_field '{"status":"ok"}' status -> ok
json_field() {
    local json="$1" field="$2"
    echo "$json" | grep -o "\"${field}\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" \
        | sed -E "s/\"${field}\"[[:space:]]*:[[:space:]]*\"([^\"]*)\"/\1/"
}

# wait_for_endpoint <path> — polls until the endpoint returns HTTP 200,
# up to MAX_RETRIES times. Deployments are eventually consistent: the
# ArgoCD sync can report Healthy a moment before the new pod actually
# passes its readiness probe and joins the service endpoints.
wait_for_endpoint() {
    local path="$1" url attempt status
    url="${BASE_URL}${path}"

    for attempt in $(seq 1 "$MAX_RETRIES"); do
        status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null)
        [ -z "$status" ] && status="000"
        if [ "$status" = "200" ]; then
            log "GET $path -> 200 (attempt $attempt/$MAX_RETRIES)"
            return 0
        fi
        log "GET $path -> $status, retrying in ${RETRY_DELAY_SECONDS}s (attempt $attempt/$MAX_RETRIES)"
        sleep "$RETRY_DELAY_SECONDS"
    done

    fail "$path never returned 200 after $MAX_RETRIES attempts (last status: $status)"
    return 1
}

log "target: $BASE_URL"

log "checking /healthz (liveness)"
if wait_for_endpoint "/healthz"; then
    body=$(curl -s --max-time 5 "${BASE_URL}/healthz")
    status_field=$(json_field "$body" status)
    if [ "$status_field" != "ok" ]; then
        fail "/healthz body did not report status=ok, got: $body"
    fi
fi

log "checking /readyz (readiness)"
if ! wait_for_endpoint "/readyz"; then
    : # already recorded as a failure by wait_for_endpoint
fi

log "checking / (service identity)"
index_body=$(curl -s --max-time 5 "${BASE_URL}/" || true)
index_status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${BASE_URL}/" 2>/dev/null)
[ -z "$index_status" ] && index_status="000"
if [ "$index_status" != "200" ]; then
    fail "/ returned HTTP $index_status"
else
    got_service=$(json_field "$index_body" service)
    if [ -z "$got_service" ]; then
        fail "/ response had no parsable service field: $index_body"
    else
        log "/ reports service: $got_service"
        if [ -n "$EXPECTED_SERVICE" ] && [ "$got_service" != "$EXPECTED_SERVICE" ]; then
            fail "deployed service '$got_service' does not match expected '$EXPECTED_SERVICE'"
        fi
    fi
fi

log "checking /metrics (Prometheus exposition)"
metrics_status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${BASE_URL}/metrics" 2>/dev/null)
[ -z "$metrics_status" ] && metrics_status="000"
if [ "$metrics_status" != "200" ]; then
    fail "/metrics returned HTTP $metrics_status"
fi

if [ "$failures" -eq 0 ]; then
    log "all smoke tests passed"
    exit 0
fi

log "$failures smoke test(s) failed"
exit 1
