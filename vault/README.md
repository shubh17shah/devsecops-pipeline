# vault/

HashiCorp Vault integration for the devsecops-pipeline app: the
Kubernetes auth method configuration, the least-privilege policy the
app's pods authenticate into, and the one-time setup script.

| File | Purpose |
| --- | --- |
| `policy.hcl` | Read-only policy scoped to a single KV v2 path — nothing else. |
| `setup-k8s-auth.sh` | Enables Vault's kubernetes auth method, configures it against the cluster, and creates the role bound to the app's ServiceAccount + namespace. |

For the full authentication flow (pod → ServiceAccount JWT → Vault →
Kubernetes TokenReview API → short-lived token → secret) and why this
replaces static GitHub Actions secrets for application-level
credentials, see **[docs/VAULT.md](../docs/VAULT.md)**.
