import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

/** Runs `getCollectionIdsCoveredByModels`' real query against an in-process Postgres. */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { mockCollectionsQueueUpdate } = vi.hoisted(() => ({ mockCollectionsQueueUpdate: vi.fn() }));
vi.mock('~/server/search-index', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  collectionsSearchIndex: { queueUpdate: mockCollectionsQueueUpdate },
}));

const { getCollectionIdsCoveredByModels, queueModelCollectionsReindex } = await import(
  '~/server/services/collection-index-sync'
);

beforeAll(async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int NOT NULL);
    CREATE TABLE "Post" (id int PRIMARY KEY, "modelVersionId" int);
    CREATE TABLE "Image" (id int PRIMARY KEY, "postId" int);
    CREATE TABLE "Collection" (id int PRIMARY KEY, "imageId" int);
    CREATE TABLE "CollectionItem" (
      id serial PRIMARY KEY, "collectionId" int NOT NULL, "modelId" int, "postId" int, "imageId" int
    );
    -- Model 1 has version 10, post 100 and image 1000; model 2 has version 20, post 200, image 2000.
    INSERT INTO "ModelVersion" VALUES (10, 1), (20, 2);
    INSERT INTO "Post" VALUES (100, 10), (200, 20), (300, NULL);
    INSERT INTO "Image" VALUES (1000, 100), (2000, 200), (3000, 300);
    -- Collections 1-4 reach model 1 by a model, post, image item and a stored cover; 5-6 do not.
    INSERT INTO "Collection" VALUES (4, 1000), (6, 3000);
    INSERT INTO "CollectionItem" ("collectionId", "modelId", "postId", "imageId") VALUES
      (1, 1, NULL, NULL), (2, NULL, 100, NULL), (3, NULL, NULL, 1000),
      (5, 2, NULL, NULL), (5, NULL, 200, 2000), (6, NULL, 300, 3000);
  `);
  (dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    pgliteRaw(db).queryRaw
  );
});

describe('getCollectionIdsCoveredByModels', () => {
  it("finds every collection whose cover may come from the model's posts, and no other", async () => {
    expect((await getCollectionIdsCoveredByModels([1])).sort()).toEqual([1, 2, 3, 4]);
  });

  it('asks nothing for no models', async () => {
    (dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockClear();
    expect(await getCollectionIdsCoveredByModels([])).toEqual([]);
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('queueModelCollectionsReindex', () => {
  it("queues the model's collections for a rebuild", async () => {
    mockCollectionsQueueUpdate.mockResolvedValueOnce(undefined);
    await queueModelCollectionsReindex([1]);
    expect(mockCollectionsQueueUpdate).toHaveBeenCalledTimes(1);
    const queued = mockCollectionsQueueUpdate.mock.calls[0][0] as { id: number }[];
    expect(queued.map((item) => item.id).sort()).toEqual([1, 2, 3, 4]);
  });

  it('resolves when the queue cannot be written, so a settings save never fails on it', async () => {
    mockCollectionsQueueUpdate.mockRejectedValueOnce(new Error('queue down'));
    await expect(queueModelCollectionsReindex([1])).resolves.toBeUndefined();
  });
});
