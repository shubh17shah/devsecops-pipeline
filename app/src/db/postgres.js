'use strict';

const { Pool } = require('pg');
const config = require('../config');

/** @type {import('pg').Pool | null} */
let pool = null;

/**
 * Lazily creates (on first call) and returns the shared connection pool.
 * Nothing connects to Postgres at module-require time — only once a
 * request actually needs the database does a pool (and its first
 * connection) get created. That matters for the 9 of 12 services in this
 * fleet that run with POSTGRES_ENABLED=false: importing this file (e.g.
 * transitively, since it's the same image for every service) never opens
 * a socket they don't need.
 *
 * Pool sizing: POSTGRES_POOL_MAX defaults to 5, deliberately conservative.
 * This is a per-*pod* pool, and this same image runs many pods across 12
 * services, each autoscaled independently — the number that actually
 * matters is (sum of replicas across every service with Postgres enabled)
 * x poolMax, which has to stay under the database's max_connections (a
 * small RDS/Aurora instance is commonly capped at 100-200). Raising this
 * value helps exactly one pod's throughput while eating into a budget
 * shared by the whole fleet, so it's tuned fleet-wide, not per-incident.
 */
function getPool() {
  if (!config.postgres.enabled) {
    throw new Error('Postgres is disabled (POSTGRES_ENABLED=false); refusing to create a pool');
  }

  if (!pool) {
    pool = new Pool({
      host: config.postgres.host,
      port: config.postgres.port,
      database: config.postgres.database,
      user: config.postgres.user,
      password: config.postgres.password,
      ssl: config.postgres.ssl ? { rejectUnauthorized: false } : false,
      max: config.postgres.poolMax,
      idleTimeoutMillis: config.postgres.idleTimeoutMs,
      connectionTimeoutMillis: config.postgres.connectionTimeoutMs,
    });

    // A connection dying in the idle pool (network blip, RDS failover)
    // shouldn't crash the process — pg re-establishes it on next checkout.
    // Without this handler an idle-client error is an uncaught 'error'
    // event, which is fatal in Node.js.
    pool.on('error', (err) => {
      // eslint-disable-next-line no-console -- logger isn't threaded through here to avoid a circular require with server.js
      console.error('Unexpected error on idle Postgres client', err);
    });
  }

  return pool;
}

/**
 * Runs a parameterized query against the pool. Always use this (or
 * pool.query directly with a placeholder array) — never template/concat
 * user input into SQL text. `$1, $2, ...` placeholders are filled in by
 * the pg driver, not string-interpolated, which is what actually prevents
 * SQL injection here.
 * @param {string} text
 * @param {unknown[]} [params]
 */
async function query(text, params = []) {
  return getPool().query(text, params);
}

/**
 * Cheap liveness-of-connection check used by GET /readyz. SELECT 1 is
 * enough to prove "a connection can be opened/reused and the server
 * responds" without touching real tables or taking locks.
 */
async function checkReadiness() {
  await query('SELECT 1');
}

/**
 * Called from the SIGTERM handler in server.js. Waits for checked-out
 * clients to be returned and closes every socket in the pool — if we
 * exit without this, in-flight queries get their TCP connections cut
 * mid-response instead of finishing cleanly.
 */
async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { getPool, query, checkReadiness, closePool };
