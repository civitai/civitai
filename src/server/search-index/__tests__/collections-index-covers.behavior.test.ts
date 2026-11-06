import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as RedisCaches from '~/server/redis/caches';

/**
 * The collections search index carries a collection's own cover only when a stranger could see
 * it, and its item-cover fallback follows the same rule.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof RedisCaches>()),
  tagIdsForImagesCache: { fetch: vi.fn().mockResolvedValue({}) },
}));

const { pullData } = await import('~/server/search-index/collections.search-index');

let pg: PGlite;
const db = {
  $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const flat = Prisma.sql(strings, ...(values as never[]));
    return pg.query(flat.text, flat.values as unknown[]).then((r) => r.rows);
  },
  image: { findMany: async () => [] },
};

const OWNER = 1;
const STRANGER = 2;
// collection id → its own cover, or its only item
const OWN_PUBLISHED = 10;
const OWN_PRIVATE_POST = 11;
const OWN_REMOVAL_REASON = 12;
const OWN_STRANGER_UPLOAD = 13;
const ITEM_PUBLISHED = 20;
const ITEM_PRIVATE_POST = 21;
const POST_ITEM_DRAFT = 22;
const ARTICLE_ITEM_DRAFT = 23;
const MODEL3D_ITEM_DRAFT = 24;
const MODEL_ITEM_DRAFT_POST = 25;
const ARTICLE_ITEM_PUBLISHED = 26;
const OWNER_UPLOAD_ADDED_BY_STRANGER = 27;
const POST_ITEM_PRIVATE = 28;
const MODEL_ITEM_UNPUBLISHED_MODEL = 29;
const OWN_OWNER_UPLOAD = 30;
const OWN_MANAGER_UPLOAD = 31;
const POST_ITEM_PUBLISHED = 32;
const MODEL_ITEM_PUBLISHED = 33;
const MODEL3D_ITEM_PUBLISHED = 34;
const SHARED_UPLOAD_OWNER_ADDED = 35;
const SHARED_UPLOAD_STRANGER_ADDED = 36;
const MANAGER = 3;
const MODEL_ITEM_DELETED_MODEL = 37;
const MODEL_ITEM_PRIVATE_MODEL = 38;
const MODEL3D_DELETED = 39;
const MODEL3D_PRIVATE = 40;
const POST_ITEM_REMOVED_LEVEL = 41;
const MODEL_ITEM_TAKEN_DOWN = 42;
const MODEL_ITEM_PRIVATE_VERSION = 43;
const MODEL_ITEM_DRAFT_VERSION = 44;
const MODEL_ITEM_SCHEDULED_VERSION = 45;
const MODEL_ITEM_PRIVATE_POST = 46;
const POST_ITEM_REMOVAL_REASON = 47;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TYPE "CollectionReadConfiguration" AS ENUM ('Private', 'Public', 'Unlisted');
    CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
    CREATE TYPE "CollectionContributorPermission" AS ENUM ('VIEW', 'ADD', 'ADD_REVIEW', 'MANAGE');
    CREATE TABLE "Collection" (
      id int PRIMARY KEY, name text, "imageId" int, "createdAt" timestamp DEFAULT now(),
      "updatedAt" timestamp DEFAULT now(), "userId" int NOT NULL, type text, mode text,
      read "CollectionReadConfiguration" NOT NULL DEFAULT 'Public', write text,
      "nsfwLevel" int DEFAULT 1, availability "Availability" NOT NULL DEFAULT 'Public'
    );
    CREATE TABLE "User" (
      id int PRIMARY KEY, username text, "deletedAt" timestamp, image text, "profilePictureId" int
    );
    CREATE TABLE "UserCosmetic" ("userId" int, "cosmeticId" int, data jsonb, "equippedAt" timestamp, "equippedToId" int);
    CREATE TABLE "Cosmetic" (id int, data jsonb, type text, source text, name text, "leaderboardId" text, "leaderboardPosition" int);
    CREATE TABLE "CollectionMetric" ("collectionId" int, timeframe text, "followerCount" int, "itemCount" int, "contributorCount" int);
    CREATE TABLE "CollectionContributor" (
      "collectionId" int NOT NULL, "userId" int NOT NULL,
      permissions "CollectionContributorPermission"[] NOT NULL
    );
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL, "postId" int, name text, url text NOT NULL DEFAULT 'u',
      "nsfwLevel" int NOT NULL DEFAULT 1, width int, height int, hash text, type text DEFAULT 'image',
      poi boolean DEFAULT false, minor boolean DEFAULT false, index int,
      ingestion text NOT NULL DEFAULT 'Scanned', "needsReview" text, "blockedFor" text
    );
    CREATE TABLE "Post" (
      id int PRIMARY KEY, "userId" int, "modelVersionId" int, "publishedAt" timestamp,
      availability text NOT NULL DEFAULT 'Public'
    );
    CREATE TABLE "CollectionItem" (
      id int PRIMARY KEY, "collectionId" int NOT NULL, "imageId" int, "postId" int, "modelId" int,
      "articleId" int, "model3dId" int, status text NOT NULL DEFAULT 'ACCEPTED',
      "addedById" int DEFAULT ${OWNER}
    );
    CREATE TABLE "ModelVersion" (
      id int PRIMARY KEY, "modelId" int, index int, status text DEFAULT 'Published',
      availability text DEFAULT 'Public', "publishedAt" timestamp
    );
    CREATE TABLE "Model" (
      id int PRIMARY KEY, "userId" int, status text, "deletedAt" timestamp, availability text, mode text
    );
    CREATE TABLE "Article" (
      id int PRIMARY KEY, cover text, "coverId" int, status text, "publishedAt" timestamp,
      availability text, ingestion text DEFAULT 'Scanned'
    );
    CREATE TABLE "Model3D" (
      id int PRIMARY KEY, "thumbnailImageId" int, status text, "deletedAt" timestamp,
      availability text
    );

    INSERT INTO "User" (id, username) VALUES (${OWNER}, 'owner'), (${STRANGER}, 'stranger');
    INSERT INTO "Post" (id, "userId", "publishedAt", availability) VALUES
      (1, ${STRANGER}, now() - interval '1 day', 'Public'),
      (2, ${STRANGER}, now() - interval '1 day', 'Private'),
      (3, ${STRANGER}, NULL, 'Public');
    INSERT INTO "Image" (id, "userId", "postId", "blockedFor") VALUES
      (100, ${STRANGER}, 1, NULL),
      (101, ${STRANGER}, 2, NULL),
      (102, ${STRANGER}, 1, 'Moderated'),
      (103, ${STRANGER}, NULL, NULL),
      (104, ${STRANGER}, 3, NULL),
      (105, ${STRANGER}, NULL, NULL),
      (106, ${STRANGER}, NULL, NULL),
      (107, ${STRANGER}, 4, NULL),
      (108, ${STRANGER}, NULL, NULL),
      (109, ${OWNER}, NULL, NULL);
    INSERT INTO "Post" (id, "userId", "modelVersionId", "publishedAt") VALUES (4, ${STRANGER}, 50, NULL);
    INSERT INTO "ModelVersion" (id, "modelId", index) VALUES (50, 40, 0);
    INSERT INTO "Model" (id, "userId", status, availability) VALUES
      (40, ${STRANGER}, 'Published', 'Public'),
      (41, ${STRANGER}, 'Unpublished', 'Public');
    INSERT INTO "ModelVersion" (id, "modelId", index) VALUES (51, 41, 0);
    INSERT INTO "Post" (id, "userId", "modelVersionId", "publishedAt") VALUES (5, ${STRANGER}, 51, now() - interval '1 day');
    INSERT INTO "Image" (id, "userId", "postId", "blockedFor") VALUES (110, ${STRANGER}, 5, NULL);
    INSERT INTO "Image" (id, "userId", "postId") VALUES
      (111, ${OWNER}, NULL),
      (112, ${MANAGER}, NULL),
      (113, ${STRANGER}, 6),
      (114, ${STRANGER}, NULL);
    INSERT INTO "Post" (id, "userId", "modelVersionId", "publishedAt") VALUES (6, ${STRANGER}, 52, now() - interval '1 day');
    INSERT INTO "ModelVersion" (id, "modelId", index) VALUES (52, 42, 0);
    INSERT INTO "Model" (id, "userId", status, availability) VALUES (42, ${STRANGER}, 'Published', 'Public');
    INSERT INTO "Model" (id, "userId", status, availability, "deletedAt") VALUES
      (43, ${STRANGER}, 'Published', 'Public', now()),
      (44, ${STRANGER}, 'Published', 'Private', NULL);
    INSERT INTO "ModelVersion" (id, "modelId", index) VALUES (53, 43, 0), (54, 44, 0);
    INSERT INTO "Post" (id, "userId", "modelVersionId", "publishedAt") VALUES
      (7, ${STRANGER}, 53, now() - interval '1 day'),
      (8, ${STRANGER}, 54, now() - interval '1 day');
    INSERT INTO "Image" (id, "userId", "postId") VALUES (115, ${STRANGER}, 7), (116, ${STRANGER}, 8);
    INSERT INTO "Collection" (id, "userId", "imageId") VALUES
      (${MODEL_ITEM_DELETED_MODEL}, ${OWNER}, NULL),
      (${MODEL_ITEM_PRIVATE_MODEL}, ${OWNER}, NULL);
    INSERT INTO "CollectionItem" (id, "collectionId", "modelId") VALUES
      (30, ${MODEL_ITEM_DELETED_MODEL}, 43),
      (31, ${MODEL_ITEM_PRIVATE_MODEL}, 44);
    INSERT INTO "Image" (id, "userId", "postId") VALUES (117, ${STRANGER}, NULL), (118, ${STRANGER}, NULL);
    INSERT INTO "Image" (id, "userId", "postId", "nsfwLevel") VALUES (119, ${STRANGER}, 9, 32);
    INSERT INTO "Post" (id, "userId", "publishedAt") VALUES (9, ${STRANGER}, now() - interval '1 day');
    INSERT INTO "Model3D" (id, "thumbnailImageId", status, availability, "deletedAt") VALUES
      (37, 117, 'Published', 'Public', now()),
      (38, 118, 'Published', 'Private', NULL);
    INSERT INTO "Collection" (id, "userId", "imageId") VALUES
      (${MODEL3D_DELETED}, ${OWNER}, NULL),
      (${MODEL3D_PRIVATE}, ${OWNER}, NULL),
      (${POST_ITEM_REMOVED_LEVEL}, ${OWNER}, NULL);
    INSERT INTO "CollectionItem" (id, "collectionId", "model3dId", "postId") VALUES
      (32, ${MODEL3D_DELETED}, 37, NULL),
      (33, ${MODEL3D_PRIVATE}, 38, NULL),
      (34, ${POST_ITEM_REMOVED_LEVEL}, NULL, 9);
    INSERT INTO "Model" (id, "userId", status, availability, mode) VALUES
      (45, ${STRANGER}, 'Published', 'Public', 'TakenDown'),
      (46, ${STRANGER}, 'Published', 'Public', NULL);
    INSERT INTO "ModelVersion" (id, "modelId", index, availability) VALUES (55, 45, 0, 'Public'), (56, 46, 0, 'Private');
    INSERT INTO "Post" (id, "userId", "modelVersionId", "publishedAt") VALUES
      (10, ${STRANGER}, 55, now() - interval '1 day'),
      (11, ${STRANGER}, 56, now() - interval '1 day');
    INSERT INTO "Image" (id, "userId", "postId") VALUES (120, ${STRANGER}, 10), (121, ${STRANGER}, 11);
    INSERT INTO "Collection" (id, "userId", "imageId") VALUES
      (${MODEL_ITEM_TAKEN_DOWN}, ${OWNER}, NULL),
      (${MODEL_ITEM_PRIVATE_VERSION}, ${OWNER}, NULL);
    INSERT INTO "CollectionItem" (id, "collectionId", "modelId") VALUES
      (35, ${MODEL_ITEM_TAKEN_DOWN}, 45),
      (36, ${MODEL_ITEM_PRIVATE_VERSION}, 46);
    INSERT INTO "Model" (id, "userId", status, availability) VALUES
      (47, ${STRANGER}, 'Published', 'Public'),
      (48, ${STRANGER}, 'Published', 'Public'),
      (49, ${STRANGER}, 'Published', 'Public');
    INSERT INTO "ModelVersion" (id, "modelId", index, status, "publishedAt") VALUES
      (57, 47, 0, 'Draft', NULL),
      (58, 48, 0, 'Published', now() + interval '1 day'),
      (59, 49, 0, 'Published', NULL);
    INSERT INTO "Post" (id, "userId", "modelVersionId", "publishedAt", availability) VALUES
      (12, ${STRANGER}, 57, now() - interval '1 day', 'Public'),
      (13, ${STRANGER}, 58, now() - interval '1 day', 'Public'),
      (14, ${STRANGER}, 59, now() - interval '1 day', 'Private'),
      (15, ${STRANGER}, NULL, now() - interval '1 day', 'Public');
    INSERT INTO "Image" (id, "userId", "postId", "blockedFor") VALUES
      (122, ${STRANGER}, 12, NULL), (123, ${STRANGER}, 13, NULL), (124, ${STRANGER}, 14, NULL),
      (125, ${STRANGER}, 15, 'Moderated');
    INSERT INTO "Collection" (id, "userId", "imageId") VALUES
      (${MODEL_ITEM_DRAFT_VERSION}, ${OWNER}, NULL),
      (${MODEL_ITEM_SCHEDULED_VERSION}, ${OWNER}, NULL),
      (${MODEL_ITEM_PRIVATE_POST}, ${OWNER}, NULL),
      (${POST_ITEM_REMOVAL_REASON}, ${OWNER}, NULL);
    INSERT INTO "CollectionItem" (id, "collectionId", "modelId", "postId") VALUES
      (37, ${MODEL_ITEM_DRAFT_VERSION}, 47, NULL),
      (38, ${MODEL_ITEM_SCHEDULED_VERSION}, 48, NULL),
      (39, ${MODEL_ITEM_PRIVATE_POST}, 49, NULL),
      (40, ${POST_ITEM_REMOVAL_REASON}, NULL, 15);
    INSERT INTO "Model3D" (id, "thumbnailImageId", status, availability) VALUES (36, 114, 'Published', 'Public');
    INSERT INTO "CollectionContributor" ("collectionId", "userId", permissions) VALUES
      (${OWN_MANAGER_UPLOAD}, ${MANAGER}, ARRAY['VIEW', 'MANAGE']::"CollectionContributorPermission"[]);
    INSERT INTO "Article" (id, cover, "coverId", status, "publishedAt", availability) VALUES
      (30, 'draft-src', 105, 'Draft', NULL, 'Public'),
      (31, NULL, 108, 'Published', now(), 'Public');
    INSERT INTO "Model3D" (id, "thumbnailImageId", status, availability) VALUES (35, 106, 'Draft', 'Public');
    INSERT INTO "Collection" (id, "userId", "imageId") VALUES
      (${OWN_PUBLISHED}, ${OWNER}, 100),
      (${OWN_PRIVATE_POST}, ${OWNER}, 101),
      (${OWN_REMOVAL_REASON}, ${OWNER}, 102),
      (${OWN_STRANGER_UPLOAD}, ${OWNER}, 103),
      (${ITEM_PUBLISHED}, ${OWNER}, NULL),
      (${ITEM_PRIVATE_POST}, ${OWNER}, NULL),
      (${POST_ITEM_DRAFT}, ${OWNER}, NULL),
      (${ARTICLE_ITEM_DRAFT}, ${OWNER}, NULL),
      (${MODEL3D_ITEM_DRAFT}, ${OWNER}, NULL),
      (${MODEL_ITEM_DRAFT_POST}, ${OWNER}, NULL),
      (${ARTICLE_ITEM_PUBLISHED}, ${OWNER}, NULL),
      (${OWNER_UPLOAD_ADDED_BY_STRANGER}, ${OWNER}, NULL),
      (${POST_ITEM_PRIVATE}, ${OWNER}, NULL),
      (${MODEL_ITEM_UNPUBLISHED_MODEL}, ${OWNER}, NULL),
      (${OWN_OWNER_UPLOAD}, ${OWNER}, 111),
      (${OWN_MANAGER_UPLOAD}, ${OWNER}, 112),
      (${POST_ITEM_PUBLISHED}, ${OWNER}, NULL),
      (${MODEL_ITEM_PUBLISHED}, ${OWNER}, NULL),
      (${MODEL3D_ITEM_PUBLISHED}, ${OWNER}, NULL),
      (${SHARED_UPLOAD_OWNER_ADDED}, ${OWNER}, NULL),
      (${SHARED_UPLOAD_STRANGER_ADDED}, ${OWNER}, NULL);
    INSERT INTO "CollectionItem" (id, "collectionId", "imageId", "postId") VALUES
      (1, ${OWN_PUBLISHED}, 100, NULL),
      (2, ${OWN_PRIVATE_POST}, 101, NULL),
      (3, ${OWN_REMOVAL_REASON}, 102, NULL),
      (4, ${OWN_STRANGER_UPLOAD}, 103, NULL),
      (5, ${ITEM_PUBLISHED}, 100, NULL),
      (6, ${ITEM_PRIVATE_POST}, 101, NULL),
      (7, ${POST_ITEM_DRAFT}, NULL, 3);
    INSERT INTO "CollectionItem" (id, "collectionId", "articleId", "model3dId", "modelId", "imageId", "addedById") VALUES
      (8,  ${ARTICLE_ITEM_DRAFT}, 30, NULL, NULL, NULL, ${OWNER}),
      (9,  ${MODEL3D_ITEM_DRAFT}, NULL, 35, NULL, NULL, ${OWNER}),
      (10, ${MODEL_ITEM_DRAFT_POST}, NULL, NULL, 40, NULL, ${OWNER}),
      (11, ${ARTICLE_ITEM_PUBLISHED}, 31, NULL, NULL, NULL, ${OWNER}),
      (12, ${OWNER_UPLOAD_ADDED_BY_STRANGER}, NULL, NULL, NULL, 109, ${STRANGER});
    INSERT INTO "CollectionItem" (id, "collectionId", "postId", "modelId") VALUES
      (13, ${POST_ITEM_PRIVATE}, 2, NULL),
      (14, ${MODEL_ITEM_UNPUBLISHED_MODEL}, NULL, 41),
      (19, ${POST_ITEM_PUBLISHED}, 1, NULL),
      (20, ${MODEL_ITEM_PUBLISHED}, NULL, 42);
    INSERT INTO "CollectionItem" (id, "collectionId", "imageId", "model3dId", "addedById") VALUES
      (15, ${OWN_OWNER_UPLOAD}, 111, NULL, ${OWNER}),
      (16, ${OWN_MANAGER_UPLOAD}, 112, NULL, ${MANAGER}),
      (17, ${MODEL3D_ITEM_PUBLISHED}, NULL, 36, ${OWNER}),
      (21, ${SHARED_UPLOAD_OWNER_ADDED}, 111, NULL, ${OWNER}),
      (22, ${SHARED_UPLOAD_STRANGER_ADDED}, 111, NULL, ${STRANGER});
  `);
});
afterAll(() => pg.close());

const pull = async (id: number) => {
  const data = await pullData(
    { db, logger: () => undefined } as never,
    {
      type: 'update',
      ids: [id],
    } as never
  );
  return {
    cover: data.collections[0]?.image?.id ?? null,
    itemCovers: data.itemImages.map((i) => i.image?.id ?? null).filter((x) => x !== null),
    itemSrcs: data.itemImages.map((i) => i.src).filter((x) => x != null),
  };
};

describe('collections search index covers', () => {
  it("indexes a collection's own cover a stranger could see (control)", async () => {
    expect((await pull(OWN_PUBLISHED)).cover).toBe(100);
  });

  it.each([
    ['sits on a Private post', OWN_PRIVATE_POST],
    ['carries a removal reason', OWN_REMOVAL_REASON],
    ["is another user's upload", OWN_STRANGER_UPLOAD],
  ])('indexes no own cover when it %s, and falls back to item covers', async (_, id) => {
    const { cover, itemCovers } = await pull(id);
    expect(cover).toBeNull();
    // Its only item is the same image, so the fallback finds nothing either.
    expect(itemCovers).toEqual([]);
  });

  it('uses an Image item a stranger could see as the fallback cover (control)', async () => {
    expect((await pull(ITEM_PUBLISHED)).itemCovers).toEqual([100]);
  });

  it.each([
    ['an Image item on a Private post', ITEM_PRIVATE_POST],
    ['a Post item that is a draft', POST_ITEM_DRAFT],
  ])('skips %s in the fallback', async (_, id) => {
    expect((await pull(id)).itemCovers).toEqual([]);
  });

  it('uses a published Article item cover as the fallback (control)', async () => {
    expect((await pull(ARTICLE_ITEM_PUBLISHED)).itemCovers).toEqual([108]);
  });

  it.each([
    ['a draft Article item', ARTICLE_ITEM_DRAFT],
    ['a draft Model3D item', MODEL3D_ITEM_DRAFT],
    ['a Model item whose post is a draft', MODEL_ITEM_DRAFT_POST],
    ["the collection owner's upload added by someone else", OWNER_UPLOAD_ADDED_BY_STRANGER],
    ['a Post item whose post is Private', POST_ITEM_PRIVATE],
    ['a Model item whose model is unpublished', MODEL_ITEM_UNPUBLISHED_MODEL],
  ])('skips %s in the fallback, cover string included', async (_, id) => {
    const { itemCovers, itemSrcs } = await pull(id);
    expect(itemCovers).toEqual([]);
    expect(itemSrcs).toEqual([]);
  });

  it.each([
    ["the owner's upload", OWN_OWNER_UPLOAD, 111],
    ["a manager's upload", OWN_MANAGER_UPLOAD, 112],
  ])("indexes %s as the collection's own cover (control)", async (_, id, imageId) => {
    expect((await pull(id)).cover).toBe(imageId);
  });

  it.each([
    ['a published Post item', POST_ITEM_PUBLISHED, 100],
    ['a published Model item', MODEL_ITEM_PUBLISHED, 113],
    ['a published Model3D item', MODEL3D_ITEM_PUBLISHED, 114],
  ])('uses %s as the fallback cover (control)', async (_, id, imageId) => {
    expect((await pull(id)).itemCovers).toEqual([imageId]);
  });

  it('judges the same upload per collection: kept where its owner added it, not where someone else did', async () => {
    // Both in one pull, so one collection's item can't stand in for the other's.
    const data = await pullData(
      { db, logger: () => undefined } as never,
      {
        type: 'update',
        ids: [SHARED_UPLOAD_OWNER_ADDED, SHARED_UPLOAD_STRANGER_ADDED],
      } as never
    );
    expect(data.itemImages.filter((i) => i.image).map((i) => [i.id, i.image?.id])).toEqual([
      [SHARED_UPLOAD_OWNER_ADDED, 111],
    ]);
  });

  it.each([
    ['whose model is deleted', MODEL_ITEM_DELETED_MODEL],
    ['whose model is Private', MODEL_ITEM_PRIVATE_MODEL],
  ])('skips a Model item %s in the fallback', async (_, id) => {
    expect((await pull(id)).itemCovers).toEqual([]);
  });

  it.each([
    ['a deleted Model3D item', MODEL3D_DELETED],
    ['a Private Model3D item', MODEL3D_PRIVATE],
    ['a Post item whose image is rated at the removed level', POST_ITEM_REMOVED_LEVEL],
  ])('skips %s in the fallback', async (_, id) => {
    expect((await pull(id)).itemCovers).toEqual([]);
  });

  it.each([
    ['whose model was taken down', MODEL_ITEM_TAKEN_DOWN],
    ['whose version is Private', MODEL_ITEM_PRIVATE_VERSION],
  ])('skips a Model item %s in the fallback', async (_, id) => {
    expect((await pull(id)).itemCovers).toEqual([]);
  });

  it.each([
    ['a Model item whose version is a draft', MODEL_ITEM_DRAFT_VERSION],
    ['a Model item whose version is scheduled for later', MODEL_ITEM_SCHEDULED_VERSION],
    ['a Model item whose post is Private', MODEL_ITEM_PRIVATE_POST],
    ['a Post item whose only image carries a removal reason', POST_ITEM_REMOVAL_REASON],
  ])('skips %s in the fallback', async (_, id) => {
    expect((await pull(id)).itemCovers).toEqual([]);
  });
});
