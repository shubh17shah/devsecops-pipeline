# vault/policy.hcl — least-privilege Vault policy for the devsecops-pipeline app.
#
# Grants read-only access to exactly one KV v2 secret and nothing else: no
# list, no write, no delete, no access to any other path or mount. A pod
# (or an attacker who compromises it) can read this one secret and nothing
# more.
#
# KV v2 serves secret data under "<mount>/data/<path>" — the "data"
# segment is part of the KV v2 HTTP API, not something you choose:
# https://developer.hashicorp.com/vault/docs/secrets/kv/kv-v2
#
# Apply with:
#   vault policy write devsecops-pipeline-app vault/policy.hcl
#
# This policy only grants a capability set — it grants it to nobody by
# itself. vault/setup-k8s-auth.sh binds it to a Kubernetes auth role,
# which is what actually restricts *who* can obtain a token carrying it
# (only pods running as a specific ServiceAccount, in a specific
# namespace). See docs/VAULT.md for the full flow.

path "secret/data/devsecops-pipeline/app" {
  capabilities = ["read"]
}

# Nothing else is granted. Vault denies by default, so there is no
# "deny everything else" stanza to write — the absence of a path block
# *is* the deny. In particular, this policy does not grant "list" on
# secret/metadata/devsecops-pipeline/app: the app can read the one secret
# it already knows the path to, but cannot enumerate versions or discover
# sibling secrets.
