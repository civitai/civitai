import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import client from 'prom-client';

// ---------------------------------------------------------------------------
// WHY THIS TEST EXISTS
//
// PR #2490 (warmup-gated /api/ready) shipped with ZERO tests for warmup.ts. This
// suite pins the statically-testable parts of the warm-state machine:
//   - the disabled (opt-out) no-op path
//   - the success path (all routes warmed → state 'warmed-ok')
//   - the fail-open hard-timeout path (a hung warm → state 'failopen-timeout')
//   - the per-request AbortSignal.timeout robustness fix (MEDIUM-1): a single
//     hung route is abandoned, the OTHER routes still run, warmup completes
//   - the globalThis pin contract (state lives on globalThis.__civitaiWarmState),
//     so a regression that reverts to a module-local `let` is caught
//
// LIMITATION (cannot be covered by a unit test): the real bug the globalThis pin
// guards against is the TWO-WEBPACK-GRAPH runtime crossing — runWarmup() flips the
// flag in the instrumentation bundle's module copy while /api/ready reads the
// request bundle's copy. Vitest loads ONE module graph, so we cannot reproduce the
// cross-graph divergence here; we can only assert the contract that the state is
// stored on the real V8 global (the mechanism that makes the cross-graph flip
// visible). The cross-graph behaviour needs a live pod to verify.
// ---------------------------------------------------------------------------

// A real throwaway registry standing in for the cross-graph shared
// `instrumentationRegistry`. The global src/__tests__/setup.ts mock of
// ~/server/prom/client stubs registerInstrumentationMetric but does NOT export
// instrumentationRegistry (which warmup.ts imports), so we override the mock here
// with a shape that provides BOTH — mirroring the eventloop-longtask test pattern.
// vi.hoisted so it's constructed before the hoisted vi.mock factory references it.
const { warmTestRegistry } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const promClient = require('prom-client');
  return { warmTestRegistry: new promClient.Registry() as client.Registry };
});

vi.mock('~/server/prom/client', () => {
  function registerInstrumentationMetric<M extends client.Metric<string>>(
    name: string,
    factory: () => M
  ): M {
    const existing = warmTestRegistry.getSingleMetric(name);
    if (existing) return existing as unknown as M;
    return factory();
  }
  return {
    instrumentationRegistry: warmTestRegistry,
    registerInstrumentationMetric,
    // Incidental helpers other instrumentation modules import; inert here.
    registerCounter: () => ({ inc: vi.fn() }),
    registerHistogram: () => ({ observe: vi.fn() }),
  };
});

// env.NEXTAUTH_URL / env.WEBHOOK_TOKEN are read by warmup.ts. The global setup
// proxy already supplies NEXTAUTH_URL='http://localhost:3000'; WEBHOOK_TOKEN
// falls through to undefined which is fine for these tests.

// Helper: a deferred promise that never resolves on its own — used to simulate a
// hung fetch. We expose resolve so a test can release it if needed.
function neverResolves<T = never>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// A minimal Response-like stub the warmer treats as a 200 with a drainable body.
function okResponse(status = 200) {
  return { status, ok: status >= 200 && status < 300, text: () => Promise.resolve('') };
}

// Reset module + global state between tests. warmup.ts pins state on
// globalThis.__civitaiWarmState and carries a module-local `started` guard, so we
// must clear the global AND re-import the module fresh for each test.
const ENV_KEYS = [
  'WARMUP_ENABLED',
  'WARMUP_ROUTES',
  'WARMUP_TIMEOUT_MS',
  'WARM_ITERATIONS',
  'WARM_INITIAL_JITTER_MAX_MS',
  'WARM_INTER_ROUTE_JITTER_MAX_MS',
  'WARM_PER_REQUEST_TIMEOUT_MS',
  'PORT',
];

function clearWarmEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

async function loadWarmup() {
  vi.resetModules();
  return import('~/server/warmup');
}

