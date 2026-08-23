import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Does the per-backend circuit breaker actually TRIP on the failures each
// backend really produces?
//
// `search` and `metricsSearch` reach runWithLimiter by different routes:
//   - search        → withMeili() / the SDK proxy, useTimeout defaults TRUE,
//                     so the 2.5s wrapper timer sets failedForCircuit.
//   - metricsSearch → fetchDocumentsAbortable() ONLY, which passes
//                     { useTimeout: false } so the caller's 5s AbortSignal is
//                     the single deadline (avoiding a double-timeout race).
//
// The `search` cases below are the POSITIVE CONTROL: they prove this harness
// can observe a real CLOSED→OPEN transition. Read them alongside the
// metricsSearch cases — a zero from the latter only means something because
// the former is non-zero on the same instrument.

// ─── Mocks ──────────────────────────────────────────────────────────────────

// Deliberately tighter than the schema defaults so a trip is reachable in a
// unit test without burning wall-clock. The threshold is what decides whether
// a trip happens, so it is set explicitly here rather than inherited.
vi.mock('~/env/server', () => ({
  env: {
    SEARCH_HOST: 'http://meili-search.example',
    SEARCH_API_KEY: 'test-search-key',
    METRICS_SEARCH_HOST: 'http://meili-metrics.example',
    METRICS_SEARCH_API_KEY: 'test-metrics-key',
    IS_BUILD: false,
    // Small so the wrapper-timeout control runs fast.
    MEILI_CALL_TIMEOUT_MS: 25,
    MEILI_CALL_CONCURRENCY: 50,
    MEILI_RESOURCE_SELECT_CONCURRENCY: 500,
    MEILI_RESOURCE_SELECT_TIMEOUT_MS: 10_000,
    MEILI_CIRCUIT_TRIP_THRESHOLD: 3,
    MEILI_CIRCUIT_WINDOW_SECONDS: 60,
    MEILI_CIRCUIT_COOLDOWN_SECONDS: 30,
    MEILI_FETCH_TIMEOUT_MS: 5000,
  },
}));

vi.mock('~/server/utils/otel-helpers', () => ({
  withSpan: <T>(_name: string, _attrsOrFn: unknown, maybeFn?: () => T): T => {
    const fn = (typeof _attrsOrFn === 'function' ? _attrsOrFn : maybeFn) as () => T;
    return fn();
  },
  safeUrl: (u: string) => u,
}));

// Unlike client.test.ts (which funnels every counter into one shared spy), we
// key recorders BY METRIC NAME. Asserting "some counter moved" cannot tell a
// circuit trip apart from a timeout counter or a rejection counter, and this
// whole file turns on exactly that distinction.
type IncCall = Record<string, string | number>;
const counterCalls = new Map<string, IncCall[]>();

function recorderFor(name: string) {
  if (!counterCalls.has(name)) counterCalls.set(name, []);
  const calls = counterCalls.get(name) as IncCall[];
  return {
    inc: (labels?: IncCall) => {
      calls.push(labels ?? {});
    },
    labels: () => ({ inc: (labels?: IncCall) => calls.push(labels ?? {}) }),
  };
}

function incsFor(name: string, backend?: string) {
  const calls = counterCalls.get(name) ?? [];
  return backend ? calls.filter((c) => c.backend === backend) : calls;
}

vi.mock('~/server/prom/client', () => ({
  registerCounter: vi.fn(({ name }: { name: string }) => recorderFor(name)),
  registerCounterWithLabels: vi.fn(({ name }: { name: string }) => recorderFor(name)),
  registerGaugeWithLabels: vi.fn(() => ({ set: vi.fn(), inc: vi.fn(), dec: vi.fn() })),
  registerHistogram: vi.fn(() => ({
    startTimer: vi.fn(() => () => undefined),
    observe: vi.fn(),
  })),
}));

vi.mock('~/utils/logging', () => ({
  createLogger: () => () => undefined,
}));

const TRIPS = 'meili_circuit_trips_total';
const TIMEOUTS = 'meili_call_timeouts_total';

/** Fetch stub that hangs until the caller's AbortSignal fires. */
function makeHangingFetch() {
  return (_input: unknown, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener(
        'abort',
        () => {
          const err = new Error('The operation was aborted.') as Error & { name: string };
          err.name = 'AbortError';
          reject(err);
        },
        { once: true }
      );
    });
}

