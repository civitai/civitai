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

type Processor = Parameters<typeof createSearchIndexUpdateProcessor>[0];

const buildIndex = (overrides: Partial<Processor> = {}) =>
  createSearchIndexUpdateProcessor({
    indexName: 'test_index',
    setup: async () => undefined,
    prepareBatches: async () => ({ batchSize: 100, startId: 0, endId: 0 }),
    pullData: async (_ctx, batch) => (batch.type === 'update' ? batch.ids : []),
    // LOAD-BEARING: this returns the pulled value unchanged, and `pullData` above returns bare
    // NUMBERS. That is what makes these batches an unreadable shape to the without-document accounting in
    // `base.search-index.ts`, so every result here reports `idsWithoutDocument: 0` and these cases stay
    // about failure reporting alone. Making it return documents "like the drop-reporting file"
    // would flip that and turn these assertions into drop assertions.
    transformData: async (data: unknown) => data,
    pushData: async () => undefined,
    ...overrides,
  });

const updateItems = (count: number) => Array.from({ length: count }, (_, i) => ({ id: i + 1 }));

/** What a Prisma statement-timeout surfaces as inside `pullData`. */
const statementTimeout = () =>
  Object.assign(new Error('canceling statement due to statement timeout'), { code: 'P2010' });

// Idle workers poll every 1s and retries back off 1s, so drive the clock instead of waiting.
const settle = async <T>(promise: Promise<T>): Promise<T> => {
  let done = false;
  void promise.finally(() => (done = true)).catch(() => undefined);
  while (!done) await vi.advanceTimersByTimeAsync(1000);
  return promise;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('updateSync :: failure reporting', () => {
  it('reports the failed batch when the pull step throws, instead of resolving silently', async () => {
    const pullData = vi.fn().mockRejectedValue(statementTimeout());
    const index = buildIndex({ pullData, updateSyncChunkSize: 300 });

    const result = await settle(index.updateSync(updateItems(3)));

    expect(result).toEqual({
      indexName: 'test_index',
      totalTasks: 1,
      failedTasks: 1,
      failedIds: 3,
      idsWithoutDocument: 0,
      idsWithoutDocumentSample: [],
      handledWithoutDocument: 0,
    });
    // 1 attempt + the 3 retries the queue promises. Before the retry slot was held open across
    // the backoff, every worker exited during the first retry's sleep and the task was dropped
    // after a single attempt with nothing recorded as failed.
    expect(pullData).toHaveBeenCalledTimes(4);
  });

  it('attributes a failure at the push step back to the ids that were never written', async () => {
    // Pins that `idCount` survives the pull -> transform -> push handoff, so a push-step failure
    // is counted.
    const pushData = vi.fn().mockRejectedValue(new Error('meilisearch rejected the batch'));
    const index = buildIndex({ pushData, updateSyncChunkSize: 300 });

    const result = await settle(index.updateSync(updateItems(7)));

    expect(result.failedTasks).toBe(1);
    expect(result.failedIds).toBe(7);
  });

  it('counts only the ids of the batches that failed, not every id in the run', async () => {
    // Deliberately pairwise-distinct, and distinct from every constant the assertions name:
    // 30 items / chunk 8 => 4 batches sized 8, 8, 8, 6. Failing the FIRST and the LAST gives
    // failedTasks 2 and failedIds 14 — a number that is not the item count (30), not the batch
    // count (4), not the chunk size (8), and not `failedTasks * chunkSize` (16). Every "close
    // enough" way of deriving it lands on a different value.
    const ITEM_COUNT = 30;
    const CHUNK_SIZE = 8;
    const FIRST_ID_OF_FAILING_HEAD_BATCH = 1;
    const FIRST_ID_OF_FAILING_TAIL_BATCH = 25;

    const pushed: number[] = [];
    const pullData = vi.fn(async (_ctx, batch) => {
      if (batch.type !== 'update') return [];
      const ids = batch.ids as number[];
      if (
        ids.includes(FIRST_ID_OF_FAILING_HEAD_BATCH) ||
        ids.includes(FIRST_ID_OF_FAILING_TAIL_BATCH)
      ) {
        throw statementTimeout();
      }
      return ids;
    });
    const pushData = vi.fn(async (_ctx: unknown, data: number[]) => {
      pushed.push(...data);
    });

    const index = buildIndex({ pullData, pushData, updateSyncChunkSize: CHUNK_SIZE });

    const result = await settle(index.updateSync(updateItems(ITEM_COUNT)));

    expect(result).toEqual({
      indexName: 'test_index',
      totalTasks: 4,
      failedTasks: 2,
      failedIds: 14,
      idsWithoutDocument: 0,
      idsWithoutDocumentSample: [],
      handledWithoutDocument: 0,
    });
    // The batches that did not fail were still written — 16 ids, the complement of the 14.
    expect(pushData).toHaveBeenCalledTimes(2);
    expect(pushed.sort((a, b) => a - b)).toEqual([
      9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
    ]);
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

    const result = await settle(index.updateSync(updateItems(ITEM_COUNT)));

    expect(result.totalTasks).toBe(3);
    expect(pulledIdCounts(pullData).sort((a, b) => b - a)).toEqual([25, 25, 10]);
  });

  // lodash `chunk` returns [] for a size of 0 or NaN, which would report a clean run that indexed nothing.
  const CLAMPED_TO_FLOOR = Array.from({ length: ITEM_COUNT }, () => 1);
  const ONE_DEFAULT_SIZED_BATCH = [ITEM_COUNT];

  it.each([
    { configured: 0, label: 'zero', expectedChunkSize: 1, expectedBatchSizes: CLAMPED_TO_FLOOR },
    {
      configured: NaN,
      label: 'NaN',
      expectedChunkSize: DEFAULT_UPDATE_SYNC_CHUNK_SIZE,
      expectedBatchSizes: ONE_DEFAULT_SIZED_BATCH,
    },
  ])(
    'still indexes every item when the chunk size is $label',
    async ({ configured, expectedChunkSize, expectedBatchSizes }) => {
      const pullData = vi.fn(async (_ctx, batch) => (batch.type === 'update' ? batch.ids : []));
      const pushData = vi.fn().mockResolvedValue(undefined);
      const index = buildIndex({ pullData, pushData, updateSyncChunkSize: configured });

      const result = await settle(index.updateSync(updateItems(ITEM_COUNT)));

      expect(index.updateSyncChunkSize).toBe(expectedChunkSize);
      expect(result.totalTasks).toBe(expectedBatchSizes.length);
      expect(result.failedTasks).toBe(0);
      expect(pushData).toHaveBeenCalledTimes(expectedBatchSizes.length);
      expect(pulledIdCounts(pullData)).toEqual(expectedBatchSizes);
    }
  );
});
