import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `queryBitdex` returns `null` for six distinct reasons and — before #3930 —
 * nothing outside it could tell them apart. These tests pin the classification
 * at the boundary where it is still possible to make, because that is the only
 * place it is still possible to make: after the return there is one `null`.
 *
 * Two things are asserted per case, and both are needed:
 *   - the `onFailure` callback receives the right reason (what the caller uses
 *     to decide `fallback_error` vs `fallback_empty`), and
 *   - `bitdex_query_failures_total` moved on that reason and no other.
 * The second is the positive control for that counter. A zero on
 * `reason="http_4xx"` is the answer to "did someone ship a filter on a field the
 * index does not know", and a zero is worth nothing until the series has been
 * watched to move.
 */

// `BITDEX_URL` is read at MODULE LOAD from `process.env`, and ES imports are
// hoisted above ordinary statements — so a plain assignment at the top of this
// file runs too late and every case would classify as `unconfigured`. `vi.hoisted`
// is what runs before the imports.
vi.hoisted(() => {
  process.env.BITDEX_URL = 'http://bitdex.test';
});

vi.mock('~/server/utils/otel-helpers', () => ({
  // Supports both call shapes used in this file: (name, fn) and (name, attrs, fn).
  withSpan: (_name: string, a: unknown, b?: unknown) =>
    typeof a === 'function' ? (a as () => unknown)() : (b as () => unknown)(),
  safeUrl: (url: string) => url,
}));

import { queryBitdex } from '../client';
import {
  BITDEX_QUERY_FAILURE_REASONS,
  ensureRegisterBitdexFeedServeMetrics,
  type BitdexQueryFailureReason,
} from '~/server/metrics/bitdex-feed-serve.metrics';

type FailureSnapshot = Record<string, number>;

async function readFailures(): Promise<FailureSnapshot> {
  const { queryFailuresTotal } = ensureRegisterBitdexFeedServeMetrics();
  const { values } = await (
    queryFailuresTotal as unknown as {
      get(): Promise<{ values: Array<{ labels: Record<string, string>; value: number }> }>;
    }
  ).get();
  const snapshot: FailureSnapshot = {};
  for (const reason of BITDEX_QUERY_FAILURE_REASONS) snapshot[reason] = 0;
  for (const v of values) snapshot[v.labels.reason] = v.value;
  return snapshot;
}

function reasonsThatMoved(before: FailureSnapshot, after: FailureSnapshot): string[] {
  return Object.keys(after)
    .filter((k) => (after[k] ?? 0) !== (before[k] ?? 0))
    .sort();
}

const okResponse = (json: unknown) => ({
  ok: true,
  status: 200,
  json: async () => json,
  text: async () => '',
});

const errorResponse = (status: number) => ({
  ok: false,
  status,
  json: async () => ({}),
  text: async () => 'boom',
});

const call = (onFailure?: (reason: BitdexQueryFailureReason) => void) =>
  queryBitdex('civitai', [], undefined, 10, undefined, undefined, undefined, onFailure);

/** Runs one case and returns both observables. */
async function observe(): Promise<{ reasons: BitdexQueryFailureReason[]; moved: string[] }> {
  const before = await readFailures();
  const reasons: BitdexQueryFailureReason[] = [];
  await call((reason) => reasons.push(reason));
  const after = await readFailures();
  return { reasons, moved: reasonsThatMoved(before, after) };
}

