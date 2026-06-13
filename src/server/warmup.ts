// In-process route warmer for the Next.js standalone server.
//
// WHY: `output: 'standalone'` lazy-`require()`s each API/page route the FIRST
// time it's hit. The dependency-only /api/health probe marks a pod Ready as
// soon as its DB/Redis/etc. are reachable — but at that moment every hot route
// is still COLD. The kubelet then routes real /api/v1/images, tRPC
// image.getInfinite / image.getImagesAsPostsInfinite / model.getAll, and SSR
// `/` traffic to the pod; the first hit pays lazy-require + JIT compilation on
// the single event-loop thread, which pins the loop → 504/502/499 — the
// cold-start cascade observed on every rollout.
//
// This module self-warms the hot routes via LOCALHOST requests during startup
// and only flips `warmReady` true once warm (or a fail-open timeout fires).
// The /api/ready probe gates on isWarm() so a pod isn't marked Ready until its
// hot paths are JIT-settled. instrumentation.node.ts kicks runWarmup() as a
// fire-and-forget (NOT awaited — register() must return so the HTTP listener
// comes up, which the warmer needs to self-request).
//
// FAIL-OPEN by design: a slightly-cold pod is far better than a wedged
// rollout. Every request is wrapped in try/catch, the listener wait is
// bounded, and a hard overall timeout guarantees `warmReady` is set no matter
// what (success, per-route errors, or timeout). A fail-open timeout still
// flips warmReady=true (the pod becomes Ready) — it is made VISIBLE via the
// `civitai_app_warmup_state` gauge + /api/ready body so an operator can tell a
// truly-warmed pod from one that just timed out, not blocked.
//
// OPT-IN: WARMUP_ENABLED defaults to FALSE. The warmer no-ops + flips
// warmReady=true immediately when disabled, so /api/ready behaves like a plain
// dependency probe everywhere it isn't explicitly enabled. It is turned on
// (WARMUP_ENABLED=true) ONLY on the SSR/API/heavy pools via the deployment
// manifest — never on jobs / civitai-next / -stage / civitai-app / PR previews
// (some of which point at the DEV DB).
//
// Server-side (nodejs runtime) only. Never imported on the edge/client.

import { env } from '~/env/server';
import { registerInstrumentationMetric, instrumentationRegistry } from '~/server/prom/client';
import client from 'prom-client';

// Observable warm state — exposed both via Prometheus (civitai_app_warmup_state)
// and the /api/ready JSON body. These let an operator SEE whether a pod truly
// warmed or just fail-open-timed-out, and how long warming took.
export type WarmState = 'disabled' | 'in-progress' | 'warmed-ok' | 'failopen-timeout';

// ---------------------------------------------------------------------------
// Cross-graph shared warm state (CRITICAL — see prom/client.ts header)
// ---------------------------------------------------------------------------
//
// WHY: Next.js compiles `instrumentation.ts` into a SEPARATE webpack bundle from
// the API-route/pages bundle, so each graph gets its OWN copy of this module —
// and thus its own module-level `let`. `runWarmup()` is invoked ONLY from the
// instrumentation graph (instrumentation.node.ts), so it flips the warm flag in
// the INSTRUMENTATION graph's copy. But `/api/ready`'s `isWarm()` reads the
// REQUEST graph's copy — where a plain module-`let` would stay `false` FOREVER,
// so /api/ready would return 503 permanently and repointing probes at it would
// wedge every rollout. (Exactly the bug the metrics-pin in prom/client.ts was
// added to fix — see registerInstrumentationMetric / __civitaiInstrumentationRegistry.)
//
// FIX: pin the warm state on `globalThis` (the real V8 global, shared across all
// webpack bundles in the same Node process). Every reader (`isWarm`, `/api/ready`)
// and every writer (`runWarmup` success/timeout, the disabled early-return,
// `setWarmState`) goes through this ONE pinned object, so a flip in the
// instrumentation graph is visible from the request graph.
declare global {
  // eslint-disable-next-line no-var
  var __civitaiWarmState:
    | { ready: boolean; state: WarmState; durationMs: number | null }
    | undefined;
}

const warm = (globalThis.__civitaiWarmState ??= {
  ready: false,
  state: 'in-progress',
  durationMs: null,
});

export const isWarm = () => warm.ready;

export const getWarmState = (): WarmState => warm.state;
export const getWarmDurationMs = (): number | null => warm.durationMs;
export const didFailOpenTimeout = (): boolean => warm.state === 'failopen-timeout';

const LOG_PREFIX = '[warmup]';

