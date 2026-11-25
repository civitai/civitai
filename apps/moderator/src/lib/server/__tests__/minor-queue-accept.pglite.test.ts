import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as ThumbnailCache from '../thumbnail-cache';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * PERMIT site of the minor content rule: a moderator's plain Accept in the minor review queue clears
 * the minor flag on mature images and keeps it on safe ones. It is not a gate that hides, so it stays
 * off the shared rule; swapping the rule in here would keep mature images flagged.
 */

vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../removal-hold', () => ({
  holdRemovals: vi.fn(async (requests: { imageId: number }[]) => ({
    held: [],
    proceed: requests.map((r) => r.imageId),
  })),
}));
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
vi.mock('../image-moderation-effects', () => ({
  applyBlockSideEffects: vi.fn(async () => undefined),
  applyAcceptSideEffects: vi.fn(async () => undefined),
  applyVisibilitySideEffects: vi.fn(async () => undefined),
  refundAppealFee: vi.fn(async () => undefined),
  notifyAppealResolved: vi.fn(async () => undefined),
  emailAppealResolution: vi.fn(async () => undefined),
  trackImageRestore: vi.fn(async () => undefined),
}));
vi.mock('../thumbnail-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof ThumbnailCache>()),
  invalidateThumbnails: vi.fn(async () => undefined),
}));
vi.mock('../tags-on-image.service', () => ({ upsertTagsOnImageNew: vi.fn() }));
vi.mock('../mod-activity', () => ({ recordModActivity: vi.fn(async () => undefined) }));
vi.mock('../search-index', () => ({ syncSearchIndex: vi.fn() }));
// The models-index requeue is covered in image-models-reindex.pglite.test.ts; this schema has no Post table.
vi.mock('../image-models-reindex', () => ({
  queueDocumentsForImageMinorChanges: vi.fn(async () => undefined),
}));

// The article lookup is covered in article-cover-reindex.pglite.test.ts; this schema has no Article table.
vi.mock('../article-cover-reindex', () => ({
  queueArticlesForCoverImages: vi.fn(async () => undefined),
}));

const { acceptImage, ImageChangedError } = await import('../image-moderation.service');
const { queueArticlesForCoverImages } = await import('../article-cover-reindex');
const { queueDocumentsForImageMinorChanges } = await import('../image-models-reindex');

const SCHEMA = `
CREATE TYPE "EntityType" AS ENUM ('Image', 'Post', 'Model');
CREATE TYPE "AppealStatus" AS ENUM ('Pending', 'Approved', 'Rejected');
CREATE DOMAIN "ImageIngestionStatus" AS TEXT;
CREATE TABLE "ModerationRule" ("id" INTEGER PRIMARY KEY, "action" TEXT NOT NULL);
CREATE TABLE "ModerationRuleVersion" ("ruleId" INTEGER, "action" TEXT);
CREATE TABLE "Image" (
  "id" INTEGER PRIMARY KEY,
  "type" TEXT,
  "needsReview" TEXT,
  "blockedFor" TEXT,
  "ingestion" TEXT,
  "metadata" JSONB,
  "pHash" BIGINT,
  "postId" INTEGER,
  "userId" INTEGER,
  "updatedAt" TIMESTAMP(3),
  "nsfwLevel" INTEGER NOT NULL DEFAULT 0,
  "nsfwLevelLocked" BOOLEAN NOT NULL DEFAULT FALSE,
  "minor" BOOLEAN NOT NULL DEFAULT FALSE,
  "scannedAt" TIMESTAMP(3)
);
CREATE TABLE "ImageTagForReview" ("imageId" INTEGER, "tagId" INTEGER);
CREATE TABLE "JobQueue" ("type" TEXT, "entityType" TEXT, "entityId" INTEGER, "data" JSONB,
  PRIMARY KEY ("entityType", "entityId", "type"));
CREATE TABLE "TagsOnImageDetails" ("imageId" INTEGER, "disabled" BOOLEAN);
ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS "scanJobs" JSONB;
CREATE TABLE "Appeal" (
  "id" SERIAL PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "entityType" "EntityType" NOT NULL,
  "entityId" INTEGER NOT NULL,
  "status" "AppealStatus" NOT NULL DEFAULT 'Pending',
  "resolvedBy" INTEGER,
  "resolvedAt" TIMESTAMP(3),
  "resolvedMessage" TEXT,
  "resolvedReason" TEXT,
  "internalNotes" TEXT,
  "buzzTransactionId" TEXT,
  "entityRemovedAt" TIMESTAMP(3)
);
CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "deletedAt" TIMESTAMP(3), "bannedAt" TIMESTAMP(3), "email" TEXT, "username" TEXT);
CREATE FUNCTION update_nsfw_levels_new(ids INTEGER[]) RETURNS VOID LANGUAGE SQL AS $$ SELECT $$;
CREATE TYPE "CsamQueueSetAsideOutcome" AS ENUM ('AfterReport', 'Dismissed');
CREATE TABLE "CsamQueueSetAside" (
  "imageId" INTEGER PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "outcome" "CsamQueueSetAsideOutcome" NOT NULL,
  "csamReportId" INTEGER,
  "moderatorId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "ModActivity" (
  "id" SERIAL PRIMARY KEY, "userId" INTEGER, "activity" TEXT NOT NULL, "entityType" TEXT,
  "entityId" INTEGER, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);
`;

