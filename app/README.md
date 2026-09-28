# telemetry-service

The Node.js/Express service behind every workload on this platform. A single
container image serves all 12 microservices, with identity and enabled
dependencies driven entirely by environment variables.

This directory is the application half of a two-repo delivery pipeline:
this repo (`devsecops-pipeline`) builds, tests, scans, signs and pushes the
image; [`shubh17shah/eks-platform`](https://github.com/shubh17shah/eks-platform)
holds the Terraform, Helm chart, and ArgoCD Applications that deploy it. See
the top-level [README.md](../README.md) for the full pipeline and how the
two repos fit together.

## Why one image serves all 12 services

Every one of the 12 `argocd/apps/*.yaml` Applications in `eks-platform`
(`api-gateway`, `auth-service`, `telemetry-ingest`, `telemetry-query`, ... )
points `charts/microservice` at this same image. What makes a running pod
*"auth-service"* instead of *"telemetry-ingest"* is not a different build —
it's a different `values-*.yaml` setting `SERVICE_NAME` (and whichever
`*_ENABLED` dependency flags that instance actually needs) as env vars on
an otherwise identical Deployment. `GET /` on any instance reports its own
identity straight from that env var, which is the fastest way to confirm,
while debugging, which "service" a given pod actually is.

This is a deliberate design choice, not a shortcut:

- **One image to build, scan, and promote.** CI builds and vulnerability-
  scans this image exactly once per commit instead of 12 times; the same
  tag gets promoted through environments for every service together,
  instead of tracking 12 independent version skews.
- **Config-driven identity is how the rest of this platform already
  works.** `charts/microservice` is one generic Helm chart parameterized
  by 12 values files (see the `eks-platform` README) — this mirrors that
  pattern at the application layer instead of fighting it with 12 bespoke
  codebases.
- **Dependencies are opt-in per instance, not per build.** `POSTGRES_ENABLED`,
  `REDIS_ENABLED`, and `RABBITMQ_ENABLED` let e.g. `auth-service` turn on
  Postgres+Redis while `notification-service` turns on RabbitMQ only —
  same binary, different runtime shape, no rebuild.
- **The honest trade-off:** a platform with 12 genuinely different services
  would eventually outgrow one shared codebase (they'd want independent
  deploy cadences, different language runtimes for different workloads,
  etc.). For a project demonstrating the infrastructure/delivery layer —
  not 12 different pieces of business logic — one well-built service
  that's *configured* differently per instance is more representative of
  how platform teams actually think about "the app" than 12 near-duplicate
  stubs would be.

## Endpoints

| Method | Path                          | Purpose                                                                 |
| ------ | ----------------------------- | ------------------------------------------------------------------------ |
| GET    | `/`                            | Service identity (`SERVICE_NAME`, env, a hello message).                |
| GET    | `/healthz`                     | Liveness probe — process is alive. No dependency checks (see below).    |
| GET    | `/readyz`                      | Readiness probe — process alive **and** enabled dependencies reachable. |
| GET    | `/metrics`                     | Prometheus exposition format (default Node.js metrics + HTTP metrics).  |
| GET    | `/api/v1/devices`               | List known devices (requires `POSTGRES_ENABLED=true`).                  |
| POST   | `/api/v1/telemetry`             | Publish a telemetry reading to RabbitMQ (requires `RABBITMQ_ENABLED=true`). |
| GET    | `/api/v1/telemetry/:deviceId`   | Query recent readings for a device from Timescale (requires `POSTGRES_ENABLED=true`). |

### Liveness vs. readiness

`/healthz` and `/readyz` answer different questions on purpose (fully
commented in `src/routes/health.js`):

- **`/healthz` (liveness)** — "should Kubernetes restart this pod?" Checks
  nothing but the process itself. If it checked Postgres and Postgres blipped,
  every pod across every service using it would fail liveness at once and
  Kubernetes would restart the entire fleet simultaneously — restarting a
  healthy process doesn't fix a downstream outage, and the resulting
  restart storm makes it worse.
- **`/readyz` (readiness)** — "should this pod currently receive traffic?"
  Checks every *enabled* dependency (Postgres/Redis/RabbitMQ) and reports
  per-dependency status. A pod that can't reach a dependency drops out of
  the Service's routing without being killed, and rejoins automatically
  once the dependency recovers.

## Environment variables

`src/config.js` is the single source of truth — it reads every one of
these, applies the default shown, and validates the result at startup
(invalid values crash the process immediately rather than failing later on
the first request that touches them).

