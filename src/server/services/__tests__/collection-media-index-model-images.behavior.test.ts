import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

/**
 * A change of a model's mode rebuilds every collection whose document shows the model's images:
 * by a model item, a post item or image item on any of its versions' posts, or a cover.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/server/search-index/collections.search-index', () => ({
  collectionsSearchIndex: { queueUpdate: vi.fn() },
}));

const db = new PGlite();
const runOnPglite = ((strings: TemplateStringsArray, ...values: unknown[]) => {
  const sql = Prisma.sql(strings, ...(values as never[]));
  return db.query(sql.text, sql.values as unknown[]).then((r) => r.rows);
}) as never;
dbMock.dbWrite.$queryRaw.mockImplementation(runOnPglite);
dbMock.dbRead.$queryRaw.mockImplementation(runOnPglite);

const { getCollectionIdsForModelImages } = await import('~/server/services/collection-media-index');

const MODEL = 10;
const OTHER_MODEL = 11;
const OWNER = 1;
const STRANGER = 2;

const BY_MODEL_ITEM = 100;
const BY_OWNER_POST_ITEM = 101;
const BY_STRANGER_POST_ITEM = 102;
const BY_IMAGE_ITEM = 103;
const BY_COVER = 104;
const UNRELATED = 105;

beforeAll(async () => {
  await db.exec(`
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int NOT NULL);
    CREATE TABLE "Post" (id int PRIMARY KEY, "userId" int NOT NULL, "modelVersionId" int);
    CREATE TABLE "Image" (id int PRIMARY KEY, "postId" int);
    CREATE TABLE "Collection" (id int PRIMARY KEY, "imageId" int);
    CREATE INDEX "Collection_imageId_idx" ON "Collection" ("imageId");
    CREATE TABLE "CollectionItem" (
      id serial PRIMARY KEY, "collectionId" int NOT NULL,
      "modelId" int, "postId" int, "imageId" int
    );

    INSERT INTO "ModelVersion" (id, "modelId") VALUES (20, ${MODEL}), (21, ${OTHER_MODEL});
    INSERT INTO "Post" (id, "userId", "modelVersionId") VALUES
      (30, ${OWNER}, 20), (31, ${STRANGER}, 20), (32, ${OWNER}, 21);
    INSERT INTO "Image" (id, "postId") VALUES (40, 30), (41, 31), (42, 32);
    INSERT INTO "Collection" (id, "imageId") VALUES
      (${BY_MODEL_ITEM}, NULL), (${BY_OWNER_POST_ITEM}, NULL), (${BY_STRANGER_POST_ITEM}, NULL),
      (${BY_IMAGE_ITEM}, NULL), (${BY_COVER}, 41), (${UNRELATED}, 42);
    INSERT INTO "CollectionItem" ("collectionId", "modelId", "postId", "imageId") VALUES
      (${BY_MODEL_ITEM}, ${MODEL}, NULL, NULL),
      (${BY_OWNER_POST_ITEM}, NULL, 30, NULL),
      (${BY_STRANGER_POST_ITEM}, NULL, 31, NULL),
      (${BY_IMAGE_ITEM}, NULL, NULL, 41),
      (${UNRELATED}, ${OTHER_MODEL}, 32, 42);
  `);
});

describe('getCollectionIdsForModelImages', () => {
  it("finds each collection showing the model's images, and no other", async () => {
    const { collectionIds, truncated } = await getCollectionIdsForModelImages({ modelId: MODEL });
    expect([...collectionIds].sort((a, b) => a - b)).toEqual([
      BY_MODEL_ITEM,
      BY_OWNER_POST_ITEM,
      BY_STRANGER_POST_ITEM,
      BY_IMAGE_ITEM,
      BY_COVER,
    ]);
    expect(truncated).toBe(false);
  });

  it('still finds the item collections when the cover index is not usable', async () => {
    await db.exec(`DROP INDEX "Collection_imageId_idx"`);
    try {
      const { collectionIds } = await getCollectionIdsForModelImages({ modelId: MODEL });
      expect([...collectionIds].sort((a, b) => a - b)).toEqual([
        BY_MODEL_ITEM,
        BY_OWNER_POST_ITEM,
        BY_STRANGER_POST_ITEM,
        BY_IMAGE_ITEM,
      ]);
      // Said, not silent: those covers stay stale until a full reindex.
      expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'collection-media-index-cover-leg-skipped' })
      );
    } finally {
      await db.exec(`CREATE INDEX "Collection_imageId_idx" ON "Collection" ("imageId")`);
    }
  });

  it('resolves nothing and says it failed, rather than throwing, when the lookup fails', async () => {
    dbMock.dbWrite.$queryRaw.mockRejectedValueOnce(new Error('probe down'));
    dbMock.dbRead.$queryRaw.mockRejectedValueOnce(new Error('connection lost'));
    expect(await getCollectionIdsForModelImages({ modelId: MODEL })).toEqual({
      collectionIds: [],
      truncated: false,
      failed: true,
    });
  });

  it('skips the cover leg when the caller has found it unusable, without checking again', async () => {
    dbMock.dbWrite.$queryRaw.mockClear();
    const { collectionIds } = await getCollectionIdsForModelImages({
      modelId: MODEL,
      withCover: false,
    });
    expect(collectionIds).not.toContain(BY_COVER);
    const probes = dbMock.dbWrite.$queryRaw.mock.calls.filter((call) =>
      (call[0] as string[]).join('?').includes('pg_class')
    );
    expect(probes).toHaveLength(0);
  });

  it('is not cut short at exactly the cap', async () => {
    const { collectionIds, truncated } = await getCollectionIdsForModelImages({
      modelId: MODEL,
      cap: 5,
    });
    expect(collectionIds).toHaveLength(5);
    expect(truncated).toBe(false);
  });

  it('says when the cap cut the list short', async () => {
    const { collectionIds, truncated } = await getCollectionIdsForModelImages({
      modelId: MODEL,
      cap: 2,
    });
    expect(collectionIds).toHaveLength(2);
    expect(truncated).toBe(true);
  });
});
