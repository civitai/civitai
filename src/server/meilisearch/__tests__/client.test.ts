import { describe, it, expect, vi, afterEach } from 'vitest';
import { MeiliSearch } from 'meilisearch';

// Tests for the Meilisearch error classifier (isTransientMeiliError) and
// searchWithSignal. The raw-fetch helper these once shared a file with went with
// the retired feeds Meilisearch.

// ─── Mocks ──────────────────────────────────────────────────────────────────

// Override the global env proxy with the few keys runWithLimiter needs at
// module import time. `MEILI_CALL_CONCURRENCY` feeds pLimit() at the top of
// client.ts; without a real number pLimit throws and module load fails.
vi.mock('~/env/server', () => ({
  env: {
    SEARCH_HOST: 'http://meili-search.example',
    SEARCH_API_KEY: 'test-search-key',
    IS_BUILD: false,
    // runWithLimiter / circuit-breaker config
    MEILI_CALL_TIMEOUT_MS: 2500,
    MEILI_CALL_CONCURRENCY: 50,
    MEILI_RESOURCE_SELECT_CONCURRENCY: 500,
    MEILI_RESOURCE_SELECT_TIMEOUT_MS: 100,
    MEILI_CIRCUIT_TRIP_THRESHOLD: 10,
    MEILI_CIRCUIT_WINDOW_SECONDS: 30,
    MEILI_CIRCUIT_COOLDOWN_SECONDS: 30,
  },
}));

