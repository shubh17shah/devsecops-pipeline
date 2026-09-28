'use strict';

const express = require('express');
const config = require('../config');
const postgres = require('../db/postgres');
const redis = require('../db/redis');
const rabbit = require('../queue/rabbit');

const router = express.Router();

// ---------------------------------------------------------------------
// Liveness vs. readiness — these answer different questions, and mixing
// them up is a classic way to take a whole fleet down:
//
//   /healthz (liveness) — "is this process alive and able to make
//   forward progress, or is it wedged and needs a restart?" It must NOT
//   check downstream dependencies. If it did, a Postgres blip would make
//   Kubernetes think every pod is unhealthy and restart all of them
//   simultaneously — restarting a healthy process fixes nothing when the
//   real problem is a downstream outage, and the resulting restart storm
//   (all pods gone at once, then all reconnecting at once) makes that
//   outage worse.
//
//   /readyz (readiness) — "can this pod currently serve traffic
//   correctly?" This DOES check dependencies: a pod that's alive but
//   can't reach Postgres/Redis/RabbitMQ should be pulled out of the
//   Service's load-balancing rotation (no Endpoints entry) without being
//   killed, so it stops receiving requests it can't fulfill but comes
//   back automatically the moment the dependency recovers.
// ---------------------------------------------------------------------

router.get('/healthz', (req, res) => {
  // No dependency checks here on purpose (see comment above). If this
  // handler can run at all, the event loop isn't blocked and the process
  // is alive — that's the entire question liveness is allowed to ask.
  res.status(200).json({ status: 'ok', service: config.serviceName });
});

router.get('/readyz', async (req, res) => {
  const checks = {};
  let allHealthy = true;

  // Each enabled dependency is checked independently so a single failure
  // is reported by name in the response body instead of a bare 503 —
  // useful when debugging why a pod dropped out of rotation.
  const checkList = [
    ['postgres', config.postgres.enabled, postgres.checkReadiness],
    ['redis', config.redis.enabled, redis.checkReadiness],
    ['rabbitmq', config.rabbitmq.enabled, rabbit.checkReadiness],
  ];

  await Promise.all(
    checkList.map(async ([name, enabled, check]) => {
      if (!enabled) {
        checks[name] = 'disabled';
        return;
      }
      try {
        await check();
        checks[name] = 'ok';
      } catch (err) {
        checks[name] = `error: ${err.message}`;
        allHealthy = false;
      }
    })
  );

  const status = allHealthy ? 200 : 503;
  res.status(status).json({ status: allHealthy ? 'ok' : 'unavailable', service: config.serviceName, checks });
});

module.exports = router;
