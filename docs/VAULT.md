# Vault Kubernetes Authentication

The devsecops-pipeline app never holds a Vault token, an API key, or any
other long-lived credential in an environment variable, a Kubernetes
Secret, or a GitHub Actions secret. Instead, each pod authenticates to
Vault using the identity Kubernetes already gives it — its ServiceAccount
— and receives back a token that is scoped to one secret, short-lived,
and fully audited.

The setup half of this (enabling the auth method, creating the role,
writing the policy) lives in
[`vault/setup-k8s-auth.sh`](../vault/setup-k8s-auth.sh) and
[`vault/policy.hcl`](../vault/policy.hcl). This document explains the
runtime flow that setup enables, and why it's the better default versus
a GitHub repository secret.

## End-to-end flow

```mermaid
sequenceDiagram
    autonumber
    participant K8s as Kubernetes API server
    participant Pod as App pod<br/>(ServiceAccount: devsecops-pipeline-app)
    participant Vault as Vault<br/>(kubernetes auth method)
    participant KV as Vault KV v2<br/>secret/data/devsecops-pipeline/app

    Note over K8s,Pod: At pod creation, kubelet projects a short-lived,<br/>audience-scoped ServiceAccount JWT into the pod's filesystem.
    K8s-->>Pod: mount /var/run/secrets/.../token (JWT)

    Pod->>Vault: POST /v1/auth/kubernetes/login<br/>role=devsecops-pipeline-app, jwt=&lt;SA JWT&gt;
    Vault->>K8s: TokenReview API call<br/>(validate JWT signature, expiry, audience)
    K8s-->>Vault: valid — subject: system:serviceaccount:devsecops-pipeline:devsecops-pipeline-app

    Vault->>Vault: check subject against role's<br/>bound_service_account_names / _namespaces
    Vault-->>Pod: short-lived Vault token<br/>(policy: devsecops-pipeline-app, ttl: 1h, max_ttl: 4h)

    Pod->>KV: GET /v1/secret/data/devsecops-pipeline/app<br/>header: X-Vault-Token: &lt;short-lived token&gt;
    KV-->>Pod: secret payload
    Note over Vault,KV: Every login and every read is<br/>recorded in Vault's audit log.

    Note over Pod,Vault: Token expires after its ttl.<br/>Pod repeats the login step with a fresh JWT to renew.
```

## Step by step

1. **Pod identity, not a stored secret.** Kubernetes projects a
   ServiceAccount JWT into every pod at a well-known path
   (`/var/run/secrets/kubernetes.io/serviceaccount/token`). It's
   short-lived and audience-bound, and the app never had to be handed it
   out-of-band — Kubernetes mints it as part of scheduling the pod.
2. **Login.** The app (or a Vault Agent sidecar/init container) POSTs
   that JWT to `auth/kubernetes/login` along with the role name
   configured in `setup-k8s-auth.sh`.
3. **Validation via TokenReview.** Vault does not trust the JWT on its
   signature alone. It calls back to the Kubernetes API's TokenReview
   endpoint — authenticating as the `vault-auth-reviewer` ServiceAccount
   created during setup — to confirm the JWT is currently valid and to
   get the authoritative subject from the cluster itself.
4. **Role binding check.** Vault checks that subject
   (`system:serviceaccount:<namespace>:<name>`) against the role's
   `bound_service_account_names` and `bound_service_account_namespaces`,
   both set in `setup-k8s-auth.sh`. A JWT from the right namespace but
   wrong ServiceAccount (or vice versa) is rejected.
5. **Short-lived token issued.** Vault returns a client token carrying
   only the `devsecops-pipeline-app` policy (`vault/policy.hcl`), with a
   1-hour TTL and a 4-hour hard max — both fixed by the role, not chosen
   by the caller.
6. **Scoped read.** The app uses that token to read exactly
   `secret/data/devsecops-pipeline/app` and nothing else — the policy
   grants no other path, no list, no write, no delete.
7. **Audit trail.** Both the login and the secret read are recorded in
   Vault's audit log, with the ServiceAccount identity attached to the
   entry.
8. **Expiry and renewal.** When the token's TTL runs out, the app repeats
   the login step with a (freshly projected, still-valid) ServiceAccount
   JWT to get a new one. Nothing long-lived ever existed to leak.

## Why this beats a GitHub repository secret

Storing an application credential as a GitHub Actions repo/environment
secret is the common shortcut this design deliberately avoids:

| | GitHub repo secret | Vault + Kubernetes auth |
| --- | --- | --- |
| **Lifetime** | Static — the same value until a human manually rotates it, often for months or years. | Short-lived by construction: 1h TTL / 4h max in this role. A leaked token is worthless soon after. |
| **Blast radius of a leak** | The full secret value, usable anywhere, until someone notices and rotates it. | A narrow, single-role token scoped to one read-only KV path, tied to a specific ServiceAccount identity. |
| **Revocation** | Rotate the value manually, then update every place that referenced it. | `vault token revoke` (or revoke by accessor/role) — immediate, no coordination with consumers required. |
| **Exposure in CI logs** | Easy to accidentally echo or capture in a build log; GitHub's masking is best-effort and only catches exact-match strings. | The secret is fetched at runtime, in the cluster, by the app itself. It never transits GitHub Actions, so there is nothing in CI to mask or leak in the first place. |
| **Exposure in git** | A secret pasted into a workflow file, a committed `.env`, or a fork's PR diff are all common real-world incidents. | No secret material exists in this repository — only policy/role *names*, which grant nothing by themselves. |
| **Audit** | GitHub's audit log shows who viewed/changed the *secret configuration*, not who consumed the value at runtime. | Every login and every read is in Vault's audit log, correlated to the requesting ServiceAccount, independent of GitHub. |
| **Identity model** | A flat, repo-wide bearer credential — any workflow with access to the secret has full access to it. | Cryptographically tied to Kubernetes' own identity (namespace + ServiceAccount), verified out-of-band via TokenReview on every login. |
| **Least privilege** | Whatever scope the underlying credential was issued with — often broader than one workload needs, because narrowing it is extra manual work. | Enforced per-workload by `vault/policy.hcl`: this identity can read exactly one path and nothing else. |

This repo also uses GitHub OIDC elsewhere (see `ci.yml`'s `sign` and
`push` jobs) to get CI short-lived AWS credentials instead of static AWS
keys. Vault's Kubernetes auth method is the same idea — trade a static
secret for a short-lived credential backed by an identity someone else
already vouches for — applied to the *running application's* access to
its own secrets, a place GitHub OIDC has no reach once the pod is
deployed.