// Numeric encoding for the gauge (Prometheus gauges are numeric):
//   0 = disabled / not-applicable, 1 = in-progress, 2 = warmed-ok,
//   3 = fail-open timeout (warm flipped on without confirmed warm path).
const WARM_STATE_CODE: Record<WarmState, number> = {
  disabled: 0,
  'in-progress': 1,
  'warmed-ok': 2,
  'failopen-timeout': 3,
};

// Cross-graph shared registry: this module is imported from the instrumentation
// webpack graph (instrumentation.node.ts -> import('~/server/warmup')), so the
// metrics MUST land in the globalThis-pinned instrumentationRegistry to be
// visible from /metrics (scraped in the request graph). registerInstrumentationMetric
// is HMR/dual-graph idempotent — it short-circuits to the existing instance
// before re-constructing. See src/server/prom/client.ts.
// Metric names use the shared PROM_PREFIX (civitai_app_*) like every other
// instrumentation metric (see prom/client.ts PROM_PREFIX + eventloop-longtask.ts).
const warmStateGauge = registerInstrumentationMetric(
  'civitai_app_warmup_state',
  () =>
    new client.Gauge({
      name: 'civitai_app_warmup_state',
      help: 'In-process route-warmer state (0=disabled,1=in-progress,2=warmed-ok,3=failopen-timeout)',
      registers: [instrumentationRegistry],
    })
);

const warmDurationGauge = registerInstrumentationMetric(
  'civitai_app_warmup_duration_seconds',
  () =>
    new client.Gauge({
      name: 'civitai_app_warmup_duration_seconds',
      help: 'Wall-clock seconds the in-process route warmer took to complete (or to fail-open timeout)',
      registers: [instrumentationRegistry],
    })
);

function setWarmState(state: WarmState) {
  warm.state = state;
  warmStateGauge.set(WARM_STATE_CODE[state]);
}

// Reflect the initial state on the gauge at module init so a scrape before
// runWarmup() resolves still reports a value (not absent).
warmStateGauge.set(WARM_STATE_CODE[warm.state]);

// WebhookEndpoint/-style routes are token-gated; /api/live + /api/health use
// env.WEBHOOK_TOKEN. Use the validated env accessor (same one health.ts /
// ready.ts use) rather than a hardcoded literal fallback, so a rotated token
// can't silently break the warmer's /api/live readiness poll.
const WEBHOOK_TOKEN = env.WEBHOOK_TOKEN;

// The app warming itself from its own canonical origin is a legitimate
// first-party request, so send the headers that satisfy the tRPC origin gate.
// isAllowedOriginRequest (src/server/createContext.ts) compares the Origin host
// (falling back to Referer) against allowedOriginHosts, which is built from the
// server domains + TRPC_ORIGINS + hostFromUrl(env.NEXTAUTH_URL). Sending
// Origin: <NEXTAUTH_URL> (= https://civitai.com) therefore makes
// acceptableOrigin=true → isAcceptableOrigin passes → the heavy resolver runs
// (instead of UNAUTHORIZED 401). We deliberately do NOT send `x-client: web`:
// needsUpdate() in trpc.ts returns false unless x-client === 'web', so omitting
// it avoids the version/x-update-required branch entirely. Applied to ALL warm
// requests (REST + tRPC + SSR) — the REST/SSR paths don't need it but it's
// harmless and keeps one header set.
const WARM_HEADERS: Record<string, string> = {
  origin: env.NEXTAUTH_URL,
};

// superjson is the app's tRPC transformer (see src/utils/trpc.ts). A tRPC v11
// GET query batch carries each op's input as `{ "<idx>": { "json": <input> } }`
// url-encoded under `?batch=1&input=`. We hand-build the minimal valid form
// here (no react/trpc-client import on the server boot path) — superjson's
// `{ json }` envelope is correct for plain JSON-safe inputs (no Date/Map/etc.).
function buildTrpcBatchUrl(procedures: string[], inputs: unknown[]): string {
  const input: Record<string, { json: unknown }> = {};
  inputs.forEach((value, i) => {
    input[String(i)] = { json: value };
  });
  const path = procedures.join(',');
  return `/api/trpc/${path}?batch=1&input=${encodeURIComponent(JSON.stringify(input))}`;
}

