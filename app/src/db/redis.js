'use strict';

const Redis = require('ioredis');
const config = require('../config');

/** @type {import('ioredis') | null} */
let client = null;

/**
 * Lazily creates (on first call) and returns the shared ioredis client.
 * Same rationale as src/db/postgres.js: services running with
 * REDIS_ENABLED=false never open a socket for it.
 */
function getClient() {
  if (!config.redis.enabled) {
    throw new Error('Redis is disabled (REDIS_ENABLED=false); refusing to create a client');
  }

  if (!client) {
    client = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password || undefined,
      db: config.redis.db,
      connectTimeout: config.redis.connectTimeoutMs,
      maxRetriesPerRequest: config.redis.maxRetriesPerRequest,
      // lazyConnect defers the actual TCP connect until the first command
      // instead of at `new Redis(...)` time, matching the lazy-init
      // contract of this module (getClient() only builds the object;
      // connecting happens on first use).
      lazyConnect: true,

      // Exponential backoff capped at 5s, retried forever. A capped-but-
      // unbounded retry is the right default for a dependency that comes
      // back on its own (Redis restart, failover) — the alternative
      // (giving up after N tries) would mean permanently wedging this
      // pod's readiness even after Redis recovers, forcing a manual pod
      // restart to notice.
      retryStrategy(attempt) {
        return Math.min(attempt * 200, 5_000);
      },
    });

    client.on('error', (err) => {
      // ioredis emits 'error' on every failed reconnect attempt too; logging
      // here (rather than letting it throw) keeps a flapping Redis from
      // taking the process down along with it.
      // eslint-disable-next-line no-console -- logger isn't threaded through here to avoid a circular require with server.js
      console.error('Redis client error', err);
    });
  }

  return client;
}

/**
 * Used by GET /readyz. A PING round-trip proves the connection is live,
 * not just that the client object exists in memory.
 */
async function checkReadiness() {
  const result = await getClient().ping();
  if (result !== 'PONG') {
    throw new Error(`Unexpected Redis PING response: ${result}`);
  }
}

/**
 * Called from the SIGTERM handler in server.js. quit() flushes any
 * in-flight commands and closes the socket cleanly, as opposed to
 * disconnect() which drops it immediately.
 */
async function closeClient() {
  if (client) {
    await client.quit();
    client = null;
  }
}

module.exports = { getClient, checkReadiness, closeClient };
