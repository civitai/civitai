import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  reviewCollectionImageSql,
  reviewQueueVisibleTargetSql,
} from '~/server/services/collection-review.sql';

const OWNER = 10;
const MANAGER = 20;
const STRANGER = 30;
const ALL_LEVELS = 31;

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan', 'PendingManualAssignment');
    CREATE TYPE "ArticleIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'Rescan');
    CREATE TYPE "ArticleStatus" AS ENUM ('Draft', 'Published', 'Unpublished');
    CREATE TYPE "ModelStatus" AS ENUM ('Draft', 'Published', 'Unpublished');
    CREATE TYPE "ModelModifier" AS ENUM ('Archived', 'TakenDown');
    CREATE TYPE "CollectionContributorPermission" AS ENUM ('VIEW', 'ADD', 'ADD_REVIEW', 'MANAGE');
    CREATE TABLE "Collection" (id int PRIMARY KEY, "userId" int NOT NULL);
    CREATE TABLE "CollectionContributor" (
      "collectionId" int, "userId" int, permissions "CollectionContributorPermission"[]
    );
    CREATE TABLE "CollectionItem" (
      id serial PRIMARY KEY, "collectionId" int, status text,
      "imageId" int, "postId" int, "modelId" int, "articleId" int
    );
    CREATE TABLE "Post" (
      id int PRIMARY KEY, "publishedAt" timestamp(3), availability "Availability" DEFAULT 'Public',
      "nsfwLevel" int DEFAULT 1, metadata jsonb DEFAULT '{}'
    );
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "postId" int, "nsfwLevel" int DEFAULT 1, "needsReview" text,
      ingestion "ImageIngestionStatus" DEFAULT 'Scanned', "blockedFor" text,
      "modelRestricted" boolean DEFAULT false
    );
    CREATE TABLE "Article" (
      id int PRIMARY KEY, status "ArticleStatus", "publishedAt" timestamp(3),
      ingestion "ArticleIngestionStatus", "nsfwLevel" int DEFAULT 1
    );
    CREATE TABLE "Model" (id int PRIMARY KEY, availability "Availability" DEFAULT 'Public');
    CREATE TABLE "ModelMetric" (
      "modelId" int PRIMARY KEY, status "ModelStatus", "nsfwLevel" int DEFAULT 1, mode "ModelModifier"
    );

    INSERT INTO "Collection" VALUES (1, ${OWNER}), (2, ${OWNER});
    INSERT INTO "CollectionContributor" VALUES (1, ${MANAGER}, ARRAY['MANAGE']::"CollectionContributorPermission"[]),
      (1, ${STRANGER}, ARRAY['ADD']::"CollectionContributorPermission"[]);

    INSERT INTO "Post" (id, "publishedAt", availability, metadata) VALUES
      (100, now() - interval '1 day', 'Public', '{}'),
      (101, now() - interval '1 day', 'Private', '{}'),
      (102, NULL, 'Public', '{}'),
      (103, now() - interval '1 day', 'Public', '{"unpublishedAt": "2026-10-01"}');

    INSERT INTO "Image" (id, "postId", "nsfwLevel", "needsReview", ingestion, "blockedFor") VALUES
      (1, 100, 1, NULL, 'Scanned', NULL),     -- rated, visible
      (2, 100, 0, NULL, 'Pending', NULL),     -- not yet rated
      (3, 100, 1, NULL, 'Blocked', NULL),
      (4, 100, 1, NULL, 'Scanned', 'tos'),
      (5, 100, 1, 'minor', 'Scanned', NULL),
      (6, 101, 1, NULL, 'Scanned', NULL),     -- on a Private post
      (7, 102, 1, NULL, 'Scanned', NULL),     -- on a draft post
      (8, 103, 1, NULL, 'Scanned', NULL),     -- on an unpublished post
      (9, 100, 0, NULL, 'Pending', NULL),     -- not yet rated, ACCEPTED
      (10, 100, 0, NULL, 'Pending', NULL);    -- not yet rated, in another collection

    INSERT INTO "Article" VALUES (200, 'Published', now(), 'Scanned', 1), (201, 'Published', now(), 'Pending', 1);
    INSERT INTO "Model" VALUES (300, 'Public'), (301, 'Private');
    INSERT INTO "ModelMetric" VALUES (300, 'Published', 1, NULL), (301, 'Published', 1, NULL);

    INSERT INTO "CollectionItem" ("collectionId", status, "imageId") VALUES
      (1, 'REVIEW', 1), (1, 'REVIEW', 2), (1, 'REVIEW', 3), (1, 'REVIEW', 4), (1, 'REVIEW', 5),
      (1, 'REVIEW', 6), (1, 'REVIEW', 7), (1, 'REVIEW', 8), (1, 'ACCEPTED', 9), (2, 'REVIEW', 10);
    INSERT INTO "CollectionItem" ("collectionId", status, "postId") VALUES (1, 'REVIEW', 100), (1, 'REVIEW', 101);
    INSERT INTO "CollectionItem" ("collectionId", status, "articleId") VALUES (1, 'REVIEW', 200), (1, 'REVIEW', 201);
    INSERT INTO "CollectionItem" ("collectionId", status, "modelId") VALUES (1, 'REVIEW', 300), (1, 'REVIEW', 301);
  `);
});
afterAll(() => db.close());

async function rows<T>(sql: Prisma.Sql) {
  return (await db.query<T>(sql.text, sql.values)).rows;
}

describe('the images a collection reviewer sees before they are rated', () => {
  const visibleTo = async (userId: number, collectionId = 1) =>
    (
      await rows<{ id: number }>(
        Prisma.sql`SELECT i.id FROM "Image" i WHERE ${reviewCollectionImageSql({
          collectionId,
          userId,
        })} ORDER BY i.id`
      )
    ).map((r) => r.id);

  it("shows the owner and a manager the collection's unrated submission", async () => {
    expect(await visibleTo(OWNER)).toEqual([2]);
    expect(await visibleTo(MANAGER)).toEqual([2]);
  });

  it('shows nothing to a contributor without MANAGE', async () => {
    expect(await visibleTo(STRANGER)).toEqual([]);
  });

  it("does not reach an ACCEPTED item or another collection's items", async () => {
    expect(await visibleTo(OWNER)).not.toContain(9);
    expect(await visibleTo(OWNER)).not.toContain(10);
    expect(await visibleTo(OWNER, 2)).toEqual([10]);
  });
});

describe('the review queue count', () => {
  const counted = async (column: 'imageId' | 'postId' | 'articleId' | 'modelId') =>
    (
      await rows<{ id: number }>(
        Prisma.sql`SELECT ci.${Prisma.raw(`"${column}"`)} AS id FROM "CollectionItem" ci
          WHERE ci."collectionId" = 1 AND ci.status = 'REVIEW'
            AND ci.${Prisma.raw(`"${column}"`)} IS NOT NULL
            AND ${reviewQueueVisibleTargetSql(ALL_LEVELS)}
          ORDER BY 1`
      )
    ).map((r) => r.id);

  it('counts the submissions the queue shows, rated or not', async () => {
    expect(await counted('imageId')).toEqual([1, 2]);
  });

  it('leaves out posts, articles and models the queue does not show', async () => {
    expect(await counted('postId')).toEqual([100]);
    expect(await counted('articleId')).toEqual([200]);
    expect(await counted('modelId')).toEqual([300]);
  });
});
