import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MeiliUtil from '~/server/meilisearch/util';

// Partial: only the cleanup helper would reach a real Meilisearch instance from `updateSync`.
vi.mock('~/server/meilisearch/util', async (importOriginal) => ({
  ...(await importOriginal<typeof MeiliUtil>()),
  onSearchIndexDocumentsCleanup: vi.fn(),
}));

const { createSearchIndexUpdateProcessor, DEFAULT_UPDATE_SYNC_CHUNK_SIZE } = await import(
  '~/server/search-index/base.search-index'
);
const { collectionsSearchIndex } = await import('~/server/search-index/collections.search-index');

type Processor = Parameters<typeof createSearchIndexUpdateProcessor>[0];

const buildIndex = (overrides: Partial<Processor> = {}) =>
  createSearchIndexUpdateProcessor({
    indexName: 'test_index',
    setup: async () => undefined,
    prepareBatches: async () => ({ batchSize: 100, startId: 0, endId: 0 }),
    pullData: async (_ctx, batch) => (batch.type === 'update' ? batch.ids : []),
    transformData: async (data: unknown) => data,
    pushData: async () => undefined,
    ...overrides,
  });

const updateItems = (count: number) => Array.from({ length: count }, (_, i) => ({ id: i + 1 }));

/** What a Prisma statement-timeout surfaces as inside `pullData`. */
const statementTimeout = () =>
  Object.assign(new Error('canceling statement due to statement timeout'), { code: 'P2010' });

beforeEach(() => {
  // processSearchIndexTask logs every caught error; keep the run readable.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('updateSync :: failure reporting', () => {
  it('reports the failed batch when the pull step throws, instead of resolving silently', async () => {
    const pullData = vi.fn().mockRejectedValue(statementTimeout());
    const index = buildIndex({ pullData, updateSyncChunkSize: 300 });

    const result = await index.updateSync(updateItems(3));

    expect(result).toEqual({
      indexName: 'test_index',
      totalTasks: 1,
      failedTasks: 1,
      failedIds: 3,
    });
    // 1 attempt + the 3 retries the queue promises. Before the retry slot was held open across
    // the backoff, every worker exited during the first retry's sleep and the task was dropped
    // after a single attempt with nothing recorded as failed.
    expect(pullData).toHaveBeenCalledTimes(4);
  }, 30_000);

  it('attributes a failure at the push step back to the ids that were never written', async () => {
    // The push task no longer carries the id list, so this pins that the id count survives the
    // pull -> transform -> push handoff.
    const pushData = vi.fn().mockRejectedValue(new Error('meilisearch rejected the batch'));
    const index = buildIndex({ pushData, updateSyncChunkSize: 300 });

    const result = await index.updateSync(updateItems(7));

    expect(result.failedTasks).toBe(1);
    expect(result.failedIds).toBe(7);
  }, 30_000);

  it('reports zero failures when every batch succeeds', async () => {
    const pushData = vi.fn().mockResolvedValue(undefined);
    const index = buildIndex({ pushData, updateSyncChunkSize: 300 });

    const result = await index.updateSync(updateItems(7));

    expect(result).toEqual({
      indexName: 'test_index',
      totalTasks: 1,
      failedTasks: 0,
      failedIds: 0,
    });
    expect(pushData).toHaveBeenCalledTimes(1);
  });

  it('returns an all-zero result for an empty item list', async () => {
    const index = buildIndex();
    await expect(index.updateSync([])).resolves.toEqual({
      indexName: 'test_index',
      totalTasks: 0,
      failedTasks: 0,
      failedIds: 0,
    });
  });
});

describe('updateSync :: per-index chunk size', () => {
  // 60 is deliberately NOT a multiple of 25 — a batching off-by-one would show up as a
  // different final batch size rather than the same count.
  const ITEM_COUNT = 60;

  const pulledIdCounts = (pullData: ReturnType<typeof vi.fn>) =>
    pullData.mock.calls.map(([, batch]) => (batch.type === 'update' ? batch.ids.length : 0));

  it('splits into batches of the configured size', async () => {
    const pullData = vi.fn(async (_ctx, batch) => (batch.type === 'update' ? batch.ids : []));
    const index = buildIndex({ pullData, updateSyncChunkSize: 25 });

    const result = await index.updateSync(updateItems(ITEM_COUNT));

    expect(result.totalTasks).toBe(3);
    expect(pulledIdCounts(pullData).sort((a, b) => b - a)).toEqual([25, 25, 10]);
  });

  it('falls back to the default chunk size when a processor sets none', async () => {
    const pullData = vi.fn(async (_ctx, batch) => (batch.type === 'update' ? batch.ids : []));
    const index = buildIndex({ pullData });

    const result = await index.updateSync(updateItems(ITEM_COUNT));

    expect(index.updateSyncChunkSize).toBe(DEFAULT_UPDATE_SYNC_CHUNK_SIZE);
    // 60 ids fit in a single default-sized batch, so the same input produces ONE task here and
    // three above — the chunk size is what moved.
    expect(result.totalTasks).toBe(1);
    expect(pulledIdCounts(pullData)).toEqual([ITEM_COUNT]);
  });

  it('keeps the collections index well below the default', () => {
    // The batch that timed out in production was 300 ids; the default is 500.
    expect(collectionsSearchIndex.updateSyncChunkSize).toBeLessThan(DEFAULT_UPDATE_SYNC_CHUNK_SIZE);
    expect(collectionsSearchIndex.updateSyncChunkSize).toBe(25);
  });
});
