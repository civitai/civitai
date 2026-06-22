import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelTensorAnalysis } from '~/utils/model-tensor-metadata';

/**
 * Coverage for the in-process decoded-tensor-analysis LRU
 * (src/server/services/tensor-metadata.service.ts), the relief-bearing fix for the
 * api-primary 504 waves: a popular file must be DECODED (brotli + msgpack unpack) at
 * most once per pod, not on every panel-open model-page view.
 *
 * Pinned here:
 *  1. MISS → invokes the (redis-backed) fetcher and returns its result.
 *  2. HIT  → returns the cached DECODED object WITHOUT re-invoking the fetcher
 *            (the regression guard: a hot path does NOT re-trigger the decode).
 *  3. Distinct file ids are cached independently.
 *  4. The cache is BOUNDED — exceeding the item cap evicts the least-recently-used
 *     entry, so a re-read of an evicted id re-invokes the fetcher.
 */

const cacheHitInc = vi.fn();
const cacheMissInc = vi.fn();

function makeAnalysis(tensorCount: number, marker: string): ModelTensorAnalysis {
  return {
    format: 'SafeTensor',
    tensorCount,
    totalTensorBytes: tensorCount * 1000,
    dtypeCounts: [],
    largestTensor: null,
    vramEstimate: null,
    tensors: Array.from({ length: tensorCount }, (_, i) => ({
      name: `${marker}.tensor.${i}`,
      shape: [1, 2, 3],
      dtype: 'F16',
      sizeBytes: 1000,
    })),
  };
}

describe('tensor-metadata.service decoded-analysis LRU', () => {
  beforeEach(async () => {
    vi.resetModules();
    // Small item cap so the eviction test is cheap and deterministic.
    process.env.TENSOR_METADATA_LRU_MAX_ITEMS = '2';
    process.env.TENSOR_METADATA_LRU_MAX_SIZE_BYTES = '0'; // disable byte cap for this suite
    process.env.TENSOR_METADATA_LRU_TTL_MS = '0';
  });

  afterEach(() => {
    delete process.env.TENSOR_METADATA_LRU_MAX_ITEMS;
    delete process.env.TENSOR_METADATA_LRU_MAX_SIZE_BYTES;
    delete process.env.TENSOR_METADATA_LRU_TTL_MS;
    vi.clearAllMocks();
  });

  async function load() {
    vi.resetModules();
    vi.doMock('~/server/prom/client', () => ({
      cacheHitCounter: { inc: cacheHitInc },
      cacheMissCounter: { inc: cacheMissInc },
    }));
    return import('../tensor-metadata.service');
  }

  it('MISS invokes the fetcher and returns its result', async () => {
    const { getFullTensorAnalysisCached, __tensorMetadataLruInternals } = await load();
    __tensorMetadataLruInternals.clear();

    const analysis = makeAnalysis(3, 'a');
    const fetcher = vi.fn(async () => analysis);

    const result = await getFullTensorAnalysisCached(1, fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result).toBe(analysis);
    expect(result.tensors).toHaveLength(3);
    expect(__tensorMetadataLruInternals.has(1)).toBe(true);
  });

  it('HIT returns the cached object WITHOUT re-invoking the fetcher (decode-once guard)', async () => {
    const { getFullTensorAnalysisCached, __tensorMetadataLruInternals } = await load();
    __tensorMetadataLruInternals.clear();

    const analysis = makeAnalysis(5, 'hot');
    const fetcher = vi.fn(async () => analysis);

    const first = await getFullTensorAnalysisCached(42, fetcher);
    const second = await getFullTensorAnalysisCached(42, fetcher);
    const third = await getFullTensorAnalysisCached(42, fetcher);

    // The decode (fetcher) ran exactly ONCE despite three reads — this is the relief.
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(first).toBe(analysis);
    expect(second).toBe(analysis);
    expect(third).toBe(analysis);
  });

  it('caches distinct file ids independently', async () => {
    const { getFullTensorAnalysisCached } = await load();

    const a = makeAnalysis(2, 'idA');
    const b = makeAnalysis(7, 'idB');
    const fetcherA = vi.fn(async () => a);
    const fetcherB = vi.fn(async () => b);

    const ra1 = await getFullTensorAnalysisCached(100, fetcherA);
    const rb1 = await getFullTensorAnalysisCached(200, fetcherB);
    const ra2 = await getFullTensorAnalysisCached(100, fetcherA);
    const rb2 = await getFullTensorAnalysisCached(200, fetcherB);

    expect(ra1).toBe(a);
    expect(ra2).toBe(a);
    expect(rb1).toBe(b);
    expect(rb2).toBe(b);
    expect(fetcherA).toHaveBeenCalledTimes(1);
    expect(fetcherB).toHaveBeenCalledTimes(1);
  });

  it('is BOUNDED — exceeding the item cap evicts LRU, forcing a re-decode of the evicted id', async () => {
    // MAX_ITEMS=2 (set in beforeEach). Insert 1, 2, then 3 -> id 1 evicted.
    const { getFullTensorAnalysisCached, __tensorMetadataLruInternals } = await load();
    __tensorMetadataLruInternals.clear();

    const f1 = vi.fn(async () => makeAnalysis(1, '1'));
    const f2 = vi.fn(async () => makeAnalysis(1, '2'));
    const f3 = vi.fn(async () => makeAnalysis(1, '3'));

    await getFullTensorAnalysisCached(1, f1); // [1]
    await getFullTensorAnalysisCached(2, f2); // [1,2]
    await getFullTensorAnalysisCached(3, f3); // [2,3]  (1 evicted)

    expect(__tensorMetadataLruInternals.size).toBe(2);
    expect(__tensorMetadataLruInternals.has(1)).toBe(false);
    expect(__tensorMetadataLruInternals.has(2)).toBe(true);
    expect(__tensorMetadataLruInternals.has(3)).toBe(true);

    // Re-reading the evicted id re-invokes the fetcher (no longer a hit).
    await getFullTensorAnalysisCached(1, f1);
    expect(f1).toHaveBeenCalledTimes(2);
  });

  it('respects the byte cap (maxSize) when item cap is generous', async () => {
    process.env.TENSOR_METADATA_LRU_MAX_ITEMS = '1000';
    // Base 4096 + 256/tensor. A 10-tensor analysis ~= 4096 + 2560 = 6656 bytes.
    // Cap at ~9000 bytes => only one such entry fits at a time.
    process.env.TENSOR_METADATA_LRU_MAX_SIZE_BYTES = '9000';
    const { getFullTensorAnalysisCached, __tensorMetadataLruInternals } = await load();
    __tensorMetadataLruInternals.clear();

    const fA = vi.fn(async () => makeAnalysis(10, 'A'));
    const fB = vi.fn(async () => makeAnalysis(10, 'B'));

    await getFullTensorAnalysisCached(1, fA);
    await getFullTensorAnalysisCached(2, fB); // pushes total over the byte cap -> evicts id 1

    expect(__tensorMetadataLruInternals.has(2)).toBe(true);
    expect(__tensorMetadataLruInternals.has(1)).toBe(false);
  });
});
