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

    const result = await index.updateSync(updateItems(ITEM_COUNT));

    expect(result).toEqual({
      indexName: 'test_index',
      totalTasks: 4,
      failedTasks: 2,
      failedIds: 14,
    });
    // A partial failure, not a total one: strictly fewer than every batch, and strictly fewer
    // than every id.
    expect(result.failedTasks).toBeLessThan(result.totalTasks);
    expect(result.failedIds).toBeLessThan(ITEM_COUNT);
    // The batches that did not fail were still written — 16 ids, the complement of the 14.
    expect(pushData).toHaveBeenCalledTimes(2);
    expect(pushed.sort((a, b) => a - b)).toEqual([
      9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
    ]);
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

  // `chunk(xs, 0)`, `chunk(xs, -1)` and `chunk(xs, NaN)` all return [] in lodash, so an unguarded
  // chunk size would queue zero tasks and return `{ totalTasks: 0, failedTasks: 0 }` — a clean
  // result for a run that indexed nothing. The two arms of the guard produce different sizes and
  // are pinned separately: a non-positive but finite value is CLAMPED to the one-id floor, while a
  // non-finite one FALLS BACK to the default.
  //
  // The non-finite cases are what pin `Number.isFinite` rather than a `typeof x === 'number'`
  // test: `NaN`, `Infinity` and `-Infinity` are all of type `number`, so the declared type does
  // not exclude them, and `Math.max(1, Math.floor(NaN))` is `NaN` — the same empty-chunk silent
  // success the clamp exists to remove. (`-Infinity` is the weakest of the three: a `typeof`
  // mutant clamps it to 1, so only the exact-size assertion below separates it from the floor.)

  // 60 ids at one id per batch is 60 batches of 1; 60 ids at the default (which is larger than
  // 60) is a single batch of 60.
  const CLAMPED_TO_FLOOR = Array.from({ length: ITEM_COUNT }, () => 1);
  const ONE_DEFAULT_SIZED_BATCH = [ITEM_COUNT];

  it.each([
    { configured: 0, label: 'zero', expectedChunkSize: 1, expectedBatchSizes: CLAMPED_TO_FLOOR },
    {
      configured: -5,
      label: 'negative',
      expectedChunkSize: 1,
      expectedBatchSizes: CLAMPED_TO_FLOOR,
    },
    {
      configured: NaN,
      label: 'NaN',
      expectedChunkSize: DEFAULT_UPDATE_SYNC_CHUNK_SIZE,
      expectedBatchSizes: ONE_DEFAULT_SIZED_BATCH,
    },
    {
      configured: Infinity,
      label: 'Infinity',
      expectedChunkSize: DEFAULT_UPDATE_SYNC_CHUNK_SIZE,
      expectedBatchSizes: ONE_DEFAULT_SIZED_BATCH,
    },
    {
      configured: -Infinity,
      label: 'negative Infinity',
      expectedChunkSize: DEFAULT_UPDATE_SYNC_CHUNK_SIZE,
      expectedBatchSizes: ONE_DEFAULT_SIZED_BATCH,
    },
  ])(
    'still indexes every item when the chunk size is $label',
    async ({ configured, expectedChunkSize, expectedBatchSizes }) => {
      const pullData = vi.fn(async (_ctx, batch) => (batch.type === 'update' ? batch.ids : []));
      const pushData = vi.fn().mockResolvedValue(undefined);
      const index = buildIndex({ pullData, pushData, updateSyncChunkSize: configured });

      const result = await index.updateSync(updateItems(ITEM_COUNT));

      // An exact size, not `toBeGreaterThanOrEqual(1)`: that weaker form cannot tell the clamped
      // floor from the default from `Infinity`, all three of which satisfy it.
      expect(index.updateSyncChunkSize).toBe(expectedChunkSize);
      // The point common to every case is that this is not 0.
      expect(result.totalTasks).toBe(expectedBatchSizes.length);
      expect(result.failedTasks).toBe(0);
      expect(pushData).toHaveBeenCalledTimes(expectedBatchSizes.length);
      expect(pulledIdCounts(pullData)).toEqual(expectedBatchSizes);
    },
    30_000
  );

  it('rounds a fractional chunk size down to a whole number of ids', async () => {
    const pullData = vi.fn(async (_ctx, batch) => (batch.type === 'update' ? batch.ids : []));
    const index = buildIndex({ pullData, updateSyncChunkSize: 7.9 });

    expect(index.updateSyncChunkSize).toBe(7);

    const result = await index.updateSync(updateItems(ITEM_COUNT));
    // 60 / 7 => 8 full batches of 7 plus a final 4.
    expect(result.totalTasks).toBe(9);
    expect(pulledIdCounts(pullData).sort((a, b) => b - a)).toEqual([7, 7, 7, 7, 7, 7, 7, 7, 4]);
  });

  it('keeps the collections index well below the default', () => {
    // The batch that timed out in production was 300 ids; the default is 500.
    expect(collectionsSearchIndex.updateSyncChunkSize).toBeLessThan(DEFAULT_UPDATE_SYNC_CHUNK_SIZE);
    expect(collectionsSearchIndex.updateSyncChunkSize).toBe(25);
  });
});