// Default hot route list. These are idempotent GET reads ONLY — never a
// mutating route. The same image runs the SSR / API / heavy pools, so warming
// the superset on every pod is fine (reads are side-effect-free) and lets a
// single image serve any pool. Ops can override per-pool via WARMUP_ROUTES.
function defaultRoutes(): string[] {
  return [
    // Hot REST route (PublicEndpoint — no token needed).
    '/api/v1/images?limit=20',
    // Heavy tRPC procedures (image.getInfinite, image.getImagesAsPostsInfinite,
    // model.getAll) batched into one GET, the form the web client uses. Minimal
    // valid inputs — the schemas default the rest (limit/period/sort/etc.).
    buildTrpcBatchUrl(
      ['image.getInfinite', 'image.getImagesAsPostsInfinite', 'model.getAll'],
      [{ limit: 20 }, { limit: 20 }, { limit: 20 }]
    ),
    // SSR catch-all — warms the SSR pool's page-render path.
    '/',
  ];
}

function getRoutes(): string[] {
  const override = process.env.WARMUP_ROUTES;
  if (override && override.trim().length > 0) {
    return override
      .split(',')
      .map((r) => r.trim())
      .filter((r) => r.length > 0);
  }
  return defaultRoutes();
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const LISTENER_POLL_INTERVAL_MS = 500;
const LISTENER_WAIT_MS = 15_000;

// One warm pass per route by default — enough to pay the lazy-require + JIT
// settle on the hot path without a heavy backend pulse. Env-overridable
// (WARM_ITERATIONS) if a pool wants more JIT settling at the cost of more
// backend load. (Open runtime question: whether 1 iteration meaningfully
// settles the JIT vs 3 — needs a real-pod before/after.)
const WARM_ITERATIONS = intFromEnv('WARM_ITERATIONS', 1);

// Jitter so a fleet of pods warming concurrently during a surge/rollout doesn't
// hit the shared DB-replica / Meili in lockstep. Both an initial random delay
// and a small inter-route delay are applied. Math.random is fine here (no
// security/uniqueness requirement — just load smearing).
//
// The INITIAL jitter ceiling is the load-smearing knob that matters: a ~75-pod
// fleet all becoming listener-ready within ~1s of each other during a rollout
// would, at a 500ms ceiling, fire their first HEAVY warm read (the feed query)
// at the shared DB-replica / Meili inside a 500ms window — a pulse on backends
// that are ALREADY stressed by the rollout. Default the ceiling to 10s so the
// fleet spreads its first heavy hit over ~10s instead. Env-overridable per pool
// (WARM_INITIAL_JITTER_MAX_MS). Inter-route jitter stays modest. (Open: the real
// pulse must be validated on a canary rollout before fleet-wide enable.)
const WARM_INITIAL_JITTER_MAX_MS = intFromEnv('WARM_INITIAL_JITTER_MAX_MS', 10_000);
const WARM_INTER_ROUTE_JITTER_MAX_MS = intFromEnv('WARM_INTER_ROUTE_JITTER_MAX_MS', 500);
const randomJitter = (maxMs: number) => (maxMs > 0 ? Math.floor(Math.random() * maxMs) : 0);

// Per-request hard timeout for a single warm fetch (MEDIUM-1). Without it a warm
// read that hangs (a brown dependency that accepts the connection but never
// responds) would leak its loopback socket for the pod's life and strand
// warmState='in-progress' on that route forever — the per-route `await` would
// never resolve. Readiness itself is NOT wedged (the independent fail-open
// setTimeout(WARMUP_TIMEOUT_MS) still flips ready=true), so this is robustness,
// not correctness. We bound EACH fetch with AbortSignal.timeout(perRouteMs)
// (Node 20+) so a hung route is abandoned and the loop CONTINUES to the next.
// 0 disables the per-request bound (falls back to no AbortSignal). Env-overridable
// via WARM_PER_REQUEST_TIMEOUT_MS (default 10s).
const WARM_PER_REQUEST_TIMEOUT_MS = intFromEnv('WARM_PER_REQUEST_TIMEOUT_MS', 10_000);

// Build the AbortSignal for a single warm fetch. Returns undefined when the
// per-request timeout is disabled (<=0) so we pass no signal in that case.
const warmAbortSignal = (): AbortSignal | undefined =>
  WARM_PER_REQUEST_TIMEOUT_MS > 0 ? AbortSignal.timeout(WARM_PER_REQUEST_TIMEOUT_MS) : undefined;

// Poll /api/live until the HTTP listener answers 200, so self-requests don't
// race the server coming up. Bounded — never block boot forever.
async function waitForListener(baseUrl: string): Promise<boolean> {
  const deadline = Date.now() + LISTENER_WAIT_MS;
  const url = `${baseUrl}/api/live?token=${encodeURIComponent(WEBHOOK_TOKEN)}`;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET', headers: WARM_HEADERS });
      if (res.ok) {
        // Drain the body so the connection can be reused/closed cleanly.
        await res.text().catch(() => undefined);
        return true;
      }
      await res.text().catch(() => undefined);
    } catch {
      // listener not up yet — keep polling
    }
    await sleep(LISTENER_POLL_INTERVAL_MS);
  }
  return false;
}

