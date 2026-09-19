# devsecops-pipeline

End-to-end CI/CD pipeline with security gates enforced at every stage.

## Pipeline

    lint + unit tests
      -> SonarQube SAST
      -> multi-stage Docker build (non-root, distroless)
      -> Trivy scan  [FAILS BUILD on HIGH/CRITICAL]
      -> SBOM (Syft) + image signing (Cosign)
      -> push to registry
      -> ArgoCD deploy to staging + smoke tests
      -> manual approval gate
      -> production
      -> automatic rollback on failed health check

## Stack

GitHub Actions · Docker · Trivy · SonarQube · Syft · Cosign · ArgoCD · HashiCorp Vault

## Proof the gates work

A branch carries a deliberately vulnerable dependency, demonstrating Trivy
blocking the build. See `docs/`.

## Secrets

No hardcoded secrets. GitHub OIDC for cloud auth, Vault for application secrets.

## Status

In progress.
