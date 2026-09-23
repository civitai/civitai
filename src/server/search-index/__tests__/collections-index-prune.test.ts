import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MeiliClient from '~/server/meilisearch/client';
import type * as MeiliUtil from '~/server/meilisearch/util';
import type * as RedisCaches from '~/server/redis/caches';

const updateDocs = vi.fn();
const onSearchIndexDocumentsCleanup = vi.fn();

vi.mock('~/server/meilisearch/client', async (importOriginal) => ({
  ...(await importOriginal<typeof MeiliClient>()),
  updateDocs: (...args: unknown[]) => updateDocs(...args),
}));

vi.mock('~/server/meilisearch/util', async (importOriginal) => ({
  ...(await importOriginal<typeof MeiliUtil>()),
  onSearchIndexDocumentsCleanup: (...args: unknown[]) => onSearchIndexDocumentsCleanup(...args),
}));

vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof RedisCaches>()),
  tagIdsForImagesCache: { fetch: async () => ({}) },
}));

const { pullData, transformData, pushData } = await import(
  '~/server/search-index/collections.search-index'
);

/** Partial on purpose: only the fields `transformData` reads have to be real. */
const collectionRow = (id: number) => ({
  id,
  name: `collection ${id}`,
  imageId: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  userId: 100,
  type: 'Model',
  read: 'Public',
  write: 'Private',
  mode: null,
  nsfwLevel: 1,
  metrics: null,
  image: null,
  user: { id: 100, username: 'someone', deletedAt: null, image: null, profilePictureId: null },
  cosmetics: null,
});

const run = async (
  batch: Parameters<typeof pullData>[1],
  rows: ReturnType<typeof collectionRow>[]
) => {
  const db = {
    // The second $queryRaw is the item-image lookup — the fixture carries no image, so it runs.
    $queryRaw: vi.fn().mockResolvedValueOnce(rows).mockResolvedValue([]),
    image: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const ctx = {
    db,
    indexName: 'collections_v3',
    logger: () => undefined,
  } as unknown as Parameters<typeof pullData>[0];

  const pulled = await pullData(ctx, batch);
  const transformed = await transformData(pulled);
  await pushData(ctx, transformed);

  return transformed;
};

beforeEach(() => {
  updateDocs.mockReset();
  onSearchIndexDocumentsCleanup.mockReset();
});

describe('collections search index :: documents whose collection no longer qualifies', () => {
  it('deletes the document of a requested collection that the index filter no longer matches', async () => {
    await run({ type: 'update', ids: [1, 2, 3] }, [collectionRow(1)]);

    expect(onSearchIndexDocumentsCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ indexName: 'collections_v3', ids: [2, 3] })
    );
  });

  it('deletes every requested id when the batch comes back empty', async () => {
    await run({ type: 'update', ids: [7, 8] }, []);

    expect(onSearchIndexDocumentsCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ ids: [7, 8] })
    );
  });

  it('deletes nothing when every requested collection still qualifies', async () => {
    await run({ type: 'update', ids: [1, 2] }, [collectionRow(1), collectionRow(2)]);

    expect(onSearchIndexDocumentsCleanup).not.toHaveBeenCalled();
  });

  it('deletes nothing on a range batch, where absence is the normal case', async () => {
    await run({ type: 'new', startId: 1, endId: 1000 }, [collectionRow(4)]);

    expect(onSearchIndexDocumentsCleanup).not.toHaveBeenCalled();
  });

  it('still upserts the collections it did pull', async () => {
    await run({ type: 'update', ids: [1, 2] }, [collectionRow(1)]);

    expect(updateDocs).toHaveBeenCalledWith(
      expect.objectContaining({
        indexName: 'collections_v3',
        documents: [expect.objectContaining({ id: 1 })],
      })
    );
  });
});
