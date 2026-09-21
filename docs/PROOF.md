# Proof: the Trivy gate actually blocks a build

Most "security pipeline" portfolio projects show a green checkmark and
ask you to take their word for it that a gate would catch something bad.
This one doesn't ask for that — `demo/vulnerable` is a branch that ships
a deliberately broken image and lets the pipeline fail in public,
on purpose, reproducibly.

## What this proves

- [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) builds
  `app/Dockerfile` and runs Trivy in its `scan` job with
  `severity: 'HIGH,CRITICAL'` and `exit-code: '1'`. That step is a gate,
  not a report: a HIGH/CRITICAL finding with a known fix fails the whole
  `build → scan → sign → push → deploy-staging → deploy-prod` chain,
  because every downstream job `needs:` the one before it.
- [`app/Dockerfile.vulnerable`](../app/Dockerfile.vulnerable) is the same
  application, built by the same builder stage, except the final stage
  sits on `ubuntu:16.04` ("Xenial") instead of
  `gcr.io/distroless/static-debian12:nonroot`, and drops the non-root
  `USER` instruction. Ubuntu 16.04 left End-of-Standard-Support in April
  2021 — nothing in its package set has been patched since, so Trivy's
  vulnerability database has years of accumulated HIGH/CRITICAL CVEs
  against it (glibc, openssl, bash, coreutils, and more, all present in
  the base layer even though the application itself is a single static
  Go binary).
- [`.github/workflows/vulnerable-demo.yml`](../.github/workflows/vulnerable-demo.yml)
  runs the identical Trivy gate — same severity threshold, same
  `ignore-unfixed`, same `exit-code: 1` — against that image, on its own
  branch and trigger, isolated so it can never accidentally block a real
  change to `main`. The run is *expected* to fail. That failure is the
  artifact this document is pointing at.

In short: this isn't a claim that the pipeline has a security gate, it's
a reproducible run of that gate stopping a bad image, committed to the
repo instead of asserted in a bullet point.

## How to reproduce it

From a clone of this repo, no code changes needed —
`app/Dockerfile.vulnerable` already exists on every branch;
`demo/vulnerable` only has to exist so the workflow's branch filter
fires:

```bash
git checkout -b demo/vulnerable
git push -u origin demo/vulnerable
```

Open the repository's **Actions** tab, select the **vulnerable-demo**
workflow, and watch the `build-and-scan-vulnerable` job. (It can also be
re-run on demand afterwards from the same tab via `workflow_dispatch`,
without pushing again.)

To see the same failure locally, without pushing anything or needing a
GitHub Actions runner (Docker and the `trivy` CLI required):

```bash
docker build -f app/Dockerfile.vulnerable -t devsecops-pipeline/app:vulnerable app
trivy image --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 \
  devsecops-pipeline/app:vulnerable
```

`trivy` install instructions:
https://aquasecurity.github.io/trivy/latest/getting-started/installation/
— the workflow itself needs nothing installed locally; it uses the
`aquasecurity/trivy-action` GitHub Action.

## Expected failure output

The **build** step succeeds — the vulnerable image is perfectly capable
of being built, that's what makes an EOL base image dangerous in
practice: nothing stops it from shipping. The **gate** step is what
fails, with Trivy exiting non-zero and the job going red. Output looks
like:

```
devsecops-pipeline/app:vulnerable-<sha> (ubuntu 16.04)
=======================================================
Total: 100+ (HIGH: NN, CRITICAL: NN)

┌─────────────┬────────────────┬──────────┬────────┬────────────────────┬───────────────────┬─────────────────────────────────────────────┐
│   Library   │ Vulnerability  │ Severity │ Status │ Installed Version  │   Fixed Version    │                    Title                     │
├─────────────┼────────────────┼──────────┼────────┼────────────────────┼───────────────────┼─────────────────────────────────────────────┤
│ libc6       │ CVE-2021-33574 │ CRITICAL │ fixed  │ 2.23-0ubuntu11     │ 2.23-0ubuntu11.3   │ glibc: mq_notify() use-after-free            │
│ libssl1.0.0 │ CVE-2016-2183  │ HIGH     │ fixed  │ 1.0.2g-1ubuntu4    │ 1.0.2g-1ubuntu4.20 │ openssl: 3DES ciphers downgraded ("SWEET32") │
│ bash        │ CVE-2019-18276 │ HIGH     │ fixed  │ 4.3-14ubuntu1.4    │ 4.3-14ubuntu1.5    │ bash: privilege escalation via disabled ...  │
│ ...         │ ...            │ ...      │ ...    │ ...                │ ...                │ ...                                           │
└─────────────┴────────────────┴──────────┴────────┴────────────────────┴───────────────────┴─────────────────────────────────────────────┘

Error: Process completed with exit code 1.
```

(Exact CVE IDs and counts drift as Trivy's database updates — the shape
of the result, a table of fixable HIGH/CRITICAL findings ending in a
non-zero exit and a red job, is what's stable and what matters.)

The failed run's job summary also carries a short note explaining that
the failure is intentional, so a reviewer landing on it cold isn't left
wondering whether something in the repo is broken.

## Screenshot

> **TODO — add screenshot:** capture the failed `vulnerable-demo` run
> from the GitHub Actions tab (the red ✗ on the
> `build-and-scan-vulnerable` job, ideally with the Trivy findings table
> expanded so the CVE table is visible). Save it to
> `docs/images/vulnerable-demo-failure.png`, then replace this callout
> with:
>
> `![Trivy gate blocking the vulnerable-demo build](images/vulnerable-demo-failure.png)`

## Why this matters in an interview

Anyone can write a YAML step that calls a scanner. The differentiator is
proving the step is wired as an actual gate — `exit-code: 1`, no
`continue-on-error`, downstream jobs `needs:` it — and not decoration
that uploads a report nobody is blocked by. `demo/vulnerable` is that
proof: a branch, a workflow, and a run anyone can trigger and inspect
themselves, rather than a claim to take on faith.
