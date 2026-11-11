import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  pendingLevelImageSql,
  pendingOthersImageConditions,
} from '~/server/common/image-visibility';
import { pendingViewerImageSql } from '~/server/services/collection-review.sql';

// The `pending` filters a signed-in non-moderator's image reads apply, run as SQL over seeded rows.

const UPLOADER = 1;
const STRANGER = 2;
const MANAGER = 3;
const COLLECTION_OWNER = 4;
const OTHER_MANAGER = 5;
const COLLECTION = 50;
const OTHER_COLLECTION = 60;
const PG = 1;

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan', 'PendingManualAssignment');
    CREATE TYPE "CollectionContributorPermission" AS ENUM ('VIEW', 'ADD', 'ADD_REVIEW', 'MANAGE');
    CREATE TYPE "CollectionItemStatus" AS ENUM ('ACCEPTED', 'REVIEW', 'REJECTED');
    CREATE TABLE "Collection" (id int PRIMARY KEY, "userId" int NOT NULL);
    CREATE TABLE "CollectionContributor" (
      "collectionId" int, "userId" int, permissions "CollectionContributorPermission"[]
    );
    CREATE TABLE "CollectionItem" (
      id serial PRIMARY KEY, "collectionId" int, status "CollectionItemStatus", "imageId" int,
      "addedById" int
    );
    CREATE TABLE "Post" (id int PRIMARY KEY, "collectionId" int);
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "postId" int, "userId" int, "nsfwLevel" int, "needsReview" text,
      ingestion "ImageIngestionStatus" DEFAULT 'Scanned', "nsfwLevelLocked" boolean DEFAULT false,
      metadata jsonb DEFAULT '{}', "scanJobs" jsonb DEFAULT '{}', "acceptableMinor" boolean NOT NULL DEFAULT false
    );

    INSERT INTO "Collection" VALUES (${COLLECTION}, ${COLLECTION_OWNER}), (${OTHER_COLLECTION}, ${COLLECTION_OWNER});
    INSERT INTO "CollectionContributor" VALUES
      (${COLLECTION}, ${MANAGER}, ARRAY['MANAGE']::"CollectionContributorPermission"[]),
      (${COLLECTION}, ${STRANGER}, ARRAY['ADD']::"CollectionContributorPermission"[]),
      (${OTHER_COLLECTION}, ${OTHER_MANAGER}, ARRAY['MANAGE']::"CollectionContributorPermission"[]);
    INSERT INTO "Post" VALUES (100, NULL), (200, ${COLLECTION});

    INSERT INTO "Image" (id, "postId", "userId", "nsfwLevel", ingestion, "acceptableMinor", "needsReview") VALUES
      (1, 100, ${UPLOADER}, 1, 'Scanned', true, NULL),    -- acceptableMinor
      (2, 100, ${UPLOADER}, 1, 'Scanned', false, NULL),   -- plain, visible to everyone
      (3, 100, ${UPLOADER}, 1, 'Error', false, NULL),     -- rated, never reviewed
      (4, 100, ${UPLOADER}, 1, 'Scanned', false, 'minor'), -- awaiting moderator review
      (10, 200, ${UPLOADER}, 4, 'Scanned', false, NULL),  -- managed collection, above the level
      (11, 200, ${UPLOADER}, 0, 'Pending', false, NULL),  -- managed collection, unrated
      (12, 200, ${UPLOADER}, 32, 'Scanned', false, NULL), -- managed collection, Blocked level
      (13, 200, ${UPLOADER}, 4, 'Scanned', true, NULL),   -- managed collection, acceptableMinor
      (14, 200, ${UPLOADER}, 4, 'Pending', false, NULL),  -- managed collection, rated, never reviewed
      (20, 100, ${UPLOADER}, 1, 'Scanned', true, NULL),   -- REVIEW submission, acceptableMinor
      (21, 100, ${UPLOADER}, 0, 'Pending', false, NULL),  -- REVIEW submission, unrated
      (22, 100, ${UPLOADER}, 1, 'Scanned', true, NULL),   -- ACCEPTED submission, acceptableMinor
      (23, 100, ${UPLOADER}, 1, 'Scanned', true, NULL),   -- REJECTED submission, acceptableMinor
      (24, 100, ${UPLOADER}, 4, 'Scanned', false, NULL),  -- REVIEW submission, above the level
      (25, 100, ${UPLOADER}, 1, 'Scanned', true, NULL),   -- REJECTED, added by the collection owner
      (26, 200, ${UPLOADER}, 4, 'Scanned', true, NULL),   -- REVIEW submission, managed post, above the level
      (27, 100, ${UPLOADER}, 0, 'Pending', false, NULL),  -- REVIEW, unrated, added by the collection owner
      (28, 100, ${UPLOADER}, 0, 'Scanned', false, NULL),  -- REVIEW submission, scanned, unrated
      (30, 100, ${UPLOADER}, 1, 'Scanned', true, NULL);   -- REVIEW submission of another collection

    INSERT INTO "CollectionItem" ("collectionId", status, "imageId", "addedById") VALUES
      (${COLLECTION}, 'REVIEW', 20, ${UPLOADER}), (${COLLECTION}, 'REVIEW', 21, ${UPLOADER}),
      (${COLLECTION}, 'ACCEPTED', 22, ${UPLOADER}), (${COLLECTION}, 'REJECTED', 23, ${UPLOADER}),
      (${COLLECTION}, 'REVIEW', 24, ${UPLOADER}), (${COLLECTION}, 'REJECTED', 25, ${COLLECTION_OWNER}),
      (${COLLECTION}, 'REVIEW', 26, ${UPLOADER}),
      (${COLLECTION}, 'REVIEW', 27, ${COLLECTION_OWNER}), (${OTHER_COLLECTION}, 'REVIEW', 30, ${UPLOADER}),
      (${COLLECTION}, 'REVIEW', 28, ${UPLOADER});
  `);
});
afterAll(() => db.close());

const visibleTo = async (userId: number, reviewCollectionId?: number) => {
  const sql = Prisma.sql`SELECT i.id FROM "Image" i JOIN "Post" p ON p.id = i."postId"
    WHERE ${pendingViewerImageSql({
      userId,
      browsingLevel: PG,
      reviewCollectionId,
    })} ORDER BY i.id`;
  return (await db.query<{ id: number }>(sql.text, sql.values)).rows.map((r) => r.id);
};

describe('a pending image read by a signed-in non-moderator', () => {
  it("shows another user's images only when any read would: reviewed by mods and the scanner, not acceptableMinor, within the level", async () => {
    expect(await visibleTo(STRANGER)).toEqual([2]);
  });

  it('shows the uploader all of their own images within the level, plus their unrated ones', async () => {
    expect(await visibleTo(UPLOADER)).toEqual([1, 2, 3, 4, 11, 20, 21, 22, 23, 25, 27, 28, 30]);
  });

  it("shows a collection manager the collection's reviewed images above the level, and no unrated, Blocked or acceptableMinor ones", async () => {
    expect(await visibleTo(MANAGER)).toEqual([2, 10]);
  });

  // A choice, not an accident: a judge must see a submission that is acceptable only in their
  // collection to reject it. The exception rides on `reviewCollectionId`, which only the review
  // queue sets, and stops at REVIEW and REJECTED items their uploader submitted to a collection the
  // viewer manages, within the viewer's level. Image 27 (unrated, not submitted by its uploader) and
  // 25 stay out.
  it("shows a judge the collection's acceptableMinor and scanned unrated submissions in the review queue", async () => {
    // 21 is 28 before its scan finished: withheld.
    expect(await visibleTo(MANAGER, COLLECTION)).toEqual([2, 10, 20, 23, 28]);
    expect(await visibleTo(COLLECTION_OWNER, COLLECTION)).toEqual([2, 20, 23, 28]);
  });

  it("hides the same submissions from the judge's reads outside the review queue", async () => {
    expect(await visibleTo(MANAGER)).not.toContain(20);
    expect(await visibleTo(COLLECTION_OWNER)).not.toContain(20);
  });

  it('gives the manager of a different collection nothing extra, in or out of the review queue', async () => {
    expect(await visibleTo(OTHER_MANAGER)).toEqual([2]);
    expect(await visibleTo(OTHER_MANAGER, COLLECTION)).toEqual([2]);
  });

  it('gives a contributor without MANAGE nothing extra, in or out of the review queue', async () => {
    expect(await visibleTo(STRANGER, COLLECTION)).toEqual([2]);
  });
});

// getImagesForPosts and getImagesForModelVersion apply these conditions plus their own level check.
const passOthersConditions = async (userId: number) => {
  const sql = Prisma.sql`SELECT i.id FROM "Image" i
    WHERE ${Prisma.join(pendingOthersImageConditions(userId), ' AND ')} ORDER BY i.id`;
  return (await db.query<{ id: number }>(sql.text, sql.values)).rows.map((r) => r.id);
};

describe("the per-image conditions on another user's pending images", () => {
  it('drop images awaiting moderator review, acceptableMinor ones, and rated ones never reviewed', async () => {
    expect(await passOthersConditions(STRANGER)).toEqual([2, 10, 11, 12, 21, 24, 27, 28]);
  });

  it("exempt the viewer's own images", async () => {
    expect(await passOthersConditions(UPLOADER)).toEqual([
      1, 2, 3, 4, 10, 11, 12, 13, 14, 20, 21, 22, 23, 24, 25, 26, 27, 28, 30,
    ]);
  });
});

const passLevel = async (userId: number, ids: number[]) => {
  const sql = Prisma.sql`SELECT i.id FROM "Image" i
    WHERE i.id IN (${Prisma.join(ids)}) AND ${pendingLevelImageSql(userId, PG)} ORDER BY i.id`;
  return (await db.query<{ id: number }>(sql.text, sql.values)).rows.map((r) => r.id);
};

describe('the level check on a pending image read', () => {
  it('keeps an image rated within the level, for anyone', async () => {
    expect(await passLevel(STRANGER, [2])).toEqual([2]);
  });

  it("keeps the viewer's own unrated image", async () => {
    expect(await passLevel(UPLOADER, [11])).toEqual([11]);
  });

  it("drops another user's unrated image", async () => {
    expect(await passLevel(STRANGER, [11])).toEqual([]);
  });

  it("drops an image rated outside the level, even the owner's", async () => {
    expect(await passLevel(STRANGER, [10])).toEqual([]);
    expect(await passLevel(UPLOADER, [10])).toEqual([]);
  });
});