describe('warmup: state machine', () => {
  beforeEach(() => {
    // Fresh global warm state every test (warmup pins it on globalThis).
    delete (globalThis as Record<string, unknown>).__civitaiWarmState;
    clearWarmEnv();
    // Disable jitter sleeps by default so timing-sensitive tests are deterministic.
    process.env.WARM_INITIAL_JITTER_MAX_MS = '0';
    process.env.WARM_INTER_ROUTE_JITTER_MAX_MS = '0';
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete (globalThis as Record<string, unknown>).__civitaiWarmState;
    clearWarmEnv();
  });

  it('disabled path: WARMUP_ENABLED unset → no-op, isWarm()=true, state=disabled, no fetch', async () => {
    // WARMUP_ENABLED is unset (cleared in beforeEach).
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const warmup = await loadWarmup();
    await warmup.runWarmup();

    expect(warmup.isWarm()).toBe(true);
    expect(warmup.getWarmState()).toBe('disabled');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('disabled path: WARMUP_ENABLED=false behaves the same as unset', async () => {
    process.env.WARMUP_ENABLED = 'false';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const warmup = await loadWarmup();
    await warmup.runWarmup();

    expect(warmup.isWarm()).toBe(true);
    expect(warmup.getWarmState()).toBe('disabled');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('success path: enabled + 200 fetches → warmed-ok, isWarm()=true, durationMs set, fetch per route×iterations', async () => {
    process.env.WARMUP_ENABLED = 'true';
    // 2 explicit routes + 1 iteration each. Plus the waitForListener /api/live poll.
    process.env.WARMUP_ROUTES = '/api/v1/images?limit=20,/';
    process.env.WARM_ITERATIONS = '1';

    const fetchMock = vi.fn(() => Promise.resolve(okResponse(200)));
    vi.stubGlobal('fetch', fetchMock);

    const warmup = await loadWarmup();
    await warmup.runWarmup();

    expect(warmup.isWarm()).toBe(true);
    expect(warmup.getWarmState()).toBe('warmed-ok');
    expect(warmup.getWarmDurationMs()).toBeTypeOf('number');
    expect(warmup.getWarmDurationMs()).toBeGreaterThanOrEqual(0);

    // Count fetches by URL kind: 1 /api/live listener poll + 1 per route.
    const calls = fetchMock.mock.calls.map((c) => String(c[0]));
    const livePolls = calls.filter((u) => u.includes('/api/live')).length;
    const routeWarms = calls.filter((u) => !u.includes('/api/live')).length;
    expect(livePolls).toBeGreaterThanOrEqual(1); // listener became ready on first poll
    expect(routeWarms).toBe(2); // 2 routes × 1 iteration
  });

  it('success path: WARM_ITERATIONS=2 warms each route twice', async () => {
    process.env.WARMUP_ENABLED = 'true';
    process.env.WARMUP_ROUTES = '/a,/b';
    process.env.WARM_ITERATIONS = '2';

    const fetchMock = vi.fn(() => Promise.resolve(okResponse(200)));
    vi.stubGlobal('fetch', fetchMock);

    const warmup = await loadWarmup();
    await warmup.runWarmup();

    expect(warmup.getWarmState()).toBe('warmed-ok');
    const routeWarms = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => !u.includes('/api/live')).length;
    expect(routeWarms).toBe(4); // 2 routes × 2 iterations
  });

  it('fail-open timeout path: a hung warm fetch + timer past WARMUP_TIMEOUT_MS → isWarm()=true, state=failopen-timeout', async () => {
    vi.useFakeTimers();
    process.env.WARMUP_ENABLED = 'true';
    process.env.WARMUP_ROUTES = '/hang';
    process.env.WARMUP_TIMEOUT_MS = '5000';
    // Disable the per-request abort so the hang is what the hard timer races
    // (otherwise the per-request timeout would abort the route first).
    process.env.WARM_PER_REQUEST_TIMEOUT_MS = '0';

    const hung = neverResolves<ReturnType<typeof okResponse>>();
    // /api/live answers 200 immediately so we reach the route-warm loop; the
    // route fetch then hangs forever.
    const fetchMock = vi.fn((url: string) => {
      if (String(url).includes('/api/live')) return Promise.resolve(okResponse(200));
      return hung.promise;
    });
    vi.stubGlobal('fetch', fetchMock);

    const warmup = await loadWarmup();
    const runPromise = warmup.runWarmup();

    // Let the listener poll + reach the hung route fetch.
    await vi.advanceTimersByTimeAsync(0);
    // Not warm yet — the route is still hanging, hard timer hasn't fired.
    expect(warmup.isWarm()).toBe(false);

    // Advance past the hard fail-open timeout.
    await vi.advanceTimersByTimeAsync(5001);

    expect(warmup.isWarm()).toBe(true);
    expect(warmup.getWarmState()).toBe('failopen-timeout');
    expect(warmup.getWarmDurationMs()).toBeTypeOf('number');

    // Release the hung fetch so the dangling promise settles; runWarmup's finally
    // is a no-op once the timeout already flipped state.
    hung.resolve(okResponse(200));
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;
    // State must remain failopen-timeout (finally must NOT overwrite it).
    expect(warmup.getWarmState()).toBe('failopen-timeout');
  });

  it('per-request timeout (MEDIUM-1): one hung route is abandoned, the OTHER route still runs, warmup completes', async () => {
    vi.useFakeTimers();
    process.env.WARMUP_ENABLED = 'true';
    process.env.WARMUP_ROUTES = '/hang,/ok';
    process.env.WARM_ITERATIONS = '1';
    process.env.WARM_PER_REQUEST_TIMEOUT_MS = '1000';
    // Keep the hard fail-open timeout well above the per-request timeout so the
    // per-request abort — not the hard timer — is what unblocks the loop.
    process.env.WARMUP_TIMEOUT_MS = '60000';

    let okWarmed = false;
    // fetch honors the AbortSignal: when /hang is called with a signal, reject
    // with a TimeoutError once the signal aborts (mirrors AbortSignal.timeout).
    const fetchMock = vi.fn((url: string, init?: { signal?: AbortSignal }) => {
      const u = String(url);
      if (u.includes('/api/live')) return Promise.resolve(okResponse(200));
      if (u.includes('/hang')) {
        return new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            signal.addEventListener('abort', () => {
              const err = new Error('The operation was aborted due to timeout');
              err.name = 'TimeoutError';
              reject(err);
            });
          }
        });
      }
      // /ok route
      okWarmed = true;
      return Promise.resolve(okResponse(200));
    });
    vi.stubGlobal('fetch', fetchMock);

    const warmup = await loadWarmup();
    const runPromise = warmup.runWarmup();

    // Drive timers: listener poll → hung route fetch begins → per-request
    // AbortSignal.timeout(1000) fires → /hang rejects → loop continues to /ok.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1001);
    // Flush any remaining microtasks/timers so /ok runs and finally completes.
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;

    // The loop CONTINUED past the hung route: /ok was warmed.
    expect(okWarmed).toBe(true);
    expect(warmup.isWarm()).toBe(true);
    // Completed naturally (per-request abort, not hard fail-open timeout).
    expect(warmup.getWarmState()).toBe('warmed-ok');

    // Assert the hung fetch was actually given an AbortSignal (the MEDIUM-1 fix).
    const hangCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/hang'));
    expect(hangCall).toBeDefined();
    expect((hangCall?.[1] as { signal?: AbortSignal })?.signal).toBeInstanceOf(AbortSignal);
  });

  it('globalThis pin: warm state lives on globalThis.__civitaiWarmState (regression guard vs module-local let)', async () => {
    process.env.WARMUP_ENABLED = 'true';
    process.env.WARMUP_ROUTES = '/';
    const fetchMock = vi.fn(() => Promise.resolve(okResponse(200)));
    vi.stubGlobal('fetch', fetchMock);

    const warmup = await loadWarmup();
    await warmup.runWarmup();

    // The state object the module's isWarm()/getWarmState() read MUST be the one
    // pinned on the real V8 global. If a regression reverts to a module-local
    // `let`, this global would stay at its initial value (or be absent) while the
    // module reports warmed — catching the cross-graph-breaking regression.
    const pinned = (globalThis as Record<string, unknown>).__civitaiWarmState as
      | { ready: boolean; state: string; durationMs: number | null }
      | undefined;
    expect(pinned).toBeDefined();
    expect(pinned?.ready).toBe(true);
    expect(pinned?.state).toBe('warmed-ok');
    // And the module's accessors agree with the pinned object.
    expect(warmup.isWarm()).toBe(pinned?.ready);
    expect(warmup.getWarmState()).toBe(pinned?.state);
  });
});
