'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../src/app');

// These tests exercise src/app.js directly (never src/server.js), so no
// real port is bound and no SIGTERM/SIGINT handlers are installed — a
// test run doesn't need, and shouldn't need, a live process to send
// signals to.
const app = createApp();

test('GET /healthz reports ok without checking dependencies', async () => {
  const res = await request(app).get('/healthz');

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.service, 'telemetry-service');
});

test('GET /readyz reports ok when no dependencies are enabled', async () => {
  // In the default (test) config, POSTGRES_ENABLED/REDIS_ENABLED/
  // RABBITMQ_ENABLED are all false, so readiness has nothing to check and
  // should report every dependency as "disabled" rather than failing.
  const res = await request(app).get('/readyz');

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
  assert.deepEqual(res.body.checks, {
    postgres: 'disabled',
    redis: 'disabled',
    rabbitmq: 'disabled',
  });
});

test('GET / returns service identity', async () => {
  const res = await request(app).get('/');

  assert.equal(res.status, 200);
  assert.equal(res.body.service, 'telemetry-service');
  assert.match(res.body.message, /telemetry-service/);
});

test('GET /metrics exposes Prometheus text format', async () => {
  const res = await request(app).get('/metrics');

  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/plain/);
  assert.match(res.text, /http_request_duration_seconds/);
});

test('GET /api/v1/devices returns 503 when Postgres is disabled', async () => {
  const res = await request(app).get('/api/v1/devices');

  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'Postgres is disabled for this service instance');
});

test('POST /api/v1/telemetry returns 503 when RabbitMQ is disabled', async () => {
  const res = await request(app)
    .post('/api/v1/telemetry')
    .send({ deviceId: 'dev-1', metric: 'temperature', value: 21.5 });

  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'RabbitMQ is disabled for this service instance');
});

test('unknown routes return 404', async () => {
  const res = await request(app).get('/does-not-exist');

  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'not found');
});
