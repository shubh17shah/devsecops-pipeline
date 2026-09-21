# syntax=docker/dockerfile:1

# ---- build stage -----------------------------------------------------------
FROM golang:1.23-alpine AS builder

WORKDIR /src

# Cache module downloads in their own layer, separate from source changes.
COPY go.mod ./
RUN go mod download

COPY . .

ARG VERSION=dev
ENV CGO_ENABLED=0 \
    GOOS=linux \
    GOARCH=amd64

RUN go vet ./... \
    && go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /out/app .

# ---- final stage ------------------------------------------------------------
# distroless/static: no shell, no package manager, no libc — nothing an
# attacker can use to pivot, and nothing for Trivy to flag beyond the CVE
# database bundled with the base image itself.
FROM gcr.io/distroless/static-debian12:nonroot AS final

WORKDIR /

COPY --from=builder /out/app /app

# Explicit for clarity even though the ":nonroot" tag already sets this
# UID/GID; several image scanners flag images without an explicit USER.
USER 65532:65532

EXPOSE 8080

# distroless ships no shell/curl/wget, so the same static binary doubles as
# its own HTTP healthcheck client via `/app healthcheck` (see app/main.go).
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD ["/app", "healthcheck"]

ENTRYPOINT ["/app"]
