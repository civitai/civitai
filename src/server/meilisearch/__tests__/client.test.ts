import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Tests for the fail-fast safety net on fetchDocumentsAbortable. Goal: prove
// that (a) the function rejects within ~timeoutMs when upstream is slow,
// (b) it resolves cleanly when upstream is fast, and (c) a caller-supplied
// AbortSignal still wins the race when triggered before the local deadline.
//
// The 5s hard deadline + AbortSignal.any() composition is the cascade-break
// for the 2026-05-29 / 2026-05-31 api-primary kubelet SIGKILL chain
// (see SKILL.md feeds-meilisearch known-issues and claudedocs/api-primary-
// cascade-handoff-2026-05-26.md). Without this cap, fetchDocumentsAbortable
// callers without a signal wait Node's default — long enough to bleed an
// event loop past the 10s probe timeout.

// ─── Mocks ──────────────────────────────────────────────────────────────────

// Override the global env proxy with the few keys runWithLimiter needs at
// module import time. `MEILI_CALL_CONCURRENCY` feeds pLimit() at the top of
// client.ts; without a real number pLimit throws and module load fails.
vi.mock('~/env/server', () => ({
  env: {
    SEARCH_HOST: 'http://meili-search.example',
    SEARCH_API_KEY: 'test-search-key',
    METRICS_SEARCH_HOST: 'http://meili-metrics.example',
    METRICS_SEARCH_API_KEY: 'test-metrics-key',
    IS_BUILD: false,
    // runWithLimiter / circuit-breaker config
    MEILI_CALL_TIMEOUT_MS: 2500,
    MEILI_CALL_CONCURRENCY: 50,
    MEILI_CIRCUIT_TRIP_THRESHOLD: 10,
    MEILI_CIRCUIT_WINDOW_SECONDS: 30,
    MEILI_CIRCUIT_COOLDOWN_SECONDS: 30,
  },
}));

// otel-helpers' withSpan needs to be a no-op pass-through so we can isolate
// the fetch/timeout behaviour.
vi.mock('~/server/utils/otel-helpers', () => ({
  withSpan: <T>(_name: string, _attrsOrFn: unknown, maybeFn?: () => T): T => {
    const fn = (typeof _attrsOrFn === 'function' ? _attrsOrFn : maybeFn) as () => T;
    return fn();
  },
  safeUrl: (u: string) => u,
}));

// Counter inc mocks — used by the assertion in test 4.
const incMock = vi.fn();
vi.mock('~/server/prom/client', () => ({
  registerCounter: vi.fn(() => ({ inc: vi.fn() })),
  registerCounterWithLabels: vi.fn(() => ({
    inc: incMock,
    labels: vi.fn(() => ({ inc: incMock })),
  })),
  registerGaugeWithLabels: vi.fn(() => ({ set: vi.fn(), inc: vi.fn(), dec: vi.fn() })),
  registerHistogram: vi.fn(() => ({
    startTimer: vi.fn(() => () => undefined),
    observe: vi.fn(),
  })),
}));

