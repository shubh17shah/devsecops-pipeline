'use strict';

const express = require('express');
const config = require('../config');
const postgres = require('../db/postgres');
const rabbit = require('../queue/rabbit');

const router = express.Router();

// GET / — service identity. What confirms, when you exec into a pod or
// curl it during a rollout, *which* of the 12 services this particular
// instance of the shared image is currently configured to be.
router.get('/', (req, res) => {
  res.status(200).json({
    service: config.serviceName,
    message: `hello from ${config.serviceName}`,
    env: config.nodeEnv,
  });
});

// GET /api/v1/devices — a representative "list resources" endpoint.
// Parameterized LIMIT: even a value we generate ourselves (not raw user
// input) goes through a placeholder, so this stays the one and only
// pattern used for building queries anywhere in the codebase — no
// "it's fine this one time" exceptions that end up copy-pasted later.
router.get('/api/v1/devices', async (req, res, next) => {
  if (!config.postgres.enabled) {
    return res.status(503).json({ error: 'Postgres is disabled for this service instance' });
  }

  try {
    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 50, 200);
    const result = await postgres.query(
      'SELECT device_id, name, last_seen_at FROM devices ORDER BY last_seen_at DESC LIMIT $1',
      [limit]
    );
    res.status(200).json({ devices: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/telemetry — ingestion endpoint. Publishes to RabbitMQ
// rather than writing to Postgres itself: this keeps the write path
// decoupled and fast (an HTTP request doesn't wait on a database round
// trip) and lets ingestion be scaled and retried independently of the API
// — a separate consumer (see src/queue/rabbit.js consume()) is
// responsible for durably writing readings into Timescale.
router.post('/api/v1/telemetry', express.json(), async (req, res, next) => {
  if (!config.rabbitmq.enabled) {
    return res.status(503).json({ error: 'RabbitMQ is disabled for this service instance' });
  }

  const { deviceId, metric, value, timestamp } = req.body || {};

  if (typeof deviceId !== 'string' || !deviceId) {
    return res.status(400).json({ error: 'deviceId (string) is required' });
  }
  if (typeof metric !== 'string' || !metric) {
    return res.status(400).json({ error: 'metric (string) is required' });
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return res.status(400).json({ error: 'value (finite number) is required' });
  }

  try {
    await rabbit.publish({
      deviceId,
      metric,
      value,
      timestamp: timestamp || new Date().toISOString(),
    });
    res.status(202).json({ status: 'accepted' });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/telemetry/:deviceId — queries readings for one device out
// of Timescale (a Postgres extension, so it's the same pool/query path as
// devices above). :deviceId and the optional ?since are both bound as
// query parameters ($1/$2) rather than interpolated into the SQL string —
// the only thing that actually prevents SQL injection.
router.get('/api/v1/telemetry/:deviceId', async (req, res, next) => {
  if (!config.postgres.enabled) {
    return res.status(503).json({ error: 'Postgres is disabled for this service instance' });
  }

  try {
    const { deviceId } = req.params;
    const since = req.query.since ? new Date(req.query.since) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    if (Number.isNaN(since.getTime())) {
      return res.status(400).json({ error: '?since must be a valid ISO 8601 timestamp' });
    }
    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 100, 1000);

    const result = await postgres.query(
      `SELECT device_id, metric, value, recorded_at
         FROM telemetry_readings
        WHERE device_id = $1 AND recorded_at >= $2
        ORDER BY recorded_at DESC
        LIMIT $3`,
      [deviceId, since.toISOString(), limit]
    );

    res.status(200).json({ deviceId, readings: result.rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
