import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MeiliUtil from '~/server/meilisearch/util';

// Partial: only the cleanup helper would reach a real Meilisearch instance from `updateSync`.
vi.mock('~/server/meilisearch/util', async (importOriginal) => ({
  ...(await importOriginal<typeof MeiliUtil>()),
  onSearchIndexDocumentsCleanup: vi.fn(),
}));

const { createSearchIndexUpdateProcessor } = await import(
  '~/server/search-index/base.search-index'
);

type Processor = Parameters<typeof createSearchIndexUpdateProcessor>[0];

const buildIndex = (overrides: Partial<Processor> = {}) =>
  createSearchIndexUpdateProcessor({
    indexName: 'test_index',
    setup: async () => undefined,
    prepareBatches: async () => ({ batchSize: 100, startId: 0, endId: 0 }),
    pullData: async (_ctx, batch) => (batch.type === 'update' ? batch.ids : []),
    // Documents, not bare ids: the base processor reads ids off the documents a transform
    // produces, which is the whole point of the accounting.
    transformData: async (ids: number[]) => ids.map((id) => ({ id })),
    pushData: async () => undefined,
    updateSyncChunkSize: 300,
    ...overrides,
  });

const updateItems = (count: number) => Array.from({ length: count }, (_, i) => ({ id: i + 1 }));

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('updateSync :: drop reporting', () => {
  it('reports the ids a transform dropped, which no failure counter can see', async () => {
    // 7 requested, 2 dropped: a number that is not the item count, not the batch count (1), and
    // not the number of documents written (5). Every "close enough" derivation lands elsewhere.
    const DROPPED = [3, 6];
    const pushData = vi.fn();
    const index = buildIndex({
      transformData: async (ids: number[]) =>
        ids.filter((id) => !DROPPED.includes(id)).map((id) => ({ id })),
      pushData,
    });

    const result = await index.updateSync(updateItems(7));

    expect(result.droppedIds).toBe(2);
    expect(result.droppedIdSample).toEqual(DROPPED);
    // The run is a SUCCESS by every pre-existing measure — that is the failure mode this
    // reporting exists to end, so pin it rather than leaving it implied.
    expect(result.failedTasks).toBe(0);
    expect(result.failedIds).toBe(0);
    expect(pushData).toHaveBeenCalledTimes(1);
    expect(pushData.mock.calls[0][1]).toEqual([1, 2, 4, 5, 7].map((id) => ({ id })));
  }, 30_000);

  it('reports every id when the transform produces no documents at all', async () => {
    // The shape of 868m6jk7w: `pullData` returns the rows, the transform drops all of them, and
    // `pushData` is handed an empty batch it then skips entirely.
    const pushData = vi.fn();
    const index = buildIndex({ transformData: async () => [], pushData });

    const result = await index.updateSync(updateItems(4));

    expect(result.droppedIds).toBe(4);
    expect(result.droppedIdSample).toEqual([1, 2, 3, 4]);
    expect(result.failedIds).toBe(0);
  }, 30_000);

  it('reads documents out of an object of arrays, as the models index returns them', async () => {
    // models.search-index returns { indexReadyRecords, indexRecordsWithImages } and drops a model
    // with no eligible version from BOTH. Pinned with the real shape so a change to that return
    // value cannot quietly stop being readable here.
    const index = buildIndex({
      transformData: async (ids: number[]) => {
        const kept = ids.filter((id) => id !== 2869929);
        return {
          indexReadyRecords: kept.map((id) => ({ id, name: `model ${id}` })),
          indexRecordsWithImages: kept.map((id) => ({ id, images: [] })),
        };
      },
    });

    const result = await index.updateSync([{ id: 2810329 }, { id: 2869929 }]);

    expect(result.droppedIds).toBe(1);
    expect(result.droppedIdSample).toEqual([2869929]);
  }, 30_000);

  it('does not report an id the processor handled without writing a document', async () => {
    // The collections shape: a disqualified id is DELETED by pushData, so it is accounted for
    // even though no document carries it. Without `getHandledIds` every prune would be reported
    // as a silent drop, and a report that cries wolf is worth nothing.
    const index = buildIndex({
      transformData: async (ids: number[]) => ({
        records: ids.filter((id) => id !== 2).map((id) => ({ id })),
        disqualifiedIds: ids.filter((id) => id === 2),
      }),
      getHandledIds: ({ records, disqualifiedIds }: any) => [
        ...records.map((r: any) => r.id),
        ...disqualifiedIds,
      ],
    });

    const result = await index.updateSync(updateItems(3));

    expect(result.droppedIds).toBe(0);
    expect(result.droppedIdSample).toEqual([]);
  }, 30_000);

  // DECISION, pinned deliberately — do not "fix" this into reporting 3 dropped ids.
  // A transform whose output holds no documents at all (here: bare numbers) is a shape the base
  // processor cannot read. Reporting every requested id as dropped would be a false alarm on every
  // batch such a processor ever runs, and an alarm nobody believes is worse than no alarm. The
  // blind spot is deliberate and bounded: a processor in that position opts in with `getHandledIds`.
  it('reports nothing, rather than everything, when the transformed shape holds no documents', async () => {
    const index = buildIndex({ transformData: async (ids: number[]) => ids });

    const result = await index.updateSync(updateItems(3));

    expect(result.droppedIds).toBe(0);
  }, 30_000);

  it('does not attribute a drop to a batch that failed outright', async () => {
    // A push that permanently fails wrote nothing either, but those ids belong to `failedIds`.
    // Counting them in both would double-report the same ids under two different names.
    const index = buildIndex({
      transformData: async (ids: number[]) => ids.filter((id) => id !== 1).map((id) => ({ id })),
      pushData: async () => {
        throw new Error('meilisearch rejected the batch');
      },
    });

    const result = await index.updateSync(updateItems(3));

    expect(result.failedIds).toBe(3);
    expect(result.droppedIds).toBe(0);
  }, 30_000);
});
