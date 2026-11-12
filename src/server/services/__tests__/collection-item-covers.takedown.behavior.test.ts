import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { collectionItemCoversSql } from '~/server/services/collection-cover-visibility';

/**
 * A collection's cover drawn from its items skips images on a taken-down model, whichever way
 * the item reaches the image: an image item, a post item, or a model item.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const OWNER = 1;
const STRANGER = 2;
const LIVE = 10;
const TAKEN_DOWN = 11;

// Collections: one item each.
const IMAGE_ON_LIVE = 100;
const IMAGE_ON_TAKEN_DOWN = 101;
const POST_ON_LIVE = 102;
const POST_ON_TAKEN_DOWN = 103;
const MODEL_LIVE = 104;
const MODEL_TAKEN_DOWN = 105;
const IMAGE_ON_NO_MODEL = 106;
const POST_ON_NO_MODEL = 107;
const TAKEN_DOWN_THEN_LIVE = 108;
const IMAGE_RESTRICTED_R = 109;
const POST_RESTRICTED_R = 110;
const IMAGE_RESTRICTED_PG = 111;
const MODEL_RESTRICTED_FIRST = 112;
const ARTICLE_RESTRICTED_R = 113;
const MODEL3D_RESTRICTED_R = 114;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "MediaType" AS ENUM ('image', 'video', 'audio');
    CREATE TABLE "TextScanHold" ("entityType" text, "entityId" int, label text, status text);
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan', 'PendingManualAssignment');
    CREATE TYPE "ModelModifier" AS ENUM ('Archived', 'TakenDown');
    CREATE TABLE "Model" (
      id int PRIMARY KEY, "userId" int NOT NULL, status text NOT NULL DEFAULT 'Published',
      "deletedAt" timestamp, availability text NOT NULL DEFAULT 'Public', mode "ModelModifier"
    );
    CREATE TABLE "ModelVersion" (
      id int PRIMARY KEY, "modelId" int NOT NULL, index int NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'Published', availability text NOT NULL DEFAULT 'Public',
      "publishedAt" timestamp
    );
    CREATE TABLE "Post" (
      id int PRIMARY KEY, "userId" int NOT NULL, "modelVersionId" int,
      "publishedAt" timestamp NOT NULL DEFAULT now() - interval '1 day',
      availability text NOT NULL DEFAULT 'Public'
    );
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL, "postId" int, index int NOT NULL DEFAULT 0,
      ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned', "needsReview" text, "blockedFor" text,
      "nsfwLevel" int NOT NULL DEFAULT 1, "modelRestricted" boolean NOT NULL DEFAULT false,
      type "MediaType" NOT NULL DEFAULT 'image', "nsfwLevelLocked" boolean NOT NULL DEFAULT false,
      metadata jsonb, "scanJobs" jsonb
    );
    CREATE TABLE "Article" (
      id int PRIMARY KEY, "coverId" int, "bannerId" int, cover text, status text,
      "publishedAt" timestamp, availability text, ingestion text
    );
    CREATE TABLE "Model3D" (
      id int PRIMARY KEY, "thumbnailImageId" int, status text, "deletedAt" timestamp,
      availability text
    );
    CREATE TABLE "CollectionItem" (
      id serial PRIMARY KEY, "collectionId" int NOT NULL, status text NOT NULL DEFAULT 'ACCEPTED',
      "addedById" int, "imageId" int, "postId" int, "modelId" int, "articleId" int, "model3dId" int
    );

    INSERT INTO "Model" (id, "userId", mode) VALUES (${LIVE}, ${OWNER}, NULL), (${TAKEN_DOWN}, ${OWNER}, 'TakenDown');
    INSERT INTO "ModelVersion" (id, "modelId") VALUES (20, ${LIVE}), (21, ${TAKEN_DOWN});
    -- The owner's showcase posts, a stranger's post on the taken-down model, and a post on no model.
    INSERT INTO "Post" (id, "userId", "modelVersionId") VALUES
      (30, ${OWNER}, 20), (31, ${OWNER}, 21), (32, ${STRANGER}, 21), (33, ${STRANGER}, NULL);
    INSERT INTO "Image" (id, "userId", "postId") VALUES
      (40, ${OWNER}, 30), (41, ${OWNER}, 31), (42, ${STRANGER}, 32), (43, ${STRANGER}, 33);
    -- On a restricted base model: an R image first on its post with a PG image after it, a PG
    -- image, a live model whose first image is R, and an article cover and 3D thumbnail at R.
    INSERT INTO "Model" (id, "userId") VALUES (12, ${OWNER});
    INSERT INTO "ModelVersion" (id, "modelId") VALUES (22, 12);
    INSERT INTO "Post" (id, "userId", "modelVersionId") VALUES (34, ${STRANGER}, NULL), (35, ${OWNER}, 22);
    INSERT INTO "Image" (id, "userId", "postId", index, "nsfwLevel", "modelRestricted") VALUES
      (44, ${STRANGER}, 34, 0, 4, true), (50, ${STRANGER}, 34, 1, 1, true),
      (45, ${STRANGER}, 33, 1, 1, true),
      (46, ${OWNER}, 35, 0, 4, true), (47, ${OWNER}, 35, 1, 1, false),
      (48, ${STRANGER}, NULL, 0, 4, true), (49, ${STRANGER}, NULL, 0, 4, true);
    INSERT INTO "Article" (id, "coverId", status, "publishedAt", availability, ingestion) VALUES
      (60, 48, 'Published', now() - interval '1 day', 'Public', 'Scanned');
    INSERT INTO "Model3D" (id, "thumbnailImageId", status, availability) VALUES (61, 49, 'Published', 'Public');
    INSERT INTO "CollectionItem" ("collectionId", "addedById", "imageId", "postId", "modelId") VALUES
      (${IMAGE_ON_LIVE}, ${OWNER}, 40, NULL, NULL),
      (${IMAGE_ON_TAKEN_DOWN}, ${STRANGER}, 42, NULL, NULL),
      (${POST_ON_LIVE}, ${OWNER}, NULL, 30, NULL),
      (${POST_ON_TAKEN_DOWN}, ${STRANGER}, NULL, 32, NULL),
      (${MODEL_LIVE}, ${OWNER}, NULL, NULL, ${LIVE}),
      (${MODEL_TAKEN_DOWN}, ${OWNER}, NULL, NULL, ${TAKEN_DOWN}),
      (${IMAGE_ON_NO_MODEL}, ${STRANGER}, 43, NULL, NULL),
      (${POST_ON_NO_MODEL}, ${STRANGER}, NULL, 33, NULL),
      (${TAKEN_DOWN_THEN_LIVE}, ${STRANGER}, NULL, 32, NULL),
      (${TAKEN_DOWN_THEN_LIVE}, ${OWNER}, 40, NULL, NULL),
      (${IMAGE_RESTRICTED_R}, ${STRANGER}, 44, NULL, NULL),
      (${POST_RESTRICTED_R}, ${STRANGER}, NULL, 34, NULL),
      (${IMAGE_RESTRICTED_PG}, ${STRANGER}, 45, NULL, NULL),
      (${MODEL_RESTRICTED_FIRST}, ${OWNER}, NULL, NULL, 12);
    INSERT INTO "CollectionItem" ("collectionId", "addedById", "articleId", "model3dId") VALUES
      (${ARTICLE_RESTRICTED_R}, ${STRANGER}, 60, NULL),
      (${MODEL3D_RESTRICTED_R}, ${STRANGER}, NULL, 61);
  `);
});

const coverOf = async (collectionId: number) => {
  const sql = collectionItemCoversSql({
    collectionIds: [collectionId],
    itemsPerCollection: 4,
    imageSql: Prisma.sql`i.id image`,
  });
  const { rows } = await db.query<{ id: number; image: number | null }>(sql.text, sql.values);
  return rows.map((row) => row.image);
};

describe('collection item covers', () => {
  it.each([
    ['an image item on a live model', IMAGE_ON_LIVE, 40],
    ['a post item on a live model', POST_ON_LIVE, 40],
    ['a model item for a live model', MODEL_LIVE, 40],
    ['an image item on no model', IMAGE_ON_NO_MODEL, 43],
    ['a post item on no model', POST_ON_NO_MODEL, 43],
    ['a PG image item on a restricted base model', IMAGE_RESTRICTED_PG, 45],
    ['a post item past its R image on a restricted base model', POST_RESTRICTED_R, 50],
    ['a model item past its R image on a restricted base model', MODEL_RESTRICTED_FIRST, 47],
  ])('takes the cover from %s', async (_, collectionId, imageId) => {
    expect(await coverOf(collectionId)).toEqual([imageId]);
  });

  it.each([
    ['an image item on a taken-down model', IMAGE_ON_TAKEN_DOWN],
    ['a post item on a taken-down model', POST_ON_TAKEN_DOWN],
    ['a model item for a taken-down model', MODEL_TAKEN_DOWN],
    ['an R image item on a restricted base model', IMAGE_RESTRICTED_R],
    ['an article item whose cover is R on a restricted base model', ARTICLE_RESTRICTED_R],
    ['a 3D model item whose thumbnail is R on a restricted base model', MODEL3D_RESTRICTED_R],
  ])('takes no cover from %s', async (_, collectionId) => {
    expect(await coverOf(collectionId)).toEqual([null]);
  });

  it('skips only the taken-down item, so a later live item still gives a cover', async () => {
    expect(await coverOf(TAKEN_DOWN_THEN_LIVE)).toEqual([null, 40]);
  });
});
