import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

/** Runs the model-to-collections lookups' real queries against an in-process Postgres. */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { mockEnqueue } = vi.hoisted(() => ({ mockEnqueue: vi.fn() }));
vi.mock('~/server/services/collection-media-index', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  enqueueCollectionRebuild: mockEnqueue,
}));

const { getCollectionIdsWithWithheldLegacyCover, queueModelCollectionsReindex } = await import(
  '~/server/services/collection-index-sync'
);

beforeAll(async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE "Model" (
      id int PRIMARY KEY, minor boolean NOT NULL DEFAULT false,
      "sfwOnly" boolean NOT NULL DEFAULT false, "gallerySettings" jsonb, mode text
    );
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int NOT NULL);
    CREATE TABLE "Post" (id int PRIMARY KEY, "modelVersionId" int);
    CREATE TABLE "Image" (
      id int PRIMARY KEY, minor boolean NOT NULL DEFAULT false, "postId" int, ingestion text NOT NULL DEFAULT 'Scanned',
      "needsReview" text, "blockedFor" text, "tosViolation" boolean NOT NULL DEFAULT false,
      "nsfwLevel" int NOT NULL DEFAULT 1, "modelRestricted" boolean NOT NULL DEFAULT false
    );
    CREATE TABLE "Article" (
      id int PRIMARY KEY, cover text, "coverId" int, "bannerId" int, "nsfwLevel" int NOT NULL DEFAULT 1
    );
    CREATE TABLE "Collection" (id int PRIMARY KEY, "imageId" int);
    CREATE INDEX "Collection_imageId_idx" ON "Collection" ("imageId");
    CREATE TABLE "CollectionItem" (
      id serial PRIMARY KEY, "collectionId" int NOT NULL, "modelId" int, "postId" int, "imageId" int, "articleId" int
    );
    -- Model 1 has version 10, post 100 and image 1000; model 2 has version 20, post 200, image 2000.
    INSERT INTO "ModelVersion" VALUES (10, 1), (20, 2);
    INSERT INTO "Post" VALUES (100, 10), (200, 20), (300, NULL);
    INSERT INTO "Image" (id, "postId") VALUES (1000, 100), (2000, 200), (3000, 300);
    -- Collections 1-4 reach model 1 by a model, post, image item and a stored cover; 5-6 do not.
    INSERT INTO "Collection" VALUES (4, 1000), (6, 3000);
    INSERT INTO "CollectionItem" ("collectionId", "modelId", "postId", "imageId") VALUES
      (1, 1, NULL, NULL), (2, NULL, 100, NULL), (3, NULL, NULL, 1000),
      (5, 2, NULL, NULL), (5, NULL, 200, 2000), (6, NULL, 300, 3000);
    -- Articles with a legacy cover string: 40 beside a servable PG cover, 41 beside a cover
    -- awaiting review, 42 beside an X cover, 43 with no image at R, 44 with no image at PG; 45 has
    -- no string. Collections 11-16 hold one each.
    INSERT INTO "Image" (id, "needsReview", "nsfwLevel") VALUES
      (4000, NULL, 1), (4100, 'minor', 1), (4200, NULL, 16);
    INSERT INTO "Article" (id, cover, "coverId", "nsfwLevel") VALUES
      (40, 'ok', 4000, 1), (41, 'pending', 4100, 1), (42, 'x', 4200, 1),
      (43, 'r', NULL, 4), (44, 'pg', NULL, 1), (45, NULL, 4100, 1);
    INSERT INTO "CollectionItem" ("collectionId", "articleId") VALUES
      (11, 40), (12, 41), (13, 42), (14, 43), (15, 44), (16, 45);
    -- Article 46's PG-13 cover is on minor model 3, whose gallery level is PG; collection 17
    -- holds it.
    INSERT INTO "Model" (id, minor, "gallerySettings") VALUES (1, false, NULL), (3, true, '{"level": 1}');
    INSERT INTO "ModelVersion" VALUES (30, 3);
    INSERT INTO "Post" VALUES (400, 30);
    INSERT INTO "Image" (id, "postId", "nsfwLevel") VALUES (4600, 400, 2);
    INSERT INTO "Article" (id, cover, "coverId", "nsfwLevel") VALUES (46, 'held', 4600, 2);
    INSERT INTO "CollectionItem" ("collectionId", "articleId") VALUES (17, 46);
    -- Collections 18 and 19 reach model 1 by an article item whose cover, or banner, is its image.
    INSERT INTO "Image" (id, "postId") VALUES (1001, 100);
    INSERT INTO "Article" (id, "coverId", "bannerId") VALUES (47, 1000, NULL), (48, NULL, 1001);
    INSERT INTO "CollectionItem" ("collectionId", "articleId") VALUES (18, 47), (19, 48);
  `);
  for (const client of [dbMock.dbRead, dbMock.dbWrite])
    (client.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      pgliteRaw(db).queryRaw
    );
});

describe('queueModelCollectionsReindex', () => {
  it("hands every one of the model's collections to the batched rebuild", async () => {
    mockEnqueue.mockResolvedValueOnce({ queued: 4, truncated: false });
    await queueModelCollectionsReindex([1]);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    const { collectionIds } = mockEnqueue.mock.calls[0][0] as { collectionIds: number[] };
    expect([...collectionIds].sort()).toEqual([1, 18, 19, 2, 3, 4]);
  });

  it('resolves when the collections cannot be read, so a settings save never fails on it', async () => {
    const raw = dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>;
    raw.mockRejectedValueOnce(new Error('replica down'));
    await expect(queueModelCollectionsReindex([1])).resolves.toBeUndefined();
  });
});

describe('getCollectionIdsWithWithheldLegacyCover', () => {
  it('finds the collections whose legacy cover string is now withheld, and not one still served', async () => {
    expect(await getCollectionIdsWithWithheldLegacyCover({ cursor: 0, limit: 100 })).toEqual([
      12, 13, 14, 17,
    ]);
  });

  it('pages by collection id', async () => {
    expect(await getCollectionIdsWithWithheldLegacyCover({ cursor: 0, limit: 2 })).toEqual([
      12, 13,
    ]);
    expect(await getCollectionIdsWithWithheldLegacyCover({ cursor: 13, limit: 2 })).toEqual([
      14, 17,
    ]);
  });
});