// Warm a single route (WARM_ITERATIONS passes, default 1) to settle the JIT.
// Every error is swallowed — a bad input or a transiently-down dependency must
// not crash boot or abort the rest of the warmup.
async function warmRoute(baseUrl: string, route: string): Promise<void> {
  const url = `${baseUrl}${route}`;
  let lastStatus = 0;
  let errored = false;
  for (let i = 0; i < WARM_ITERATIONS; i++) {
    try {
      // Per-request AbortSignal.timeout (MEDIUM-1): a hung warm read is aborted
      // after WARM_PER_REQUEST_TIMEOUT_MS so it can't leak a socket or strand
      // this route's await forever. The abort surfaces as a throw from fetch (or
      // from res.text() if the body hangs) — caught below — and the caller's
      // loop CONTINUES to the next route. Body drain shares the same signal so a
      // hung body stream is also abandoned.
      const signal = warmAbortSignal();
      const res = await fetch(url, { method: 'GET', headers: WARM_HEADERS, signal });
      lastStatus = res.status;
      // Read the body so the handler runs to completion (the response stream is
      // part of the hot path we want JIT-compiled) and the socket frees up. If
      // the body stream hangs and the shared signal aborts, let it throw to the
      // outer catch (LOW-2) so the route is logged errored, not a false success.
      await res.text();
    } catch (err) {
      errored = true;
      // AbortSignal.timeout aborts with a TimeoutError DOMException; surface it
      // concisely so an operator can tell a per-request timeout from a real
      // connection error. Either way we swallow it and continue.
      const e = err as Error;
      const aborted = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      console.warn(
        `${LOG_PREFIX} route warm ${aborted ? 'timeout' : 'error'} ${route}` +
          `${aborted ? ` (>${WARM_PER_REQUEST_TIMEOUT_MS}ms)` : ''}:`,
        e?.message ?? err
      );
    }
  }
  console.log(
    `${LOG_PREFIX} warmed ${route} (${WARM_ITERATIONS}x, lastStatus=${lastStatus}${
      errored ? ', errored' : ''
    })`
  );
}

// Double-run guard. Left module-local (NOT globalThis-pinned) deliberately:
// runWarmup() is invoked ONLY from the instrumentation graph
// (instrumentation.node.ts), so there is a single copy that matters. Even if a
// second graph ever called it, both writes go through the shared globalThis
// `warm` object, so a duplicate run is at worst a harmless extra warm pass — it
// cannot corrupt the readiness state.
let started = false;

