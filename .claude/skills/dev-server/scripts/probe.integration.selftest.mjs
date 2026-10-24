/**
 * `node .claude/skills/dev-server/scripts/probe.integration.selftest.mjs`
 *
 * Drives the REAL `probe()` against a real local HTTP server and a stubbed daemon, because the
 * unit self-test could not have caught the bug that mattered most: `runSample` destructured the
 * fields it forwarded to `classify`, and `missingModule` was simply not among them. The whole
 * `stale-deps` verdict was dead code, and every unit case for it passed — they hand-built the very
 * field the shipping code never produced.
 *
 * So the rule these cases enforce is the propagation boundary: a signal that `readServerView`
 * extracts has to survive all the way to a verdict.
 */

import { createServer } from 'http';
import { probe, REMEDIES } from './probe.mjs';

let failures = 0;
function check(name, actual, expected) {
  const pass = actual === expected;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  got=${actual} want=${expected}`);
}

// The URL the server actually saw. `probe` appends a `__probe=` nonce so it can identify its own
// request in the log, so a fixture that hardcodes the bare path no longer matches — which is the
// point of the nonce. `{url}` in a fixture line is substituted with what the server received.
let lastUrl = '/';

const stubDaemon = (lines) => async (path) => {
  if (path.includes('/logs')) {
    return {
      ok: true,
      data: {
        logs: lines.map((message, index) => ({ index, message: message.replace('{url}', lastUrl) })),
      },
    };
  }
  return { ok: true, data: { session: { currentLogIndex: 0 } } };
};

async function withServer(handler, fn) {
  const server = createServer((req, res) => {
    lastUrl = req.url;
    handler(req, res);
  });
  // Bind what `probe` dials. Binding 127.0.0.1 while probing `localhost` relies on the client
  // falling back from ::1, and if it ever stops, every case here fails as `down` and reads as five
  // real regressions.
  await new Promise((r) => server.listen(0, 'localhost', r));
  try {
    return await fn(server.address().port);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const run = (port, lines, route = '/home') =>
  probe({ route, port, sessionId: 's1', daemonRequest: stubDaemon(lines), timeoutMs: 5000 });

// The regression. A stale node_modules 500s FAST, so every timing signal reads healthy.
await withServer(
  (req, res) => {
    res.statusCode = 500;
    res.end('boom');
  },
  async (port) => {
    const r = await run(port, [
      "Module not found: Can't resolve 'html2canvas'",
      ' GET {url} 500 in 120ms (next.js: 90ms, application-code: 20ms)',
    ]);
    check('stale-deps survives the runSample boundary', r.verdict, 'stale-deps');
    check('and it reaches the sample payload', Boolean(r.samples[0].missingModule), true);
  }
);

// A fast 404 is not a healthy server.
await withServer(
  (req, res) => {
    res.statusCode = 404;
    res.end('nope');
  },
  async (port) => {
    const r = await run(port, [' GET {url} 404 in 30ms (next.js: 20ms, application-code: 5ms)']);
    check('fast 404 is not ok', r.verdict, 'error-status');
  }
);

// Someone else's compile in the window must not authorise a purge.
await withServer(
  (req, res) => setTimeout(() => res.end('slow'), 60),
  async (port) => {
    const r = await run(port, [
      '○ Compiling /models ...',
      ' GET {url} 200 in 8.1s (next.js: 30ms, application-code: 8.1s)',
    ]);
    check('unrelated compile does not mean wedged', r.verdict, 'upstream-slow');
  }
);

// Middleware time is neither the build cache nor the database.
await withServer(
  (req, res) => setTimeout(() => res.end('slow'), 60),
  async (port) => {
    const r = await run(port, [
      ' GET {url} 200 in 8.0s (next.js: 50ms, proxy.ts: 7.9s, application-code: 40ms)',
    ]);
    check('proxy-dominant is its own verdict', r.verdict, 'proxy-slow');
  }
);

// An ambiguous split must not authorise a 45s rebuild.
await withServer(
  (req, res) => setTimeout(() => res.end('slow'), 60),
  async (port) => {
    const r = await run(port, [
      ' GET {url} 200 in 8.0s (next.js: 4.1s, application-code: 3.9s)',
    ]);
    check('51/49 split is unclassified, not wedged', r.verdict, 'slow-unclassified');
  }
);

// The other signal that travels the same spread as `missingModule`. Without a case here, moving
// the bug one identifier to the left is invisible again.
await withServer(
  (req, res) => res.end('degraded'),
  async (port) => {
    const r = await run(port, [
      '[_app] settings bootstrap fetch failed, rendering without it: The operation was aborted',
      ' GET {url} 200 in 300ms (next.js: 40ms, application-code: 200ms)',
    ]);
    check('self-fetch marker survives the same boundary', r.verdict, 'self-fetch-failing');
  }
);

// R3: ranking the slices against each other only. `proxy.ts: 0ms` is the normal reading for a route
// middleware does not match, and `x < 0 * 1.3` is false for every x.
await withServer(
  (req, res) => setTimeout(() => res.end('slow'), 60),
  async (port) => {
    const r = await run(port, [
      ' GET {url} 200 in 8.0s (next.js: 5ms, proxy.ts: 0ms, application-code: 0ms)',
    ]);
    check('a 5ms slice cannot explain an 8s request', r.verdict, 'slow-unclassified');
  }
);

// R6: a SLOW error must keep its diagnosis instead of being labelled fast-and-wrong.
await withServer(
  (req, res) => {
    res.statusCode = 500;
    setTimeout(() => res.end('boom'), 60);
  },
  async (port) => {
    const r = await run(port, [
      ' GET {url} 500 in 8.0s (next.js: 40ms, application-code: 7.9s)',
    ]);
    check('slow 500 keeps the split', r.verdict, 'upstream-slow');
  }
);

// R4: Next announces the route PATTERN, so a dynamic route never matched by string equality.
await withServer(
  (req, res) => setTimeout(() => res.end('slow'), 60),
  async (port) => {
    const r = await run(
      port,
      [
        '○ Compiling /models/[id] ...',
        ' GET {url} 200 in 8.0s (next.js: 7.9s, application-code: 40ms)',
      ],
      '/models/1234'
    );
    check('dynamic-route compile is recognised', r.verdict, 'wedged');
  }
);

// R5: a FAILED log read is not the server declining to explain itself.
await withServer(
  (req, res) => res.end('ok'),
  async (port) => {
    const failingDaemon = async (path) =>
      path.includes('/logs') ? { ok: false } : { ok: true, data: { session: { currentLogIndex: 0 } } };
    const r = await probe({
      route: '/home',
      port,
      sessionId: 's1',
      daemonRequest: failingDaemon,
      timeoutMs: 5000,
    });
    check('failed log read is reported as unread', r.samples[0].logUnread, true);
  }
);

// The remedy is where a wrong verdict actually costs someone 45s, so pin the mapping, not just the
// label.
await withServer(
  (req, res) => setTimeout(() => res.end('slow'), 60),
  async (port) => {
    const r = await run(port, [
      ' GET {url} 200 in 8.0s (next.js: 50ms, proxy.ts: 7.9s, application-code: 40ms)',
    ]);
    // The command, not the word: the remedy says "do NOT purge", and matching on `purge` alone
    // fails a correct string.
    check('proxy-slow does not hand over the unwedge command', /cli\.mjs unwedge/.test(r.remedy), false);
    check('wedged does hand it over', /cli\.mjs unwedge/.test(REMEDIES.wedged({ sessionId: 'x' })), true);
  }
);

// Nothing listening at all.
const r = await probe({
  route: '/home',
  port: 1,
  sessionId: null,
  daemonRequest: stubDaemon([]),
  timeoutMs: 2000,
});
check('closed port is down', r.verdict, 'down');
check('and it says the log was never read', r.samples[0].logUnread, true);

// An explicit --timeout must bound BOTH samples. The previous arithmetic,
// max(30000, min(30000, x)), is the constant 30000 for every input, so a 5s budget ran a 30s
// repeat — and every case in this file passes 5000, so all of them were doing it unnoticed.
await withServer(
  () => {
    /* never responds */
  },
  async (port) => {
    const started = Date.now();
    const r = await probe({
      route: '/home',
      port,
      sessionId: 's1',
      daemonRequest: stubDaemon([]),
      timeoutMs: 2000,
    });
    const elapsed = Date.now() - started;
    check('an explicit timeout bounds both samples', elapsed < 6000, true);
    check('and a server that never answers is a timeout', r.verdict, 'timeout');
    if (elapsed >= 6000) console.log(`      took ${elapsed}ms`);
  }
);

console.log(failures ? `\n${failures} FAILURES` : '\nall green');
process.exit(failures ? 1 : 0);
