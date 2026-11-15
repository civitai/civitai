import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import {
  collectionItemCoversSql,
  getServableCoverCollectionIds,
} from '~/server/services/collection-cover-visibility';

/**
 * A collection's cover on a minor or SFW-only model's post is served within the model's gallery
 * level: drawn from an item, the next image within it is taken; stored, it is hidden from all but
 * the model's owner and moderators.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const MODEL_OWNER = 1;
const STRANGER = 2;
const HELD = 10;
const UNHELD = 11;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ModelModifier" AS ENUM ('Archived', 'TakenDown');
    CREATE TYPE "CollectionContributorPermission" AS ENUM ('VIEW', 'ADD', 'ADD_REVIEW', 'MANAGE');
    CREATE TABLE "Model" (
      id int PRIMARY KEY, "userId" int NOT NULL, status text NOT NULL DEFAULT 'Published',
      "deletedAt" timestamp, availability text NOT NULL DEFAULT 'Public', mode "ModelModifier",
      minor boolean NOT NULL DEFAULT false, "sfwOnly" boolean NOT NULL DEFAULT false,
      "gallerySettings" jsonb
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
      "nsfwLevel" int NOT NULL DEFAULT 1, "modelRestricted" boolean NOT NULL DEFAULT false
    );
    CREATE TABLE "Article" (
      id int PRIMARY KEY, "coverId" int, "bannerId" int, cover text, status text,
      "publishedAt" timestamp, availability text, ingestion text, "nsfwLevel" int NOT NULL DEFAULT 0
    );
    CREATE TABLE "Model3D" (
      id int PRIMARY KEY, "thumbnailImageId" int, status text, "deletedAt" timestamp,
      availability text
    );
    CREATE TABLE "CollectionItem" (
      id serial PRIMARY KEY, "collectionId" int NOT NULL, status text NOT NULL DEFAULT 'ACCEPTED',
      "addedById" int, "imageId" int, "postId" int, "modelId" int, "articleId" int, "model3dId" int
    );
    CREATE TABLE "CollectionContributor" (
      "collectionId" int, "userId" int, permissions "CollectionContributorPermission"[]
    );

    -- Model 10 is minor with PG stored; model 11 is unflagged.
    INSERT INTO "Model" (id, "userId", minor, "gallerySettings") VALUES
      (${HELD}, ${MODEL_OWNER}, true, '{"level": ${NsfwLevel.PG}}'),
      (${UNHELD}, ${MODEL_OWNER}, false, NULL);
    INSERT INTO "ModelVersion" (id, "modelId") VALUES (20, ${HELD}), (21, ${UNHELD});
    -- The model owner's showcase post and a stranger's post on the held model lead with an X
    -- image; the unheld model's post has only an X image.
    INSERT INTO "Post" (id, "userId", "modelVersionId") VALUES
      (30, ${MODEL_OWNER}, 20), (31, ${STRANGER}, 20), (32, ${MODEL_OWNER}, 21);
    INSERT INTO "Image" (id, "userId", "postId", index, "nsfwLevel") VALUES
      (40, ${MODEL_OWNER}, 30, 0, ${NsfwLevel.X}), (41, ${MODEL_OWNER}, 30, 1, ${NsfwLevel.PG}),
      (42, ${STRANGER}, 31, 0, ${NsfwLevel.X}), (43, ${STRANGER}, 31, 1, ${NsfwLevel.PG}),
      (44, ${MODEL_OWNER}, 32, 0, ${NsfwLevel.X});

    -- Articles with only a legacy cover string: 70 PG, 71 R; 72 has a cover image too.
    INSERT INTO "Image" (id, "userId", "nsfwLevel") VALUES (45, ${STRANGER}, ${NsfwLevel.PG});
    INSERT INTO "Article" (id, "coverId", cover, status, "publishedAt", availability, ingestion, "nsfwLevel") VALUES
      (70, NULL, 'legacy-pg', 'Published', now() - interval '1 day', 'Public', 'Scanned', ${NsfwLevel.PG}),
      (71, NULL, 'legacy-r', 'Published', now() - interval '1 day', 'Public', 'Scanned', ${NsfwLevel.R}),
      (72, 45, 'legacy-with-image', 'Published', now() - interval '1 day', 'Public', 'Scanned', ${NsfwLevel.PG});

    INSERT INTO "CollectionItem" ("collectionId", "addedById", "imageId", "postId", "modelId", "articleId") VALUES
      (100, ${MODEL_OWNER}, 40, NULL, NULL, NULL),
      (101, ${MODEL_OWNER}, 41, NULL, NULL, NULL),
      (102, ${STRANGER}, NULL, 30, NULL, NULL),
      (103, ${STRANGER}, NULL, NULL, ${HELD}, NULL),
      (104, ${STRANGER}, NULL, 31, NULL, NULL),
      (105, ${STRANGER}, NULL, NULL, ${UNHELD}, NULL),
      (106, ${STRANGER}, NULL, NULL, NULL, 70),
      (107, ${STRANGER}, NULL, NULL, NULL, 71),
      (108, ${STRANGER}, NULL, NULL, NULL, 72);
  `);
});

const itemCovers = async (collectionId: number) => {
  const sql = collectionItemCoversSql({
    collectionIds: [collectionId],
    itemsPerCollection: 4,
    imageSql: Prisma.sql`i.id image`,
  });
  const { rows } = await db.query<{ image: number | null; src: string | null }>(
    sql.text,
    sql.values
  );
  return rows;
};

describe('a cover drawn from an item of a minor or SFW-only model', () => {
  it.each([
    ['an image item above the gallery level', 100, null],
    ['an image item within it', 101, 41],
    ["a post item on the model owner's post", 102, 41],
    ["a post item on a stranger's post", 104, 43],
    ['a model item', 103, 41],
    ['a model item for an unheld model', 105, 44],
  ])('%s takes the first image within the gallery level', async (_, collectionId, image) => {
    expect((await itemCovers(collectionId)).map((row) => row.image)).toEqual([image]);
  });
});

describe("an article item's legacy cover string", () => {
  it.each([
    ['an SFW article with no cover image', 106, 'legacy-pg'],
    ['a mature article with no cover image', 107, null],
    ['an article with a cover image', 108, null],
  ])('%s', async (_, collectionId, src) => {
    expect((await itemCovers(collectionId)).map((row) => row.src)).toEqual([src]);
  });
});

describe('a stored cover on a minor or SFW-only model', () => {
  const raw = () => ({ $queryRaw: pgliteRaw(db).queryRaw } as never);
  // Collection 200 is the stranger's, with their own X image on the held model as its cover.
  const above = [{ collectionId: 200, collectionOwnerId: STRANGER, imageId: 42 }];
  const within = [{ collectionId: 201, collectionOwnerId: STRANGER, imageId: 43 }];

  it.each([
    ['a signed-out viewer', undefined],
    ['the collection and image owner, who does not own the model', { id: STRANGER }],
  ])('is hidden from %s when above the gallery level', async (_, viewer) => {
    expect([...(await getServableCoverCollectionIds(above, viewer, raw()))]).toEqual([]);
  });

  it.each([
    ['the model owner', { id: MODEL_OWNER }],
    ['a moderator', { id: 99, isModerator: true }],
  ])('is shown to %s', async (_, viewer) => {
    expect([...(await getServableCoverCollectionIds(above, viewer, raw()))]).toEqual([200]);
  });

  it('is shown to anyone when within the gallery level', async () => {
    expect([...(await getServableCoverCollectionIds(within, undefined, raw()))]).toEqual([201]);
  });
});
