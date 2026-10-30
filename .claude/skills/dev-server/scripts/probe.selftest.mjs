/**
 * `node .claude/skills/dev-server/scripts/probe.selftest.mjs`
 *
 * The classifier is the whole value of `probe` — every case below is a shape measured on this repo,
 * and getting one wrong sends an agent to purge a 10 GB cache for a slow database (or the reverse).
 * Pure functions, no daemon, no server: it runs in milliseconds and a wrong verdict prints
 * `got=ok want=wedged` rather than hanging.
 */

import { classify, parseRequestLine, normalizeRoute, routePatternMatches } from './probe.mjs';

let failures = 0;
function check(name, actual, expected) {
  const pass = actual === expected;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  got=${actual} want=${expected}`);
}

const sample = ({ total, next, app, compiled = false, ok = true, timedOut = false }) => ({
  ok,
  timedOut,
  elapsedMs: total,
  compiled,
  server: total == null ? null : { totalMs: total, nextMs: next, appMs: app, path: '/home', status: 200 },
});

// Healthy warm: both fast.
check('ok', classify(sample({ total: 600, next: 40, app: 500 }), sample({ total: 570, next: 30, app: 500 })), 'ok');

// Healthy cold: first compiles, repeat is fast.
check(
  'cold',
  classify(sample({ total: 45000, next: 44000, app: 300, compiled: true }), sample({ total: 570, next: 30, app: 500 })),
  'cold'
);

// Charlie's wedge: flat and slow, framework time dominant.
check(
  'wedged (framework dominant)',
  classify(sample({ total: 8160, next: 8000, app: 100 }), sample({ total: 8150, next: 8000, app: 100 })),
  'wedged'
);

// Recompiling a route it already compiled.
check(
  'wedged (recompiles on repeat)',
  classify(sample({ total: 8160, next: 8000, app: 100, compiled: true }), sample({ total: 8150, next: 8000, app: 100, compiled: true })),
  'wedged'
);

// Tonight's real specimen: flat and slow, application code dominant.
check(
  'upstream-slow',
  classify(sample({ total: 8100, next: 30, app: 8100 }), sample({ total: 8100, next: 31, app: 8100 })),
  'upstream-slow'
);

// The 2026-08-12 incident: a sick server aborts its own settings self-fetch at 8s, and that abort is
// billed to application-code — so the split alone would say "upstream" and send you to the database.
// The marker outranks the split, and it wins even when the degraded render is fast.
check(
  'self-fetch-failing (beats an upstream-shaped split)',
  classify(
    { ...sample({ total: 8050, next: 40, app: 8000 }), selfFetchFailed: true },
    { ...sample({ total: 8050, next: 40, app: 8000 }), selfFetchFailed: true }
  ),
  'self-fetch-failing'
);
check(
  'self-fetch-failing (beats a fast degraded render)',
  classify(
    { ...sample({ total: 300, next: 40, app: 200 }), selfFetchFailed: true },
    { ...sample({ total: 300, next: 40, app: 200 }), selfFetchFailed: true }
  ),
  'self-fetch-failing'
);

// A stale node_modules 500s FAST, so every timing signal calls it healthy. It has to beat the fast
// path or `probe` returns `ok` on a broken page — the one verdict worse than no verdict.
check(
  'stale-deps (beats a fast 500)',
  classify(
    { ...sample({ total: 120, next: 90, app: 20 }), missingModule: "Module not found: Can't resolve 'html2canvas'" },
    { ...sample({ total: 110, next: 80, app: 20 }), missingModule: "Module not found: Can't resolve 'html2canvas'" }
  ),
  'stale-deps'
);
check(
  'stale-deps seen on only one sample still counts',
  classify(
    { ...sample({ total: 120, next: 90, app: 20 }), missingModule: 'Cannot find module foo' },
    sample({ total: 110, next: 80, app: 20 })
  ),
  'stale-deps'
);

// Slow with no log line to read (buffer overran, or no session).
check(
  'slow-unclassified',
  classify(sample({ total: 8220, next: null, app: null }), { ok: true, elapsedMs: 8130, compiled: false, server: null }),
  'slow-unclassified'
);

check('timeout', classify(sample({ ok: false, timedOut: true, total: 90000 }), sample({ ok: false, timedOut: true, total: 30000 })), 'timeout');
check('down', classify({ ok: false, timedOut: false, elapsedMs: 5, error: 'ECONNREFUSED', server: null }, { ok: false, timedOut: false, elapsedMs: 5, error: 'ECONNREFUSED', server: null }), 'down');

// Parser
const p = parseRequestLine(' GET /home 200 in 8.1s (next.js: 39ms, proxy.ts: 8ms, application-code: 8.1s)');
check('parse total', p.totalMs, 8100);
check('parse next', p.nextMs, 39);
check('parse app', p.appMs, 8100);
check('parse no-split', parseRequestLine(' GET /x 200 in 1.2s').nextMs, null);
check('parse non-request', parseRequestLine('○ Compiling /home ...'), null);

check('route mangled', normalizeRoute('C:/Program Files/Git/home').route, '/home');
check('route mangled flag', normalizeRoute('C:/Program Files/Git/home').mangled, true);
check('route plain', normalizeRoute('/models').route, '/models');
check('route bare', normalizeRoute('models').route, '/models');

// Next announces the route PATTERN, not the URL, so string equality made the compile match inert
// for every dynamic route — 113 of 566 files under src/pages, including all of /api/trpc.
check('pattern: dynamic segment', routePatternMatches('/models/[id]', '/models/1234'), true);
check('pattern: one segment only', routePatternMatches('/models/[id]', '/models/1/reviews'), false);
check('pattern: catch-all', routePatternMatches('/docs/[...slug]', '/docs/a/b/c'), true);
check('pattern: catch-all needs a segment', routePatternMatches('/docs/[...slug]', '/docs'), false);
check('pattern: OPTIONAL catch-all matches zero', routePatternMatches('/docs/[[...slug]]', '/docs'), true);
check('pattern: optional catch-all matches many', routePatternMatches('/docs/[[...slug]]', '/docs/a/b'), true);
check('pattern: literal dot is escaped', routePatternMatches('/a.b/[id]', '/axb/1'), false);
check('pattern: trailing slash', routePatternMatches('/home', '/home/'), true);
check('pattern: malformed does not throw', routePatternMatches('['.repeat(30), '/x'), false);

console.log(failures ? `\n${failures} FAILURES` : '\nall green');
process.exit(failures ? 1 : 0);
