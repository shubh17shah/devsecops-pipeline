#!/usr/bin/env bash
#
# smoke-test.sh — post-deploy smoke tests for the devsecops-pipeline app.
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
#   SMOKE_TEST_URL      Base URL of the deployed service.
#                        Defaults to http://localhost:8080, or to the
#                        positional argument if one is given.
#   EXPECTED_VERSION     If set, /version must report exactly this value.
#                        The CI pipeline passes the git SHA it just deployed
#                        so a smoke test can catch "ArgoCD synced the wrong
#                        image tag" as well as "the pod won't start".
#   MAX_RETRIES          Number of attempts per endpoint (default: 10).
#   RETRY_DELAY_SECONDS  Delay between attempts (default: 3).
#
# Requires: curl. Uses grep/sed for JSON field extraction so it has no
# dependency on jq being present on the runner or in the container image.

set -uo pipefail

BASE_URL="${1:-${SMOKE_TEST_URL:-http://localhost:8080}}"
BASE_URL="${BASE_URL%/}"
EXPECTED_VERSION="${EXPECTED_VERSION:-}"
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

log "checking /version"
version_body=$(curl -s --max-time 5 "${BASE_URL}/version" || true)
version_status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${BASE_URL}/version" 2>/dev/null)
[ -z "$version_status" ] && version_status="000"
if [ "$version_status" != "200" ]; then
    fail "/version returned HTTP $version_status"
else
    got_version=$(json_field "$version_body" version)
    if [ -z "$got_version" ]; then
        fail "/version response had no parsable version field: $version_body"
    else
        log "/version reports: $got_version"
        if [ -n "$EXPECTED_VERSION" ] && [ "$got_version" != "$EXPECTED_VERSION" ]; then
            fail "deployed version '$got_version' does not match expected '$EXPECTED_VERSION'"
        fi
    fi
fi

if [ "$failures" -eq 0 ]; then
    log "all smoke tests passed"
    exit 0
fi

log "$failures smoke test(s) failed"
exit 1