vi.mock('~/server/prom/client', () => ({
  registerCounter: vi.fn(() => ({ inc: vi.fn() })),
  registerCounterWithLabels: vi.fn(() => ({
    inc: vi.fn(),
    labels: vi.fn(() => ({ inc: vi.fn() })),
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

  it.each([502, 503, 504])(
    'returns true for a MeiliSearchApiError with transient gateway httpStatus %i',
    async (status) => {
      const { isTransientMeiliError } = await import('~/server/meilisearch/client');
      expect(isTransientMeiliError(makeApiError(status))).toBe(true);
    }
  );

  // ── Masking-guard (audit 🟡 #1): a STRUCTURED-JSON Meili 500 is deterministic ──
  // A MeiliSearchApiError carries a parseable JSON body — for a 5xx that is far
  // more likely a deterministic Meili-internal error than a transient brownout.
  // So a JSON-body 500 must NOT be classified transient (it must surface as a
  // hard 500), while the empty/non-JSON-body transport-layer 500
  // (MeiliSearchCommunicationError) IS transient. This pins exactly that split.
  it('returns FALSE for a MeiliSearchApiError with httpStatus=500 (JSON body → deterministic, must bubble as 500 not 503)', async () => {
    const { isTransientMeiliError } = await import('~/server/meilisearch/client');
    expect(isTransientMeiliError(makeApiError(500))).toBe(false);
  });

  it.each(['Internal Server Error', 'Request Timeout', 'Service Unavailable'])(
    'returns TRUE for a MeiliSearchCommunicationError with statusCode=500 (empty/transport body "%s" → transient 503)',
    async (statusText) => {
      const { isTransientMeiliError } = await import('~/server/meilisearch/client');
      // Transport-layer 500 (empty / non-JSON body) — the SDK couldn't parse a
      // structured error, so this is the genuinely-transient case → 503.
      const e = new Error(statusText) as Error & { name: string; statusCode: number };
      e.name = 'MeiliSearchCommunicationError';
      e.statusCode = 500;
      expect(isTransientMeiliError(e)).toBe(true);
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

  // ── statusText-message fallback: the STRIPPED PROD SHAPE #2759 missed ──────
  //
  // Captured live on dp-prod AFTER #2759 deployed: GET /api/v1/images returned a
  // hard 500 with body {"error":"Service Unavailable"} / {"error":"Request
  // Timeout"} and NO `code` field. The error reaching the service catch is a
  // PLAIN Error — NO Meili `name`, NO `statusCode`/`httpStatus`/`code`/`errno` —
  // carrying ONLY `message = <HTTP statusText>` (the structured SDK shape is lost
  // crossing the event-engine-common submodule boundary; only `statusText`
  // survives). #2759's tests passed because they built the RAW SDK error (name +
  // statusCode), which prod never sees. These tests pin the PROD shape directly.
  it.each([
    'Request Timeout', // 408
    'Too Many Requests', // 429
    'Bad Gateway', // 502
    'Service Unavailable', // 503
    'Gateway Timeout', // 504
  ])(
    'returns TRUE for a PLAIN Error whose message is ONLY the transient statusText "%s" (no name, no statusCode — the prod shape)',
    async (statusText) => {
      const { isTransientMeiliError } = await import('~/server/meilisearch/client');
      // Deliberately a bare Error: no .name, no .statusCode, no .code/.errno —
      // exactly what arrives at the catch in prod.
      const e = new Error(statusText);
      expect((e as { name?: string }).name).toBe('Error'); // sanity: NOT a Meili name
      expect((e as { statusCode?: number }).statusCode).toBeUndefined();
      expect(isTransientMeiliError(e)).toBe(true);
    }
  );

  it.each([
    'Internal Server Error', // 500 — ambiguous (could be a deterministic app/Meili bug)
    'Not Found', // 404 — real client error
    'Bad Request', // 400
    'Unauthorized', // 401
    'some app bug', // arbitrary application error message
    'null deref upstream',
  ])(
    'returns FALSE for a plain Error with a non-transient / arbitrary message "%s" (no masking of real bugs)',
    async (message) => {
      const { isTransientMeiliError } = await import('~/server/meilisearch/client');
      expect(isTransientMeiliError(new Error(message))).toBe(false);
    }
  );

  it.each([
    'DB error: Service Unavailable downstream',
    'Bad Gateway error: connection reset by peer',
    'upstream said Request Timeout after 30s',
    'Service Unavailable', // exact — sanity that the substring cases below are the only diff
  ])('matches EXACT statusText only, never a substring — "%s"', async (message) => {
    const { isTransientMeiliError } = await import('~/server/meilisearch/client');
    const exact = message === 'Service Unavailable';
    // Only the bare exact reason phrase is transient; a message that merely
    // CONTAINS it (with surrounding text) must NOT be masked as a 503.
    expect(isTransientMeiliError(new Error(message))).toBe(exact);
  });

  it('does not match a case-mismatched statusText (exact, case-sensitive)', async () => {
    const { isTransientMeiliError } = await import('~/server/meilisearch/client');
    expect(isTransientMeiliError(new Error('service unavailable'))).toBe(false);
    expect(isTransientMeiliError(new Error('SERVICE UNAVAILABLE'))).toBe(false);
    expect(isTransientMeiliError(new Error('Service Unavailable '))).toBe(false); // trailing space
  });

  // ── THE REAL PROD SHAPE (audit-confirmed) — name PRESERVED, statusCode DROPPED ──
  //
  // This is the test that would have caught #2759 AND #2765. The audit traced the
  // ACTUAL bundled meilisearch-js (0.33/0.34, both confirmed): the error reaching
  // the service catch is a `MeiliSearchCommunicationError` with
  //   name = 'MeiliSearchCommunicationError'  (INTACT — NOT stripped)
  //   statusCode = undefined                  (DROPPED)
  //   message = 'Service Unavailable' / etc.  (the surviving statustext)
  //
  // Mechanism: `httpResponseErrorHandler` throws
  // `MeiliSearchCommunicationError(statusText, Response, url)` (sets message +
  // statusCode); then `request()`'s catch re-wraps via `httpErrorHandler` →
  // `new MeiliSearchCommunicationError(firstErr.message, firstErr, url, stack)`.
  // The 2nd arg is now an Error (not a Response), so the constructor's
  // `if (body instanceof Response)` block that sets `statusCode` does NOT run →
  // statusCode dropped — but the constructor still sets `this.name`.
  //
  // The OLD code's CommunicationError branch saw `statusCode === undefined` + no
  // errno/code and `return`ed false BEFORE the terminal message lookup ran — so
  // #2759/#2765's statustext fallback was DEAD CODE for the real shape and the
  // handler still emitted a hard 500 `{"error":"Service Unavailable"}`. The fix
  // makes the message lookup reachable in this branch. These tests construct the
  // proven shape directly (name set, statusCode undefined) and would FAIL against
  // the pre-fix code (which returned false here).
  describe('real prod shape — MeiliSearchCommunicationError, name preserved, statusCode dropped', () => {
    // Replicate the SDK double-wrap end-product faithfully: name set,
    // statusCode left undefined (never assigned by the 2nd constructor call),
    // message = the surviving statustext. No errno/code (this is a
    // server-responded transport error re-wrap, not a network ECONNREFUSED).
    const makeRewrappedCommunicationError = (statusText: string) => {
      const e = new Error(statusText) as Error & { name: string; statusCode?: number };
      e.name = 'MeiliSearchCommunicationError';
      // statusCode intentionally NOT set — this is the dropped-status reality.
      return e;
    };

    it.each([
      'Request Timeout', // 408
      'Too Many Requests', // 429
      'Bad Gateway', // 502
      'Service Unavailable', // 503 — the dominant captured prod body
      'Gateway Timeout', // 504
    ])(
      'returns TRUE for the re-wrapped CommunicationError "%s" (name kept, statusCode undefined)',
      async (statusText) => {
        const { isTransientMeiliError } = await import('~/server/meilisearch/client');
        const e = makeRewrappedCommunicationError(statusText);
        // Pin the proven shape so a regression in the test's own construction is loud.
        expect(e.name).toBe('MeiliSearchCommunicationError');
        expect((e as { statusCode?: number }).statusCode).toBeUndefined();
        expect((e as { code?: string }).code).toBeUndefined();
        expect((e as { errno?: string }).errno).toBeUndefined();
        expect(isTransientMeiliError(e)).toBe(true);
      }
    );

    it('still returns FALSE for a re-wrapped CommunicationError whose message is NOT a transient statustext (no masking of a real bug)', async () => {
      const { isTransientMeiliError } = await import('~/server/meilisearch/client');
      // name preserved + statusCode undefined, but the message is an arbitrary
      // app/internal error — must NOT be masked as transient.
      expect(isTransientMeiliError(makeRewrappedCommunicationError('Internal Server Error'))).toBe(
        false
      );
      expect(isTransientMeiliError(makeRewrappedCommunicationError('some internal failure'))).toBe(
        false
      );
    });

    it('an ApiError with httpStatus undefined falls through to the message lookup (a real Meili JSON message does NOT false-match)', async () => {
      const { isTransientMeiliError } = await import('~/server/meilisearch/client');
      // ApiError whose httpStatus got dropped but carries a Meili JSON message —
      // it is NOT a bare statustext so it must stay non-transient.
      const e = new Error('Index `images` not found.') as Error & { name: string };
      e.name = 'MeiliSearchApiError';
      expect(isTransientMeiliError(e)).toBe(false);
      // ...but if such a path ever yielded a bare transient statustext, catch it.
      const e2 = new Error('Service Unavailable') as Error & { name: string };
      e2.name = 'MeiliSearchApiError';
      expect(isTransientMeiliError(e2)).toBe(true);
    });
  });

  it('exposes TRANSIENT_STATUSTEXT_TO_STATUS mapping the same statuses isFailfastStatus treats transient', async () => {
    const { TRANSIENT_STATUSTEXT_TO_STATUS, isFailfastStatus } = await import(
      '~/server/meilisearch/client'
    );
    // Every mapped status must itself be fast-fail eligible (no drift between
    // the statusText set and the numeric predicate).
    for (const status of Object.values(TRANSIENT_STATUSTEXT_TO_STATUS)) {
      expect(isFailfastStatus(status)).toBe(true);
    }
    expect(TRANSIENT_STATUSTEXT_TO_STATUS).toMatchObject({
      'Request Timeout': 408,
      'Too Many Requests': 429,
      'Bad Gateway': 502,
      'Service Unavailable': 503,
      'Gateway Timeout': 504,
    });
    // Notably ABSENT: a bare "Internal Server Error" (500) — not masked.
    expect('Internal Server Error' in TRANSIENT_STATUSTEXT_TO_STATUS).toBe(false);
  });
});

describe('withMeiliResourceSelect cancellation', () => {
  function abortableCall(signal: AbortSignal) {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<never>((_, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    );
  }

  it('aborts the signal handed to the call when the timeout fires', async () => {
    const { withMeiliResourceSelect, MeiliCallTimeoutError } = await import(
      '~/server/meilisearch/client'
    );
    let seen: AbortSignal | undefined;

    const call = withMeiliResourceSelect((signal) => {
      seen = signal;
      return new Promise<never>(() => undefined);
    });

    await expect(call).rejects.toBeInstanceOf(MeiliCallTimeoutError);
    expect(seen?.aborted).toBe(true);
  });

  it('aborts the signal handed to the call when the caller aborts', async () => {
    const { withMeiliResourceSelect } = await import('~/server/meilisearch/client');
    const caller = new AbortController();
    let seen: AbortSignal | undefined;

    const call = withMeiliResourceSelect(
      (signal) => {
        seen = signal;
        return abortableCall(signal);
      },
      { signal: caller.signal }
    );
    caller.abort();

    await expect(call).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen?.aborted).toBe(true);
  });
});

describe('searchWithSignal', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // A 200 whose body stalls after a partial chunk, then fails on abort or after
  // `failAfterMs` — the shape that makes meilisearch-js resolve `undefined`.
  function stallingBodyFetch(failAfterMs = 1000) {
    const seen: { signal?: AbortSignal } = {};
    const fetchFn = (_input: unknown, init?: { signal?: AbortSignal }) => {
      seen.signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"hits":['));
          const timer = setTimeout(
            () => controller.error(new Error('socket hang up')),
            failAfterMs
          );
          init?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              controller.error(init.signal?.reason);
            },
            { once: true }
          );
        },
      });
      return Promise.resolve(
        new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
      );
    };
    return { fetchFn: fetchFn as unknown as typeof fetch, seen };
  }

  it('rejects with the abort, not an empty result, when aborted mid-body', async () => {
    const { searchWithSignal } = await import('~/server/meilisearch/client');
    const { fetchFn, seen } = stallingBodyFetch();
    global.fetch = fetchFn;
    const ctrl = new AbortController();
    const index = new MeiliSearch({ host: 'http://meili-search.example' }).index('models');

    const call = searchWithSignal(index, '', {}, ctrl.signal);
    setTimeout(() => ctrl.abort(), 10);

    await expect(call).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen.signal).toBeDefined();
  });

  it('treats a body that never arrives as a transient upstream failure', async () => {
    const { searchWithSignal, isTransientMeiliError, MeilisearchFetchError } = await import(
      '~/server/meilisearch/client'
    );
    global.fetch = stallingBodyFetch(10).fetchFn;
    const index = new MeiliSearch({ host: 'http://meili-search.example' }).index('models');

    const err = await searchWithSignal(index, '', {}, new AbortController().signal).catch(
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(MeilisearchFetchError);
    expect(isTransientMeiliError(err)).toBe(true);
  });
});
