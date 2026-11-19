import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { tagIdsForImagesCache } from '~/server/redis/caches';
import { articlesSearchIndex } from '~/server/search-index/articles.search-index';
import { comicsSearchIndex } from '~/server/search-index/comics.search-index';
import { bountiesSearchIndex } from '~/server/search-index/bounties.search-index';
import {
  enqueueCollectionRebuild,
  getCollectionIdsForImages,
} from '~/server/services/collection-media-index';
import { modelsSearchIndex } from '~/server/search-index/models.search-index';
import { imagesForModelVersionsCache } from '~/server/services/image.service';
import {
  queueArticlesAndComicsForImages,
  queueDocumentsForImageMinorChanges,
} from '~/server/services/image-models-reindex.service';

// The real index modules build a Meilisearch processor at load; only their queues are under test.
vi.mock('~/server/search-index/models.search-index', () => ({
  modelsSearchIndex: { queueUpdate: vi.fn(async () => undefined) },
}));
vi.mock('~/server/search-index/articles.search-index', () => ({
  articlesSearchIndex: { queueUpdate: vi.fn(async () => undefined) },
}));
vi.mock('~/server/search-index/comics.search-index', () => ({
  comicsSearchIndex: { queueUpdate: vi.fn(async () => undefined) },
}));
vi.mock('~/server/search-index/bounties.search-index', () => ({
  bountiesSearchIndex: { queueUpdate: vi.fn(async () => undefined) },
}));
// Its own suites cover the image -> collection resolve; here only what is handed on is under test.
vi.mock('~/server/services/collection-media-index', () => ({
  getCollectionIdsForImages: vi.fn(async () => ({ collectionIds: [], truncated: false })),
  enqueueCollectionRebuild: vi.fn(async () => ({ queued: 0, truncated: false })),
}));
// Hand-listed: the real image.service pulls in most of the server; only this cache is touched.
vi.mock('~/server/services/image.service', () => ({
  imagesForModelVersionsCache: { refresh: vi.fn(async () => undefined) },
}));

const sqlText = (strings: TemplateStringsArray) => strings.join('?');
const queries = () =>
  dbMock.dbWrite.$queryRaw.mock.calls.map(([strings, ...values]) => ({
    text: sqlText(strings as TemplateStringsArray),
    values,
  }));
const query = (table: string) => queries().find((q) => q.text.includes(table));

/** Answers the minor-flag check and the image -> model and -> article/comic lookups, on the primary. */
function arm({
  models = [] as number[],
  minorFlagged = [] as number[],
  articles = [] as number[],
  comics = [] as number[],
  bounties = [] as number[],
} = {}) {
  dbMock.dbWrite.$queryRaw.mockImplementation((async (sql: TemplateStringsArray) => {
    const text = sqlText(sql);
    if (text.includes('"ImageConnection"')) return bounties.map((id) => ({ id }));
    if (text.includes('"Article"'))
      return [
        ...articles.map((id) => ({ kind: 'article', id })),
        ...comics.map((id) => ({ kind: 'comic', id })),
      ];
    if (!text.includes('"Post"')) return minorFlagged.map((id) => ({ id }));
    return models.map((modelId) => ({ modelId, modelVersionId: modelId * 10 }));
  }) as never);
}

const tagRefresh = vi.spyOn(tagIdsForImagesCache, 'refresh');
const idsQueuedOn = (index: { queueUpdate: unknown }) =>
  vi
    .mocked(index.queueUpdate as typeof modelsSearchIndex.queueUpdate)
    .mock.calls.flatMap(([items]) => items.map((x) => x.id));
const queued = () => idsQueuedOn(modelsSearchIndex);

beforeEach(() => {
  vi.clearAllMocks();
  tagRefresh.mockReset().mockResolvedValue(undefined as never);
  arm();
});

