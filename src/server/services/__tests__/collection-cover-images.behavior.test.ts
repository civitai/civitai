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
const IMAGE_REMOVAL_REASON = 8008;
const IMAGE_PRIVATE_POST = 8009;
const IMAGE_DRAFT_POST = 8010;
const IMAGE_STRANGER_UPLOAD = 8011;
const IMAGE_OWNER_UPLOAD = 8012;
const POST_ITEM_PUBLIC = 8013;
const POST_ITEM_PRIVATE = 8014;
const POST_ITEM_DRAFT = 8015;
const OWNER_UPLOAD_ADDED_BY_STRANGER = 8016;
const ARTICLE_DRAFT = 8017;
const MODEL3D_DRAFT = 8018;
const MODEL_ITEM_DRAFT_POST = 8019;
const MODEL_ITEM_PUBLISHED = 8020;
const MODEL_ITEM_UNPUBLISHED_MODEL = 8021;
const SHARED_UPLOAD_OWNER_ADDED = 8022;
const SHARED_UPLOAD_STRANGER_ADDED = 8023;
const UPLOAD_ADDER_UNKNOWN = 8024;
const MODEL_ITEM_DELETED_MODEL = 8025;
const ARTICLE_PRIVATE = 8026;
const ARTICLE_RESCANNING = 8027;
const POST_ITEM_REMOVED_LEVEL = 8028;
const MODEL_ITEM_PRIVATE_MODEL = 8029;
const MODEL3D_DELETED = 8030;
const MODEL3D_PRIVATE = 8031;
const MODEL_ITEM_PRIVATE_POST = 8032;
const POST_ITEM_REMOVAL_REASON = 8033;
const MODEL_ITEM_TAKEN_DOWN = 8034;
const MODEL_ITEM_PRIVATE_VERSION = 8035;
const MODEL_ITEM_SCHEDULED_VERSION = 8036;
const MODEL_ITEM_DRAFT_VERSION = 8037;
const IMAGE_MINOR_R = 8038;
const IMAGE_MINOR_PG13 = 8039;
const POST_ITEM_MINOR_R_FIRST = 8040;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "Image" (
      minor boolean DEFAULT false,
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
      "needsReview" text,
      "blockedFor"  text
    );
    CREATE TABLE "Post" (
      "id" integer PRIMARY KEY, "userId" integer, "modelVersionId" integer,
      "publishedAt" timestamp, "availability" text NOT NULL DEFAULT 'Public'
    );
    CREATE TABLE "Collection" ("id" integer PRIMARY KEY, "userId" integer NOT NULL);
    CREATE TYPE "CollectionContributorPermission" AS ENUM ('VIEW', 'ADD', 'ADD_REVIEW', 'MANAGE');
    CREATE TABLE "CollectionContributor" (
      "collectionId" integer NOT NULL, "userId" integer NOT NULL,
      "permissions" "CollectionContributorPermission"[] NOT NULL
    );
    CREATE TABLE "ModelVersion" (
      "id" integer PRIMARY KEY, "modelId" integer, "index" integer,
      "status" text NOT NULL DEFAULT 'Published', "availability" text NOT NULL DEFAULT 'Public',
      "publishedAt" timestamp
    );
    CREATE TABLE "Model" (
      "id" integer PRIMARY KEY, "userId" integer, "status" text NOT NULL DEFAULT 'Published',
      "deletedAt" timestamp, "availability" text NOT NULL DEFAULT 'Public', "mode" text
    );
    CREATE TABLE "Article" (
      "id" integer PRIMARY KEY, "cover" text, "coverId" integer,
      "status" text NOT NULL DEFAULT 'Published', "publishedAt" timestamp DEFAULT now(),
      "availability" text NOT NULL DEFAULT 'Public', "ingestion" text NOT NULL DEFAULT 'Scanned'
    );
    CREATE TABLE "Model3D" (
      "id" integer PRIMARY KEY, "thumbnailImageId" integer,
      "status" text NOT NULL DEFAULT 'Published', "deletedAt" timestamp,
      "availability" text NOT NULL DEFAULT 'Public'
    );
    CREATE TABLE "CollectionItem" (
      "id"           integer PRIMARY KEY,
      "collectionId" integer NOT NULL,
      "imageId"      integer,
      "postId"       integer,
      "modelId"      integer,
      "articleId"    integer,
      "model3dId"    integer,
      "status"       text NOT NULL DEFAULT 'ACCEPTED',
      "addedById"    integer DEFAULT 1
    );
    INSERT INTO "Post" ("id", "userId", "publishedAt", "availability") VALUES
      (1, 2, now() - interval '1 day', 'Public'),
      (2, 2, now() - interval '1 day', 'Private'),
      (3, 2, NULL, 'Public');
    INSERT INTO "Image" ("id", "url", "postId", "userId", "ingestion", "blockedFor", "index") VALUES
      (106, 'removal-reason', 1, 2, 'Scanned', 'Moderated', 0),
      (107, 'private-post', 2, 2, 'Scanned', NULL, 0),
      (108, 'draft-post', 3, 2, 'Scanned', NULL, 0),
      (109, 'stranger-upload', NULL, 2, 'Scanned', NULL, 0),
      (110, 'owner-upload', NULL, 1, 'Scanned', NULL, 0),
      (111, 'post-1-first', 1, 2, 'Scanned', NULL, -1);
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
    INSERT INTO "Post" ("id", "userId", "modelVersionId", "publishedAt") VALUES
      (4, 2, 50, NULL),
      (5, 2, 51, now() - interval '1 day');
    INSERT INTO "ModelVersion" ("id", "modelId", "index") VALUES (50, 40, 0), (51, 41, 0);
    INSERT INTO "Model" ("id", "userId") VALUES (40, 2), (41, 2);
    INSERT INTO "Model" ("id", "userId", "status") VALUES (42, 2, 'Unpublished');
    INSERT INTO "ModelVersion" ("id", "modelId", "index") VALUES (52, 42, 0);
    INSERT INTO "Post" ("id", "userId", "modelVersionId", "publishedAt") VALUES (6, 2, 52, now() - interval '1 day');
    INSERT INTO "Image" ("id", "url", "postId", "userId", "index") VALUES (117, 'unpublished-model', 6, 2, 0);
    INSERT INTO "Image" ("id", "url", "postId", "userId", "index") VALUES
      (118, 'shared-owner-upload', NULL, 1, 0),
      (119, 'deleted-model', 8, 2, 0),
      (120, 'private-article-cover', NULL, 2, 0),
      (121, 'rescanning-article-cover', NULL, 2, 0);
    INSERT INTO "Image" ("id", "url", "postId", "userId", "index", "nsfwLevel") VALUES
      (122, 'removed-level', 9, 2, 0, 32);
    INSERT INTO "Model" ("id", "userId", "deletedAt") VALUES (43, 2, now());
    INSERT INTO "Model" ("id", "userId", "availability") VALUES (44, 2, 'Private');
    INSERT INTO "ModelVersion" ("id", "modelId", "index") VALUES (54, 44, 0);
    INSERT INTO "Post" ("id", "userId", "modelVersionId", "publishedAt") VALUES (10, 2, 54, now() - interval '1 day');
    INSERT INTO "Image" ("id", "url", "postId", "userId", "index") VALUES (123, 'private-model', 10, 2, 0);
    INSERT INTO "CollectionItem" ("id", "collectionId", "modelId") VALUES (29, ${MODEL_ITEM_PRIVATE_MODEL}, 44);
    INSERT INTO "Image" ("id", "url", "postId", "userId", "index") VALUES
      (124, 'deleted-model3d', NULL, 2, 0),
      (125, 'private-model3d', NULL, 2, 0),
      (126, 'model-private-post', 11, 2, 0);
    INSERT INTO "Image" ("id", "url", "postId", "userId", "index", "blockedFor") VALUES
      (127, 'post-removal-reason', 12, 2, 0, 'Moderated');
    INSERT INTO "Model3D" ("id", "thumbnailImageId", "deletedAt") VALUES (32, 124, now());
    INSERT INTO "Model3D" ("id", "thumbnailImageId", "availability") VALUES (33, 125, 'Private');
    INSERT INTO "Model" ("id", "userId") VALUES (45, 2);
    INSERT INTO "ModelVersion" ("id", "modelId", "index") VALUES (55, 45, 0);
    INSERT INTO "Post" ("id", "userId", "modelVersionId", "publishedAt", "availability") VALUES
      (11, 2, 55, now() - interval '1 day', 'Private'),
      (12, 2, NULL, now() - interval '1 day', 'Public');
    INSERT INTO "CollectionItem" ("id", "collectionId", "model3dId", "modelId", "postId") VALUES
      (30, ${MODEL3D_DELETED}, 32, NULL, NULL),
      (31, ${MODEL3D_PRIVATE}, 33, NULL, NULL),
      (32, ${MODEL_ITEM_PRIVATE_POST}, NULL, 45, NULL),
      (33, ${POST_ITEM_REMOVAL_REASON}, NULL, NULL, 12);
    INSERT INTO "Model" ("id", "userId", "mode") VALUES (46, 2, 'TakenDown'), (47, 2, NULL), (48, 2, NULL);
    INSERT INTO "ModelVersion" ("id", "modelId", "index", "availability", "publishedAt") VALUES
      (56, 46, 0, 'Public', NULL),
      (57, 47, 0, 'Private', NULL),
      (58, 48, 0, 'Public', now() + interval '1 day');
    INSERT INTO "Post" ("id", "userId", "modelVersionId", "publishedAt") VALUES
      (13, 2, 56, now() - interval '1 day'),
      (14, 2, 57, now() - interval '1 day'),
      (15, 2, 58, now() - interval '1 day');
    INSERT INTO "Image" ("id", "url", "postId", "userId", "index") VALUES
      (128, 'taken-down', 13, 2, 0), (129, 'private-version', 14, 2, 0), (130, 'scheduled-version', 15, 2, 0);
    INSERT INTO "CollectionItem" ("id", "collectionId", "modelId") VALUES
      (34, ${MODEL_ITEM_TAKEN_DOWN}, 46),
      (35, ${MODEL_ITEM_PRIVATE_VERSION}, 47),
      (36, ${MODEL_ITEM_SCHEDULED_VERSION}, 48);
    INSERT INTO "Model" ("id", "userId") VALUES (49, 2);
    INSERT INTO "ModelVersion" ("id", "modelId", "index", "status") VALUES (59, 49, 0, 'Draft');
    INSERT INTO "Post" ("id", "userId", "modelVersionId", "publishedAt") VALUES (16, 2, 59, now() - interval '1 day');
    INSERT INTO "Image" ("id", "url", "postId", "userId", "index") VALUES (131, 'draft-version', 16, 2, 0);
    INSERT INTO "CollectionItem" ("id", "collectionId", "modelId") VALUES (37, ${MODEL_ITEM_DRAFT_VERSION}, 49);
    INSERT INTO "Post" ("id", "userId", "publishedAt") VALUES (17, 2, now() - interval '1 day');
    INSERT INTO "Image" ("id", "url", "postId", "userId", "index", "nsfwLevel", "minor") VALUES
      (132, 'minor-r', 1, 2, 0, 4, true),
      (133, 'minor-pg13', 1, 2, 0, 2, true),
      (134, 'post-17-minor-r', 17, 2, 0, 4, true),
      (135, 'post-17-second', 17, 2, 1, 4, false);
    INSERT INTO "CollectionItem" ("id", "collectionId", "imageId", "postId", "addedById") VALUES
      (38, ${IMAGE_MINOR_R}, 132, NULL, 2),
      (39, ${IMAGE_MINOR_PG13}, 133, NULL, 2),
      (40, ${POST_ITEM_MINOR_R_FIRST}, NULL, 17, 2);
    INSERT INTO "ModelVersion" ("id", "modelId", "index") VALUES (53, 43, 0);
    INSERT INTO "Post" ("id", "userId", "modelVersionId", "publishedAt") VALUES
      (8, 2, 53, now() - interval '1 day'),
      (9, 2, NULL, now() - interval '1 day');
    INSERT INTO "Article" ("id", "cover", "coverId", "availability", "ingestion") VALUES
      (26, NULL, 120, 'Private', 'Scanned'),
      (27, NULL, 121, 'Public', 'Rescan');
    INSERT INTO "Image" ("id", "url", "postId", "userId", "index") VALUES
      (112, 'owner-upload-2', NULL, 1, 0),
      (113, 'draft-article-cover', NULL, 2, 0),
      (114, 'draft-model3d-thumb', NULL, 2, 0),
      (115, 'model-draft-post', 4, 2, 0),
      (116, 'model-published-post', 5, 2, 0);
    INSERT INTO "Article" ("id", "cover", "coverId", "status", "publishedAt") VALUES
      (25, 'draft-src', 113, 'Draft', NULL);
    INSERT INTO "Model3D" ("id", "thumbnailImageId", "status") VALUES (31, 114, 'Draft');
    UPDATE "Image" SET "postId" = 1 WHERE "id" = 100;
    INSERT INTO "CollectionItem" ("id", "collectionId", "imageId", "articleId", "model3dId") VALUES
      (1, ${IMAGE_ITEM},           100,  NULL, NULL),
      (2, ${ARTICLE_COVER},        NULL, 20,   NULL),
      (3, ${ARTICLE_UNSCANNED},    NULL, 21,   NULL),
      (4, ${ARTICLE_NEEDS_REVIEW}, NULL, 22,   NULL),
      (5, ${ARTICLE_LEGACY_ONLY},  NULL, 23,   NULL),
      (6, ${ARTICLE_BOTH},         NULL, 24,   NULL),
      (7, ${MODEL3D_THUMBNAIL},    NULL, NULL, 30);
    INSERT INTO "CollectionItem" ("id", "collectionId", "imageId", "postId") VALUES
      (8,  ${IMAGE_REMOVAL_REASON},    106,  NULL),
      (9,  ${IMAGE_PRIVATE_POST},    107,  NULL),
      (10, ${IMAGE_DRAFT_POST},      108,  NULL),
      (11, ${IMAGE_STRANGER_UPLOAD}, 109,  NULL),
      (12, ${IMAGE_OWNER_UPLOAD},    110,  NULL),
      (13, ${POST_ITEM_PUBLIC},      NULL, 1),
      (14, ${POST_ITEM_PRIVATE},     NULL, 2),
      (15, ${POST_ITEM_DRAFT},       NULL, 3);
    INSERT INTO "CollectionItem" ("id", "collectionId", "imageId", "articleId", "model3dId", "modelId", "addedById") VALUES
      (16, ${OWNER_UPLOAD_ADDED_BY_STRANGER}, 112, NULL, NULL, NULL, 2),
      (17, ${ARTICLE_DRAFT},         NULL, 25,   NULL, NULL, 1),
      (18, ${MODEL3D_DRAFT},         NULL, NULL, 31,   NULL, 1),
      (19, ${MODEL_ITEM_DRAFT_POST}, NULL, NULL, NULL, 40,   1),
      (20, ${MODEL_ITEM_PUBLISHED},  NULL, NULL, NULL, 41,   1),
      (21, ${MODEL_ITEM_UNPUBLISHED_MODEL}, NULL, NULL, NULL, 42, 1),
      (22, ${SHARED_UPLOAD_OWNER_ADDED}, 118, NULL, NULL, NULL, 1),
      (23, ${SHARED_UPLOAD_STRANGER_ADDED}, 118, NULL, NULL, NULL, 2),
      (24, ${UPLOAD_ADDER_UNKNOWN}, 110, NULL, NULL, NULL, NULL),
      (25, ${MODEL_ITEM_DELETED_MODEL}, NULL, NULL, NULL, 43, 1),
      (26, ${ARTICLE_PRIVATE}, NULL, 26, NULL, NULL, 1),
      (27, ${ARTICLE_RESCANNING}, NULL, 27, NULL, NULL, 1);
    INSERT INTO "CollectionItem" ("id", "collectionId", "postId") VALUES
      (28, ${POST_ITEM_REMOVED_LEVEL}, 9);
    INSERT INTO "Collection" ("id", "userId")
      SELECT DISTINCT "collectionId", 1 FROM "CollectionItem";
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

  it('uses an upload whose owner added it as the item', async () => {
    expect(await coversFor(IMAGE_OWNER_UPLOAD)).toEqual([{ imageId: 110, src: null }]);
  });

  it.each([
    ['carries a removal reason', IMAGE_REMOVAL_REASON],
    ['sits on a Private post', IMAGE_PRIVATE_POST],
    ['sits on a draft post', IMAGE_DRAFT_POST],
    ["is another user's upload", IMAGE_STRANGER_UPLOAD],
    ["is the collection owner's upload added by someone else", OWNER_UPLOAD_ADDED_BY_STRANGER],
  ])('skips an Image item that %s', async (_, collectionId) => {
    expect(await coversFor(collectionId)).toEqual([]);
  });

  it("resolves a Post item to the post's first image (control)", async () => {
    expect(await coversFor(POST_ITEM_PUBLIC)).toEqual([{ imageId: 111, src: null }]);
  });

  it.each([
    ['Private', POST_ITEM_PRIVATE],
    ['a draft', POST_ITEM_DRAFT],
  ])('skips a Post item whose post is %s', async (_, collectionId) => {
    expect(await coversFor(collectionId)).toEqual([]);
  });

  it("resolves a Model item to its published post's image (control)", async () => {
    expect(await coversFor(MODEL_ITEM_PUBLISHED)).toEqual([{ imageId: 116, src: null }]);
  });

  it.each([
    ['a Model item whose post is a draft', MODEL_ITEM_DRAFT_POST],
    ['a Model item whose model is unpublished', MODEL_ITEM_UNPUBLISHED_MODEL],
    ['a draft Article, including its cover string', ARTICLE_DRAFT],
    ['a draft Model3D', MODEL3D_DRAFT],
  ])('skips %s', async (_, collectionId) => {
    expect(await coversFor(collectionId)).toEqual([]);
  });

  it('judges the same upload per collection: shown where its owner added it, not where someone else did', async () => {
    const rows = await getCollectionCoverImages({
      collectionIds: [SHARED_UPLOAD_OWNER_ADDED, SHARED_UPLOAD_STRANGER_ADDED],
      imagesPerCollection: 10,
    });
    expect(rows.map(({ id, image }) => [id, image?.id ?? null])).toEqual([
      [SHARED_UPLOAD_OWNER_ADDED, 118],
    ]);
  });

  it.each([
    ['an upload whose adder is unknown', UPLOAD_ADDER_UNKNOWN],
    ['a Model item whose model is deleted', MODEL_ITEM_DELETED_MODEL],
    ['a Private Article', ARTICLE_PRIVATE],
    ['an Article being rescanned', ARTICLE_RESCANNING],
    ['a Post item whose image is rated at the removed level', POST_ITEM_REMOVED_LEVEL],
  ])('skips %s', async (_, collectionId) => {
    expect(await coversFor(collectionId)).toEqual([]);
  });

  it('skips a Model item whose model is Private', async () => {
    expect(await coversFor(MODEL_ITEM_PRIVATE_MODEL)).toEqual([]);
  });

  it.each([
    ['a deleted Model3D', MODEL3D_DELETED],
    ['a Private Model3D', MODEL3D_PRIVATE],
    ['a Model item whose post is Private', MODEL_ITEM_PRIVATE_POST],
    ['a Post item whose only image carries a removal reason', POST_ITEM_REMOVAL_REASON],
  ])('skips %s', async (_, collectionId) => {
    expect(await coversFor(collectionId)).toEqual([]);
  });

  it.each([
    ['a Model item whose model was taken down', MODEL_ITEM_TAKEN_DOWN],
    ['a Model item whose version is Private', MODEL_ITEM_PRIVATE_VERSION],
    ['a Model item whose version is scheduled for later', MODEL_ITEM_SCHEDULED_VERSION],
  ])('skips %s', async (_, collectionId) => {
    expect(await coversFor(collectionId)).toEqual([]);
  });

  it('skips a Model item whose version is a draft', async () => {
    expect(await coversFor(MODEL_ITEM_DRAFT_VERSION)).toEqual([]);
  });

  it('skips a minor-flagged Image item rated R, and keeps one rated PG-13', async () => {
    expect(await coversFor(IMAGE_MINOR_R)).toEqual([]);
    expect(await coversFor(IMAGE_MINOR_PG13)).toEqual([{ imageId: 133, src: null }]);
  });

  it("passes over a post's first image when it is minor-flagged and rated R", async () => {
    expect(await coversFor(POST_ITEM_MINOR_R_FIRST)).toEqual([{ imageId: 135, src: null }]);
  });
});
