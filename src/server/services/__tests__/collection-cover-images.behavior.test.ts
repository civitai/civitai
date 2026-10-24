import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as RedisCaches from '~/server/redis/caches';

// Booting PGlite (WASM Postgres) can exceed the default 10s hook timeout on a
// contended runner.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof RedisCaches>()),
  tagIdsForImagesCache: { fetch: vi.fn().mockResolvedValue({}) },
}));

const holder = { db: null as unknown as PGlite };

// Flatten through `Prisma.sql` so the nested `imageSql` fragment lands as SQL, not as a bind.
dbMock.dbRead.$queryRaw.mockImplementation(
  (strings: TemplateStringsArray, ...values: unknown[]) => {
    const flat = Prisma.sql(strings, ...(values as never[]));
    return holder.db.query(flat.text, flat.values as unknown[]).then((r) => r.rows);
  }
);

const { getCollectionCoverImages } = await import('~/server/services/collection.service');

const IMAGE_ITEM = 8001;
const ARTICLE_COVER = 8002;
const ARTICLE_UNSCANNED = 8003;
const ARTICLE_NEEDS_REVIEW = 8004;
const ARTICLE_LEGACY_ONLY = 8005;
const ARTICLE_BOTH = 8006;
const MODEL3D_THUMBNAIL = 8007;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "Image" (
      "id"          integer PRIMARY KEY,
      "index"       integer,
      "postId"      integer,
      "name"        text,
      "url"         text NOT NULL,
      "nsfwLevel"   integer NOT NULL DEFAULT 1,
      "width"       integer,
      "height"      integer,
      "hash"        text,
      "createdAt"   timestamp NOT NULL DEFAULT now(),
      "mimeType"    text,
      "scannedAt"   timestamp,
      "type"        text NOT NULL DEFAULT 'image',
      "meta"        jsonb,
      "userId"      integer NOT NULL DEFAULT 1,
      "ingestion"   text NOT NULL DEFAULT 'Scanned',
      "needsReview" text
    );
    CREATE TABLE "Post" ("id" integer PRIMARY KEY, "userId" integer, "modelVersionId" integer);
    CREATE TABLE "ModelVersion" ("id" integer PRIMARY KEY, "modelId" integer, "index" integer);
    CREATE TABLE "Model" ("id" integer PRIMARY KEY, "userId" integer);
    CREATE TABLE "Article" ("id" integer PRIMARY KEY, "cover" text, "coverId" integer);
    CREATE TABLE "Model3D" ("id" integer PRIMARY KEY, "thumbnailImageId" integer);
    CREATE TABLE "CollectionItem" (
      "id"           integer PRIMARY KEY,
      "collectionId" integer NOT NULL,
      "imageId"      integer,
      "postId"       integer,
      "modelId"      integer,
      "articleId"    integer,
      "model3dId"    integer,
      "status"       text NOT NULL DEFAULT 'ACCEPTED'
    );
    INSERT INTO "Image" ("id", "url", "ingestion", "needsReview") VALUES
      (100, 'image-item', 'Scanned', NULL),
      (101, 'article-cover', 'Scanned', NULL),
      (102, 'article-unscanned', 'Pending', NULL),
      (103, 'article-needs-review', 'Scanned', 'minor'),
      (104, 'article-both', 'Scanned', NULL),
      (105, 'model3d-thumbnail', 'Scanned', NULL);
    INSERT INTO "Article" ("id", "cover", "coverId") VALUES
      (20, NULL, 101),
      (21, NULL, 102),
      (22, NULL, 103),
      (23, 'legacy-only', NULL),
      (24, 'legacy-both', 104);
    INSERT INTO "Model3D" ("id", "thumbnailImageId") VALUES (30, 105);
    INSERT INTO "CollectionItem" ("id", "collectionId", "imageId", "articleId", "model3dId") VALUES
      (1, ${IMAGE_ITEM},           100,  NULL, NULL),
      (2, ${ARTICLE_COVER},        NULL, 20,   NULL),
      (3, ${ARTICLE_UNSCANNED},    NULL, 21,   NULL),
      (4, ${ARTICLE_NEEDS_REVIEW}, NULL, 22,   NULL),
      (5, ${ARTICLE_LEGACY_ONLY},  NULL, 23,   NULL),
      (6, ${ARTICLE_BOTH},         NULL, 24,   NULL),
      (7, ${MODEL3D_THUMBNAIL},    NULL, NULL, 30);
  `);
});

async function coversFor(collectionId: number) {
  const rows = await getCollectionCoverImages({
    collectionIds: [collectionId],
    imagesPerCollection: 10,
  });
  return rows.map(({ image, src }) => ({ imageId: image?.id ?? null, src }));
}

describe('getCollectionCoverImages', () => {
  it('resolves an Image item to its image (harness control)', async () => {
    expect(await coversFor(IMAGE_ITEM)).toEqual([{ imageId: 100, src: null }]);
  });

  it('resolves an Article through coverId to the cover Image', async () => {
    expect(await coversFor(ARTICLE_COVER)).toEqual([{ imageId: 101, src: null }]);
  });

  it('skips an Article cover that is not scanned yet', async () => {
    expect(await coversFor(ARTICLE_UNSCANNED)).toEqual([]);
  });

  it('skips an Article cover that needs review', async () => {
    expect(await coversFor(ARTICLE_NEEDS_REVIEW)).toEqual([]);
  });

  it('still returns the legacy cover string as src', async () => {
    expect(await coversFor(ARTICLE_LEGACY_ONLY)).toEqual([{ imageId: null, src: 'legacy-only' }]);
    expect(await coversFor(ARTICLE_BOTH)).toEqual([{ imageId: 104, src: 'legacy-both' }]);
  });

  it('resolves a Model3D through thumbnailImageId', async () => {
    expect(await coversFor(MODEL3D_THUMBNAIL)).toEqual([{ imageId: 105, src: null }]);
  });
});
