'use strict';

const amqplib = require('amqplib');
const config = require('../config');

/** @type {import('amqplib').Connection | null} */
let connection = null;
/** @type {import('amqplib').Channel | null} */
let channel = null;
/** @type {Promise<import('amqplib').Channel> | null} */
let connecting = null;
let shuttingDown = false;

/**
 * Lazily connects (on first call) and returns a ready-to-use channel,
 * asserting the configured exchange and queue exist and are bound. Reuses
 * an in-flight connection attempt (`connecting`) so concurrent callers
 * (e.g. two requests landing before the first connect finishes) don't
 * each open their own TCP connection to the broker.
 */
async function getChannel() {
  if (!config.rabbitmq.enabled) {
    throw new Error('RabbitMQ is disabled (RABBITMQ_ENABLED=false); refusing to connect');
  }

  if (channel) return channel;
  if (connecting) return connecting;

  connecting = (async () => {
    connection = await amqplib.connect(config.rabbitmq.url);

    // A broker-side error or a dropped TCP connection surfaces as 'close'/
    // 'error' on the connection object, not as a rejected promise on some
    // in-flight call — without these handlers, losing the broker after
    // startup would be a silent uncaught event instead of a recoverable
    // reconnect.
    connection.on('error', (err) => {
      // eslint-disable-next-line no-console -- logger isn't threaded through here to avoid a circular require with server.js
      console.error('RabbitMQ connection error', err);
    });
    connection.on('close', () => {
      channel = null;
      connection = null;
      connecting = null;
      if (!shuttingDown) {
        // eslint-disable-next-line no-console -- logger isn't threaded through here to avoid a circular require with server.js
        console.error(
          `RabbitMQ connection closed unexpectedly, reconnecting in ${config.rabbitmq.reconnectDelayMs}ms`
        );
        setTimeout(() => {
          getChannel().catch((err) => {
            // eslint-disable-next-line no-console -- logger isn't threaded through here to avoid a circular require with server.js
            console.error('RabbitMQ reconnect attempt failed', err);
          });
        }, config.rabbitmq.reconnectDelayMs);
      }
    });

    const ch = await connection.createChannel();
    await ch.assertExchange(config.rabbitmq.exchange, config.rabbitmq.exchangeType, {
      durable: true,
    });
    await ch.assertQueue(config.rabbitmq.queue, { durable: true });
    await ch.bindQueue(config.rabbitmq.queue, config.rabbitmq.exchange, config.rabbitmq.routingKey);

    channel = ch;
    return ch;
  })();

  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

/**
 * Publishes a JSON-serializable message to the configured exchange.
 * `persistent: true` asks the broker to write the message to disk so it
 * survives a broker restart — required for anything (like telemetry
 * readings) we can't afford to silently drop.
 * @param {Record<string, unknown>} message
 * @param {{ routingKey?: string }} [opts]
 */
async function publish(message, opts = {}) {
  const ch = await getChannel();
  const routingKey = opts.routingKey || config.rabbitmq.routingKey;
  const payload = Buffer.from(JSON.stringify(message));

  const ok = ch.publish(config.rabbitmq.exchange, routingKey, payload, {
    persistent: true,
    contentType: 'application/json',
    timestamp: Date.now(),
  });

  if (!ok) {
    // channel.publish() returns false when the internal write buffer is
    // full (backpressure) — the message is still queued, but callers that
    // care about throughput should slow down until 'drain' fires. We
    // don't block on it here since a single HTTP request publishing one
    // message isn't a sustained-throughput producer.
    // eslint-disable-next-line no-console -- logger isn't threaded through here to avoid a circular require with server.js
    console.warn('RabbitMQ channel write buffer full; message queued but broker is applying backpressure');
  }
}

/**
 * Starts consuming from the configured queue. `handler` receives the
 * parsed JSON message body and must resolve (ack) or throw (nack +
 * requeue) — the consumer never auto-acks, so a crash mid-handler doesn't
 * silently lose the message.
 * @param {(message: unknown, raw: import('amqplib').ConsumeMessage) => Promise<void>} handler
 */
async function consume(handler) {
  const ch = await getChannel();
  // Cap in-flight (unacked) deliveries per consumer so one slow handler
  // can't be handed the entire queue's backlog at once.
  await ch.prefetch(10);

  await ch.consume(config.rabbitmq.queue, async (msg) => {
    if (!msg) return; // null delivery means the consumer was cancelled server-side
    try {
      const parsed = JSON.parse(msg.content.toString('utf8'));
      await handler(parsed, msg);
      ch.ack(msg);
    } catch (err) {
      // eslint-disable-next-line no-console -- logger isn't threaded through here to avoid a circular require with server.js
      console.error('RabbitMQ message handler failed; requeueing', err);
      // requeue=true by default here: a transient failure (e.g. a DB blip)
      // shouldn't drop the message. A handler that hits a poison message
      // (never processable) should nack with requeue=false itself via a
      // dead-letter policy rather than relying on this catch-all.
      ch.nack(msg, false, true);
    }
  });
}

/**
 * Used by GET /readyz — a connection object existing and not having fired
 * 'close' is as close to "is the broker reachable" as we can cheaply check
 * without publishing a real message.
 */
async function checkReadiness() {
  if (!channel || !connection) {
    throw new Error('RabbitMQ channel is not established');
  }
}

/**
 * Called from the SIGTERM handler in server.js. Closing the connection
 * (rather than just the channel) also closes its underlying socket;
 * `shuttingDown` suppresses the 'close' handler's automatic reconnect so
 * we don't fight our own graceful shutdown.
 */
async function closeConnection() {
  shuttingDown = true;
  if (connection) {
    await connection.close();
  }
  channel = null;
  connection = null;
}

module.exports = { getChannel, publish, consume, checkReadiness, closeConnection };
