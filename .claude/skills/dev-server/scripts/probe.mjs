/**
 * Bounded request against a dev session, classified by mechanism rather than by wall time.
 *
 * Next prints its own split on every request line —
 *   ` GET /images 500 in 3.7s (next.js: 3.7s, proxy.ts: 6ms, application-code: 8ms)`
 * — so "the framework is redoing work" and "something downstream is slow" are already separated at
 * the source. That is the whole discriminator: a timing threshold cannot tell a stale build cache
 * from a slow database over a tunnel, and both produce the same flat slow page.
 */

import { randomUUID } from 'crypto';
import { rmSync, existsSync } from 'fs';
import { resolve, relative, isAbsolute } from 'path';

// A warm page in this app answers in ~0.6s; /api/health's application-code alone is ~1s.
const FAST_MS = 1500;

// A first hit that compiles the shared graph legitimately costs ~45s.
const DEFAULT_TIMEOUT_MS = 90_000;
const REPEAT_TIMEOUT_MS = 30_000;

const REQUEST_LINE =
  /^\s*(GET|POST|PUT|PATCH|DELETE|HEAD)\s+(\S+)\s+(\d{3})\s+in\s+([\d.]+\s*m?s)(?:\s*\(([^)]*)\))?/;

export function parseDuration(text) {
  const match = String(text).trim().match(/^([\d.]+)\s*(ms|s|m)$/);
  if (!match) return null;
  const value = parseFloat(match[1]);
  if (Number.isNaN(value)) return null;
  return match[2] === 'ms' ? value : match[2] === 's' ? value * 1000 : value * 60_000;
}

// ` GET /x 200 in 3.1s (next.js: 3.0s, application-code: 47ms)` -> the parts that discriminate.
export function parseRequestLine(message) {
  const match = String(message).match(REQUEST_LINE);
  if (!match) return null;
  const parts = {};
  for (const chunk of (match[5] || '').split(',')) {
    const [name, value] = chunk.split(':').map((s) => s && s.trim());
    if (name && value) parts[name] = parseDuration(value);
  }
  return {
    method: match[1],
    path: match[2],
    status: Number(match[3]),
    totalMs: parseDuration(match[4]),
    nextMs: parts['next.js'] ?? null,
    proxyMs: parts['proxy.ts'] ?? null,
    appMs: parts['application-code'] ?? null,
  };
}

// Git Bash rewrites a leading-slash argument into a Windows path (`/home` -> `C:/Program
// Files/Git/home`) before this process ever sees it. Probing the mangled string returns a fast,
// confident 404 about a route nobody asked for — the exact shape of wrong answer this command
// exists to stop — so undo it rather than trusting the argument.
export function normalizeRoute(route) {
  const match = String(route).match(/^[A-Za-z]:[\\/].*?[\\/]Git[\\/](.*)$/);
  const cleaned = match ? `/${match[1]}` : route;
  const normalized = cleaned.replace(/\\/g, '/');
  return {
    route: normalized.startsWith('/') ? normalized : `/${normalized}`,
    mangled: Boolean(match),
  };
}

