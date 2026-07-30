import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for the tensor-metadata summary/full cache SPLIT (the whale fix).
 *
 * The shared service composes two `fetchThroughCache` calls (see
 * src/server/services/tensor-metadata-cache.service.ts):
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

import {
  bustModelTensorMetadataCaches,
  getModelTensorCacheIdentity,
  getModelTensorAnalysisCached,
  getModelTensorSummaryCached,
  getModelTensorSummaryCachedWithTimeout,
} from '~/server/services/tensor-metadata-cache.service';
import { __tensorMetadataLruInternals } from '~/server/services/tensor-metadata.service';
import { bustFetchThroughCache } from '~/server/utils/cache-helpers';

const CACHE_SOURCE = { fileId: 42, fileUrl: 'https://storage.example/old.safetensors' };
const CACHE_IDENTITY = getModelTensorCacheIdentity(CACHE_SOURCE);
const FULL_KEY = `packed:caches:tensor-metadata:${CACHE_IDENTITY}`;
const SUMMARY_KEY = `packed:caches:tensor-metadata-summary:${CACHE_IDENTITY}`;
const LEGACY_FULL_KEY = 'packed:caches:tensor-metadata:42';
const LEGACY_SUMMARY_KEY = 'packed:caches:tensor-metadata-summary:42';

const makeAnalysis = (dtype = 'F16') => ({
  format: 'SafeTensor' as const,
  tensorCount: 2,
  totalTensorBytes: 100,
  dtypeCounts: [{ dtype, count: 2, bytes: 100 }],
  largestTensor: { name: 'a.weight', shape: [10, 10], dtype, sizeBytes: 50 },
  vramEstimate: null,
  tensors: [
    { name: 'a.weight', shape: [10, 10], dtype, sizeBytes: 50 },
    { name: 'b.weight', shape: [10, 10], dtype, sizeBytes: 50 },
  ],
});

// Uses the same shared service as the endpoint and model-version mini response.
function makeFetchers(
  parse: () => Promise<ReturnType<typeof makeAnalysis>>,
  source = CACHE_SOURCE
) {
  const fetchFull = () => getModelTensorAnalysisCached(source, parse);
  const fetchSummary = () => getModelTensorSummaryCached(source, parse);
  return { fetchFull, fetchSummary };
}

beforeEach(() => {
  store.clear();
  setCompressFlags.clear();
  packedGet.mockClear();
  packedSet.mockClear();
  setNxMock.mockClear().mockResolvedValue(true);
  delMock.mockClear();
  __tensorMetadataLruInternals.clear();
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

  it('does not cache a failed summary load and retries the lazy loader', async () => {
    const parse = vi
      .fn<() => Promise<ReturnType<typeof makeAnalysis>>>()
      .mockRejectedValueOnce(new Error('header unavailable'))
      .mockResolvedValueOnce(makeAnalysis());
    const { fetchSummary } = makeFetchers(parse);

    await expect(fetchSummary()).rejects.toThrow('header unavailable');
    expect(store.has(SUMMARY_KEY)).toBe(false);
    expect(store.has(FULL_KEY)).toBe(false);

    await expect(fetchSummary()).resolves.toMatchObject({ tensorCount: 2 });
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it('busts the summary, full, and decoded caches for a replaced file', async () => {
    const parse = vi.fn(async () => makeAnalysis());
    await getModelTensorAnalysisCached(CACHE_SOURCE, parse);
    expect(__tensorMetadataLruInternals.has(CACHE_IDENTITY)).toBe(true);

    await bustModelTensorMetadataCaches(42, CACHE_SOURCE.fileUrl);

    expect(__tensorMetadataLruInternals.has(CACHE_IDENTITY)).toBe(false);
    expect(delMock).toHaveBeenCalledWith(FULL_KEY);
    expect(delMock).toHaveBeenCalledWith(SUMMARY_KEY);
    expect(delMock).toHaveBeenCalledWith(LEGACY_FULL_KEY);
    expect(delMock).toHaveBeenCalledWith(LEGACY_SUMMARY_KEY);
  });

  it('never serves an old in-flight parse to a replacement URL with the same file id', async () => {
    const oldSource = CACHE_SOURCE;
    const newSource = { fileId: 42, fileUrl: 'https://storage.example/new.safetensors' };
    let finishOldParse!: (analysis: ReturnType<typeof makeAnalysis>) => void;
    const oldParse = vi.fn(
      () =>
        new Promise<ReturnType<typeof makeAnalysis>>((resolve) => {
          finishOldParse = resolve;
        })
    );

    const oldRequest = getModelTensorSummaryCached(oldSource, oldParse);
    await vi.waitFor(() => expect(oldParse).toHaveBeenCalledOnce());

    // The mutation commits the new URL and busts while the old parse is still
    // running. It cannot cancel that work, so the old request will populate its
    // cache after the bust.
    await bustModelTensorMetadataCaches(42, oldSource.fileUrl);

    const newParse = vi.fn(async () => makeAnalysis('BF16'));
    const newSummary = await getModelTensorSummaryCached(newSource, newParse);
    expect(newSummary.dtypeCounts).toEqual([{ dtype: 'BF16', count: 2, bytes: 100 }]);

    finishOldParse(makeAnalysis('F8_E4M3FN'));
    await oldRequest;

    // Even after the stale request finishes and writes its old data, the new
    // identity remains isolated and warm with the replacement content.
    const shouldNotParse = vi.fn(async () => makeAnalysis('F16'));
    const newSummaryAgain = await getModelTensorSummaryCached(newSource, shouldNotParse);
    expect(newSummaryAgain.dtypeCounts).toEqual([{ dtype: 'BF16', count: 2, bytes: 100 }]);
    expect(newParse).toHaveBeenCalledOnce();
    expect(shouldNotParse).not.toHaveBeenCalled();
  });

  it('fails open on a bounded summary timeout while the shared cache fill keeps warming', async () => {
    let finishParse!: (analysis: ReturnType<typeof makeAnalysis>) => void;
    const parse = vi.fn(
      () =>
        new Promise<ReturnType<typeof makeAnalysis>>((resolve) => {
          finishParse = resolve;
        })
    );
    const onTimeout = vi.fn();

    const summary = await getModelTensorSummaryCachedWithTimeout(CACHE_SOURCE, parse, 5, onTimeout);

    expect(summary).toBeNull();
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(parse).toHaveBeenCalledOnce();

    finishParse(makeAnalysis('BF16'));
    await vi.waitFor(() => expect(store.has(SUMMARY_KEY)).toBe(true));

    const shouldNotParse = vi.fn(async () => makeAnalysis('F16'));
    const warmedSummary = await getModelTensorSummaryCached(CACHE_SOURCE, shouldNotParse);
    expect(warmedSummary.dtypeCounts).toEqual([{ dtype: 'BF16', count: 2, bytes: 100 }]);
    expect(shouldNotParse).not.toHaveBeenCalled();
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
