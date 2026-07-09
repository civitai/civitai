import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for the tensor-metadata summary/full cache SPLIT (the whale fix).
 *
 * The endpoint composes two `fetchThroughCache` calls (see
 * src/pages/api/v1/model-files/[id]/tensor-metadata.ts):
 *   - FULL cache  → the whole analysis incl. the ~335 KB `tensors[]` (compressed at rest)
 *   - SUMMARY cache → the tiny `{ ...summary }` with `tensors` dropped, whose fetcher
 *     calls the full fetcher on a MISS.
 *
 * Contract pinned here (against the REAL fetchThroughCache, with redis mocked as an
 * in-memory packed store so hits/misses are deterministic):
 *   1. A summary cache HIT does NOT invoke the full fetcher / parse (the hot path on every
 *      model-version view must never touch the big blob).
 *   2. A summary cache MISS populates the summary FROM the full analysis (and the summary
 *      never contains `tensors`).
 *   3. The full path returns the full analysis INCLUDING `tensors`.
 *   4. The full cache write opts into `compress: true`; the summary write does not.
 */

// In-memory packed store keyed by redis key. `compress` is recorded per-set so we can
// assert the full cache opts in and the summary does not.
const store = new Map<string, unknown>();
const setCompressFlags = new Map<string, boolean | undefined>();

const packedGet = vi.fn(async (key: string) => (store.has(key) ? store.get(key) : null));
const packedSet = vi.fn(
  async (key: string, value: unknown, _opts?: unknown, packedOptions?: { compress?: boolean }) => {
    store.set(key, value);
    setCompressFlags.set(key, packedOptions?.compress);
  }
);
const setNxMock = vi.fn().mockResolvedValue(true); // always win the lock
const delMock = vi.fn().mockResolvedValue(undefined);

vi.mock('~/server/redis/client', () => ({
  redis: {
    packed: {
      get: (...a: unknown[]) => packedGet(...(a as [string])),
      set: (...a: unknown[]) =>
        packedSet(...(a as [string, unknown, unknown, { compress?: boolean }])),
    },
    setNxKeepTtlWithEx: (...a: unknown[]) => setNxMock(...a),
    del: (...a: unknown[]) => delMock(...a),
  },
  sysRedis: {},
  REDIS_KEYS: {
    CACHE_LOCKS: 'caches:lock',
    CACHES: {
      TENSOR_METADATA: 'packed:caches:tensor-metadata',
      TENSOR_METADATA_SUMMARY: 'packed:caches:tensor-metadata-summary',
    },
  },
}));

vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/prom/client', () => ({
  cacheHitCounter: { inc: vi.fn() },
  cacheMissCounter: { inc: vi.fn() },
  cacheRevalidateCounter: { inc: vi.fn() },
  cacheFailOpenDegradedCounter: { inc: vi.fn() },
  cacheFailOpenOriginFetchCounter: { inc: vi.fn() },
}));

import { CacheTTL } from '~/server/common/constants';
import { bustFetchThroughCache, fetchThroughCache } from '~/server/utils/cache-helpers';

const FULL_KEY = 'packed:caches:tensor-metadata:42';
const SUMMARY_KEY = 'packed:caches:tensor-metadata-summary:42';

const makeAnalysis = () => ({
  format: 'SafeTensor' as const,
  tensorCount: 2,
  totalTensorBytes: 100,
  dtypeCounts: [{ dtype: 'F16', count: 2, bytes: 100 }],
  largestTensor: { name: 'a.weight', shape: [10, 10], dtype: 'F16', sizeBytes: 50 },
  vramEstimate: null,
  tensors: [
    { name: 'a.weight', shape: [10, 10], dtype: 'F16', sizeBytes: 50 },
    { name: 'b.weight', shape: [10, 10], dtype: 'F16', sizeBytes: 50 },
  ],
});

// Mirrors the endpoint's composition exactly.
function makeFetchers(parse: () => Promise<ReturnType<typeof makeAnalysis>>) {
  const fetchFull = () =>
    fetchThroughCache(FULL_KEY as never, parse, { ttl: CacheTTL.month, compress: true });
  const fetchSummary = () =>
    fetchThroughCache(
      SUMMARY_KEY as never,
      async () => {
        const analysis = await fetchFull();
        const { tensors, ...rest } = analysis;
        return rest;
      },
      { ttl: CacheTTL.month }
    );
  return { fetchFull, fetchSummary };
}