// `/models/[id]` matches `/models/1234`; `/docs/[...slug]` matches the rest of the path. Next also
// strips a trailing slash when it formats the trigger, so compare without one.
export function routePatternMatches(pattern, pathname) {
  const trim = (v) => (v.length > 1 ? v.replace(/\/+$/, '') : v);
  const pat = trim(pathnameOf(pattern));
  const path = trim(pathname);
  if (pat === path) return true;
  if (!pat.includes('[')) return false;
  let source = '';
  for (const seg of pat.replace(/^\//, '').split('/')) {
    // `[[...slug]]` is the OPTIONAL catch-all and must match zero segments, so it swallows the
    // slash in front of it: `/docs/[[...slug]]` has to match `/docs`.
    if (/^\[\[\.\.\..+\]\]$/.test(seg)) source += '(?:/.*)?';
    else if (/^\[\.\.\..+\]$/.test(seg)) source += '/.*';
    else if (/^\[.+\]$/.test(seg)) source += '/[^/]+';
    else source += `/${seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
  }
  try {
    return new RegExp(`^${source}$`).test(path);
  } catch {
    // This reads arbitrary server stdout. A pattern that will not compile is not a match, and it is
    // certainly not a reason to take `probe` down mid-window.
    return false;
  }
}

function pathnameOf(target) {
  const q = target.indexOf('?');
  return q === -1 ? target : target.slice(0, q);
}

// Reads the session's own stdout for what the server thought it was doing during our request.
// `_app` self-fetches /api/user/settings on every SSR render and aborts it at
// APP_SETTINGS_FETCH_TIMEOUT_MS (8s). That abort is charged to application-code, so a server too
// sick to answer its own API route reads as "slow upstream" on the split alone — the one case where
// the split points at the wrong half of the stack. The marker is the tell, and it outranks timing.
const SELF_FETCH_FAILED = /\[_app\] settings bootstrap fetch failed/;

// A branch or merge that adds a dependency leaves node_modules behind, and the page then 500s
// FAST. Fast is what makes this one its own verdict: every other failure here is slow, so the
// timing signals say "healthy" and the reflex that follows is to purge the build cache — a ~45s
// rebuild that reinstalls nothing and changes nothing. Cost someone a full purge cycle on
// 2026-08-15 after a merge brought in html2canvas.
const MISSING_MODULE = /Module not found|Cannot find module|ERR_MODULE_NOT_FOUND/;
const SETTINGS_ROUTE = '/api/user/settings';
const SETTINGS_PROBE_MS = 15_000;

function readServerView(logs, route, nonce) {
  const wanted = pathnameOf(route);
  let line = null;
  let matches = 0;
  let compiled = false;
  let selfFetchFailed = false;
  let missingModule = null;
  for (const entry of logs) {
    const message = entry.message || '';
    // Only OUR route counts. A human clicking around, or a file save, puts someone else's
    // `Compiling` line in the window — and `compiled` short-circuits straight to `wedged`, whose
    // remedy deletes the build dir of a session they are using.
    //
    // Next logs the route PATTERN, not the URL: /models/1234 is announced as
    // `Compiling /models/[id]`. Comparing strings made this inert for every dynamic route —
    // 113 of 566 files under src/pages, including all of /api/trpc.
    const compiling = message.match(/[○o]?\s*Compiling\s+(\S+)/);
    if (compiling && routePatternMatches(compiling[1], wanted)) compiled = true;
    if (SELF_FETCH_FAILED.test(message)) selfFetchFailed = true;
    if (!missingModule && MISSING_MODULE.test(message)) missingModule = message.trim().slice(0, 200);
    const parsed = parseRequestLine(message);
    if (!parsed) continue;
    // With a nonce we can identify OUR request exactly: Next logs the full query string, so the
    // token appears on our line and on nobody else's. Without one (see probe()), fall back to the
    // pathname and count the matches, so an ambiguous window can say so instead of picking.
    const mine = nonce ? parsed.path.includes(nonce) : pathnameOf(parsed.path) === wanted;
    if (mine) {
      line = parsed;
      matches++;
    }
  }
  // Counted on both paths. Both samples share one nonce, so a request line flushed after its own
  // window closes shows up in the next one — and a nonce path that never counts cannot say so.
  return { line, compiled, selfFetchFailed, missingModule, ambiguous: matches > 1 };
}

async function timedFetch(url, timeoutMs) {
  const started = Date.now();
  try {
    // `manual`: following a redirect measures a route we never asked about, and then matches
    // the log line of the one we did — the timing and the verdict come from different requests.
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    // Draining matters: TTFB alone would call a server healthy that never finishes the body.
    await res.arrayBuffer();
    return { ok: true, status: res.status, elapsedMs: Date.now() - started };
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
    return {
      ok: false,
      timedOut,
      error: err.message,
      elapsedMs: Date.now() - started,
    };
  }
}

const VERDICTS = {
  ok: (s) => `OK — answered in ${ms(s.totalMs)} on repeat.`,
  cold: (s) => `COLD — first hit compiled, repeat came back in ${ms(s.totalMs)}. Nothing to fix.`,
  wedged: () => 'WEDGED — the build cache is not serving; the framework redoes the work every hit.',
  'upstream-slow': () =>
    'UPSTREAM-SLOW — the framework is fine; time is spent in application code (database, tunnel, cache).',
  'slow-unclassified': () =>
    'SLOW — repeat is no faster than the first hit, but the server log did not say why.',
  'stale-deps': () =>
    'STALE-DEPS — the server answered fast, but it cannot resolve a module. node_modules is behind the checkout, so this is an install, not a cache problem.',
  'self-fetch-failing': () =>
    "SELF-FETCH-FAILING — the server cannot reach its OWN /api/user/settings, so every page renders signed-out and degraded. The 8s abort is billed to application-code, so the timing split points the wrong way here.",
  'error-status': (s) => `ERROR-STATUS — answered ${s.status} in ${ms(s.totalMs)}. Fast, and wrong.`,
  'proxy-slow': () =>
    'PROXY-SLOW — the time is in middleware (proxy.ts), not in the framework or in application code.',
  'stopped-answering': (s) =>
    `STOPPED-ANSWERING — it answered once, in ${ms(s.firstMs)}, then did not answer at all. The process is up; something inside it has parked.`,
  timeout: () => 'TIMEOUT — the server did not answer within the budget.',
  down: () => 'DOWN — nothing answered on that port.',
};

export const REMEDIES = {
  wedged: (ctx) =>
    `Purge and restart: node .claude/skills/dev-server/cli.mjs unwedge ${ctx.sessionId || '<session-id>'}   (~45s rebuild)`,
  'upstream-slow': () =>
    'Not a cache problem — do NOT purge, it will not help. Time is in the data this route reads: a session on a remote database pays real latency per query, and a dropped tunnel to one looks exactly like this. Check the session env modes (cli.mjs list) and whatever connection your setup uses to reach them.',
  'error-status': () =>
    'Check the route you asked for actually exists — a mistyped route, or a flag value swallowed as the route, lands here. If the route is right, this is the app returning an error, not a sick dev server.',
  'proxy-slow': () =>
    'Not the build cache and not the database — do NOT purge. Look at the middleware chain (proxy.ts) for this route.',
  'slow-unclassified': (ctx) =>
    `Read the server log before purging: node .claude/skills/dev-server/cli.mjs logs ${ctx.sessionId || '<session-id>'}`,
  'stale-deps': (ctx) =>
    `Install, do not purge: pnpm install --prefer-offline${ctx.worktree ? ` (in ${ctx.worktree})` : ''}. A merge or checkout that adds a dependency leaves node_modules behind; the build cache is fine and rebuilding it installs nothing.`,
  'self-fetch-failing': (ctx) =>
    ctx.settingsHangs
      ? `/api/user/settings itself never answers (probed above), so this is the endpoint, not the build cache — a purge costs 45s and changes nothing (measured 2026-08-16: it still hung on a freshly built session). Find what that handler awaits. Meanwhile every page renders signed-out at exactly APP_SETTINGS_FETCH_TIMEOUT_MS.`
      : `The self-fetch failed but /api/user/settings answers directly, so it is aimed at the wrong place: check NEXTAUTH_URL_INTERNAL in this session's .env against the port in \`cli.mjs list\`. If it matches, the server is too sick to reach itself: node .claude/skills/dev-server/cli.mjs unwedge ${ctx.sessionId || '<session-id>'}`,
  timeout: (ctx) =>
    `Check the session is alive (node .claude/skills/dev-server/cli.mjs list). If it is running and every route behaves this way, unwedge ${ctx.sessionId || '<session-id>'}.`,
  'stopped-answering': (ctx) =>
    `Do NOT start another session — this one is running. Read what it was doing when it stopped: node .claude/skills/dev-server/cli.mjs logs ${ctx.sessionId || '<session-id>'}`,
  down: () => 'Start a session: node .claude/skills/dev-server/cli.mjs start',
};

function ms(value) {
  if (value == null) return 'unknown';
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`;
}

// How much bigger the dominant slice must be before it names a culprit. A 51/49 split between
// framework and application time is not evidence for either, and the `wedged` remedy costs a ~45s
// rebuild — so an ambiguous split says so instead of guessing.
const DOMINANCE = 1.3;

export function classify(first, second) {
  if (!first.ok && !second.ok) return first.timedOut || second.timedOut ? 'timeout' : 'down';
  // Answered once, then stopped answering. Falling back to the good sample here reported `ok` for
  // the exact "sick, not dead" server this command exists to catch — but "nothing is listening" and
  // "it answered 600ms ago and then stopped" are different states, and the second is the worrying
  // one. Reporting it as `down` sends you to start a session that is already running.
  if (!second.ok) return second.timedOut ? 'timeout' : 'stopped-answering';

  // Both of these are FAST failures, so they must beat every timing rule below: a verdict of `ok`
  // on a broken page is worse than no verdict at all.
  if (first.missingModule || second.missingModule) return 'stale-deps';
  if (first.selfFetchFailed || second.selfFetchFailed) return 'self-fetch-failing';

  const view = second.server;
  const totalMs = view?.totalMs ?? second.elapsedMs;
  const status = view?.status ?? second.status;

  // A 404/500 served in 30ms is a fast wrong answer, most often a route argument that never
  // arrived intact. A SLOW error is a different thing entirely — Next dev serves compile-error
  // 500s slowly as a matter of course — so it falls through to the timing rules, which are what
  // can still explain it.
  if (status != null && status >= 400 && totalMs < FAST_MS) return 'error-status';
  if (totalMs < FAST_MS) return first.compiled || first.elapsedMs >= FAST_MS ? 'cold' : 'ok';

  // Slow on the repeat, so something is doing the work twice or waiting on something.
  if (second.compiled) return 'wedged';
  if (!view) return 'slow-unclassified';

  // Next splits its own request line three ways. Name the dominant slice, not the bigger of two.
  const slices = [
    ['wedged', view.nextMs],
    ['upstream-slow', view.appMs],
    ['proxy-slow', view.proxyMs],
  ].filter(([, v]) => v != null);
  if (!slices.length) return 'slow-unclassified';
  slices.sort((a, b) => b[1] - a[1]);
  const [[verdict, top], runnerUp] = [slices[0], slices[1]];
  // Ranking the slices against EACH OTHER is not enough: `proxy.ts: 0ms` is the normal reading for
  // a route middleware does not match, and `x < 0 * 1.3` is false for every x, so 40ms of framework
  // time on an 8s request came out "dominant" and authorised deleting the build dir. The slice has
  // to explain the request before it gets to name it.
  if (top < totalMs * 0.5) return 'slow-unclassified';
  if (runnerUp && top < runnerUp[1] * DOMINANCE) return 'slow-unclassified';
  return verdict;
}

/**
 * @param {object} opts
 * @param {string} opts.route      path to request, e.g. `/home`
 * @param {number} opts.port
 * @param {string|null} opts.sessionId
 * @param {string} [opts.worktree]   named in the stale-deps remedy, so the install lands in the right tree
 * @param {function} opts.daemonRequest
 * @param {number} [opts.timeoutMs]
 */
export async function probe({ route, port, sessionId, worktree, daemonRequest, timeoutMs }) {
  const path = route.startsWith('/') ? route : `/${route}`;
  // A nonce makes our own request identifiable in the log. Skipped when the route already carries a
  // query string, and for tRPC, whose handlers parse their query rather than ignoring it — there,
  // matching falls back to the pathname and reports ambiguity instead.
  const canNonce = !path.includes('?') && !path.startsWith('/api/trpc');
  // Random, not clock-derived. A `performance.now()`-based token measured across fresh processes
  // clustered in a ~68,000-wide band because every one of them starts the clock at the same point
  // in module load — and a collision here is SILENT, since a matched nonce is what suppresses the
  // ambiguity note.
  const nonce = canNonce ? `p${randomUUID().slice(0, 8)}` : null;
  const url = `http://localhost:${port}${path}${nonce ? `?__probe=${nonce}` : ''}`;
  const budget = timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Where the session's log sits before we ask for anything, so each sample reads only its own
  // window. The buffer is 2000 lines and this app is chatty, so we read it back immediately.
  const markLog = async () => {
    if (!sessionId) return null;
    // Guarded like the log read: a daemon that dies between the CLI's readiness check and this
    // call would otherwise reject out of probe() with a raw `TypeError: fetch failed` and no
    // verdict — the same shape as the known crash in the queued-test path.
    const res = await daemonRequest(`/sessions/${sessionId}`).catch(() => ({ ok: false }));
    // GET /sessions/:id answers `{ session: {...} }`, unlike the list endpoint.
    return res.ok ? res.data?.session?.currentLogIndex ?? null : null;
  };
  const readLog = async (since) => {
    if (!sessionId || since == null)
      return { line: null, compiled: false, selfFetchFailed: false, missingModule: null, unread: true };
    const res = await daemonRequest(`/sessions/${sessionId}/logs?since=${since}`).catch(() => ({
      ok: false,
    }));
    // `unread` has to cover a FAILED read, not just a skipped one. Otherwise a daemon that dropped
    // the request prints "no matching request line in the log window" — a claim about the server.
    return { ...readServerView(res.ok ? res.data?.logs ?? [] : [], route, nonce), unread: !res.ok };
  };

  const runSample = async (perRequestMs) => {
    const since = await markLog();
    const result = await timedFetch(url, perRequestMs);
    const view = await readLog(since);
    return { ...result, server: view.line, ...view, line: undefined };
  };

  const first = await runSample(budget);
  const spent = first.elapsedMs;
  // Floor the repeat generously. A first hit that legitimately compiled for most of the budget
  // used to leave the repeat 5s, which turned a slow-but-recovering server into a `timeout` whose
  // remedy is a purge.
  // An explicit `--timeout` is a bound the caller asked for, so honour it on both samples — capped
  // by what is left of the budget, floored at 1s so an exhausted budget still gets a real attempt.
  // The default path is a flat 30s: a first hit that compiled for 85s should still get a full
  // repeat, and a first hit that took 600ms does not need 89 seconds to answer again.
  //
  // Both halves have been wrong once. `max(30000, min(30000, x))` is the constant 30000, which
  // ignored `--timeout` entirely; `max(30000, remaining)` is a floor with no ceiling, which gave a
  // default probe an 89s repeat. Evaluate this over a table before changing it — it does not read
  // the way it computes.
  const remaining = budget - spent;
  const repeatBudget =
    timeoutMs != null ? Math.max(1000, Math.min(timeoutMs, Math.max(remaining, 1000)))
    : REPEAT_TIMEOUT_MS;
  const second = await runSample(repeatBudget);

  const verdict = classify(first, second);
  const sample = second.ok ? second : first;

  // The remedy for a failing self-fetch splits on whether the endpoint answers at all, and that is
  // one bounded request away — asking the agent to run it is asking them to improvise a curl.
  let followUp = null;
  if (verdict === 'self-fetch-failing' && route !== SETTINGS_ROUTE) {
    const res = await timedFetch(`http://localhost:${port}${SETTINGS_ROUTE}`, SETTINGS_PROBE_MS);
    followUp = {
      route: SETTINGS_ROUTE,
      ok: res.ok,
      status: res.status ?? null,
      elapsedMs: res.elapsedMs,
      error: res.error ?? null,
    };
  }
  const ctx = { sessionId, worktree, settingsHangs: followUp ? !followUp.ok : false };

  return {
    verdict,
    followUp,
    url,
    sessionId,
    headline: VERDICTS[verdict]({
      totalMs: sample.server?.totalMs ?? sample.elapsedMs,
      status: sample.server?.status ?? sample.status,
      firstMs: first.elapsedMs,
    }),
    remedy: REMEDIES[verdict] ? REMEDIES[verdict](ctx) : null,
    samples: [first, second].map((s) => ({
      ok: s.ok,
      status: s.status ?? null,
      elapsedMs: s.elapsedMs,
      compiled: s.compiled,
      selfFetchFailed: Boolean(s.selfFetchFailed),
      missingModule: s.missingModule ?? null,
      logUnread: Boolean(s.unread),
      ambiguous: Boolean(s.ambiguous),
      serverTotalMs: s.server?.totalMs ?? null,
      nextMs: s.server?.nextMs ?? null,
      proxyMs: s.server?.proxyMs ?? null,
      appMs: s.server?.appMs ?? null,
      error: s.error ?? null,
    })),
  };
}

export function formatProbe(result) {
  const [a, b] = result.samples;
  const line = (label, s) => {
    if (!s.ok) return `  ${label}: ${s.error} after ${ms(s.elapsedMs)}`;
    const split =
      s.nextMs != null || s.appMs != null
        ? `  [next.js ${ms(s.nextMs)}${s.proxyMs != null ? ` | proxy.ts ${ms(s.proxyMs)}` : ''} | application-code ${ms(s.appMs)}]`
        : '';
    return `  ${label}: ${s.status} in ${ms(s.serverTotalMs ?? s.elapsedMs)}${
      s.compiled ? ' (compiled)' : ''
    }${s.selfFetchFailed ? ' (settings self-fetch FAILED)' : ''}${split}`;
  };
  const out = [
    `${result.verdict.toUpperCase()}  ${result.url}`,
    `  ${result.headline}`,
    line('first ', a),
    line('repeat', b),
  ];
  const missing = a.missingModule || b.missingModule;
  if (missing) out.push(`  log: ${missing}`);
  // "the log did not say why" and "we never read the log" are different claims, and only one of
  // them is about the server.
  if (a.ambiguous || b.ambiguous) {
    out.push(
      '  note: more than one request to this route in the window — the line read may not be ours.'
    );
  }
  if (a.logUnread || b.logUnread) {
    out.push('  note: the session log was NOT read, so this verdict is wall-clock only.');
  } else if (!a.serverTotalMs && !b.serverTotalMs) {
    out.push('  note: no matching request line in the log window; verdict is wall-clock only.');
  }
  if (result.followUp) {
    const f = result.followUp;
    out.push(
      `  ${f.route}: ${f.ok ? `${f.status} in ${ms(f.elapsedMs)}` : `${f.error} after ${ms(f.elapsedMs)}`}`
    );
  }
  if (result.remedy) out.push(`  -> ${result.remedy}`);
  return out.join('\n');
}

// Deleting the build dir is the fix for `wedged` and nothing else; it costs a guaranteed ~45s
// rebuild, so it is never applied on a guess.
export function purgeDistDir(worktree, distDir) {
  const target = resolve(worktree, distDir || '.next');
  const rel = relative(worktree, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Refusing to purge ${target}: outside the worktree.`);
  }
  if (!rel.replace(/\\/g, '/').startsWith('.next')) {
    throw new Error(`Refusing to purge ${target}: not a Next build dir.`);
  }
  if (!existsSync(target)) return { path: target, removed: false };
  rmSync(target, { recursive: true, force: true });
  return { path: target, removed: true };
}