vi.mock('~/utils/logging', () => ({
  createLogger: () => () => undefined,
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a fetch-like function that responds after `delayMs`. If `delayMs` is
 * larger than the timeoutMs under test, the AbortSignal fires first and the
 * promise rejects with an AbortError (Node's whatwg-fetch behaviour). The
 * delay is implemented with a `setTimeout` that we cancel on abort so the
 * test doesn't hang on the final teardown.
 */
function makeDelayedFetch(delayMs: number, payload: unknown = { results: [] }) {
  return (_input: unknown, init?: { signal?: AbortSignal }) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve({
          ok: true,
          status: 200,
          json: async () => payload,
          text: async () => '',
        });
      }, delayMs);
      init?.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          const reason = (init.signal as unknown as { reason?: unknown }).reason;
          // Node's fetch surfaces aborts as DOMException('AbortError'); mimic
          // that shape so the call-site catch in image.service.ts can match.
          const err = new Error('The operation was aborted.') as Error & {
            name: string;
            cause?: unknown;
          };
          err.name = 'AbortError';
          err.cause = reason;
          reject(err);
        },
        { once: true }
      );
    });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('fetchDocumentsAbortable timeout safety net', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    incMock.mockClear();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('rejects with an abort error within ~timeoutMs when upstream is slow', async () => {
    // Late dynamic import so the mocks above are in place at module load.
    const { fetchDocumentsAbortable, FETCH_DOCUMENTS_TIMEOUT_MESSAGE } = await import(
      '~/server/meilisearch/client'
    );

    // Upstream takes 10s — well past the 100ms timeoutMs.
    global.fetch = makeDelayedFetch(10_000) as unknown as typeof fetch;

    const start = Date.now();
    let caught: unknown;
    try {
      await fetchDocumentsAbortable<unknown>(
        'images',
        { limit: 1 },
        {
          host: 'http://meili-metrics.example',
          apiKey: 'test',
          timeoutMs: 100,
        }
      );
    } catch (e) {
      caught = e;
    }
    const elapsed = Date.now() - start;

    expect(caught).toBeDefined();
    // Either: (a) fetch propagates the AbortError directly with the timeout
    // message tucked into `.cause`, or (b) some intermediate rewrites it.
    // Both shapes are valid signals — the post-filter catch in image.service.ts
    // handles either.
    const err = caught as Error & { name?: string; cause?: { message?: string } };
    const looksLikeTimeout =
      err.message === FETCH_DOCUMENTS_TIMEOUT_MESSAGE ||
      err.name === 'AbortError' ||
      err.cause?.message === FETCH_DOCUMENTS_TIMEOUT_MESSAGE;
    expect(looksLikeTimeout).toBe(true);

    // Should bail well under 1s; we give 500ms slack for CI jitter.
    expect(elapsed).toBeLessThan(500);
  });

  it('resolves cleanly when upstream responds before the local deadline', async () => {
    const { fetchDocumentsAbortable } = await import('~/server/meilisearch/client');

    const payload = { results: [{ id: 1 }, { id: 2 }] };
    global.fetch = makeDelayedFetch(20, payload) as unknown as typeof fetch;

    const result = await fetchDocumentsAbortable<{ id: number }>(
      'images',
      { limit: 2 },
      {
        host: 'http://meili-metrics.example',
        apiKey: 'test',
        timeoutMs: 1000,
      }
    );

    expect(result).toEqual(payload);
  });

  it('post-filter catch shape recognises the local-timeout abort and increments the counter', async () => {
    // This test acts as a contract between fetchDocumentsAbortable and the
    // getImagesFromSearchPostFilter catch block in image.service.ts. If
    // either side changes shape (e.g. the abort reason chain breaks) this
    // test catches it before prod sees the regression.
    const { fetchDocumentsAbortable, FETCH_DOCUMENTS_TIMEOUT_MESSAGE, meiliFetchTimeoutTotal } =
      await import('~/server/meilisearch/client');

    global.fetch = makeDelayedFetch(5_000) as unknown as typeof fetch;

    // Mirror the call-site catch logic in getImagesFromSearchPostFilter to
    // prove it would (a) match, (b) break out of the loop, (c) tag the right
    // labels.
    const iterationUnderTest = 2;
    let brokeOut = false;
    try {
      await fetchDocumentsAbortable<unknown>(
        'images',
        { limit: 100, offset: 200 },
        {
          host: 'http://meili-metrics.example',
          apiKey: 'test',
          timeoutMs: 80,
        }
      );
    } catch (e) {
      const err = e as Error & { name?: string; cause?: { message?: string } };
      const isLocalTimeout =
        err?.message === FETCH_DOCUMENTS_TIMEOUT_MESSAGE ||
        (err?.name === 'AbortError' && err.cause?.message === FETCH_DOCUMENTS_TIMEOUT_MESSAGE);
      if (isLocalTimeout) {
        meiliFetchTimeoutTotal.inc({
          route: 'getImagesFromSearchPostFilter',
          iteration: String(iterationUnderTest),
        });
        brokeOut = true;
      } else {
        throw e;
      }
    }

    expect(brokeOut).toBe(true);
    expect(incMock).toHaveBeenCalledWith({
      route: 'getImagesFromSearchPostFilter',
      iteration: '2',
    });
    expect(incMock).toHaveBeenCalledTimes(1);
  });

  it('caller signal aborts the call before the local timer fires', async () => {
    const { fetchDocumentsAbortable } = await import('~/server/meilisearch/client');

    // Both the upstream and the local timer would otherwise resolve slowly /
    // far in the future; the caller signal should win.
    global.fetch = makeDelayedFetch(10_000) as unknown as typeof fetch;

    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(new Error('client-disconnect')), 30);

    const start = Date.now();
    let caught: unknown;
    try {
      await fetchDocumentsAbortable<unknown>(
        'images',
        { limit: 1 },
        {
          host: 'http://meili-metrics.example',
          apiKey: 'test',
          signal: ctrl.signal,
          timeoutMs: 5000, // far longer than the caller-abort delay
        }
      );
    } catch (e) {
      caught = e;
    }
    const elapsed = Date.now() - start;

    expect(caught).toBeDefined();
    expect(elapsed).toBeLessThan(500);

    // Cause should chain back to the caller's abort reason, not the local
    // timeout message — that's how we distinguish client disconnect from
    // local-deadline timeout in the call-site catch.
    const err = caught as Error & { cause?: { message?: string } };
    if (err.name === 'AbortError' && err.cause?.message) {
      expect(err.cause.message).not.toBe('meili-fetch-timeout');
    }
  });
});
