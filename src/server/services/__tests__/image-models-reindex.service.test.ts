import { beforeEach, describe, expect, it, vi } from 'vitest';
import { childBrowsingTagIds } from '@civitai/shared';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { tagIdsForImagesCache } from '~/server/redis/caches';
import { modelsSearchIndex } from '~/server/search-index/models.search-index';
import { imagesForModelVersionsCache } from '~/server/services/image.service';
import { queueModelsForImageChildTagChanges } from '~/server/services/image-models-reindex.service';

// The real index module builds a Meilisearch processor at load; only its queue is under test.
vi.mock('~/server/search-index/models.search-index', () => ({
  modelsSearchIndex: { queueUpdate: vi.fn(async () => undefined) },
}));
// Hand-listed: the real image.service pulls in most of the server; only this cache is touched.
vi.mock('~/server/services/image.service', () => ({
  imagesForModelVersionsCache: { refresh: vi.fn(async () => undefined) },
}));

const CHILD_TAG = childBrowsingTagIds[0];
const OTHER_TAG = -1;

type SqlArg = { strings?: string[]; sql?: string; values: unknown[] };
const sqlText = (sql: SqlArg) => sql.sql ?? sql.strings?.join('?') ?? '';
const queries = () => dbMock.dbWrite.$queryRaw.mock.calls.map(([sql]) => sql as unknown as SqlArg);
const query = (table: string) => queries().find((q) => sqlText(q).includes(table));

/** Answers the child-tag check and the image -> model lookup, both on the primary. */
function arm({ models = [] as number[], childTagged = [] as number[] } = {}) {
  dbMock.dbWrite.$queryRaw.mockImplementation((async (sql: SqlArg) =>
    sqlText(sql).includes('"TagsOnImageNew"')
      ? childTagged.map((imageId) => ({ imageId }))
      : models.map((modelId) => ({ modelId, modelVersionId: modelId * 10 }))) as never);
}

const tagRefresh = vi.spyOn(tagIdsForImagesCache, 'refresh');
const queued = () =>
  vi.mocked(modelsSearchIndex.queueUpdate).mock.calls.flatMap(([items]) => items.map((x) => x.id));

beforeEach(() => {
  vi.clearAllMocks();
  tagRefresh.mockReset().mockResolvedValue(undefined as never);
  arm();
});

describe('queueModelsForImageChildTagChanges', () => {
  it('queues the models of an image whose child tag was written, after re-reading its caches', async () => {
    arm({ models: [500, 501] });

    await queueModelsForImageChildTagChanges({ tagWrites: [{ imageId: 7, tagId: CHILD_TAG }] });

    expect(queued()).toEqual([500, 501]);
    expect(query('"ModelVersion"')?.values[0]).toEqual([7]);
    expect(tagRefresh).toHaveBeenCalledWith([7]);
    expect(imagesForModelVersionsCache.refresh).toHaveBeenCalledWith([5000, 5010]);
  });

  it('queues nothing, and reads nothing, for a write of other tags only', async () => {
    arm({ models: [500] });

    await queueModelsForImageChildTagChanges({ tagWrites: [{ imageId: 7, tagId: OTHER_TAG }] });

    expect(modelsSearchIndex.queueUpdate).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  it('queues the models of a re-rated image only while it carries a child tag', async () => {
    arm({ models: [600], childTagged: [8] });

    await queueModelsForImageChildTagChanges({ levelImageIds: [8, 9] });

    expect(query('"TagsOnImageNew"')?.values[0]).toEqual([8, 9]);
    expect(query('"ModelVersion"')?.values[0]).toEqual([8]);
    expect(queued()).toEqual([600]);
    expect(imagesForModelVersionsCache.refresh).toHaveBeenCalledWith([6000]);
  });

  it('queues nothing for a re-rated image without a child tag', async () => {
    arm({ models: [600], childTagged: [] });

    await queueModelsForImageChildTagChanges({ levelImageIds: [9] });

    expect(modelsSearchIndex.queueUpdate).not.toHaveBeenCalled();
  });

  it('queues each model once, as an update, when several of its versions hold the images', async () => {
    dbMock.dbWrite.$queryRaw.mockImplementation((async (sql: SqlArg) =>
      sqlText(sql).includes('"TagsOnImageNew"')
        ? [{ imageId: 8 }]
        : [
            { modelId: 500, modelVersionId: 5000 },
            { modelId: 500, modelVersionId: 5001 },
          ]) as never);

    await queueModelsForImageChildTagChanges({ levelImageIds: [8] });

    expect(query('"TagsOnImageNew"')?.values[1]).toEqual([...childBrowsingTagIds]);
    expect(modelsSearchIndex.queueUpdate).toHaveBeenCalledWith([
      { id: 500, action: SearchIndexUpdateQueueAction.Update },
    ]);
    expect(imagesForModelVersionsCache.refresh).toHaveBeenCalledWith([5000, 5001]);
  });

  it('queues nothing for an image on no model', async () => {
    arm({ models: [] });

    await queueModelsForImageChildTagChanges({ tagWrites: [{ imageId: 7, tagId: CHILD_TAG }] });

    expect(modelsSearchIndex.queueUpdate).not.toHaveBeenCalled();
  });

  it('does not throw when the queue fails, so the committed write is not reported as failed', async () => {
    arm({ models: [500] });
    vi.mocked(modelsSearchIndex.queueUpdate).mockRejectedValueOnce(new Error('redis down'));

    await expect(
      queueModelsForImageChildTagChanges({ tagWrites: [{ imageId: 7, tagId: CHILD_TAG }] })
    ).resolves.toBeUndefined();
  });
});