| Variable | Default | Purpose |
| --- | --- | --- |
| `SERVICE_NAME` | `telemetry-service` | Identity of this instance — drives `GET /`, log lines, and Grafana labels. Set per-service in `eks-platform`'s `charts/values/*.yaml`. |
| `NODE_ENV` | `development` | `development` \| `test` \| `production`. |
| `PORT` | `8080` | HTTP listen port. |
| `LOG_LEVEL` | `info` | pino level: `fatal`\|`error`\|`warn`\|`info`\|`debug`\|`trace`\|`silent`. |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Max time graceful shutdown is given before a force-exit. Must stay under the pod's `terminationGracePeriodSeconds`. |
| `PRE_SHUTDOWN_DELAY_MS` | `0` | Pause before shutdown begins draining, to cover the delay between a pod receiving SIGTERM and its removal from Service Endpoints propagating cluster-wide. |
| `POSTGRES_ENABLED` | `false` | Turns on the Postgres pool and the endpoints that depend on it. |
| `POSTGRES_HOST` | `localhost` | Postgres/Timescale host. |
| `POSTGRES_PORT` | `5432` | Postgres port. |
| `POSTGRES_DB` | `telemetry` | Database name. |
| `POSTGRES_USER` | `telemetry` | Database user. |
| `POSTGRES_PASSWORD` | *(empty)* | Database password — supplied via a Kubernetes Secret, never baked into the image. |
| `POSTGRES_SSL` | `false` | Enable TLS to Postgres. |
| `POSTGRES_POOL_MAX` | `5` | Max connections in this pod's pool. Kept small deliberately — see `src/db/postgres.js`; it's a fleet-wide budget, not a per-pod tuning knob. |
| `POSTGRES_IDLE_TIMEOUT_MS` | `30000` | How long an idle pooled connection is kept before being closed. |
| `POSTGRES_CONNECTION_TIMEOUT_MS` | `5000` | How long to wait for a new connection before failing. |
| `REDIS_ENABLED` | `false` | Turns on the Redis client. |
| `REDIS_HOST` | `localhost` | Redis host. |
| `REDIS_PORT` | `6379` | Redis port. |
| `REDIS_PASSWORD` | *(empty)* | Redis auth password, from a Secret. |
| `REDIS_DB` | `0` | Redis logical DB index. |
| `REDIS_CONNECT_TIMEOUT_MS` | `5000` | Initial connection timeout. |
| `REDIS_MAX_RETRIES_PER_REQUEST` | `3` | ioredis per-command retry cap before a command fails instead of queuing forever. |
| `RABBITMQ_ENABLED` | `false` | Turns on the AMQP connection/channel and the endpoints that depend on it. |
| `RABBITMQ_URL` | `amqp://guest:guest@localhost:5672` | Full AMQP connection URI, credentials included — from a Secret in any real environment. |
| `RABBITMQ_EXCHANGE` | `telemetry` | Exchange asserted/published to. |
| `RABBITMQ_EXCHANGE_TYPE` | `topic` | Exchange type. |
| `RABBITMQ_QUEUE` | `telemetry.ingest` | Queue asserted and bound for `consume()`. |
| `RABBITMQ_ROUTING_KEY` | `telemetry.reading` | Default routing key used by `publish()`. |
| `RABBITMQ_RECONNECT_DELAY_MS` | `2000` | Delay before retrying after an unexpected connection close. |

## Local development

No dependency was installed by hand while authoring this service, so there
is no `package-lock.json` committed yet. Generate it once, locally, before
running anything:

```bash
cd app
npm install          # resolves deps and writes package-lock.json
npm run lint          # eslint src test
npm test               # node --test test/  (pure unit/route tests, no infra required)
npm run dev             # nodemon src/server.js — all *_ENABLED default to false
```

With every `*_ENABLED` flag left at its default `false`, the service comes
up with no external dependencies at all — `/`, `/healthz`, `/readyz`,
and `/metrics` all work immediately; `/readyz` reports every dependency as
`"disabled"` rather than failing.

To exercise a dependency locally, set its `*_ENABLED` flag plus its
connection variables from the table above, e.g.:

```bash
POSTGRES_ENABLED=true POSTGRES_HOST=localhost POSTGRES_PASSWORD=devpass \
  SERVICE_NAME=auth-service npm run dev
```

### Building the image

```bash
docker build -t telemetry-service:local app
docker run --rm -p 8080:8080 -e SERVICE_NAME=api-gateway telemetry-service:local
curl localhost:8080/
```

See the comment at the top of `Dockerfile`'s `deps` stage for why it runs
`npm install` (generating the lockfile inside the build) rather than `npm
ci` until `package-lock.json` is committed.

## Layout

```
app/
├── src/
│   ├── app.js            # Express app construction — no listen(), no side effects at import time
│   ├── server.js          # listen() + SIGTERM/SIGINT graceful shutdown
│   ├── config.js           # env vars -> validated config, single source of truth
│   ├── logger.js            # pino instance, structured JSON to stdout
│   ├── metrics.js            # prom-client registry + custom HTTP metrics + /metrics handler
│   ├── routes/
│   │   ├── health.js          # /healthz, /readyz
│   │   └── api.js              # /, /api/v1/devices, /api/v1/telemetry[/:deviceId]
│   ├── db/
│   │   ├── postgres.js          # pg Pool, lazy-init, parameterized queries only
│   │   └── redis.js              # ioredis client, lazy-init, retry strategy
│   └── queue/
│       └── rabbit.js              # amqplib connection/channel, publish + consume, reconnect-on-close
├── test/
│   └── health.test.js              # node:test + supertest against src/app.js
├── Dockerfile                       # multi-stage, non-root, dumb-init, HEALTHCHECK
├── Dockerfile.vulnerable            # EOL base image, used only to verify the Trivy gate blocks
├── .dockerignore
├── .eslintrc.json
└── package.json
```
