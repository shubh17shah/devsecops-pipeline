# syntax=docker/dockerfile:1

# ---- deps stage ---------------------------------------------------------
# package-lock.json isn't committed (this image was authored without
# `npm ci` installs exactly what package-lock.json pins — no version
# drift between this build and any other. It also fails loudly if the
# lockfile and package.json disagree, which is the behaviour you want
# in a build: a surprising dependency should break CI, not production.
RUN npm ci --omit=dev && npm cache clean --force

# ---- runtime stage -------------------------------------------------------
# Same base as the deps stage (not a from-scratch/distroless image):
# Node.js needs its runtime present regardless, and node:20-alpine already
# gives us a non-root `node` user (uid 1000) and a package manager for the
# one runtime tool we add below, at ~180MB rather than a full Debian base.
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# dumb-init is PID 1 in the container and forwards signals (SIGTERM from
# `kubectl delete pod` / a rolling update) to the actual `node` process
# and reaps zombie processes. Node.js run directly as PID 1 does receive
# signals, but PID 1 has kernel-assigned default-disposition quirks
# (e.g. it never gets default handlers for signals it doesn't explicitly
# listen for, and won't reap orphaned children) — dumb-init removes the
# ambiguity for a couple hundred KB.
RUN apk add --no-cache dumb-init

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# No secrets baked in anywhere above: POSTGRES_PASSWORD, REDIS_PASSWORD
# and the credentials embedded in RABBITMQ_URL are all read from the
# environment at runtime (src/config.js) and supplied by the Deployment's
# envFrom/Secret refs in charts/microservice — never as an ARG/ENV/COPY
# here, which would bake them into a layer that anyone who can pull the
# image could read back out.

# The `node` user/group (uid/gid 1000) ships built into the base image;
# chown so it can actually read what got COPYed in as root above.
RUN chown -R node:node /app
USER node

EXPOSE 8080

# Uses Node's own http client instead of curl/wget so the runtime image
# doesn't need either installed. Hits /healthz (liveness), not /readyz —
# HEALTHCHECK exists for docker-run/standalone use; under Kubernetes the
# kubelet's own liveness/readinessProbe (charts/microservice/templates/
# deployment.yaml) supersedes this entirely.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz',res=>process.exit(res.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/server.js"]
