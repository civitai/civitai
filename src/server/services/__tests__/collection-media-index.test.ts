import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit coverage for the collections-reindex enqueue used by every model/image
 * removal path.
 *
 * The defect it exists for: `prepareBatches` in collections.search-index.ts filters on
 * `c."createdAt" >= lastUpdatedAt`, so the incremental sweep only revisits NEWLY
 * CREATED collections. An existing collection is rebuilt only via an explicit enqueue,
 * and no removal path issued one — so a collection kept serving the thumbnail of a
 * model or image that had been deleted.
 *
 * Fixture discipline: every collection id here is distinct from every other, from the
 * model/image ids that resolve it, and from the cap and batch-size constants the
 * assertions name. A mutant that hardcodes any literal in the module cannot survive.
 */

const { mockCollectionsQueueUpdate } = vi.hoisted(() => ({
  mockCollectionsQueueUpdate: vi.fn(),
}));

vi.mock('~/server/search-index', () => ({
  collectionsSearchIndex: { queueUpdate: mockCollectionsQueueUpdate },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
  imagesSearchIndex: { queueUpdate: vi.fn() },
  modelsSearchIndex: { queueUpdate: vi.fn() },
}));

import {
  enqueueCollectionRebuild,
  getCollectionIdsForMedia,
  getCollectionIdsForModelCascade,
  queueCollectionsForMedia,
} from '~/server/services/collection-media-index';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const MODEL_ID = 4212;
const IMAGE_ID = 6631;
const COLLECTION_A = 8801;
const COLLECTION_B = 9107;
const COLLECTION_C = 7743;

const rows = (...ids: number[]) => ids.map((collectionId) => ({ collectionId }));

// The template-tag call arrives as [strings, ...values]; join to recover the SQL text.
const sqlOf = (call: unknown[]) => (call[0] as string[]).join('?');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getCollectionIdsForMedia', () => {
  it('resolves collections by modelId and enqueues nothing on its own', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce(rows(COLLECTION_A, COLLECTION_B));

    const result = await getCollectionIdsForMedia({ modelIds: [MODEL_ID] });

    expect(result).toEqual({ collectionIds: [COLLECTION_A, COLLECTION_B], dropped: 0 });
    expect(sqlOf(dbMock.dbWrite.$queryRaw.mock.calls[0])).toContain('"CollectionItem"');
    expect(sqlOf(dbMock.dbWrite.$queryRaw.mock.calls[0])).toContain('"modelId"');
    expect(mockCollectionsQueueUpdate).not.toHaveBeenCalled();
  });

  it('resolves collections by imageId', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce(rows(COLLECTION_C));

    const result = await getCollectionIdsForMedia({ imageIds: [IMAGE_ID] });

    expect(result.collectionIds).toEqual([COLLECTION_C]);
    expect(sqlOf(dbMock.dbWrite.$queryRaw.mock.calls[0])).toContain('"imageId"');
  });

  it('dedupes a collection that holds both a removed model and a removed image', async () => {
    dbMock.dbWrite.$queryRaw
      .mockResolvedValueOnce(rows(COLLECTION_A, COLLECTION_B))
      .mockResolvedValueOnce(rows(COLLECTION_B, COLLECTION_C));

    const result = await getCollectionIdsForMedia({
      modelIds: [MODEL_ID],
      imageIds: [IMAGE_ID],
    });

    expect(result.collectionIds).toEqual([COLLECTION_A, COLLECTION_B, COLLECTION_C]);
  });

  it('does not query at all when given no ids', async () => {
    const result = await getCollectionIdsForMedia({ modelIds: [], imageIds: [] });

    expect(result).toEqual({ collectionIds: [], dropped: 0 });
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  it('reports how many collections it dropped when the cap is exceeded', async () => {
    // Cap of 3 against 5 distinct collections: two are dropped. The ids are chosen so
    // no assertion below can be satisfied by a coincidence of ordering.
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce(
      rows(COLLECTION_A, COLLECTION_B, COLLECTION_C, 5519, 6284)
    );

    const result = await getCollectionIdsForMedia({ modelIds: [MODEL_ID], cap: 3 });

    expect(result.collectionIds).toEqual([COLLECTION_A, COLLECTION_B, COLLECTION_C]);
    expect(result.dropped).toBe(2);
  });

  it('never throws when the lookup fails, so a caller can resolve before its delete', async () => {
    dbMock.dbWrite.$queryRaw.mockRejectedValueOnce(new Error('connection reset'));

    const result = await getCollectionIdsForMedia({ modelIds: [MODEL_ID], source: 'image-delete' });

    expect(result).toEqual({ collectionIds: [], dropped: 0 });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'collection-media-index-resolve-failed', type: 'error' })
    );
  });
});

