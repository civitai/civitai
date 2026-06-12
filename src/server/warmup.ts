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
// what (success, per-route errors, or timeout). Disable entirely with
// WARMUP_ENABLED=false (env, no code revert).
//
// Server-side (nodejs runtime) only. Never imported on the edge/client.

let warmReady = false;

export const isWarm = () => warmReady;

const LOG_PREFIX = '[warmup]';

// WebhookEndpoint/-style routes are token-gated; /api/live + /api/health use
// env.WEBHOOK_TOKEN, whose prod value is `letsgethookie` (set via the deployment
// manifest, not this repo). The warmer reads it from env so it works in any
// environment; falls back to the known prod literal so a missing env var can't
// silently break the listener-readiness probe.
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN ?? 'letsgethookie';

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
const WARM_ITERATIONS = 3;

// Poll /api/live until the HTTP listener answers 200, so self-requests don't
// race the server coming up. Bounded — never block boot forever.
async function waitForListener(baseUrl: string): Promise<boolean> {
  const deadline = Date.now() + LISTENER_WAIT_MS;
  const url = `${baseUrl}/api/live?token=${encodeURIComponent(WEBHOOK_TOKEN)}`;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET' });
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

// Warm a single route a few times to settle the JIT. Every error is swallowed
// — a bad input or a transiently-down dependency must not crash boot or abort
// the rest of the warmup.
async function warmRoute(baseUrl: string, route: string): Promise<void> {
  const url = `${baseUrl}${route}`;
  let lastStatus = 0;
  let errored = false;
  for (let i = 0; i < WARM_ITERATIONS; i++) {
    try {
      const res = await fetch(url, { method: 'GET' });
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

  // Disable switch — flip warm immediately so /api/ready behaves like a plain
  // dependency probe (no warm gate) without a code change.
  if (process.env.WARMUP_ENABLED === 'false') {
    console.log(`${LOG_PREFIX} disabled (WARMUP_ENABLED=false) — marking warm immediately`);
    warmReady = true;
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

    // Warm routes sequentially so we don't pile concurrent cold lazy-requires
    // onto the single event-loop thread (that would re-create the very pin
    // we're trying to avoid). Stop early if the hard timeout already fired.
    for (const route of routes) {
      if (timedOut) break;
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
    console.log(
      `${LOG_PREFIX} complete in ${Date.now() - startedAt}ms — warmReady=true${
        timedOut ? ' (via timeout)' : ''
      }`
    );
  }
}
