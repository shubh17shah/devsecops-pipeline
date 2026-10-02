# Security Policy

## Reporting a vulnerability

If you find a security vulnerability in this repository (the
`telemetry-service` application, its `Dockerfile`, or the
`.github/workflows/` pipeline that builds, scans, signs, and ships it),
please report it privately rather than opening a public issue:

1. Use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability)
   feature on this repository (**Security** tab → **Report a
   vulnerability**), if enabled.
2. If that isn't available, open a [GitHub Security Advisory](https://github.com/shubh17shah/devsecops-pipeline/security/advisories/new)
   draft, or contact the maintainer (`@shubh17shah`) directly rather than
   filing a public issue.

Please include:

- The affected file(s)/job(s) and, if applicable, a reproduction (e.g. a
  request that bypasses a check, or a pipeline run demonstrating a gate
  not enforcing).
- The impact you believe it has (e.g. "the `scan` job can be bypassed
  on a fork PR", "a secret is logged in plaintext in a workflow step").

You should expect an acknowledgment within a few days. This is a
personal/portfolio project without a dedicated security team or a
funded bug bounty, so response times aren't contractually guaranteed,
but reports are taken seriously and triaged promptly.

Please do not open a public issue for anything that could be used to
compromise the pipeline, the published image, or the `eks-platform`
GitOps repo it deploys into, until it's been triaged.

## Supported versions

This repository ships one rolling release: the `stable` tag of
`ghcr.io/shubh17shah/telemetry-service`, built from the tip of `main`.
There are no maintained release branches or long-term support versions —
security fixes land on `main` and are released as the next image build.

| Version / tag | Supported |
| --- | --- |
| `stable` (tip of `main`) | Yes |
| Any other tag (commit-SHA-pinned images, `vulnerable-*`) | No — `app/Dockerfile.vulnerable` images are intentionally insecure fixtures for [`verify-security-gates.yml`](.github/workflows/verify-security-gates.yml) and are never meant to run anywhere |

## Security controls enforced by this repository

These aren't aspirational — each one is a real, enforced gate in
[`.github/workflows/ci.yml`](.github/workflows/ci.yml), documented in
full (mechanism, failure behavior, how it's continuously re-verified) in
[`docs/SECURITY-GATES.md`](docs/SECURITY-GATES.md).

- **Vulnerability scanning (Trivy), blocking.** Every image is scanned
  before it can be signed or pushed. A HIGH or CRITICAL CVE with an
  available fix fails the `scan` job (`exit-code: 1`,
  `ignore-unfixed: true`) — this is a hard stop, not a report. A separate
  scheduled workflow, [`verify-security-gates.yml`](.github/workflows/verify-security-gates.yml),
  builds a deliberately vulnerable image weekly to continuously prove
  this gate still blocks.
- **Software Bill of Materials (SBOM).** Syft generates an SPDX SBOM for
  every image the `sign` job pushes, and the SBOM is attached to the
  image as a signed Cosign attestation — anyone can inspect exactly
  what's in a given image tag without re-pulling and unpacking it.
- **Image signing (Cosign, keyless).** Every image pushed to GHCR is
  signed via Sigstore keyless signing (OIDC identity, Fulcio-issued
  certificate — no private key to manage or leak). The `push` job
  verifies that signature before promoting the `stable` tag, so an
  image that wasn't signed by this repository's own workflow can never
  reach the moving `stable` pointer `eks-platform` tracks.
- **No long-lived registry credentials.** Authentication to GHCR uses
  the ephemeral, per-run `GITHUB_TOKEN` (`permissions.packages: write`),
  and Cosign's Sigstore flow uses GitHub's own OIDC token
  (`permissions.id-token: write`) rather than a stored signing key.
  There is no static registry password or long-lived PAT checked into
  this repository or its secrets for the default GHCR path (the
  optional ECR alternative in the `sign` job is also OIDC-based — see
  README.md "Configuration").
- **No application secrets in repository secrets.** Runtime secrets for
  the deployed application (database passwords, queue credentials) are
  never stored as GitHub Actions secrets or baked into the image. They
  are fetched at runtime from HashiCorp Vault via Kubernetes
  ServiceAccount auth — see [`docs/VAULT.md`](docs/VAULT.md) and
  [`vault/setup-k8s-auth.sh`](vault/setup-k8s-auth.sh). The only secrets
  this repository's CI itself holds are pipeline-scoped (`SONAR_TOKEN`,
  `GITOPS_REPO_TOKEN`, `ARGOCD_AUTH_TOKEN` — see README.md
  "Configuration"), and none of them are embedded in the image or
  exposed to the running application.
- **Least-privilege workflow permissions.** `ci.yml` sets
  `permissions: {}` at the workflow level; every job opts back in to
  only the exact scopes it needs (e.g. `contents: read`, and only the
  `sign`/`push` jobs get `packages: write` / `id-token: write`).

For the full gate-by-gate breakdown, including how each control is
verified rather than just asserted, see
[`docs/SECURITY-GATES.md`](docs/SECURITY-GATES.md).
