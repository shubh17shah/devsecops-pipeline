'use strict';

const express = require('express');
const pinoHttp = require('pino-http');
const logger = require('./logger');
const config = require('./config');
const { metricsMiddleware, metricsHandler } = require('./metrics');
const healthRoutes = require('./routes/health');
const apiRoutes = require('./routes/api');

/**
 * Builds and returns a configured Express app *without* starting an HTTP
 * listener or touching any dependency (DB/Redis/RabbitMQ all stay
 * uninitialized until a request needs them — see the lazy-init comments
 * in src/db and src/queue). Kept separate from server.js specifically so
 * tests (test/health.test.js) can exercise routes with supertest without
 * binding a real port or standing up infrastructure.
 */
function createApp() {
  const app = express();

  // Trust the first proxy hop (the in-cluster ALB/ingress) so req.ip and
  // the request logger reflect the real client address from
  // X-Forwarded-For instead of the load balancer's.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // Structured JSON request logging. Runs before routes so every request
  // — including ones that error out — gets a log line with method, path,
  // status and latency.
  app.use(
    pinoHttp({
      logger,
      autoLogging: {
        // Don't spam logs with the Kubernetes kubelet hitting /healthz
        // every few seconds — readiness/liveness probe traffic is noise,
        // not something worth a log line on every poll.
        ignore: (req) => req.url === '/healthz',
      },
    })
  );

  // /metrics is registered before metricsMiddleware so scraping it isn't
  // itself counted (see the comment on metricsHandler in src/metrics.js).
  app.get('/metrics', metricsHandler);
  app.use(metricsMiddleware);

  app.use(healthRoutes);
  app.use(apiRoutes);

  // 404 for anything unmatched above.
  app.use((req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  // Centralized error handler — every route forwards failures here via
  // next(err) instead of handling them inline, so error responses (shape,
  // status code, logging) stay consistent across every endpoint.
  // eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity (4 args); `next` must stay even though it's unused
  app.use((err, req, res, next) => {
    req.log ? req.log.error({ err }, 'unhandled request error') : logger.error({ err }, 'unhandled request error');
    if (res.headersSent) return;
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}

module.exports = { createApp };
