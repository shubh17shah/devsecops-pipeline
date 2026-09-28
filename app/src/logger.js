'use strict';

const pino = require('pino');
const config = require('./config');

// Always plain JSON, one line per event, straight to stdout — never
// pino-pretty here. This is a container: stdout is scraped by the
// cluster's log collector (e.g. Fluent Bit) and shipped somewhere that
// expects structured JSON, not a human-formatted TTY string. Pretty
// printing is something you opt into locally by piping `npm run dev`
// through the `pino-pretty` CLI, not something the app does itself.
const logger = pino({
  level: config.logLevel,
  base: { service: config.serviceName },
  timestamp: pino.stdTimeFunctions.isoTime,
});

module.exports = logger;
