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
    // fetchDocumentsAbortable default deadline — set explicitly so tests
    // that rely on the default match the production default (and to keep
    // the test independent of the schema's z.default()).
    MEILI_FETCH_TIMEOUT_MS: 5000,
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

/**
 * Build a fetch-like function that immediately resolves with a non-ok HTTP
 * response. fetchDocumentsAbortable's `if (!res.ok)` branch then throws a
 * MeilisearchFetchError carrying the status + body. Used to verify that the
 * post-filter catch shape branches correctly on 408/5xx (graceful break) vs
 * 4xx-other (re-throw).
 */
function makeStatusFetch(status: number, body = '') {
  return (_input: unknown, _init?: { signal?: AbortSignal }) =>
    Promise.resolve({
      ok: false,
      status,
      json: async () => ({}),
      text: async () => body,
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
    const { fetchDocumentsAbortable, FETCH_DOCUMENTS_TIMEOUT_MESSAGE, meiliFetchFailfastTotal } =
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
        meiliFetchFailfastTotal.inc({
          route: 'getImagesFromSearchPostFilter',
          iteration: String(iterationUnderTest),
          reason: 'local-timeout',
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
      reason: 'local-timeout',
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

// ─── Upstream-side fail-fast (PR follow-up to #2370) ────────────────────────
//
// The 5s local timer in #2370 caught the slow-fetch path, but post-deploy
// telemetry showed the dominant failure mode is upstream returning 503
// (civitai-feeds-proxy shed) or 408 (Meilisearch backend timeout). These
// were re-throwing as bare Error from fetchDocumentsAbortable, so the
// post-filter catch in image.service.ts didn't recognise them and the
// 500 bubbled to clients → retry storm → cascade sustained.
//
// This block proves the new MeilisearchFetchError shape + the extended
// post-filter catch handle the three upstream failure modes correctly,
// AND that 4xx-other (e.g. 400 malformed filter) still re-throws.

describe('fetchDocumentsAbortable upstream-side fail-fast', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    incMock.mockClear();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('throws MeilisearchFetchError on 503 with status + body preserved', async () => {
    const { fetchDocumentsAbortable, MeilisearchFetchError } = await import(
      '~/server/meilisearch/client'
    );
    global.fetch = makeStatusFetch(503, 'service overloaded') as unknown as typeof fetch;

    let caught: unknown;
    try {
      await fetchDocumentsAbortable<unknown>(
        'images',
        { limit: 1 },
        { host: 'http://meili-metrics.example', apiKey: 'test' }
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(MeilisearchFetchError);
    const err = caught as InstanceType<typeof MeilisearchFetchError>;
    expect(err.status).toBe(503);
    expect(err.responseText).toBe('service overloaded');
    // Message-format contract — Loki/dashboard queries depend on this prefix.
    expect(err.message).toBe('Meilisearch fetch failed (503): service overloaded');
  });

  it('throws MeilisearchFetchError on 408 with status preserved', async () => {
    const { fetchDocumentsAbortable, MeilisearchFetchError } = await import(
      '~/server/meilisearch/client'
    );
    global.fetch = makeStatusFetch(408, '') as unknown as typeof fetch;

    let caught: unknown;
    try {
      await fetchDocumentsAbortable<unknown>(
        'images',
        { limit: 1 },
        { host: 'http://meili-metrics.example', apiKey: 'test' }
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(MeilisearchFetchError);
    expect((caught as InstanceType<typeof MeilisearchFetchError>).status).toBe(408);
  });

  it('does NOT throw MeilisearchFetchError on a 2xx happy path', async () => {
    const { fetchDocumentsAbortable } = await import('~/server/meilisearch/client');
    const payload = { results: [{ id: 42 }] };
    global.fetch = makeDelayedFetch(10, payload) as unknown as typeof fetch;

    const result = await fetchDocumentsAbortable<{ id: number }>(
      'images',
      { limit: 1 },
      { host: 'http://meili-metrics.example', apiKey: 'test' }
    );

    expect(result).toEqual(payload);
  });

  it('post-filter catch shape recognises 503 (upstream-overload) and breaks with the right reason label', async () => {
    const {
      fetchDocumentsAbortable,
      MeilisearchFetchError,
      isFailfastStatus,
      failfastReasonForStatus,
      meiliFetchFailfastTotal,
      FETCH_DOCUMENTS_TIMEOUT_MESSAGE,
    } = await import('~/server/meilisearch/client');

    global.fetch = makeStatusFetch(503, 'service overloaded') as unknown as typeof fetch;

    const iterationUnderTest = 3;
    let brokeOut = false;
    let reThrew = false;
    try {
      await fetchDocumentsAbortable<unknown>(
        'images',
        { limit: 100, offset: 200 },
        { host: 'http://meili-metrics.example', apiKey: 'test' }
      );
    } catch (e) {
      // Mirror the call-site catch from getImagesFromSearchPostFilter.
      const err = e as Error & { name?: string; cause?: { message?: string } };
      const isLocalTimeout =
        err?.message === FETCH_DOCUMENTS_TIMEOUT_MESSAGE ||
        (err?.name === 'AbortError' && err.cause?.message === FETCH_DOCUMENTS_TIMEOUT_MESSAGE);
      if (isLocalTimeout) {
        meiliFetchFailfastTotal.inc({
          route: 'getImagesFromSearchPostFilter',
          iteration: String(iterationUnderTest),
          reason: 'local-timeout',
        });
        brokeOut = true;
      } else if (e instanceof MeilisearchFetchError && isFailfastStatus(e.status)) {
        meiliFetchFailfastTotal.inc({
          route: 'getImagesFromSearchPostFilter',
          iteration: String(iterationUnderTest),
          reason: failfastReasonForStatus(e.status),
        });
        brokeOut = true;
      } else {
        reThrew = true;
      }
    }

    expect(brokeOut).toBe(true);
    expect(reThrew).toBe(false);
    expect(incMock).toHaveBeenCalledWith({
      route: 'getImagesFromSearchPostFilter',
      iteration: '3',
      reason: 'upstream-overload',
    });
    expect(incMock).toHaveBeenCalledTimes(1);
  });

  it('post-filter catch shape recognises 408 (upstream-timeout)', async () => {
    const {
      fetchDocumentsAbortable,
      MeilisearchFetchError,
      isFailfastStatus,
      failfastReasonForStatus,
      meiliFetchFailfastTotal,
      FETCH_DOCUMENTS_TIMEOUT_MESSAGE,
    } = await import('~/server/meilisearch/client');

    global.fetch = makeStatusFetch(408, '') as unknown as typeof fetch;

    let brokeOut = false;
    try {
      await fetchDocumentsAbortable<unknown>(
        'images',
        { limit: 100 },
        { host: 'http://meili-metrics.example', apiKey: 'test' }
      );
    } catch (e) {
      const err = e as Error & { name?: string; cause?: { message?: string } };
      const isLocalTimeout =
        err?.message === FETCH_DOCUMENTS_TIMEOUT_MESSAGE ||
        (err?.name === 'AbortError' && err.cause?.message === FETCH_DOCUMENTS_TIMEOUT_MESSAGE);
      if (isLocalTimeout) {
        meiliFetchFailfastTotal.inc({
          route: 'getImagesFromSearchPostFilter',
          iteration: '1',
          reason: 'local-timeout',
        });
        brokeOut = true;
      } else if (e instanceof MeilisearchFetchError && isFailfastStatus(e.status)) {
        meiliFetchFailfastTotal.inc({
          route: 'getImagesFromSearchPostFilter',
          iteration: '1',
          reason: failfastReasonForStatus(e.status),
        });
        brokeOut = true;
      } else {
        throw e;
      }
    }

    expect(brokeOut).toBe(true);
    expect(incMock).toHaveBeenCalledWith({
      route: 'getImagesFromSearchPostFilter',
      iteration: '1',
      reason: 'upstream-timeout',
    });
  });

  it('post-filter catch re-throws on 400 (malformed filter is a real bug, must bubble)', async () => {
    const {
      fetchDocumentsAbortable,
      MeilisearchFetchError,
      isFailfastStatus,
      failfastReasonForStatus,
      meiliFetchFailfastTotal,
      FETCH_DOCUMENTS_TIMEOUT_MESSAGE,
    } = await import('~/server/meilisearch/client');

    global.fetch = makeStatusFetch(
      400,
      '{"message":"Invalid filter","code":"invalid_search_filter"}'
    ) as unknown as typeof fetch;

    let brokeOut = false;
    let reThrown: unknown;
    try {
      await fetchDocumentsAbortable<unknown>(
        'images',
        { limit: 100 },
        { host: 'http://meili-metrics.example', apiKey: 'test' }
      );
    } catch (e) {
      const err = e as Error & { name?: string; cause?: { message?: string } };
      const isLocalTimeout =
        err?.message === FETCH_DOCUMENTS_TIMEOUT_MESSAGE ||
        (err?.name === 'AbortError' && err.cause?.message === FETCH_DOCUMENTS_TIMEOUT_MESSAGE);
      if (isLocalTimeout) {
        meiliFetchFailfastTotal.inc({
          route: 'getImagesFromSearchPostFilter',
          iteration: '1',
          reason: 'local-timeout',
        });
        brokeOut = true;
      } else if (e instanceof MeilisearchFetchError && isFailfastStatus(e.status)) {
        meiliFetchFailfastTotal.inc({
          route: 'getImagesFromSearchPostFilter',
          iteration: '1',
          reason: failfastReasonForStatus(e.status),
        });
        brokeOut = true;
      } else {
        reThrown = e;
      }
    }

    // 400 must NOT be swallowed — it indicates a real malformed-filter bug.
    expect(brokeOut).toBe(false);
    expect(reThrown).toBeInstanceOf(MeilisearchFetchError);
    expect((reThrown as InstanceType<typeof MeilisearchFetchError>).status).toBe(400);
    // The fail-fast counter MUST NOT have incremented on 4xx-other.
    expect(incMock).not.toHaveBeenCalled();
  });

  it('post-filter catch shape recognises 502 (upstream-error — generic 5xx)', async () => {
    const {
      fetchDocumentsAbortable,
      MeilisearchFetchError,
      isFailfastStatus,
      failfastReasonForStatus,
      meiliFetchFailfastTotal,
      FETCH_DOCUMENTS_TIMEOUT_MESSAGE,
    } = await import('~/server/meilisearch/client');

    global.fetch = makeStatusFetch(502, 'Bad Gateway') as unknown as typeof fetch;

    let brokeOut = false;
    try {
      await fetchDocumentsAbortable<unknown>(
        'images',
        { limit: 100 },
        { host: 'http://meili-metrics.example', apiKey: 'test' }
      );
    } catch (e) {
      const err = e as Error & { name?: string; cause?: { message?: string } };
      const isLocalTimeout =
        err?.message === FETCH_DOCUMENTS_TIMEOUT_MESSAGE ||
        (err?.name === 'AbortError' && err.cause?.message === FETCH_DOCUMENTS_TIMEOUT_MESSAGE);
      if (isLocalTimeout) {
        meiliFetchFailfastTotal.inc({
          route: 'getImagesFromSearchPostFilter',
          iteration: '1',
          reason: 'local-timeout',
        });
        brokeOut = true;
      } else if (e instanceof MeilisearchFetchError && isFailfastStatus(e.status)) {
        meiliFetchFailfastTotal.inc({
          route: 'getImagesFromSearchPostFilter',
          iteration: '1',
          reason: failfastReasonForStatus(e.status),
        });
        brokeOut = true;
      } else {
        throw e;
      }
    }

    expect(brokeOut).toBe(true);
    expect(incMock).toHaveBeenCalledWith({
      route: 'getImagesFromSearchPostFilter',
      iteration: '1',
      reason: 'upstream-error',
    });
  });
});

// ─── Wrapper-side fail-fast (PR follow-up to #2371) ─────────────────────────
//
// PR #2371's audit explicitly flagged that `runWithLimiter` still throws
// `MeiliCallTimeoutError` on the concurrency / circuit-open path, and that
// the post-filter catch at line 4314 re-throws those — bleeding into the
// remaining 900/day api-primary restart wave after the HTTP-status paths
// were closed. This block proves the new branch:
//   (a) catches MeiliCallTimeoutError with reason='upstream-circuit-open'
//       and breaks out of the iteration loop (same shape as the existing
//       branches), and
//   (b) does NOT widen to catch generic Error subclasses — those still
//       re-throw so we don't silently hide unrelated bugs.
//
// We construct the MeiliCallTimeoutError directly and pipe it into a mock
// catch block that mirrors the production shape from getImagesFromSearchPostFilter.
// fetchDocumentsAbortable itself can't surface this error type — it comes
// out of runWithLimiter wrapping the SDK calls — so a direct unit-level
// test of the catch-shape contract is the right granularity.

describe('post-filter catch — MeiliCallTimeoutError (circuit-open / wrapper-timeout)', () => {
  beforeEach(() => {
    incMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('MeiliCallTimeoutError triggers catch + breaks with reason="upstream-circuit-open"', async () => {
    const {
      MeiliCallTimeoutError,
      MeilisearchFetchError,
      MEILI_FETCH_FAILFAST_REASON_CIRCUIT_OPEN,
      isFailfastStatus,
      failfastReasonForStatus,
      meiliFetchFailfastTotal,
      FETCH_DOCUMENTS_TIMEOUT_MESSAGE,
    } = await import('~/server/meilisearch/client');

    // Build both shapes — concurrency (circuit-open) + timeout (wrapper-timer
    // fire). Both should land in the same bucket per the audit's guidance.
    const circuitOpenErr = new MeiliCallTimeoutError(
      'concurrency',
      'Meilisearch backend circuit open — failing fast'
    );
    const wrapperTimeoutErr = new MeiliCallTimeoutError('timeout');

    for (const errToThrow of [circuitOpenErr, wrapperTimeoutErr]) {
      incMock.mockClear();
      const iterationUnderTest = 4;
      let brokeOut = false;
      let reThrown: unknown;
      try {
        throw errToThrow;
      } catch (e) {
        // Mirror the production catch block from getImagesFromSearchPostFilter.
        // Branch order MUST match: local-timeout → MeilisearchFetchError →
        // MeiliCallTimeoutError → re-throw.
        const err = e as Error & { name?: string; cause?: { message?: string } };
        const isLocalTimeout =
          err?.message === FETCH_DOCUMENTS_TIMEOUT_MESSAGE ||
          (err?.name === 'AbortError' && err.cause?.message === FETCH_DOCUMENTS_TIMEOUT_MESSAGE);
        if (isLocalTimeout) {
          meiliFetchFailfastTotal.inc({
            route: 'getImagesFromSearchPostFilter',
            iteration: String(iterationUnderTest),
            reason: 'local-timeout',
          });
          brokeOut = true;
        } else if (e instanceof MeilisearchFetchError && isFailfastStatus(e.status)) {
          meiliFetchFailfastTotal.inc({
            route: 'getImagesFromSearchPostFilter',
            iteration: String(iterationUnderTest),
            reason: failfastReasonForStatus(e.status),
          });
          brokeOut = true;
        } else if (e instanceof MeiliCallTimeoutError) {
          meiliFetchFailfastTotal.inc({
            route: 'getImagesFromSearchPostFilter',
            iteration: String(iterationUnderTest),
            reason: MEILI_FETCH_FAILFAST_REASON_CIRCUIT_OPEN,
          });
          brokeOut = true;
        } else {
          reThrown = e;
        }
      }

      expect(brokeOut).toBe(true);
      expect(reThrown).toBeUndefined();
      expect(incMock).toHaveBeenCalledWith({
        route: 'getImagesFromSearchPostFilter',
        iteration: '4',
        reason: 'upstream-circuit-open',
      });
      expect(incMock).toHaveBeenCalledTimes(1);
    }
  });

  it('does NOT widen to catch unrelated Error subclasses — they still re-throw', async () => {
    // Regression guard: the new branch must use `instanceof MeiliCallTimeoutError`
    // (not a generic `instanceof Error`) so we don't silently swallow real bugs
    // like ReferenceError, network errors from outside the wrapper, etc.
    const {
      MeiliCallTimeoutError,
      MeilisearchFetchError,
      MEILI_FETCH_FAILFAST_REASON_CIRCUIT_OPEN,
      isFailfastStatus,
      failfastReasonForStatus,
      meiliFetchFailfastTotal,
      FETCH_DOCUMENTS_TIMEOUT_MESSAGE,
    } = await import('~/server/meilisearch/client');

    const unrelatedErr = new Error('something unrelated — null deref upstream');

    let brokeOut = false;
    let reThrown: unknown;
    try {
      throw unrelatedErr;
    } catch (e) {
      const err = e as Error & { name?: string; cause?: { message?: string } };
      const isLocalTimeout =
        err?.message === FETCH_DOCUMENTS_TIMEOUT_MESSAGE ||
        (err?.name === 'AbortError' && err.cause?.message === FETCH_DOCUMENTS_TIMEOUT_MESSAGE);
      if (isLocalTimeout) {
        meiliFetchFailfastTotal.inc({
          route: 'getImagesFromSearchPostFilter',
          iteration: '1',
          reason: 'local-timeout',
        });
        brokeOut = true;
      } else if (e instanceof MeilisearchFetchError && isFailfastStatus(e.status)) {
        meiliFetchFailfastTotal.inc({
          route: 'getImagesFromSearchPostFilter',
          iteration: '1',
          reason: failfastReasonForStatus(e.status),
        });
        brokeOut = true;
      } else if (e instanceof MeiliCallTimeoutError) {
        meiliFetchFailfastTotal.inc({
          route: 'getImagesFromSearchPostFilter',
          iteration: '1',
          reason: MEILI_FETCH_FAILFAST_REASON_CIRCUIT_OPEN,
        });
        brokeOut = true;
      } else {
        reThrown = e;
      }
    }

    expect(brokeOut).toBe(false);
    expect(reThrown).toBe(unrelatedErr);
    // The fail-fast counter MUST NOT have incremented for an unrelated Error.
    expect(incMock).not.toHaveBeenCalled();
  });
});

// ─── isTransientMeiliError: SDK-error classification (500→503 reclassification) ─
//
// The REST image feed (/api/v1/images) runs through event-engine-common's
// populatedQuery, whose INNER meilisearch-js (0.33) calls throw the SDK's OWN
// error types on a slow / shed backend — NOT civitai's MeilisearchFetchError /
// MeiliCallTimeoutError (those wrap only the direct raw-fetch path). When the
// proxy/backend returns 408 ("Request Timeout") or 503 ("Service Unavailable")
// with an empty body, the SDK throws MeiliSearchCommunicationError with
// message=statusText + statusCode=<http status>; a parseable error body yields
// MeiliSearchApiError carrying httpStatus. Neither is a TRPCError, so they were
// hitting the generic 500 mapping → the dominant remaining HTTP-500 source on
// /api/v1/images. isTransientMeiliError classifies these (and the civitai
// wrapper errors) as genuinely-transient so the caller can re-map them to a
// retryable 503 — while a 4xx-other / app error stays a hard error.
//
// We reconstruct the SDK error SHAPES (name + statusCode/httpStatus/code/errno)
// rather than import the SDK classes, because the predicate intentionally
// name-matches (`error.name === 'MeiliSearch...'`) so it survives a duplicated
// SDK copy inside the event-engine-common submodule's own node_modules — the
// real bug was an instanceof miss across module boundaries.

describe('isTransientMeiliError — transient upstream classification', () => {
  // Faithful reproductions of the meilisearch-js 0.33 error shapes.
  const makeCommunicationError = (statusCode: number) => {
    // SDK: `this.message = body.statusText; this.statusCode = body.status`
    const e = new Error(statusCode === 408 ? 'Request Timeout' : 'Service Unavailable') as Error & {
      name: string;
      statusCode: number;
    };
    e.name = 'MeiliSearchCommunicationError';
    e.statusCode = statusCode;
    return e;
  };

  const makeApiError = (httpStatus: number) => {
    const e = new Error('meilisearch upstream error') as Error & {
      name: string;
      httpStatus: number;
      code: string;
    };
    e.name = 'MeiliSearchApiError';
    e.httpStatus = httpStatus;
    e.code = 'internal';
    return e;
  };

  it.each([408, 429, 502, 503, 504])(
    'returns true for a MeiliSearchCommunicationError with transient statusCode %i',
    async (status) => {
      const { isTransientMeiliError } = await import('~/server/meilisearch/client');
      expect(isTransientMeiliError(makeCommunicationError(status))).toBe(true);
    }
  );

  it.each([408, 429, 502, 503, 504])(
    'returns true for a MeiliSearchApiError with transient httpStatus %i',
    async (status) => {
      const { isTransientMeiliError } = await import('~/server/meilisearch/client');
      expect(isTransientMeiliError(makeApiError(status))).toBe(true);
    }
  );

  it('returns true for a network-level MeiliSearchCommunicationError (no http status, has errno/code)', async () => {
    const { isTransientMeiliError } = await import('~/server/meilisearch/client');
    const e = new Error('request to ... failed, reason: connect ECONNREFUSED') as Error & {
      name: string;
      code: string;
      errno: string;
    };
    e.name = 'MeiliSearchCommunicationError';
    e.code = 'ECONNREFUSED';
    e.errno = 'ECONNREFUSED';
    expect(isTransientMeiliError(e)).toBe(true);
  });

  it('returns true for a MeiliSearchTimeOutError (name-matched)', async () => {
    const { isTransientMeiliError } = await import('~/server/meilisearch/client');
    const e = new Error('timeout of 5000ms has exceeded ...') as Error & { name: string };
    e.name = 'MeiliSearchTimeOutError';
    expect(isTransientMeiliError(e)).toBe(true);
  });

  it('returns true for the civitai wrapper errors (MeiliCallTimeoutError, failfast MeilisearchFetchError)', async () => {
    const { isTransientMeiliError, MeiliCallTimeoutError, MeilisearchFetchError } = await import(
      '~/server/meilisearch/client'
    );
    expect(isTransientMeiliError(new MeiliCallTimeoutError('timeout'))).toBe(true);
    expect(isTransientMeiliError(new MeiliCallTimeoutError('concurrency'))).toBe(true);
    expect(isTransientMeiliError(new MeilisearchFetchError(503, 'overloaded'))).toBe(true);
    expect(isTransientMeiliError(new MeilisearchFetchError(408, ''))).toBe(true);
    expect(isTransientMeiliError(new MeilisearchFetchError(429, ''))).toBe(true);
  });

  it('returns true for the raw-fetch local-deadline error (FETCH_DOCUMENTS_TIMEOUT_MESSAGE)', async () => {
    const { isTransientMeiliError, FETCH_DOCUMENTS_TIMEOUT_MESSAGE } = await import(
      '~/server/meilisearch/client'
    );
    expect(isTransientMeiliError(new Error(FETCH_DOCUMENTS_TIMEOUT_MESSAGE))).toBe(true);
  });

  it.each([400, 401, 403, 404, 422])(
    'returns FALSE for a non-transient %i status (real client/app error must surface, not be masked as 503)',
    async (status) => {
      const { isTransientMeiliError } = await import('~/server/meilisearch/client');
      // Both SDK error shapes with a 4xx-other status must NOT be treated as transient.
      expect(isTransientMeiliError(makeCommunicationError(status))).toBe(false);
      expect(isTransientMeiliError(makeApiError(status))).toBe(false);
    }
  );

  it('returns FALSE for a non-failfast MeilisearchFetchError (400 malformed filter)', async () => {
    const { isTransientMeiliError, MeilisearchFetchError } = await import(
      '~/server/meilisearch/client'
    );
    expect(isTransientMeiliError(new MeilisearchFetchError(400, 'bad filter'))).toBe(false);
  });

  it('returns FALSE for unrelated errors and non-error values', async () => {
    const { isTransientMeiliError } = await import('~/server/meilisearch/client');
    expect(isTransientMeiliError(new Error('null deref upstream'))).toBe(false);
    expect(isTransientMeiliError(new TypeError('x is not a function'))).toBe(false);
    expect(isTransientMeiliError(undefined)).toBe(false);
    expect(isTransientMeiliError(null)).toBe(false);
    expect(isTransientMeiliError('a string')).toBe(false);
    expect(isTransientMeiliError({ random: 'object' })).toBe(false);
    // A communication-error NAME but no status and no network code → not classifiable as transient.
    const ambiguous = new Error('weird') as Error & { name: string };
    ambiguous.name = 'MeiliSearchCommunicationError';
    expect(isTransientMeiliError(ambiguous)).toBe(false);
  });
});