describe('queueDocumentsForImageMinorChanges', () => {
  it('queues the models of an image whose minor flag was written, after re-reading its caches', async () => {
    arm({ models: [500, 501] });

    await queueDocumentsForImageMinorChanges({ minorImageIds: [7] });

    expect(queued()).toEqual([500, 501]);
    expect(query('"ModelVersion"')?.values[0]).toEqual([7]);
    expect(tagRefresh).toHaveBeenCalledWith([7]);
    expect(imagesForModelVersionsCache.refresh).toHaveBeenCalledWith([5000, 5010]);
  });

  it('queues nothing for a re-rated image without the minor flag', async () => {
    arm({ models: [600], minorFlagged: [] });

    await queueDocumentsForImageMinorChanges({ levelImageIds: [9] });

    expect(modelsSearchIndex.queueUpdate).not.toHaveBeenCalled();
  });

  // The minor rule reads the level, so a re-rate of a minor-flagged image counts.
  it('🔴 queues the models of a re-rated image only while it carries the minor flag', async () => {
    arm({ models: [600], minorFlagged: [8] });

    await queueDocumentsForImageMinorChanges({ levelImageIds: [8, 9] });

    expect(query(' minor')?.values[0]).toEqual([8, 9]);
    expect(query('"ModelVersion"')?.values[0]).toEqual([8]);
    expect(imagesForModelVersionsCache.refresh).toHaveBeenCalledWith([6000]);
    expect(queued()).toEqual([600]);
  });

  it('reads a large minor-flag write in batches', async () => {
    arm({ models: [700] });
    const ids = Array.from({ length: 2500 }, (_, i) => i + 1);

    await queueDocumentsForImageMinorChanges({ minorImageIds: ids });

    const batches = queries()
      .filter((q) => q.text.includes('"ModelVersion"'))
      .map((q) => (q.values[0] as number[]).length);
    expect(batches).toEqual([1000, 1000, 500]);
  });

  it('queues a model once for an image passed as both re-rated and minor-flagged', async () => {
    arm({ models: [700] });

    await queueDocumentsForImageMinorChanges({ levelImageIds: [9], minorImageIds: [9] });

    expect(query(' minor')).toBeUndefined();
    expect(modelsSearchIndex.queueUpdate).toHaveBeenCalledTimes(1);
    expect(queued()).toEqual([700]);
  });

  it('queues each model once, as an update, when several of its versions hold the images', async () => {
    dbMock.dbWrite.$queryRaw.mockImplementation((async (sql: TemplateStringsArray) =>
      sqlText(sql).includes('"Post"')
        ? [
            { modelId: 500, modelVersionId: 5000 },
            { modelId: 500, modelVersionId: 5001 },
          ]
        : []) as never);

    await queueDocumentsForImageMinorChanges({ minorImageIds: [8] });

    expect(modelsSearchIndex.queueUpdate).toHaveBeenCalledWith([
      { id: 500, action: SearchIndexUpdateQueueAction.Update },
    ]);
    expect(imagesForModelVersionsCache.refresh).toHaveBeenCalledWith([5000, 5001]);
  });

  it('queues nothing for an image on no model', async () => {
    arm({ models: [] });

    await queueDocumentsForImageMinorChanges({ minorImageIds: [7] });

    expect(modelsSearchIndex.queueUpdate).not.toHaveBeenCalled();
  });

  it('still queues the models when a cache refresh fails', async () => {
    arm({ models: [500] });
    tagRefresh.mockRejectedValueOnce(new Error('redis down'));

    await queueDocumentsForImageMinorChanges({ minorImageIds: [7] });

    expect(queued()).toEqual([500]);
    expect(imagesForModelVersionsCache.refresh).toHaveBeenCalledWith([5000]);
  });

  it('retries a failed lookup once, then queues', async () => {
    vi.useFakeTimers();
    arm({ models: [500] });
    dbMock.dbWrite.$queryRaw.mockRejectedValueOnce(new Error('connection reset'));

    const run = queueDocumentsForImageMinorChanges({ minorImageIds: [7] });
    await vi.runAllTimersAsync();
    await run;
    vi.useRealTimers();

    expect(queued()).toEqual([500]);
  });

  it('does not throw when every attempt fails, so the committed write is not reported as failed', async () => {
    vi.useFakeTimers();
    dbMock.dbWrite.$queryRaw.mockRejectedValue(new Error('connection reset'));

    const run = queueDocumentsForImageMinorChanges({ minorImageIds: [7] });
    await vi.runAllTimersAsync();
    vi.useRealTimers();

    await expect(run).resolves.toBeUndefined();
    expect(queries().filter((q) => q.text.includes('"ModelVersion"'))).toHaveLength(2);
    expect(modelsSearchIndex.queueUpdate).not.toHaveBeenCalled();
  });

  it('queues the articles using the image as cover or banner, and the comics using it as cover', async () => {
    arm({ models: [500], articles: [30, 31], comics: [40] });

    await queueDocumentsForImageMinorChanges({ minorImageIds: [7] });

    expect(query('"Article"')?.text).toMatch(/"coverId"[\s\S]*"bannerId"[\s\S]*"coverImageId"/);
    expect(idsQueuedOn(articlesSearchIndex)).toEqual([30, 31]);
    expect(idsQueuedOn(comicsSearchIndex)).toEqual([40]);
    expect(queued()).toEqual([500]);
  });

  // The reindex is how a minor flag reaches the articles index.
  it('queues the articles and comics of a minor-flagged image, once', async () => {
    arm({ models: [], articles: [30], comics: [40] });

    await queueDocumentsForImageMinorChanges({ minorImageIds: [7] });

    expect(articlesSearchIndex.queueUpdate).toHaveBeenCalledTimes(1);
    expect(idsQueuedOn(articlesSearchIndex)).toEqual([30]);
    expect(idsQueuedOn(comicsSearchIndex)).toEqual([40]);
  });

  it('queues the article or comic of an image on no model', async () => {
    arm({ models: [], articles: [30], comics: [40] });

    await queueDocumentsForImageMinorChanges({ minorImageIds: [7] });

    expect(modelsSearchIndex.queueUpdate).not.toHaveBeenCalled();
    expect(idsQueuedOn(articlesSearchIndex)).toEqual([30]);
    expect(idsQueuedOn(comicsSearchIndex)).toEqual([40]);
  });

  it('queues no article or comic for an image no article or comic uses', async () => {
    arm({ models: [500] });
    await queueDocumentsForImageMinorChanges({ minorImageIds: [7] });

    expect(articlesSearchIndex.queueUpdate).not.toHaveBeenCalled();
    expect(comicsSearchIndex.queueUpdate).not.toHaveBeenCalled();
  });
});

