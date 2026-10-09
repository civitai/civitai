import { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';
import { walkPages } from './keyset-walk.harness';

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));

const { getImageReviewQueue, getReportedImageQueue } = await import('../image-review.service');
const { getComicReviewQueue } = await import('../comic-review.service');
const { getImagesPendingIngestion, getIngestionErrorImages } = await import('../ingestion.service');
const { getImageTagReviewQueue } = await import('../image-tags.service');
const { getImageRatingRequests } = await import('../image-rating-review.service');

const SCHEMA = `
CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'PendingManualAssignment');
CREATE TABLE "User" (
  "id" INTEGER PRIMARY KEY, "username" TEXT, "image" TEXT,
  "deletedAt" TIMESTAMP(3), "bannedAt" TIMESTAMP(3)
);
CREATE TABLE "Post" ("id" INTEGER PRIMARY KEY, "title" TEXT);
CREATE TABLE "Image" (
  "id" INTEGER PRIMARY KEY,
  "url" TEXT NOT NULL DEFAULT 'u',
  "name" TEXT,
  "nsfwLevel" INTEGER NOT NULL DEFAULT 1,
  "width" INTEGER,
  "height" INTEGER,
  "type" TEXT NOT NULL DEFAULT 'image',
  "needsReview" TEXT,
  "minor" BOOLEAN NOT NULL DEFAULT FALSE,
  "poi" BOOLEAN NOT NULL DEFAULT FALSE,
  "acceptableMinor" BOOLEAN NOT NULL DEFAULT FALSE,
  "nsfwLevelLocked" BOOLEAN NOT NULL DEFAULT FALSE,
  "blockedFor" TEXT,
  "tosViolation" BOOLEAN NOT NULL DEFAULT FALSE,
  "ingestion" "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned',
  "metadata" JSONB,
  "meta" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "postId" INTEGER,
  "userId" INTEGER NOT NULL DEFAULT 7
);
CREATE TABLE "ImageConnection" ("imageId" INTEGER, "entityType" TEXT, "entityId" INTEGER);
CREATE TABLE "Report" (
  "id" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL DEFAULT 7, "reason" TEXT NOT NULL DEFAULT 'TOSViolation',
  "status" TEXT NOT NULL DEFAULT 'Pending', "details" JSONB, "alsoReportedBy" INTEGER[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE TABLE "ImageReport" ("imageId" INTEGER, "reportId" INTEGER);
CREATE TABLE "ComicProject" (
  "id" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL, "name" TEXT, "status" TEXT,
  "tosViolation" BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE "ComicChapter" ("projectId" INTEGER, "position" INTEGER, "name" TEXT, "status" TEXT);
CREATE TABLE "ComicPanel" (
  "id" INTEGER PRIMARY KEY, "position" INTEGER NOT NULL DEFAULT 0, "chapterPosition" INTEGER NOT NULL,
  "projectId" INTEGER NOT NULL, "prompt" TEXT, "enhancedPrompt" TEXT, "metadata" JSONB,
  "imageId" INTEGER NOT NULL
);
CREATE TABLE "Tag" ("id" INTEGER PRIMARY KEY, "name" TEXT, "nsfwLevel" INTEGER, "type" TEXT);
CREATE TABLE "TagsOnImageNew" ("imageId" INTEGER, "tagId" INTEGER, "attributes" INTEGER);
CREATE TABLE "TagsOnImageDetails" (
  "imageId" INTEGER, "tagId" INTEGER, "needsReview" BOOLEAN, "disabled" BOOLEAN
);
CREATE TABLE "TagsOnImageVote" ("imageId" INTEGER, "tagId" INTEGER, "vote" INTEGER);
CREATE TABLE "ImageTagForReview" ("imageId" INTEGER, "tagId" INTEGER);
CREATE TABLE "ImageRatingRequest" (
  "imageId" INTEGER, "weight" INTEGER, "nsfwLevel" INTEGER, "status" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);
`;

const IMAGE_IDS = [101, 102, 103, 104, 105];
const NEWEST_FIRST = [...IMAGE_IDS].reverse();

let db: PGlite;

// One instance per file: a fresh PGlite per case is what times out under a full-suite run.
beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(SCHEMA);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

beforeEach(async () => {
  const { rows } = await db.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
  );
  await db.exec(`
    TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')};
    INSERT INTO "User" ("id", "username") VALUES (7, 'uploader');
  `);
});

