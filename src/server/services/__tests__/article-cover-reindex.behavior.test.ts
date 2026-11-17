import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

/** Runs `getArticleIdsCoveredByModel`'s real query against an in-process Postgres. */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { getArticleIdsCoveredByModel } = await import('~/server/services/article-cover-reindex');

beforeAll(async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int NOT NULL);
    CREATE TABLE "Post" (id int PRIMARY KEY, "modelVersionId" int);
    CREATE TABLE "Image" (id int PRIMARY KEY, "postId" int);
    CREATE TABLE "Article" (id int PRIMARY KEY, "coverId" int, "bannerId" int);
    -- Model 1 has image 100 (post 10) and 101 (post 11); model 2 has image 200; 300 is postless.
    INSERT INTO "ModelVersion" VALUES (1, 1), (2, 1), (3, 2);
    INSERT INTO "Post" VALUES (10, 1), (11, 2), (20, 3);
    INSERT INTO "Image" VALUES (100, 10), (101, 11), (200, 20), (300, NULL);
    -- Article 1's cover and article 2's banner are model 1's; 3 is model 2's; 4 is postless.
    INSERT INTO "Article" VALUES (1, 100, NULL), (2, NULL, 101), (3, 200, NULL), (4, 300, 300);
  `);
  (dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    pgliteRaw(db).queryRaw
  );
});

describe('getArticleIdsCoveredByModel', () => {
  it("finds the articles whose cover or banner is on any of the model's versions, and no other", async () => {
    expect((await getArticleIdsCoveredByModel(1)).sort()).toEqual([1, 2]);
  });
});
