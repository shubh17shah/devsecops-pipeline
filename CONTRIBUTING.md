# Contributing

Thanks for taking the time to improve `telemetry-service` or its
pipeline. This document covers the local dev loop, branch/commit
conventions, and exactly what CI checks on a pull request.

## Prerequisites

- **Node.js 20** — matches the `node:20-alpine` base image in
  [`app/Dockerfile`](app/Dockerfile) and the `engines` field in
  [`app/package.json`](app/package.json). If you use `nvm`, `app/.nvmrc`
  pins this for you: `cd app && nvm use`.
- **Docker** (with Buildx) — to build and run the container image
  locally, same `app/Dockerfile` the `build` job in
  [`.github/workflows/ci.yml`](.github/workflows/ci.yml) uses.
- Nothing else is required to run the test suite — `node --test` covers
  the app with no external services.

## Local development loop

```bash
cd app
npm install     # resolves deps and writes package-lock.json (none is committed yet)
npm run lint    # eslint src test — same command the `test` job runs
npm test        # node --test test/ — pure unit/route tests, no infra required
```

Build and run the container the same way `ci.yml`'s `build` job does:

```bash
docker build -f app/Dockerfile -t telemetry-service:local app
docker run --rm -p 8080:8080 telemetry-service:local
curl -s http://localhost:8080/healthz
```

### Running the service with its dependencies disabled

Every dependency (`POSTGRES_ENABLED`, `REDIS_ENABLED`,
`RABBITMQ_ENABLED`) defaults to `false`. With all three left at their
defaults, the service starts with no external infrastructure at all:
`/`, `/healthz`, `/readyz`, and `/metrics` all work immediately, and
`/readyz` reports each dependency as `"disabled"` instead of failing.

```bash
cd app
npm run dev   # nodemon src/server.js — all *_ENABLED default to false
```

To exercise a real dependency, flip its `*_ENABLED` flag and set its
connection variables (see [`app/README.md`](app/README.md#environment-variables)
for the full list), e.g.:

```bash
POSTGRES_ENABLED=true POSTGRES_HOST=localhost POSTGRES_PASSWORD=devpass \
  SERVICE_NAME=auth-service npm run dev
```

## Branch naming

Branch off `main` using a `<type>/<short-description>` pattern, matching
the commit types below, e.g.:

- `feat/readiness-check-timeout`
- `fix/rabbitmq-reconnect-loop`
- `chore/bump-trivy-action`
- `docs/security-gates-walkthrough`

## Commit messages

This repo follows [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<optional scope>): <short summary>

<optional body>
```

Common `<type>` values: `feat`, `fix`, `docs`, `chore`, `refactor`,
`test`, `ci`, `build`. Example:

```
fix(db): close idle postgres connections before pool resize
ci: pin trivy-action to v0.36.0
```

## What CI enforces on a pull request

Every PR against `main` runs the jobs defined in
[`.github/workflows/ci.yml`](.github/workflows/ci.yml), in order, each
gated on the previous one succeeding:

| Job | What fails it |
| --- | --- |
| `test` | `npm run lint` (ESLint, `eslint src test`) or `node --test test/` failing |
| `sast` | Semgrep (`p/nodejsscan`, `p/expressjs`) reporting a finding — always blocking; SonarCloud is advisory when `SONAR_TOKEN` isn't configured |
| `build` | The multi-stage `app/Dockerfile` failing to build |
| `scan` | Trivy finding a HIGH/CRITICAL CVE with an available fix in the built image (`ignore-unfixed: true`) — see [`docs/SECURITY-GATES.md`](docs/SECURITY-GATES.md) |
| `sign` | SBOM generation (Syft) or Cosign keyless signing failing |
| `push` | Cosign signature verification failing before the image is promoted |

`deploy-staging` and `deploy-prod` only run on a direct push to `main`
(not on pull requests), so a PR's pipeline stops after `push`: by the
time it's green, the image has been built, scanned, signed, and pushed
to GHCR under the commit SHA tag — nothing is deployed.

Before opening a PR, run `npm run lint` and `npm test` locally (see
above) — it's faster than waiting on CI to catch a lint error or a
failing test.

## Pull requests

Fill out [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md)
when you open the PR — it's the same checklist a reviewer will use.
Changes to `app/Dockerfile` or anything in the `scan`/`sign`/`push` jobs
get extra scrutiny since they sit directly on the security gates
documented in [`docs/SECURITY-GATES.md`](docs/SECURITY-GATES.md).
