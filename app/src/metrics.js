'use strict';

const client = require('prom-client');

// One registry per process, shared by the default Node.js/process metrics
// and the two HTTP metrics below, so /metrics exposes all of it together.
const register = new client.Registry();

register.setDefaultLabels({});
// Event loop lag, heap/RSS, GC pauses, open handles, etc. — free
// visibility into the Node.js runtime itself, not just our own code.
client.collectDefaultMetrics({ register });

// Labeled by route/method/status (not the raw URL) so cardinality stays
// bounded — an Express *route pattern* like "/api/v1/telemetry/:deviceId"
// is one label value no matter how many distinct device IDs are requested.
// Labeling on req.originalUrl instead would leak an unbounded number of
// time series into Prometheus, one per unique path ever hit.
const httpRequestDurationSeconds = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency in seconds.',
  labelNames: ['route', 'method', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests handled, labeled by route, method and status code.',
  labelNames: ['route', 'method', 'status'],
  registers: [register],
});

/**
 * Express middleware that records the two custom metrics above for every
 * request. Mounted before the routers in server.js so it wraps everything,
 * including 404s — a route that returns 404 is still an observation worth
 * having (e.g. a client hitting the wrong path).
 */
function metricsMiddleware(req, res, next) {
  const stopTimer = process.hrtime.bigint();

  res.on('finish', () => {
    // req.route is only set once Express has matched a route; for a 404
    // there's no route, so we fall back to a low-cardinality placeholder
    // instead of the raw path.
    const route = req.route ? `${req.baseUrl}${req.route.path}` : 'unmatched';
    const elapsedSeconds = Number(process.hrtime.bigint() - stopTimer) / 1e9;
    const labels = { route, method: req.method, status: res.statusCode };

    httpRequestDurationSeconds.observe(labels, elapsedSeconds);
    httpRequestsTotal.inc(labels);
  });

  next();
}

/**
 * Express handler for GET /metrics. Deliberately NOT wrapped in
 * metricsMiddleware in server.js — instrumenting the metrics endpoint with
 * the counters it itself exposes is a pointless feedback loop, and it also
 * means a slow /metrics scrape (e.g. under memory pressure) doesn't skew
 * the http_request_duration_seconds histogram for real traffic.
 */
async function metricsHandler(req, res) {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
}

module.exports = {
  register,
  metricsMiddleware,
  metricsHandler,
  httpRequestDurationSeconds,
  httpRequestsTotal,
};
