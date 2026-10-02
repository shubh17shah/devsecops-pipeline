## Summary

<!-- What does this change do, and why? -->

## Related issue(s)

<!-- Closes #123, relates to #456 -->

## Checklist

- [ ] `npm run lint` passes locally (`app/`)
- [ ] `npm test` passes locally (`node --test test/`)
- [ ] CI's `test`, `sast`, `build`, `scan`, `sign`, and `push` jobs are
      green on this PR (see `.github/workflows/ci.yml`)
- [ ] I reviewed the `scan` job's Trivy results and confirmed **no new
      HIGH/CRITICAL** vulnerabilities were introduced (see
      `docs/SECURITY-GATES.md`)
- [ ] No secrets, tokens, credentials, or `.env` files were added to the
      diff (check `git diff` yourself — don't rely on `.gitignore` alone)
- [ ] If `app/Dockerfile` or `app/Dockerfile.vulnerable` changed: the
      change is explained below and doesn't weaken the non-root user,
      base image pin, or multi-stage layout
- [ ] Docs updated if behavior, environment variables, endpoints, or
      pipeline jobs changed (`README.md`, `app/README.md`,
      `docs/SECURITY-GATES.md`, `docs/VAULT.md` as applicable)

## Dockerfile changes (if any)

<!-- If app/Dockerfile or app/Dockerfile.vulnerable changed, explain why.
     If not applicable, delete this section. -->

## Notes for reviewers

<!-- Anything a reviewer should pay extra attention to: risk areas,
     follow-up work, things intentionally left out of scope. -->
