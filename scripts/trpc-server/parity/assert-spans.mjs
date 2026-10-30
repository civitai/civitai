#!/usr/bin/env node
/**
 * Fails the parity job when the server under test stops emitting the request span that an
 * external latency alert keys on by NAME: "executing api route (pages) /api/trpc/[trpc]".
 *
 * A missing span would not break any request; the alert would just read green forever. So this
 * reads what each server actually exported to the job's OTLP receiver (`otlp-stub.mjs`) and
 * requires, for the candidate:
 *   - the named span at least once, and
 *   - the instrumentation's own boot span, which proves its exporter reached the receiver at all
 * and requires the same two from the reference (`server.js`) — the positive control that the
 * receiver and the byte count can see the span when it is there. It prints both counts.
 *
 * Usage: node assert-spans.mjs --spans spans.json --reference-ip <ip> --candidate-ip <ip>
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

export const ALERTED_SPAN = 'executing api route (pages) /api/trpc/[trpc]';
export const BOOT_SPAN = 'test-span';

const { values: args } = parseArgs({
  options: {
    spans: { type: 'string' },
    'reference-ip': { type: 'string' },
    'candidate-ip': { type: 'string' },
  },
});
if (!args.spans || !args['reference-ip'] || !args['candidate-ip']) {
  console.error('--spans, --reference-ip and --candidate-ip are required');
  process.exit(2);
}

const byAddress = JSON.parse(readFileSync(args.spans, 'utf8'));
const count = (ip, name) => (byAddress[ip] && byAddress[ip].names[name]) || 0;

const rows = [
  ['reference', args['reference-ip']],
  ['candidate', args['candidate-ip']],
].map(([role, ip]) => ({
  role,
  ip,
  traceExports: (byAddress[ip] && byAddress[ip].traceExports) || 0,
  alerted: count(ip, ALERTED_SPAN),
  boot: count(ip, BOOT_SPAN),
}));

for (const r of rows) {
  console.log(
    `${r.role.padEnd(10)} ${r.ip.padEnd(16)} trace exports=${r.traceExports} "${ALERTED_SPAN}"=${
      r.alerted
    } "${BOOT_SPAN}"=${r.boot}`
  );
}

const [ref, cand] = rows;
if (ref.boot === 0 || ref.alerted === 0) {
  console.error(
    'FAIL (cannot observe): the reference server exported no boot span or no alerted span, so this check cannot tell a missing span from a receiver that sees nothing.'
  );
  process.exit(2);
}
if (cand.boot === 0) {
  console.error(
    'FAIL: the candidate exported no boot span — its instrumentation did not register.'
  );
  process.exit(1);
}
if (cand.alerted === 0) {
  console.error(`FAIL: the candidate never emitted "${ALERTED_SPAN}".`);
  process.exit(1);
}
console.log('OK: the candidate emits the alerted span.');
