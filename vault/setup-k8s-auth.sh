#!/usr/bin/env bash
#
# setup-k8s-auth.sh — one-time bootstrap of Vault's Kubernetes auth method
# for the devsecops-pipeline app.
#
# After this runs, any pod running as the bound ServiceAccount, in the
# bound namespace, on the target cluster, can exchange its projected
# ServiceAccount JWT for a short-lived Vault token scoped to the
# read-only policy in vault/policy.hcl. See docs/VAULT.md for the full
# request/response flow and why this beats a static GitHub Actions
# secret for application-level credentials.
#
# Prerequisites:
#   - vault CLI installed, with VAULT_ADDR / VAULT_TOKEN set to an
#     operator token that can enable auth methods and write policies
#     (e.g. an admin policy) — NOT the app's own token, which this
#     script is busy creating.
#   - kubectl configured against the target cluster.
#   - A "vault-auth-reviewer" ServiceAccount already created in the
#     cluster, bound to the system:auth-delegator ClusterRole. Vault uses
#     this identity to call the Kubernetes TokenReview API on every login
#     (see docs/VAULT.md for why). Create it once with:
#       kubectl create serviceaccount vault-auth-reviewer -n "$K8S_NAMESPACE"
#       kubectl create clusterrolebinding vault-auth-reviewer-binding \
#         --clusterrole=system:auth-delegator \
#         --serviceaccount="$K8S_NAMESPACE:vault-auth-reviewer"
#
# Usage:
#   VAULT_ADDR=https://vault.example.internal:8200 \
#   VAULT_TOKEN=<operator-token> \
#   ./vault/setup-k8s-auth.sh
#
# VAULT_ADDR, KUBERNETES_HOST, K8S_NAMESPACE and K8S_SERVICE_ACCOUNT below
# are all placeholder-shaped — replace them (via env vars, not by editing
# this file) with real values for your cluster before running this
# against a real Vault.

set -euo pipefail

# --- configuration (placeholders — override via environment) ---------------
VAULT_ADDR="${VAULT_ADDR:?set VAULT_ADDR, e.g. https://vault.example.internal:8200}"
KUBERNETES_HOST="${KUBERNETES_HOST:-https://kubernetes.default.svc:443}"
K8S_NAMESPACE="${K8S_NAMESPACE:-devsecops-pipeline}"
K8S_SERVICE_ACCOUNT="${K8S_SERVICE_ACCOUNT:-devsecops-pipeline-app}"
VAULT_ROLE_NAME="${VAULT_ROLE_NAME:-devsecops-pipeline-app}"
VAULT_POLICY_NAME="${VAULT_POLICY_NAME:-devsecops-pipeline-app}"
VAULT_REVIEWER_SA="${VAULT_REVIEWER_SA:-vault-auth-reviewer}"
POLICY_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/policy.hcl"
TOKEN_TTL="1h"
TOKEN_MAX_TTL="4h"

export VAULT_ADDR

echo "==> Writing least-privilege policy '${VAULT_POLICY_NAME}' from ${POLICY_FILE}"
vault policy write "${VAULT_POLICY_NAME}" "${POLICY_FILE}"

echo "==> Enabling the kubernetes auth method (no-op if already enabled)"
if vault auth list -format=json | grep -q '"kubernetes/"'; then
    echo "    kubernetes auth method already enabled, skipping"
else
    vault auth enable kubernetes
fi

# --- Kubernetes-side inputs Vault needs to validate ServiceAccount JWTs ----
# The cluster CA is what Vault uses to verify it's really talking to this
# API server; the reviewer JWT is what Vault presents to the TokenReview
# API on every login attempt it receives.
echo "==> Reading cluster CA certificate via kubectl"
KUBE_CA_CERT="$(kubectl config view --raw --minify --flatten \
    -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' | base64 -d)"

echo "==> Minting a long-lived token for the '${VAULT_REVIEWER_SA}' ServiceAccount"
KUBE_REVIEWER_JWT="$(kubectl create token "${VAULT_REVIEWER_SA}" \
    --namespace "${K8S_NAMESPACE}" --duration=8760h)"

echo "==> Configuring kubernetes auth method against ${KUBERNETES_HOST}"
vault write auth/kubernetes/config \
    kubernetes_host="${KUBERNETES_HOST}" \
    kubernetes_ca_cert="${KUBE_CA_CERT}" \
    token_reviewer_jwt="${KUBE_REVIEWER_JWT}"

echo "==> Creating role '${VAULT_ROLE_NAME}' bound to ${K8S_NAMESPACE}/${K8S_SERVICE_ACCOUNT}"
vault write "auth/kubernetes/role/${VAULT_ROLE_NAME}" \
    bound_service_account_names="${K8S_SERVICE_ACCOUNT}" \
    bound_service_account_namespaces="${K8S_NAMESPACE}" \
    policies="${VAULT_POLICY_NAME}" \
    ttl="${TOKEN_TTL}" \
    max_ttl="${TOKEN_MAX_TTL}"

echo "==> Done."
echo "    Pods running as ServiceAccount '${K8S_SERVICE_ACCOUNT}' in namespace '${K8S_NAMESPACE}' can now authenticate:"
echo '      vault write auth/kubernetes/login \'
echo "        role=\"${VAULT_ROLE_NAME}\" \\"
echo '        jwt="$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)"'
