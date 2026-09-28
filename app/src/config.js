'use strict';

// Single source of truth for runtime configuration. Every other module
// requires *this* file rather than reading process.env directly, so there
// is exactly one place that knows the env var names, defaults, and types —
// and exactly one place a reviewer needs to check to see the full surface
// of what's configurable.
//
// SERVICE_NAME is the important one: this is the one container image that
// all 12 microservices in this platform run (see README.md "Why one
// image"). Every other env var below is infrastructure config (ports,
// hosts, pool sizes); SERVICE_NAME is identity — it's what makes a pod
// running this image "auth-service" instead of "telemetry-ingest" in logs,
// metrics labels, and the JSON body of GET /.

function str(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function int(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) {
    throw new ConfigError(`${name} must be an integer, got: ${v}`);
  }
  return n;
}

function bool(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const normalized = v.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  throw new ConfigError(`${name} must be a boolean-ish value (true/false/1/0), got: ${v}`);
}

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const VALID_LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];
const VALID_NODE_ENVS = ['development', 'test', 'production'];

const config = {
  serviceName: str('SERVICE_NAME', 'telemetry-service'),
  nodeEnv: str('NODE_ENV', 'development'),
  port: int('PORT', 8080),
  logLevel: str('LOG_LEVEL', 'info'),

  // How long we give in-flight requests (and dependency pools) to drain
  // after SIGTERM before we give up and force-exit. Must stay comfortably
  // under the pod's terminationGracePeriodSeconds (charts/microservice
  // defaults that to 30s) or Kubernetes SIGKILLs us before we finish.
  shutdownTimeoutMs: int('SHUTDOWN_TIMEOUT_MS', 10_000),

  // Optional pause between "stop accepting new work" and "start closing
  // connections" — see the comment on this same env var in server.js for
  // why a rolling update needs it at all.
  preShutdownDelayMs: int('PRE_SHUTDOWN_DELAY_MS', 0),

  postgres: {
    enabled: bool('POSTGRES_ENABLED', false),
    host: str('POSTGRES_HOST', 'localhost'),
    port: int('POSTGRES_PORT', 5432),
    database: str('POSTGRES_DB', 'telemetry'),
    user: str('POSTGRES_USER', 'telemetry'),
    password: str('POSTGRES_PASSWORD', ''),
    ssl: bool('POSTGRES_SSL', false),
    // Kept deliberately small — see the "pool sizing" comment in
    // src/db/postgres.js for why this number matters at fleet scale, not
    // just per-pod.
    poolMax: int('POSTGRES_POOL_MAX', 5),
    idleTimeoutMs: int('POSTGRES_IDLE_TIMEOUT_MS', 30_000),
    connectionTimeoutMs: int('POSTGRES_CONNECTION_TIMEOUT_MS', 5_000),
  },

  redis: {
    enabled: bool('REDIS_ENABLED', false),
    host: str('REDIS_HOST', 'localhost'),
    port: int('REDIS_PORT', 6379),
    password: str('REDIS_PASSWORD', ''),
    db: int('REDIS_DB', 0),
    connectTimeoutMs: int('REDIS_CONNECT_TIMEOUT_MS', 5_000),
    maxRetriesPerRequest: int('REDIS_MAX_RETRIES_PER_REQUEST', 3),
  },

  rabbitmq: {
    enabled: bool('RABBITMQ_ENABLED', false),
    url: str('RABBITMQ_URL', 'amqp://guest:guest@localhost:5672'),
    exchange: str('RABBITMQ_EXCHANGE', 'telemetry'),
    exchangeType: str('RABBITMQ_EXCHANGE_TYPE', 'topic'),
    queue: str('RABBITMQ_QUEUE', 'telemetry.ingest'),
    routingKey: str('RABBITMQ_ROUTING_KEY', 'telemetry.reading'),
    reconnectDelayMs: int('RABBITMQ_RECONNECT_DELAY_MS', 2_000),
  },
};

function validate(cfg) {
  const errors = [];

  if (!cfg.serviceName) errors.push('SERVICE_NAME must not be empty');
  if (cfg.port < 1 || cfg.port > 65535) errors.push(`PORT out of range: ${cfg.port}`);
  if (!VALID_LOG_LEVELS.includes(cfg.logLevel)) {
    errors.push(`LOG_LEVEL must be one of ${VALID_LOG_LEVELS.join(', ')}, got: ${cfg.logLevel}`);
  }
  if (!VALID_NODE_ENVS.includes(cfg.nodeEnv)) {
    errors.push(`NODE_ENV must be one of ${VALID_NODE_ENVS.join(', ')}, got: ${cfg.nodeEnv}`);
  }
  if (cfg.shutdownTimeoutMs < 0) errors.push('SHUTDOWN_TIMEOUT_MS must be >= 0');

  if (cfg.postgres.enabled) {
    if (!cfg.postgres.host) errors.push('POSTGRES_HOST is required when POSTGRES_ENABLED=true');
    if (!cfg.postgres.database) errors.push('POSTGRES_DB is required when POSTGRES_ENABLED=true');
    if (cfg.postgres.poolMax < 1) errors.push('POSTGRES_POOL_MAX must be >= 1');
  }

  if (cfg.redis.enabled && !cfg.redis.host) {
    errors.push('REDIS_HOST is required when REDIS_ENABLED=true');
  }

  if (cfg.rabbitmq.enabled) {
    if (!cfg.rabbitmq.url) errors.push('RABBITMQ_URL is required when RABBITMQ_ENABLED=true');
    if (!cfg.rabbitmq.queue) errors.push('RABBITMQ_QUEUE is required when RABBITMQ_ENABLED=true');
  }

  if (errors.length > 0) {
    throw new ConfigError(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
  }
}

// Fail fast: an invalid config should crash the process at startup (and
// get caught by CrashLoopBackOff / a failed readiness gate), not surface
// later as a confusing runtime error on the first request that touches it.
validate(config);

module.exports = config;
module.exports.ConfigError = ConfigError;
