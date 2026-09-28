# Security gates: what each one catches, and how it's verified

A YAML step that invokes a scanner is not the same thing as a gate. The
difference is whether a finding actually stops the pipeline
(`exit-code: 1`, no `continue-on-error`, a downstream job that `needs:`
the one that failed) or just uploads a report nobody is blocked by. This
document covers, gate by gate: what it catches, how blocking is enforced,
what a failure looks like, and where the evidence that it still works
lives.

## Gates

| Gate | Enforced in | What it catches | Mechanism |
| --- | --- | --- | --- |
| `go vet` equivalent — `npm run lint` (ESLint) | `test` job | Unused vars, `==` vs `===`, `var` usage, common correctness bugs | `eslint src test` exits non-zero on any `error`-level rule violation |
| `node --test` | `test` job | Regressions in route/handler behavior (`test/health.test.js`) | Non-zero process exit on any failing test |
| SonarCloud (SAST) | `sast` job | Bugs, code smells, security hotspots | Advisory — `continue-on-error: true` when `SONAR_TOKEN` isn't configured, so a missing SonarCloud org doesn't take down `sast` entirely |
| Semgrep (SAST fallback) | `sast` job | OWASP / Node.js / Express security anti-patterns (`p/nodejsscan`, `p/expressjs`) | **Blocking** — `--error` flag, always runs regardless of SonarCloud's outcome, so `sast` enforces something even when SonarCloud is unavailable |
| Trivy image scan | `scan` job | OS package + npm dependency CVEs in the built container | **Blocking** on HIGH/CRITICAL with an available fix (`exit-code: 1`, `ignore-unfixed: true`) — verified on a real failing run, see below |
| Cosign keyless signing + verify | `push` job | Unsigned or tampered images reaching production | **Blocking** — `push` verifies the Sigstore signature before promoting the `stable` tag; an unverifiable digest fails the job |
| Syft SBOM + Cosign attestation | `sign` job | Supply-chain provenance / composition | Advisory — recorded and attached to the image, not itself a gate |
| ArgoCD health check + smoke tests | `deploy-staging` / `deploy-prod` | Broken deploys | **Blocking** — a failed smoke test or unhealthy ArgoCD sync fails the job; failure in `deploy-prod` triggers `rollback` |
| Manual approval (`production` environment) | `deploy-prod` | Unreviewed production releases | **Blocking** — GitHub required reviewers on the environment |

## Verifying the Trivy gate specifically

The Trivy gate is the one most worth verifying continuously, because it's
also the easiest one to accidentally defang — a version bump to
`trivy-action`, a typo in `severity`, or someone adding
`continue-on-error: true` "just for now" would all silently turn it back
into a report. [`.github/workflows/verify-security-gates.yml`](../.github/workflows/verify-security-gates.yml)
exists to catch that:

- It builds [`app/Dockerfile.vulnerable`](../app/Dockerfile.vulnerable) —
  the same application as `app/Dockerfile`, same `npm install`, but the
  runtime stage sits on `node:16-alpine` instead of `node:20-alpine`, and
  drops the non-root `USER`. Node.js 16 reached End-of-Life in September
  2023: no further security patches are published for it or the Alpine
  package set pinned alongside it, so Trivy's vulnerability database has
  a permanent, accumulating supply of HIGH/CRITICAL CVEs against it.
- It runs the identical Trivy gate `ci.yml`'s `scan` job uses — same
  severity threshold, same `ignore-unfixed`, same `exit-code: 1` — against
  that image.
- It runs on a weekly `schedule` (Mondays 06:00 UTC) and on
  `workflow_dispatch`, so it doesn't depend on anyone remembering to run
  it before it matters (an audit, an incident review, a "prove the
  pipeline actually blocks bad images" question).
- The gate step is **expected to fail** every run. That failure is the
  control working. If this workflow ever goes green, the gate has stopped
  blocking and that's a finding to investigate immediately — not evidence
  that the base image got safer.

It is isolated from `ci.yml` on its own workflow file and trigger set: it
never runs on `push`/`pull_request` to `main`, never pushes an image
anywhere, and stops after the scan step — it cannot block a real change.

## How to reproduce it manually

From a clone of this repo, no code changes needed —
`app/Dockerfile.vulnerable` already exists on every branch. Open the
repository's **Actions** tab, select **verify-security-gates**, and run it
via `workflow_dispatch`.

To see the same failure locally, without pushing anything or needing a
GitHub Actions runner (Docker and the `trivy` CLI required):

```bash
docker build -f app/Dockerfile.vulnerable -t telemetry-service:vulnerable app
trivy image --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 \
  telemetry-service:vulnerable
```

`trivy` install instructions:
https://aquasecurity.github.io/trivy/latest/getting-started/installation/
— the workflow itself needs nothing installed locally; it uses the
`aquasecurity/trivy-action` GitHub Action.

## Expected failure output

The **build** step succeeds — the vulnerable image is perfectly capable of
being built, that's what makes an EOL base image dangerous in practice:
nothing stops it from shipping. The **gate** step is what fails, with
Trivy exiting non-zero and the job going red. Output looks like:

```
telemetry-service:vulnerable-<sha> (alpine 3.x)
================================================
Total: 20+ (HIGH: NN, CRITICAL: NN)

┌───────────┬────────────────┬──────────┬────────┬────────────────────┬───────────────────┬─────────────────────────────────────────────┐
│  Library  │ Vulnerability  │ Severity │ Status │ Installed Version  │   Fixed Version    │                    Title                     │
├───────────┼────────────────┼──────────┼────────┼────────────────────┼───────────────────┼─────────────────────────────────────────────┤
│ libcrypto3│ CVE-2024-XXXXX │ CRITICAL │ fixed  │ 3.1.x              │ 3.1.y              │ openssl: ...                                 │
│ libssl3   │ CVE-2024-XXXXX │ HIGH     │ fixed  │ 3.1.x              │ 3.1.y              │ openssl: ...                                 │
│ ...       │ ...            │ ...      │ ...    │ ...                │ ...                │ ...                                           │
└───────────┴────────────────┴──────────┴────────┴────────────────────┴───────────────────┴─────────────────────────────────────────────┘

Error: Process completed with exit code 1.
```

(Exact CVE IDs and counts drift as both Trivy's database and Alpine's
package set change — the shape of the result, a table of fixable
HIGH/CRITICAL findings ending in a non-zero exit and a red job, is what's
stable and what matters.)

The failed run's job summary also carries a short note explaining that the
failure is intentional, so anyone landing on it cold isn't left wondering
whether something in the repo is broken.

## Where the evidence lives

Every run of `verify-security-gates` — scheduled or manually dispatched —
is retained under the repository's **Actions** tab for the standard GitHub
Actions log-retention window, and each run's Trivy findings are also
visible under the **Security** tab (SARIF upload, `category:
trivy-image-verify-security-gates`). That run history is the audit trail:
anyone can pull up "was this gate verified in the last N weeks, and did it
fail as expected" without taking anyone's word for it.

### Screenshot

> Capture a failed `verify-security-gates` run from the GitHub Actions tab
> (the red X on the `verify-trivy-gate` job, with the Trivy findings table
> expanded so the CVE table is visible) periodically as a point-in-time
> audit artifact, save it to
> `docs/images/verify-security-gates-failure.png`, and reference it here:
>
> `![Trivy gate blocking the verify-security-gates build](images/verify-security-gates-failure.png)`
