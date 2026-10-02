# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/) for the
`telemetry-service` application in `app/`.

## [Unreleased]

### Added

- Repository hygiene for a public GitHub project: `LICENSE` (MIT),
  `CONTRIBUTING.md`, `SECURITY.md`, `CODEOWNERS`, `.editorconfig`,
  `app/.nvmrc`, a pull request template, issue templates, and a
  `dependabot.yml` covering `npm` (`/app`), `docker` (`/app`), and
  `github-actions` (`/`).
- CI status badges on `README.md` for `ci.yml` and
  `verify-security-gates.yml`.

## [0.1.0] - 2026-10-02

### Added

- `telemetry-service`: a Node.js/Express application (`app/`) whose
  identity and enabled dependencies (Postgres, Redis, RabbitMQ) are
  entirely environment-variable driven, so one built image backs all 12
  microservice Applications in the `eks-platform` GitOps repo. Includes
  liveness/readiness endpoints (`/healthz`, `/readyz`), Prometheus
  metrics (`/metrics`), and a small telemetry ingest/query API.
- A multi-stage `app/Dockerfile` (non-root `node` user, `dumb-init` as
  PID 1, `node:20-alpine` base) and a deliberately vulnerable
  `app/Dockerfile.vulnerable` fixture used to continuously verify the
  Trivy gate below actually blocks.
- `.github/workflows/ci.yml`: the delivery pipeline —
  `test` (lint + `node --test`) → `sast` (SonarCloud with a
  Semgrep blocking fallback) → `build` → `scan` (blocking Trivy gate on
  HIGH/CRITICAL, `ignore-unfixed`) → `sign` (Syft SBOM + Cosign keyless
  signing and attestation) → `push` (signature verification, `stable`
  tag promotion) → `deploy-staging` (GitOps image-tag bump +
  ArgoCD sync/health wait + smoke test, on push to `main` only) →
  `deploy-prod` (manual-approval GitHub Environment + post-approval
  health check) → `rollback` (automatic, on `deploy-prod` failure).
- `.github/workflows/verify-security-gates.yml`: a scheduled
  (weekly) and manually dispatchable workflow that runs the same
  blocking Trivy gate against `app/Dockerfile.vulnerable`, so the gate's
  ability to actually fail a build is re-verified continuously rather
  than asserted once.
- `docs/SECURITY-GATES.md`: a gate-by-gate reference for what each
  security control catches, how it's enforced (vs. merely reported),
  and how to reproduce the Trivy gate failure locally.
- `docs/VAULT.md` and `vault/`: HashiCorp Vault Kubernetes-auth setup
  (`setup-k8s-auth.sh`, `policy.hcl`) so application runtime secrets are
  fetched via short-lived, ServiceAccount-scoped Vault tokens instead of
  GitHub repository secrets or baked-in credentials.
- `smoke-tests/smoke-test.sh`: the post-deploy health check used by
  both `deploy-staging` and `deploy-prod`.
- `README.md`: architecture, the `devsecops-pipeline` /
  `eks-platform` repo split, the pipeline DAG, the security gates
  table, and required repository configuration (variables/secrets).

[Unreleased]: https://github.com/shubh17shah/devsecops-pipeline/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/shubh17shah/devsecops-pipeline/releases/tag/v0.1.0
