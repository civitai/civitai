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
// `civitai_warmup_state` gauge + /api/ready body so an operator can tell a
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

let warmReady = false;

export const isWarm = () => warmReady;

// Observable warm state — exposed both via Prometheus (civitai_warmup_state)
// and the /api/ready JSON body. These let an operator SEE whether a pod truly
// warmed or just fail-open-timed-out, and how long warming took.
export type WarmState = 'disabled' | 'in-progress' | 'warmed-ok' | 'failopen-timeout';
let warmState: WarmState = 'in-progress';
let warmDurationMs: number | null = null;

export const getWarmState = (): WarmState => warmState;
export const getWarmDurationMs = (): number | null => warmDurationMs;
export const didFailOpenTimeout = (): boolean => warmState === 'failopen-timeout';

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
const warmStateGauge = registerInstrumentationMetric(
  'civitai_warmup_state',
  () =>
    new client.Gauge({
      name: 'civitai_warmup_state',
      help: 'In-process route-warmer state (0=disabled,1=in-progress,2=warmed-ok,3=failopen-timeout)',
      registers: [instrumentationRegistry],
    })
);

const warmDurationGauge = registerInstrumentationMetric(
  'civitai_warmup_duration_seconds',
  () =>
    new client.Gauge({
      name: 'civitai_warmup_duration_seconds',
      help: 'Wall-clock seconds the in-process route warmer took to complete (or to fail-open timeout)',
      registers: [instrumentationRegistry],
    })
);

function setWarmState(state: WarmState) {
  warmState = state;
  warmStateGauge.set(WARM_STATE_CODE[state]);
}

// Reflect the initial in-progress state on the gauge at module init so a scrape
// before runWarmup() resolves still reports a value (not absent).
warmStateGauge.set(WARM_STATE_CODE[warmState]);

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
const WARM_INITIAL_JITTER_MAX_MS = intFromEnv('WARM_INITIAL_JITTER_MAX_MS', 500);
const WARM_INTER_ROUTE_JITTER_MAX_MS = intFromEnv('WARM_INTER_ROUTE_JITTER_MAX_MS', 500);
const randomJitter = (maxMs: number) => (maxMs > 0 ? Math.floor(Math.random() * maxMs) : 0);

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
      const res = await fetch(url, { method: 'GET', headers: WARM_HEADERS });
      lastStatus = res.status;
      // Read the body so the handler runs to completion (the response stream is
      // part of the hot path we want JIT-compiled) and the socket frees up.
      await res.text().catch(() => undefined);
    } catch (err) {
      errored = true;
      console.error(`${LOG_PREFIX} route warm error ${route}:`, (err as Error)?.message ?? err);
    }
  }
  console.log(
    `${LOG_PREFIX} warmed ${route} (${WARM_ITERATIONS}x, lastStatus=${lastStatus}${
      errored ? ', errored' : ''
    })`
  );
}

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
    console.log(
      `${LOG_PREFIX} disabled (WARMUP_ENABLED!=='true') — marking warm immediately, no warm run`
    );
    warmReady = true;
    setWarmState('disabled');
    return;
  }

  const port = process.env.PORT ?? '3000';
  // Always self-call over loopback regardless of the bind HOSTNAME (the
  // standalone server binds 0.0.0.0 by default; 127.0.0.1 is always reachable
  // in-pod and avoids any external DNS/hostname resolution).
  const baseUrl = `http://127.0.0.1:${port}`;
  const timeoutMs = intFromEnv('WARMUP_TIMEOUT_MS', 60_000);
  const startedAt = Date.now();

  // Hard fail-open timer: whatever happens, the pod becomes Ready-eligible
  // after timeoutMs. Better a slightly-cold pod than a rollout wedged on a
  // warmer that hangs (e.g. a dependency the warm reads touch is brown).
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    if (!warmReady) {
      warmReady = true;
      // Record the fail-open: the pod IS now Ready (so a slow backend can't
      // wedge the rollout), but the warm path was NOT confirmed. This is the
      // alertable state — visible on civitai_warmup_state=3 and /api/ready.
      warmDurationMs = Date.now() - startedAt;
      warmDurationGauge.set(warmDurationMs / 1000);
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
    warmReady = true;
    // Record duration + final state. If the hard timeout already fired, leave
    // the failopen-timeout state/duration it set (don't overwrite with the
    // later natural-completion time). Otherwise the warm pass completed → mark
    // warmed-ok with its wall-clock.
    if (!timedOut) {
      warmDurationMs = Date.now() - startedAt;
      warmDurationGauge.set(warmDurationMs / 1000);
      setWarmState('warmed-ok');
    }
    console.log(
      `${LOG_PREFIX} complete in ${Date.now() - startedAt}ms — warmReady=true, state=${warmState}${
        timedOut ? ' (via timeout)' : ''
      }`
    );
  }
}