afterAll(async () => {
  dbHandle.current = null;
  await db.close();
});

const insertImages = async (columns: string, values: (id: number, n: number) => string) => {
  for (const [n, id] of IMAGE_IDS.entries())
    await db.exec(`INSERT INTO "Image" ("id", ${columns}) VALUES (${id}, ${values(id, n)})`);
};

const LIMITS = [1, 2, 3, 4];

describe('keyset queues reach every item exactly once', () => {
  it.each(LIMITS)('image review queue at %i per page', async (limit) => {
    await insertImages(`"needsReview"`, () => `'minor'`);

    const seen = await walkPages<number>((cursor) =>
      getImageReviewQueue({ needsReview: 'minor', browsingLevel: 1, cursor, limit })
    );

    expect(seen).toEqual(NEWEST_FIRST);
  });

  it.each(LIMITS)('reported image queue at %i per page', async (limit) => {
    await insertImages(`"nsfwLevel"`, () => `1`);
    // Report ids run opposite to image ids, so the walk follows the report cursor, not the image id.
    for (const [n, imageId] of NEWEST_FIRST.entries()) {
      await db.exec(`INSERT INTO "Report" ("id") VALUES (${501 + n})`);
      await db.exec(`INSERT INTO "ImageReport" VALUES (${imageId}, ${501 + n})`);
    }

    const seen = await walkPages<number>((cursor) =>
      getReportedImageQueue({ browsingLevel: 1, cursor, limit })
    );

    expect(seen).toEqual(NEWEST_FIRST);
  });

  it.each(LIMITS)('comic panel queue at %i per page', async (limit) => {
    await insertImages(`"needsReview"`, () => `'minor'`);
    await db.exec(`INSERT INTO "ComicProject" VALUES (1, 7, 'p', 'Active', false)`);
    await db.exec(`INSERT INTO "ComicChapter" VALUES (1, 0, 'c', 'Published')`);
    for (const id of IMAGE_IDS)
      await db.exec(
        `INSERT INTO "ComicPanel" ("id", "chapterPosition", "projectId", "imageId") VALUES (${id}, 0, 1, ${id})`
      );

    const seen = await walkPages<number>((cursor) => getComicReviewQueue({ cursor, limit }));

    expect(seen).toEqual(NEWEST_FIRST);
  });

  it.each(LIMITS)('pending ingestion queue at %i per page', async (limit) => {
    await insertImages(`"ingestion", "createdAt"`, () => `'Pending', now() - interval '1 hour'`);

    const seen = await walkPages<number>((cursor) =>
      getImagesPendingIngestion({ view: 'recent', cursor, limit })
    );

    expect(seen).toEqual(NEWEST_FIRST);
  });

  it.each(LIMITS)('ingestion error queue at %i per page', async (limit) => {
    // createdAt runs opposite to id: the cursor is an id, so the order must be by id too or a page
    // boundary lands somewhere else in the sequence.
    await insertImages(
      `"ingestion", "nsfwLevel", "createdAt"`,
      (_, n) => `'Error', 0, now() - interval '1 day' - make_interval(mins => ${n})`
    );

    const seen = await walkPages<number>((cursor) => getIngestionErrorImages({ cursor, limit }));

    expect(seen).toEqual(NEWEST_FIRST);
  });

  it.each(LIMITS)('image tag review queue at %i per page', async (limit) => {
    await insertImages(`"nsfwLevel"`, () => `1`);
    for (const id of IMAGE_IDS)
      await db.exec(`INSERT INTO "TagsOnImageNew" VALUES (${id}, 1, ${1 << 9})`);

    const seen = await walkPages<number>((cursor) => getImageTagReviewQueue({ cursor, limit }));

    expect(seen).toEqual(NEWEST_FIRST);
  });

  it.each(LIMITS)('image rating request queue at %i per page', async (limit) => {
    await insertImages(`"nsfwLevel"`, () => `1`);
    for (const id of IMAGE_IDS)
      await db.exec(`INSERT INTO "ImageRatingRequest" VALUES (${id}, 3, 4, 'Pending', now())`);

    const seen = await walkPages<number>((cursor) => getImageRatingRequests({ cursor, limit }));

    expect(seen).toEqual(IMAGE_IDS);
  });
});