beforeEach(() => {
  store.clear();
  setCompressFlags.clear();
  packedGet.mockClear();
  packedSet.mockClear();
  setNxMock.mockClear().mockResolvedValue(true);
  delMock.mockClear();
});

afterEach(() => vi.restoreAllMocks());

describe('tensor-metadata summary/full cache split', () => {
  it('summary MISS populates from the full analysis and drops `tensors`', async () => {
    const parse = vi.fn(async () => makeAnalysis());
    const { fetchSummary } = makeFetchers(parse);

    const summary = await fetchSummary();

    expect(parse).toHaveBeenCalledTimes(1); // miss → full fetcher → parse
    expect(summary).not.toHaveProperty('tensors');
    expect(summary).toMatchObject({ format: 'SafeTensor', tensorCount: 2 });
    // Both caches got written; full opts into compression, summary does not.
    expect(store.has(SUMMARY_KEY)).toBe(true);
    expect(store.has(FULL_KEY)).toBe(true);
    expect(setCompressFlags.get(FULL_KEY)).toBe(true);
    expect(setCompressFlags.get(SUMMARY_KEY)).toBeFalsy();
  });

  it('summary HIT does NOT invoke the full fetcher / parse (never touches the big blob)', async () => {
    const parse = vi.fn(async () => makeAnalysis());
    const { fetchSummary } = makeFetchers(parse);

    await fetchSummary(); // first call: miss, parses once
    expect(parse).toHaveBeenCalledTimes(1);

    packedGet.mockClear();
    const summary = await fetchSummary(); // second call: summary HIT

    expect(parse).toHaveBeenCalledTimes(1); // STILL 1 — full fetcher never ran
    // It read ONLY the summary key, never the full key.
    const readKeys = packedGet.mock.calls.map((c) => c[0]);
    expect(readKeys).toContain(SUMMARY_KEY);
    expect(readKeys).not.toContain(FULL_KEY);
    expect(summary).not.toHaveProperty('tensors');
  });

  it('the full path returns the analysis INCLUDING `tensors`', async () => {
    const parse = vi.fn(async () => makeAnalysis());
    const { fetchFull } = makeFetchers(parse);

    const analysis = await fetchFull();
    expect(analysis.tensors).toHaveLength(2);
    expect(analysis.tensorCount).toBe(2);
    expect(setCompressFlags.get(FULL_KEY)).toBe(true);
  });

  it('a full cache HIT serves without re-parsing', async () => {
    const parse = vi.fn(async () => makeAnalysis());
    const { fetchFull } = makeFetchers(parse);

    await fetchFull();
    const again = await fetchFull();
    expect(parse).toHaveBeenCalledTimes(1);
    expect(again.tensors).toHaveLength(2);
  });
});

// Audit hardening: bustFetchThroughCache must thread `compress` to BOTH the get and
// the set, so busting a compressed key reads/writes it with the matching codec instead
// of decode-failing → evicting → silently no-op'ing the bust.
describe('bustFetchThroughCache compress threading', () => {
  const compressArgOf = (key: string) =>
    (packedGet.mock.calls.find((c) => c[0] === key)?.[1] as { compress?: boolean } | undefined)
      ?.compress;

  it('threads compress=true to the get AND the set when busting a compressed key', async () => {
    store.set(FULL_KEY, { data: { x: 1 }, cachedAt: 999 });
    setCompressFlags.clear();
    packedGet.mockClear();

    await bustFetchThroughCache(FULL_KEY as never, { compress: true });

    expect(compressArgOf(FULL_KEY)).toBe(true); // read with the compressed codec
    expect(setCompressFlags.get(FULL_KEY)).toBe(true); // rewritten compressed
    // staleness reset actually happened (the bust did not no-op)
    expect((store.get(FULL_KEY) as { cachedAt: number }).cachedAt).toBe(0);
  });

  it('defaults to compress=false (general path) for uncompressed callers', async () => {
    store.set(SUMMARY_KEY, { data: { y: 2 }, cachedAt: 999 });
    setCompressFlags.clear();
    packedGet.mockClear();

    await bustFetchThroughCache(SUMMARY_KEY as never);

    expect(compressArgOf(SUMMARY_KEY)).toBeFalsy();
    expect(setCompressFlags.get(SUMMARY_KEY)).toBeFalsy();
    expect((store.get(SUMMARY_KEY) as { cachedAt: number }).cachedAt).toBe(0);
  });
});