/** Fetch stub that immediately returns a non-ok HTTP response. */
function makeStatusFetch(status: number) {
  return () =>
    Promise.resolve({ ok: false, status, json: async () => ({}), text: async () => '' });
}

describe('per-backend circuit breaker — does it trip on each backend’s real failures?', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    // Fresh module instance per test: the circuit state lives in module scope,
    // so without this a trip in one test leaks into the next.
    vi.resetModules();
    counterCalls.clear();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ── POSITIVE CONTROL ──────────────────────────────────────────────────────
  // The `search` backend keeps the wrapper timer, so its failures DO reach the
  // breaker. If this ever goes to zero the harness is broken, and every
  // metricsSearch assertion below becomes meaningless.
  it('POSITIVE CONTROL: search backend trips CLOSED→OPEN after threshold wrapper-timeouts', async () => {
    const { withMeili } = await import('~/server/meilisearch/client');

    for (let i = 0; i < 3; i++) {
      await expect(withMeili('search', () => new Promise(() => undefined))).rejects.toThrow(
        /exceeded 25ms timeout/
      );
    }

    expect(incsFor(TIMEOUTS, 'search')).toHaveLength(3);
    expect(incsFor(TRIPS, 'search')).toHaveLength(1);
  });

  it('POSITIVE CONTROL: once OPEN, the search backend rejects immediately without calling the SDK', async () => {
    const { withMeili, MeiliCallTimeoutError } = await import('~/server/meilisearch/client');

    for (let i = 0; i < 3; i++) {
      await expect(withMeili('search', () => new Promise(() => undefined))).rejects.toThrow();
    }
    expect(incsFor(TRIPS, 'search')).toHaveLength(1);

    const sdk = vi.fn(() => Promise.resolve('ok'));
    const started = Date.now();
    const err = await withMeili('search', sdk).catch((e) => e);

    expect(err).toBeInstanceOf(MeiliCallTimeoutError);
    expect((err as { reason: string }).reason).toBe('concurrency');
    expect(sdk).not.toHaveBeenCalled();
    expect(Date.now() - started).toBeLessThan(25);
  });

  // ── THE DEFECT ────────────────────────────────────────────────────────────
  // fetchDocumentsAbortable is the ONLY caller of the metricsSearch limiter,
  // and it passes { useTimeout: false }. On that branch the sole thing that
  // sets failedForCircuit is `err instanceof MeiliCallTimeoutError` — which
  // that branch cannot itself produce. So neither of the two failures this
  // path really sees is counted.
  it('metricsSearch trips after threshold local-deadline (5s abort) failures', async () => {
    const { fetchDocumentsAbortable } = await import('~/server/meilisearch/client');
    global.fetch = makeHangingFetch() as unknown as typeof global.fetch;

    for (let i = 0; i < 3; i++) {
      await expect(
        fetchDocumentsAbortable('images', {}, { host: 'http://meili-metrics.example', timeoutMs: 15 })
      ).rejects.toThrow();
    }

    expect(incsFor(TRIPS, 'metricsSearch')).toHaveLength(1);
  });

  it('metricsSearch trips after threshold upstream 503 load-shed responses', async () => {
    const { fetchDocumentsAbortable } = await import('~/server/meilisearch/client');
    global.fetch = makeStatusFetch(503) as unknown as typeof global.fetch;

    for (let i = 0; i < 3; i++) {
      await expect(
        fetchDocumentsAbortable('images', {}, { host: 'http://meili-metrics.example' })
      ).rejects.toThrow();
    }

    expect(incsFor(TRIPS, 'metricsSearch')).toHaveLength(1);
  });

  it('metricsSearch increments meili_call_timeouts_total on the local-deadline path', async () => {
    const { fetchDocumentsAbortable } = await import('~/server/meilisearch/client');
    global.fetch = makeHangingFetch() as unknown as typeof global.fetch;

    await expect(
      fetchDocumentsAbortable('images', {}, { host: 'http://meili-metrics.example', timeoutMs: 15 })
    ).rejects.toThrow();

    expect(incsFor(TIMEOUTS, 'metricsSearch')).toHaveLength(1);
  });
});
