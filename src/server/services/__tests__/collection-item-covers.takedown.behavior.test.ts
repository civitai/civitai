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

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
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
      ingestion text NOT NULL DEFAULT 'Scanned', "needsReview" text, "blockedFor" text,
      "nsfwLevel" int NOT NULL DEFAULT 1
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
      (${TAKEN_DOWN_THEN_LIVE}, ${OWNER}, 40, NULL, NULL);
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
  ])('takes the cover from %s', async (_, collectionId, imageId) => {
    expect(await coverOf(collectionId)).toEqual([imageId]);
  });

  it.each([
    ['an image item on a taken-down model', IMAGE_ON_TAKEN_DOWN],
    ['a post item on a taken-down model', POST_ON_TAKEN_DOWN],
    ['a model item for a taken-down model', MODEL_TAKEN_DOWN],
  ])('takes no cover from %s', async (_, collectionId) => {
    expect(await coverOf(collectionId)).toEqual([null]);
  });

  it('skips only the taken-down item, so a later live item still gives a cover', async () => {
    expect(await coverOf(TAKEN_DOWN_THEN_LIVE)).toEqual([null, 40]);
  });
});