// Rating -> whether the image is still flagged as a minor after a plain Accept.
const LEVELS: [number, boolean][] = [
  [0, true],
  [1, true],
  [2, true],
  [4, false],
  [8, false],
  [16, false],
];

let db: PGlite;

beforeAll(async () => {
  db = await freshPglite();
  await db.exec(SCHEMA);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
  for (const [i, [nsfwLevel]] of LEVELS.entries())
    await db.query(
      `INSERT INTO "Image" ("id", "userId", "needsReview", "ingestion", "nsfwLevel", "minor")
       VALUES ($1, 7, 'minor', 'Scanned', $2, TRUE)`,
      [i + 1, nsfwLevel]
    );
});

afterAll(async () => {
  dbHandle.current = null;
  await db.close();
});

describe('minor queue Accept', () => {
  it('clears the minor flag on mature images and keeps it on safe ones', async () => {
    for (const [i] of LEVELS.entries()) await acceptImage({ imageId: i + 1, userId: 2 });

    const { rows } = await db.query<{ nsfwLevel: number; minor: boolean }>(
      `SELECT "nsfwLevel", "minor" FROM "Image" ORDER BY "id"`
    );
    expect(rows.map((row) => [row.nsfwLevel, row.minor])).toEqual(LEVELS);
  });

  // The accept rewrites "minor", which no trigger watches.
  it('queues the articles each accepted image covers', async () => {
    await db.query(`UPDATE "Image" SET "needsReview" = 'minor' WHERE "id" = 1`);
    vi.mocked(queueArticlesForCoverImages).mockClear();
    await acceptImage({ imageId: 1, userId: 2 });
    expect(queueArticlesForCoverImages).toHaveBeenCalledWith([1]);
  });

  it('queues the models whose showcase can hold each accepted image', async () => {
    await db.query(`UPDATE "Image" SET "needsReview" = 'minor' WHERE "id" = 1`);
    vi.mocked(queueDocumentsForImageMinorChanges).mockClear();
    await acceptImage({ imageId: 1, userId: 2 });
    expect(queueDocumentsForImageMinorChanges).toHaveBeenCalledWith({ minorImageIds: [1] });
  });

  it('queues neither for an accept out of another queue (control)', async () => {
    await db.query(`UPDATE "Image" SET "needsReview" = 'newUser' WHERE "id" = 1`);
    vi.mocked(queueArticlesForCoverImages).mockClear();
    vi.mocked(queueDocumentsForImageMinorChanges).mockClear();
    await acceptImage({ imageId: 1, userId: 2 });
    expect(queueArticlesForCoverImages).not.toHaveBeenCalled();
    expect(queueDocumentsForImageMinorChanges).not.toHaveBeenCalledWith(
      expect.objectContaining({ minorImageIds: expect.anything() })
    );
  });

  // A moderator removed it after the page loaded: the removal cleared the flag the page showed.
  it("refuses an accept from a page loaded before a moderator's removal", async () => {
    await db.query(
      `UPDATE "Image" SET "needsReview" = NULL, "blockedFor" = 'moderated', ingestion = 'Blocked',
         "nsfwLevel" = 32 WHERE "id" = 1`
    );

    await expect(
      acceptImage({ imageId: 1, userId: 2, shownNeedsReview: 'minor' })
    ).rejects.toBeInstanceOf(ImageChangedError);

    const { rows } = await db.query(`SELECT ingestion FROM "Image" WHERE "id" = 1`);
    expect(rows).toEqual([{ ingestion: 'Blocked' }]);
  });

  // The reported queue shows one image on several cards and does not reload between verdicts.
  it("does not refuse a report verdict over a flag another card's verdict already cleared", async () => {
    await db.query(
      `UPDATE "Image" SET "needsReview" = NULL, "blockedFor" = NULL, ingestion = 'Scanned' WHERE "id" = 1`
    );

    await acceptImage({
      imageId: 1,
      userId: 2,
      keepModeratorRemoved: true,
      shownNeedsReview: 'minor',
    });
  });

  it('accepts when the flag is still the one the page showed', async () => {
    await db.query(`UPDATE "Image" SET "needsReview" = 'minor' WHERE "id" = 1`);

    await acceptImage({ imageId: 1, userId: 2, shownNeedsReview: 'minor' });

    const { rows } = await db.query(`SELECT "needsReview" FROM "Image" WHERE "id" = 1`);
    expect(rows).toEqual([{ needsReview: null }]);
  });
});
