import { beforeEach, describe, expect, it, vi } from 'vitest';
import { childBrowsingTagIds } from '@civitai/shared';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { modelsSearchIndex } from '~/server/search-index/models.search-index';
import { imagesForModelVersionsCache } from '~/server/services/image.service';
import { queueModelsForImageChildTagChanges } from '~/server/services/image-models-reindex.service';

// The real index module builds a Meilisearch processor at load; only its queue is under test.
vi.mock('~/server/search-index/models.search-index', () => ({
  modelsSearchIndex: { queueUpdate: vi.fn(async () => undefined) },
}));
// Hand-listed: the real image.service pulls in most of the server; only this cache is touched.
vi.mock('~/server/services/image.service', () => ({
  imagesForModelVersionsCache: { bust: vi.fn(async () => undefined) },
}));

const CHILD_TAG = childBrowsingTagIds[0];
const OTHER_TAG = -1;

const sqlText = (call: unknown[]) => {
  const sql = call[0] as { strings?: string[]; sql?: string };
  return sql.sql ?? sql.strings?.join('?') ?? '';
};
const imageIdsIn = (call: unknown[]) => (call[0] as { values: unknown[] }).values[0];

/** dbRead answers the image -> model lookup; dbWrite answers which images carry a child tag. */
function arm({ models = [] as number[], childTagged = [] as number[] } = {}) {
  dbMock.dbRead.$queryRaw.mockResolvedValue(
    models.map((modelId) => ({ modelId, modelVersionId: modelId * 10 })) as never
  );
  dbMock.dbWrite.$queryRaw.mockResolvedValue(childTagged.map((imageId) => ({ imageId })) as never);
}

const queued = () =>
  vi.mocked(modelsSearchIndex.queueUpdate).mock.calls.flatMap(([items]) => items.map((x) => x.id));

beforeEach(() => {
  vi.clearAllMocks();
  arm();
});

describe('queueModelsForImageChildTagChanges', () => {
  it('queues the models of an image whose child tag was written', async () => {
    arm({ models: [500, 501] });

    await queueModelsForImageChildTagChanges({ tagWrites: [{ imageId: 7, tagId: CHILD_TAG }] });

    expect(queued()).toEqual([500, 501]);
    expect(imagesForModelVersionsCache.bust).toHaveBeenCalledWith([5000, 5010]);
    const [lookup] = dbMock.dbRead.$queryRaw.mock.calls;
    expect(sqlText(lookup)).toContain('"ModelVersion"');
    expect(imageIdsIn(lookup)).toEqual([7]);
  });

  it('queues nothing, and reads nothing, for a write of other tags only', async () => {
    arm({ models: [500] });

    await queueModelsForImageChildTagChanges({ tagWrites: [{ imageId: 7, tagId: OTHER_TAG }] });

    expect(modelsSearchIndex.queueUpdate).not.toHaveBeenCalled();
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
  });

  it('queues the models of a re-rated image only while it carries a child tag', async () => {
    arm({ models: [600], childTagged: [8] });

    await queueModelsForImageChildTagChanges({ levelImageIds: [8, 9] });

    const [childCheck] = dbMock.dbWrite.$queryRaw.mock.calls;
    expect(sqlText(childCheck)).toContain('"TagsOnImageNew"');
    expect(imageIdsIn(childCheck)).toEqual([8, 9]);
    expect(imageIdsIn(dbMock.dbRead.$queryRaw.mock.calls[0])).toEqual([8]);
    expect(queued()).toEqual([600]);
    expect(imagesForModelVersionsCache.bust).toHaveBeenCalledWith([6000]);
  });

  it('queues nothing for a re-rated image without a child tag', async () => {
    arm({ models: [600], childTagged: [] });

    await queueModelsForImageChildTagChanges({ levelImageIds: [9] });

    expect(modelsSearchIndex.queueUpdate).not.toHaveBeenCalled();
  });

  it('queues nothing for an image on no model', async () => {
    arm({ models: [] });

    await queueModelsForImageChildTagChanges({ tagWrites: [{ imageId: 7, tagId: CHILD_TAG }] });

    expect(modelsSearchIndex.queueUpdate).not.toHaveBeenCalled();
  });
});