describe('queryBitdex classifies every null it returns', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a 5xx → http_5xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(503)));
    const { reasons, moved } = await observe();
    expect(reasons).toEqual(['http_5xx']);
    expect(moved).toEqual(['http_5xx']);
  });

  it('🔴 a 4xx → http_4xx — the "we shipped a filter the index does not know" case', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(400)));
    const { reasons, moved } = await observe();
    expect(reasons).toEqual(['http_4xx']);
    expect(moved).toEqual(['http_4xx']);
  });

  it('a thrown fetch → network', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const { reasons, moved } = await observe();
    expect(reasons).toEqual(['network']);
    expect(moved).toEqual(['network']);
  });

  /**
   * A real abort rejects with a `DOMException`, not a plain `Error`. A fixture
   * built from `new Error()` with the name reassigned cannot tell the difference,
   * so it would keep passing even if the classification depended on a prototype
   * relationship that does not hold — measured here, `DOMException` IS an `Error`
   * subclass on this runtime, but that is a WebIDL detail and not something the
   * classification should rest on. Using the real type is what makes this case
   * evidence about production rather than about the fixture.
   */
  it('a real DOMException abort → timeout, NOT network', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'))
    );
    const { reasons, moved } = await observe();
    expect(reasons).toEqual(['timeout']);
    expect(moved).toEqual(['timeout']);
  });

  it('a plain Error named AbortError → timeout too (the classification is duck-typed)', async () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abort));
    const { reasons, moved } = await observe();
    expect(reasons).toEqual(['timeout']);
    expect(moved).toEqual(['timeout']);
  });

  it('a non-Error thrown value cannot crash the classifier', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(undefined));
    const { reasons, moved } = await observe();
    expect(reasons).toEqual(['network']);
    expect(moved).toEqual(['network']);
  });

  /**
   * 🔴 THE BOUNDARY. The split is `status >= 500`, and fixtures of 503 and 400
   * sit either side of it without ever landing ON it — so `>= 500` → `> 500`
   * survived a fully green run, silently reclassifying every HTTP 500 (the single
   * most common server error) as a client error and pointing an operator at the
   * wrong team. Exactly 500 is the only value that separates the two operators.
   */
  it('exactly 500 → http_5xx, not http_4xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(500)));
    const { reasons, moved } = await observe();
    expect(reasons).toEqual(['http_5xx']);
    expect(moved).toEqual(['http_5xx']);
  });

  it('499 → http_4xx, the other side of the same boundary', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(499)));
    const { reasons, moved } = await observe();
    expect(reasons).toEqual(['http_4xx']);
    expect(moved).toEqual(['http_4xx']);
  });

  it('a 2xx whose body will not decode → parse, NOT network', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON');
        },
        text: async () => '',
      })
    );
    const { reasons, moved } = await observe();
    expect(reasons).toEqual(['parse']);
    expect(moved).toEqual(['parse']);
  });

  it('no endpoint configured → unconfigured, without issuing a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.resetModules();
    const previous = process.env.BITDEX_URL;
    delete process.env.BITDEX_URL;
    try {
      const fresh = await import('../client');
      const reasons: BitdexQueryFailureReason[] = [];
      const result = await fresh.queryBitdex(
        'civitai',
        [],
        undefined,
        10,
        undefined,
        undefined,
        undefined,
        (r) => reasons.push(r)
      );
      expect(result).toBeNull();
      expect(reasons).toEqual(['unconfigured']);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      process.env.BITDEX_URL = previous;
      vi.resetModules();
    }
  });

  it('NEGATIVE CONTROL: a successful query reports nothing and moves no series', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okResponse({ ids: [1], total_matched: 1, elapsed_us: 5 }))
    );
    const { reasons, moved } = await observe();
    expect(reasons).toEqual([]);
    expect(moved).toEqual([]);
  });

  it('a SUCCESSFUL but EMPTY result is not a failure — the distinction the metric exists for', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okResponse({ ids: [], total_matched: 0, elapsed_us: 5 }))
    );
    const { reasons, moved } = await observe();
    expect(reasons).toEqual([]);
    expect(moved).toEqual([]);
  });

  it('a caller callback that THROWS cannot break the query path', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(500)));
    await expect(
      call(() => {
        throw new Error('a metrics sink fell over');
      })
    ).resolves.toBeNull();
  });
});

describe('queryBitdex clears its abort timer on the failure path', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /**
   * 🔴 THE LEAK. The only `clearTimeout` used to sit after the fetch resolved,
   * which a thrown fetch skips entirely — leaving a 30s timer holding the
   * AbortController alive on every failed call, at feed request rate. Asserted
   * on the pending-timer count rather than on a comment, because a comment
   * cannot go red.
   */
  it('a thrown fetch leaves no pending timer', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    // Positive control for the instrument itself: the counter must be able to
    // report a non-zero, or "0 pending timers" would mean nothing.
    const sentinel = setTimeout(() => undefined, 60_000);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    clearTimeout(sentinel);
    expect(vi.getTimerCount()).toBe(0);

    await call();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('a successful call leaves no pending timer either', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okResponse({ ids: [], total_matched: 0, elapsed_us: 1 }))
    );

    await call();

    expect(vi.getTimerCount()).toBe(0);
  });
});