describe('queueArticlesAndComicsForImages', () => {
  it('queues the articles and comics using the images, with no minor-flag check', async () => {
    arm({ models: [500], articles: [30], comics: [40] });

    await queueArticlesAndComicsForImages([7, 7, 8]);

    expect(query(' minor')).toBeUndefined();
    expect(query('"Article"')?.values[0]).toEqual([7, 8]);
    expect(idsQueuedOn(articlesSearchIndex)).toEqual([30]);
    expect(idsQueuedOn(comicsSearchIndex)).toEqual([40]);
    expect(modelsSearchIndex.queueUpdate).not.toHaveBeenCalled();
  });

  it('reads nothing for no images', async () => {
    await queueArticlesAndComicsForImages([]);

    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  it('does not throw when every attempt fails', async () => {
    vi.useFakeTimers();
    dbMock.dbWrite.$queryRaw.mockRejectedValue(new Error('connection reset'));

    const run = queueArticlesAndComicsForImages([7]);
    await vi.runAllTimersAsync();
    vi.useRealTimers();

    await expect(run).resolves.toBeUndefined();
    expect(queries().filter((q) => q.text.includes('"Article"'))).toHaveLength(2);
  });
});

describe('queueDocumentsForImageMinorChanges: collections and bounties', () => {
  it('queues the collections and bounties showing an image whose minor flag was written', async () => {
    arm({ bounties: [70, 71] });
    vi.mocked(getCollectionIdsForImages).mockResolvedValueOnce({
      collectionIds: [30, 31],
      truncated: false,
    });

    await queueDocumentsForImageMinorChanges({ minorImageIds: [7] });

    expect(getCollectionIdsForImages).toHaveBeenCalledWith(
      expect.objectContaining({ imageIds: [7], throwOnError: true })
    );
    expect(enqueueCollectionRebuild).toHaveBeenCalledWith(
      expect.objectContaining({ collectionIds: [30, 31] })
    );
    expect(idsQueuedOn(bountiesSearchIndex)).toEqual([70, 71]);
    expect(query('"ImageConnection"')?.values[0]).toEqual([7]);
    expect(tagRefresh).toHaveBeenCalledWith([7]);
  });
});
