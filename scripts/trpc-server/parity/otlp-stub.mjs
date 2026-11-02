#!/usr/bin/env node
/**
 * A minimal OTLP/HTTP receiver for the parity job. It accepts trace, log and metric exports,
 * answers each with an empty success, and counts — per sending address, so two containers
 * exporting to the same port are told apart — how many times each `--watch` span name occurs in
 * the trace payloads.
 *
 * Counting is a byte search: OTLP protobuf stores a span name as a length-prefixed UTF-8 string,
 * so the exact name appears verbatim in the payload. That is a deliberate match on the exact
 * string, because the exact string is the contract — an alert elsewhere keys on the span NAME.
 *
 * On SIGTERM/SIGINT it writes `--out` and exits. Usage:
 *   node otlp-stub.mjs --port 4318 --out spans.json --watch "<span name>" [--watch …]
 */

import { writeFileSync } from 'node:fs';
import http from 'node:http';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';

const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: '4318' },
    out: { type: 'string' },
    watch: { type: 'string', multiple: true, default: [] },
  },
});
if (!args.out) {
  console.error('--out is required');
  process.exit(2);
}

const watched = args.watch.map((name) => ({ name, bytes: Buffer.from(name, 'utf8') }));
/** address -> { traceExports, logExports, otherExports, names: { [name]: count } } */
const byAddress = {};

function countOccurrences(haystack, needle) {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (d) => chunks.push(d));
  req.on('end', () => {
    const address = (req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
    const entry = (byAddress[address] ??= {
      traceExports: 0,
      logExports: 0,
      otherExports: 0,
      names: Object.fromEntries(watched.map((w) => [w.name, 0])),
    });
    let body = Buffer.concat(chunks);
    if (req.headers['content-encoding'] === 'gzip') body = gunzipSync(body);
    if (req.url === '/v1/traces') {
      entry.traceExports += 1;
      for (const w of watched) entry.names[w.name] += countOccurrences(body, w.bytes);
    } else if (req.url === '/v1/logs') {
      entry.logExports += 1;
    } else {
      entry.otherExports += 1;
    }
    res.writeHead(200, { 'content-type': 'application/x-protobuf' });
    res.end();
  });
});

function shutdown() {
  writeFileSync(args.out, JSON.stringify(byAddress, null, 2));
  console.log(JSON.stringify(byAddress, null, 2));
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(Number(args.port), '0.0.0.0', () => {
  console.log(`otlp-stub listening on :${args.port}, watching ${watched.length} span name(s)`);
});
