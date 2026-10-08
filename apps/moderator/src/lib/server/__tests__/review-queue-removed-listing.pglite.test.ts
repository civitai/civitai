import { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * A block keeps the moderator-only review flag, so that queue has to list removed images as well:
 * otherwise a removed, flagged image is held from the purge with no page that can reach it. Every
 * other queue still lists only live images.
 */

// PGlite boots a WASM Postgres; under a full parallel run that alone can pass the default hook budget.
vi.setConfig({ hookTimeout: 60_000 });

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

const { getImageReviewQueue, getImageReviewCounts } = await import('../image-review.service');

const SCHEMA = `
CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'PendingManualAssignment');
CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "username" TEXT, "image" TEXT);
CREATE TABLE "Post" ("id" INTEGER PRIMARY KEY, "title" TEXT);
CREATE TABLE "Image" (
  "id" INTEGER PRIMARY KEY,
  "url" TEXT NOT NULL DEFAULT 'u',
  "nsfwLevel" INTEGER NOT NULL DEFAULT 1,
  "width" INTEGER,
  "height" INTEGER,
  "type" TEXT NOT NULL DEFAULT 'image',
  "needsReview" TEXT,
  "minor" BOOLEAN NOT NULL DEFAULT FALSE,
  "poi" BOOLEAN NOT NULL DEFAULT FALSE,
  "acceptableMinor" BOOLEAN NOT NULL DEFAULT FALSE,
  "blockedFor" TEXT,
  "ingestion" "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned',
  "metadata" JSONB,
  "meta" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "postId" INTEGER,
  "userId" INTEGER NOT NULL DEFAULT 7
);
CREATE TABLE "ImageConnection" ("imageId" INTEGER, "entityType" TEXT, "entityId" INTEGER);
CREATE TABLE "ImageTagForReview" ("imageId" INTEGER, "tagId" INTEGER);
CREATE TABLE "Tag" ("id" INTEGER PRIMARY KEY, "name" TEXT, "nsfwLevel" INTEGER, "type" TEXT);
`;

// Every level, Blocked included, so the browsing-level filter is not what decides a row.
const ALL_LEVELS = 63;

let db: PGlite;

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(SCHEMA);
  await db.exec(`
    INSERT INTO "User" ("id", "username") VALUES (7, 'uploader');
    INSERT INTO "Image" ("id", "needsReview", "ingestion", "nsfwLevel") VALUES
      (1, 'csam', 'Scanned', 4),
      (2, 'csam', 'Blocked', 32),
      (3, 'csam', 'Error', 4),
      (4, 'minor', 'Scanned', 4),
      (5, 'minor', 'Blocked', 32),
      (6, 'csam', 'Blocked', 32);
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterAll(async () => {
  dbHandle.current = null;
  await db.close();
});

const queueIds = async (needsReview: 'csam' | 'minor') =>
  (await getImageReviewQueue({ needsReview, browsingLevel: ALL_LEVELS, limit: 50 })).items.map(
    (i) => ({ id: i.id, ingestion: i.ingestion })
  );

describe('the review-flag queue', () => {
  it('lists removed images beside live ones', async () => {
    expect(await queueIds('csam')).toEqual([
      { id: 6, ingestion: 'Blocked' },
      { id: 2, ingestion: 'Blocked' },
      { id: 1, ingestion: 'Scanned' },
    ]);
  });

  it('counts them in its badge', async () => {
    expect((await getImageReviewCounts()).csam).toBe(3);
  });
});

describe('every other review queue', () => {
  it('still lists only live images', async () => {
    expect(await queueIds('minor')).toEqual([{ id: 4, ingestion: 'Scanned' }]);
  });

  it('still counts only live images', async () => {
    expect((await getImageReviewCounts()).minor).toBe(1);
  });
});
