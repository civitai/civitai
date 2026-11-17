import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * A banner-only article shows its banner as the cover of every collection holding it, so a change
 * to that banner image (removed, rescanned, flagged) must re-index those collections.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/server/search-index', () => ({
  collectionsSearchIndex: { queueUpdate: vi.fn() },
}));
vi.mock('~/server/search-index/collections.search-index', () => ({
  collectionsSearchIndex: { queueUpdate: vi.fn() },
}));

const { getCollectionIdsForImages } = await import('~/server/services/collection-media-index');

let pg: PGlite;
dbMock.dbWrite.$queryRaw.mockImplementation(((
  strings: TemplateStringsArray,
  ...values: unknown[]
) => {
  const q = Prisma.sql(strings, ...(values as never[]));
  return pg.query(q.text, q.values as unknown[]).then((r) => r.rows);
}) as never);

const COVER = 300;
const BANNER = 301;
const UNRELATED = 302;
const HOLDS_BANNER_ONLY = 70;
const HOLDS_COVERED = 71;
const HOLDS_OTHER = 72;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY, "profilePictureId" int);
    CREATE TABLE "Collection" (id int PRIMARY KEY, "userId" int, "imageId" int);
    CREATE INDEX "Collection_imageId_idx" ON "Collection" ("imageId");
    CREATE TABLE "CollectionItem" (
      id int PRIMARY KEY, "collectionId" int, "imageId" int, "postId" int, "modelId" int,
      "articleId" int, "model3dId" int
    );
    CREATE TABLE "Image" (id int PRIMARY KEY, "postId" int);
    CREATE TABLE "Post" (id int PRIMARY KEY, "userId" int, "modelVersionId" int);
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int);
    CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int);
    CREATE TABLE "Model3D" (id int PRIMARY KEY, "thumbnailImageId" int);
    CREATE TABLE "Article" (id int PRIMARY KEY, "coverId" int, "bannerId" int);
    INSERT INTO "User" (id) VALUES (1);
    INSERT INTO "Image" (id) VALUES (${COVER}), (${BANNER}), (${UNRELATED});
    INSERT INTO "Article" (id, "coverId", "bannerId") VALUES
      (80, NULL, ${BANNER}),
      (81, ${COVER}, NULL),
      (82, NULL, NULL);
    INSERT INTO "Collection" (id, "userId") VALUES
      (${HOLDS_BANNER_ONLY}, 1), (${HOLDS_COVERED}, 1), (${HOLDS_OTHER}, 1);
    INSERT INTO "CollectionItem" (id, "collectionId", "articleId") VALUES
      (1, ${HOLDS_BANNER_ONLY}, 80),
      (2, ${HOLDS_COVERED}, 81),
      (3, ${HOLDS_OTHER}, 82);
  `);
});
afterAll(() => pg.close());

describe('getCollectionIdsForImages on an article banner', () => {
  it('re-indexes the collections holding an article whose banner changed', async () => {
    const { collectionIds } = await getCollectionIdsForImages({ imageIds: [BANNER] });
    expect(collectionIds).toEqual([HOLDS_BANNER_ONLY]);
  });

  it("still re-indexes by an article's cover (control)", async () => {
    const { collectionIds } = await getCollectionIdsForImages({ imageIds: [COVER] });
    expect(collectionIds).toEqual([HOLDS_COVERED]);
  });

  it('re-indexes nothing for an image no article shows', async () => {
    const { collectionIds } = await getCollectionIdsForImages({ imageIds: [UNRELATED] });
    expect(collectionIds).toEqual([]);
  });
});