describe('getCollectionIdsForModelCascade', () => {
  it('resolves the model and its cascading gallery images in one statement', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce(rows(COLLECTION_B, COLLECTION_A));

    const result = await getCollectionIdsForModelCascade({ modelId: MODEL_ID });

    expect(result.collectionIds).toEqual([COLLECTION_B, COLLECTION_A]);
    const sql = sqlOf(dbMock.dbWrite.$queryRaw.mock.calls[0]);
    // Both arms matter: the model's own membership AND the images the cascade reaps.
    expect(sql).toContain('ci."modelId"');
    expect(sql).toContain('ci."imageId"');
    expect(sql).toContain('"ModelVersion"');
  });

  it('never throws, so a failed lookup cannot cancel the delete that follows', async () => {
    dbMock.dbWrite.$queryRaw.mockRejectedValueOnce(new Error('deadlock detected'));

    await expect(getCollectionIdsForModelCascade({ modelId: MODEL_ID })).resolves.toEqual({
      collectionIds: [],
      dropped: 0,
    });
  });
});

describe('enqueueCollectionRebuild', () => {
  it('queues an Update — never a Delete — for each collection', async () => {
    await enqueueCollectionRebuild({
      collectionIds: [COLLECTION_A, COLLECTION_C],
      dropped: 0,
      source: 'model-delete',
    });

    expect(mockCollectionsQueueUpdate).toHaveBeenCalledTimes(1);
    expect(mockCollectionsQueueUpdate).toHaveBeenCalledWith([
      { id: COLLECTION_A, action: SearchIndexUpdateQueueAction.Update },
      { id: COLLECTION_C, action: SearchIndexUpdateQueueAction.Update },
    ]);
  });

  it('does not touch the index when there is nothing to rebuild', async () => {
    const result = await enqueueCollectionRebuild({
      collectionIds: [],
      dropped: 0,
      source: 'model-delete',
    });

    expect(mockCollectionsQueueUpdate).not.toHaveBeenCalled();
    expect(result.queued).toBe(0);
  });

  it('batches so one enormous id list never becomes one enormous queue write', async () => {
    // 1200 distinct ids against a 500 batch size => 500 / 500 / 200. Ids start well
    // above every named constant so a batch boundary cannot coincide with an id.
    const ids = Array.from({ length: 1200 }, (_, i) => 20_000 + i);

    await enqueueCollectionRebuild({ collectionIds: ids, dropped: 0, source: 'model-delete' });

    expect(mockCollectionsQueueUpdate).toHaveBeenCalledTimes(3);
    const sizes = mockCollectionsQueueUpdate.mock.calls.map((c) => (c[0] as unknown[]).length);
    expect(sizes).toEqual([500, 500, 200]);
    // Every id is queued exactly once, and every one as an Update.
    const queued = mockCollectionsQueueUpdate.mock.calls.flatMap(
      (c) => c[0] as { id: number; action: string }[]
    );
    expect(queued).toHaveLength(1200);
    expect(new Set(queued.map((q) => q.id)).size).toBe(1200);
    expect(queued.every((q) => q.action === SearchIndexUpdateQueueAction.Update)).toBe(true);
  });

  it('logs what it dropped rather than truncating silently', async () => {
    await enqueueCollectionRebuild({
      collectionIds: [COLLECTION_A],
      dropped: 17,
      source: 'model-perma-delete',
      cap: 3,
    });

    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'collection-media-index-enqueue-truncated',
        type: 'warning',
        source: 'model-perma-delete',
        dropped: 17,
        cap: 3,
      })
    );
  });

  it('never throws when the queue write fails, so post-delete cleanup still runs', async () => {
    mockCollectionsQueueUpdate.mockRejectedValueOnce(new Error('redis unavailable'));

    const result = await enqueueCollectionRebuild({
      collectionIds: [COLLECTION_B],
      dropped: 0,
      source: 'image-delete',
    });

    expect(result.queued).toBe(0);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'collection-media-index-enqueue-failed', type: 'error' })
    );
  });
});

describe('queueCollectionsForMedia', () => {
  it('resolves then enqueues an Update for each resolved collection', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce(rows(COLLECTION_C, COLLECTION_A));

    await queueCollectionsForMedia({ modelIds: [MODEL_ID], source: 'model-delete' });

    expect(mockCollectionsQueueUpdate).toHaveBeenCalledWith([
      { id: COLLECTION_C, action: SearchIndexUpdateQueueAction.Update },
      { id: COLLECTION_A, action: SearchIndexUpdateQueueAction.Update },
    ]);
  });

  it('enqueues nothing when the model was in no collection', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([]);

    await queueCollectionsForMedia({ modelIds: [MODEL_ID], source: 'model-delete' });

    expect(mockCollectionsQueueUpdate).not.toHaveBeenCalled();
  });
});