export async function runWarmup(): Promise<void> {
  if (started) return;
  started = true;

  // Default OFF (opt-in). The warmer only runs when WARMUP_ENABLED === 'true'
  // (set on the SSR/API/heavy dp-prod deployments). Everywhere else — jobs,
  // civitai-next, -stage, civitai-app, PR previews — it no-ops and flips warm
  // immediately so /api/ready behaves like a plain dependency probe (no warm
  // gate). This keeps the warmer (which executes the heavy feed query and could
  // hit a DEV DB on previews) off the pools it has no business warming.
  if (process.env.WARMUP_ENABLED !== 'true') {
    // WARN (not log) + a distinct, alertable gauge value (state=disabled → 0).
    // This is the silent-cold footgun guard: if a manifest repoints startup/
    // readiness probes at /api/ready but FORGETS WARMUP_ENABLED=true on a
    // warming pool, the warmer no-ops and /api/ready returns 200 on a COLD pod.
    // The greppable per-pod WARN below + the disabled gauge value let an
    // operator (and a Prometheus alert scoped to the SSR/API/heavy pools)
    // detect that misconfig. Setting WARMUP_ENABLED=true and repointing the
    // probes MUST be ONE atomic manifest change.
    console.warn(
      `${LOG_PREFIX} DISABLED (WARMUP_ENABLED!=='true') — no warm run; /api/ready will 200 on a COLD pod. ` +
        `This is correct for non-warming pools (jobs/next/stage/app/previews); on an SSR/API/heavy pool it means a missed WARMUP_ENABLED=true.`
    );
    warm.ready = true;
    setWarmState('disabled');
    return;
  }

  const port = process.env.PORT ?? '3000';
  // Self-call the host the standalone server ACTUALLY binds to. Next's
  // server.js listens on `process.env.HOSTNAME || '0.0.0.0'`, and Kubernetes
  // sets HOSTNAME to the POD NAME — so the server binds the pod-name interface
  // ONLY and 127.0.0.1 is REFUSED (verified on a live preview pod: loopback →
  // ECONNREFUSED, $HOSTNAME → 200). Mirror that bind: use HOSTNAME when set
  // (k8s/standalone), fall back to loopback for local/dev where HOSTNAME is
  // unset and the server binds 0.0.0.0. WARM_HOST overrides if ever needed.
  const rawHost = process.env.WARM_HOST || process.env.HOSTNAME || '127.0.0.1';
  // Self-defend against the wildcard-bind case: if HOSTNAME is set to a wildcard
  // (`0.0.0.0`/`::`) — e.g. someone adds the common `HOSTNAME=0.0.0.0` Next-k8s
  // bind workaround — the server binds all interfaces (loopback included) but a
  // wildcard is NOT a valid CONNECT target on Linux/undici. Normalize it to
  // loopback so the warmer can't silently revert to the inert-ECONNREFUSED bug.
  const host =
    rawHost === '0.0.0.0' || rawHost === '::' || rawHost === '[::]' ? '127.0.0.1' : rawHost;
  const baseUrl = `http://${host}:${port}`;
  const timeoutMs = intFromEnv('WARMUP_TIMEOUT_MS', 60_000);
  const startedAt = Date.now();

  // Hard fail-open timer: whatever happens, the pod becomes Ready-eligible
  // after timeoutMs. Better a slightly-cold pod than a rollout wedged on a
  // warmer that hangs (e.g. a dependency the warm reads touch is brown).
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    if (!warm.ready) {
      warm.ready = true;
      // Record the fail-open: the pod IS now Ready (so a slow backend can't
      // wedge the rollout), but the warm path was NOT confirmed. This is the
      // alertable state — visible on civitai_app_warmup_state=3 and /api/ready.
      warm.durationMs = Date.now() - startedAt;
      warmDurationGauge.set(warm.durationMs / 1000);
      setWarmState('failopen-timeout');
      console.warn(`${LOG_PREFIX} hard timeout after ${timeoutMs}ms — marking warm (fail-open)`);
    }
  }, timeoutMs);
  timeoutId.unref?.();

  try {
    const routes = getRoutes();
    console.log(
      `${LOG_PREFIX} starting — baseUrl=${baseUrl}, timeoutMs=${timeoutMs}, routes=${routes.length}`
    );

    const listenerUp = await waitForListener(baseUrl);
    if (!listenerUp) {
      console.warn(
        `${LOG_PREFIX} listener not ready after ${LISTENER_WAIT_MS}ms — warming anyway (fail-open)`
      );
    }

    // Randomized initial delay so a fleet of pods that all become listener-ready
    // at roughly the same instant during a rollout don't fire their first heavy
    // warm read at the shared DB-replica / Meili in lockstep.
    if (!timedOut) {
      const initialJitter = randomJitter(WARM_INITIAL_JITTER_MAX_MS);
      if (initialJitter > 0) await sleep(initialJitter);
    }

    // Warm routes sequentially so we don't pile concurrent cold lazy-requires
    // onto the single event-loop thread (that would re-create the very pin
    // we're trying to avoid). Stop early if the hard timeout already fired.
    // Small randomized inter-route delay further smears the backend load.
    let first = true;
    for (const route of routes) {
      if (timedOut) break;
      if (!first) {
        const interJitter = randomJitter(WARM_INTER_ROUTE_JITTER_MAX_MS);
        if (interJitter > 0) await sleep(interJitter);
      }
      first = false;
      await warmRoute(baseUrl, route);
    }
  } catch (err) {
    // Defensive: nothing above should throw (each leg is guarded), but a throw
    // here must NOT prevent the ready flip below.
    console.error(`${LOG_PREFIX} unexpected error:`, (err as Error)?.message ?? err);
  } finally {
    clearTimeout(timeoutId);
    // Fail-open: flip warm at the end no matter what — success, per-route
    // errors, or partial completion. (If the hard timeout already flipped it,
    // this is a harmless no-op.)
    warm.ready = true;
    // Record duration + final state. If the hard timeout already fired, leave
    // the failopen-timeout state/duration it set (don't overwrite with the
    // later natural-completion time). Otherwise the warm pass completed → mark
    // warmed-ok with its wall-clock.
    if (!timedOut) {
      warm.durationMs = Date.now() - startedAt;
      warmDurationGauge.set(warm.durationMs / 1000);
      setWarmState('warmed-ok');
    }
    console.log(
      `${LOG_PREFIX} complete in ${Date.now() - startedAt}ms — warmReady=true, state=${warm.state}${
        timedOut ? ' (via timeout)' : ''
      }`
    );
  }
}
