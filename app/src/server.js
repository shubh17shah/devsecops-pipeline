'use strict';

const { createApp } = require('./app');
const config = require('./config');
const logger = require('./logger');
const postgres = require('./db/postgres');
const redis = require('./db/redis');
const rabbit = require('./queue/rabbit');

const app = createApp();

const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, `${config.serviceName} listening`);
});

// ---------------------------------------------------------------------
// Graceful shutdown on SIGTERM.
//
// Why this matters more here than on a laptop: every rolling update,
// every HPA scale-down, and every node drain in Kubernetes terminates
// pods by sending SIGTERM and then, after terminationGracePeriodSeconds
// (30s by default in charts/microservice), SIGKILL if the process hasn't
// exited by then. This isn't an edge case — for a service that gets
// redeployed regularly, it is one of the most common ways the process
// ever stops. Exiting immediately on SIGTERM (the Node.js default if
// nothing handles it: the process just dies) drops every in-flight HTTP
// request and abandons open DB/Redis/AMQP sockets mid-operation instead
// of finishing or failing them cleanly.
//
// There is also a well-known race: kubelet sends SIGTERM to the
// container at (roughly) the same moment it starts removing the pod from
// the Service's Endpoints/EndpointSlice, but that removal has to
// propagate to every kube-proxy/node before traffic actually stops
// arriving. Without PRE_SHUTDOWN_DELAY_MS, a pod can receive SIGTERM and
// start closing its listening socket while some nodes are still routing
// requests to it, which turns into connection-refused errors for
// clients. Setting PRE_SHUTDOWN_DELAY_MS (0 by default; a couple of
// seconds is typical in production) inserts a pause where the process
// keeps accepting new connections normally before shutdown begins,
// giving that propagation time to finish.
// ---------------------------------------------------------------------

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutdown signal received, draining');

  // Force-exit safety net: if closing connections hangs (a stuck query, a
  // broker that never confirms channel.close), don't let the process
  // linger past SHUTDOWN_TIMEOUT_MS and get SIGKILLed with no log output
  // explaining why. This timer is unref()'d implicitly by process.exit
  // below in the success path; if it fires, exit(1) makes the failure
  // visible in the pod's exit code / kubectl describe.
  const forceExitTimer = setTimeout(() => {
    logger.error({ signal }, 'graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, config.shutdownTimeoutMs);
  forceExitTimer.unref();

  try {
    if (config.preShutdownDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, config.preShutdownDelayMs));
    }

    // Stop accepting new connections and wait for in-flight requests to
    // finish. server.close()'s callback only fires once every open
    // connection has ended, which is exactly the "drain" behavior we want.
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    logger.info('http server drained');

    // Close dependency pools/connections after the HTTP server, not
    // before — a request that's still finishing above may need them.
    // Each close is independently safe to call even if that dependency
    // was never enabled/initialized (see the lazy-init guards in
    // src/db/postgres.js, src/db/redis.js, src/queue/rabbit.js).
    await Promise.all([postgres.closePool(), redis.closeClient(), rabbit.closeConnection()]);
    logger.info('dependency connections closed');

    clearTimeout(forceExitTimer);
    logger.info('shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'error during graceful shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT')); // Ctrl+C during local `npm run dev`

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandled promise rejection');
});

process.on('uncaughtException', (err) => {
  // An uncaught synchronous throw means the process is in an unknown
  // state — log it and exit rather than limping on; Kubernetes restarts
  // the container and, assuming the fault was transient, a fresh process
  // recovers cleanly.
  logger.fatal({ err }, 'uncaught exception, exiting');
  process.exit(1);
});

module.exports = { app, server };
