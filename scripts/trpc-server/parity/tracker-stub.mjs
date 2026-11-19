#!/usr/bin/env node
/**
 * A stand-in for the analytics tracker service, for the parity job. Both servers boot with
 * `CLICKHOUSE_TRACKER_URL` pointing here (`make-env.mjs`), so every `Tracker` event a route sends
 * (`POST /track/<table>` with a JSON row) lands here instead of nowhere.
 *
 * It records each one with the address it came from, so two containers sending to the same port
 * are told apart, and answers `200` as the real service does on success (the Tracker retries
 * anything else, which would add events).
 *
 * `GET /__events?since=<n>` returns `{ total, events }`: every event recorded after the first `n`.
 * The parity harness reads it around each request (`compare.mjs --tracker`), so a beacon case can
 * compare the rows each server's route actually produced, and require that the candidate's route
 * produced any at all.
 *
 * Usage: node tracker-stub.mjs --port 4319
 */

import http from 'node:http';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({ options: { port: { type: 'string', default: '4319' } } });

/** { seq, from, method, path, body } — body is the parsed JSON, or the raw text if it is not. */
const events = [];

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://stub');
  if (req.method === 'GET' && url.pathname === '/__events') {
    const since = Number(url.searchParams.get('since') || 0);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ total: events.length, events: events.slice(since) }));
    return;
  }
  const chunks = [];
  req.on('data', (d) => chunks.push(d));
  req.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8');
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    events.push({
      seq: events.length + 1,
      from: (req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, ''),
      method: req.method,
      path: url.pathname,
      body,
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
});

server.listen(Number(args.port), '0.0.0.0', () => {
  console.log(`tracker-stub listening on :${args.port}`);
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`tracker-stub: ${events.length} event(s) recorded`);
    process.exit(0);
  });
}
