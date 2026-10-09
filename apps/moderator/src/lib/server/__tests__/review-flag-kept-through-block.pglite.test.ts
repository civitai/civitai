import { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ThumbnailCache from '../thumbnail-cache';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * The moderator-only review flag holds a Blocked image back from the purge until its own queue or a
 * filed report settles it. These writers must leave it on unless they are that decision.
 */

// PGlite boots a WASM Postgres; under a full parallel run that alone can pass the default hook budget.
vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle, recordModActivity, applyBlockSideEffects } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  recordModActivity: vi.fn(async () => undefined),
  applyBlockSideEffects: vi.fn(async () => undefined),
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
  applyBlockSideEffects,
  applyAcceptSideEffects: vi.fn(async () => undefined),
  applyVisibilitySideEffects: vi.fn(async () => undefined),
  refundAppealFee: vi.fn(async () => undefined),
  notifyAppealResolved: vi.fn(async () => undefined),
  emailAppealResolution: vi.fn(async () => undefined),
}));
vi.mock('../thumbnail-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof ThumbnailCache>()),
  invalidateThumbnails: vi.fn(async () => undefined),
}));
vi.mock('../tags-on-image.service', () => ({ upsertTagsOnImageNew: vi.fn() }));
vi.mock('../mod-activity', () => ({ recordModActivity }));
vi.mock('../search-index', () => ({ syncSearchIndex: vi.fn() }));

const { acceptImage, blockImage, dismissReviewFlag, FlagOnlyRemovedError, resolveImageAppeal } =
  await import('../image-moderation.service');

const SCHEMA = `
CREATE TYPE "EntityType" AS ENUM ('Image', 'Post', 'Model');
CREATE TYPE "AppealStatus" AS ENUM ('Pending', 'Approved', 'Rejected');
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
  "nsfwLevelLocked" BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE "ImageTagForReview" ("imageId" INTEGER, "tagId" INTEGER);
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
  "buzzTransactionId" TEXT
);
CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "email" TEXT, "username" TEXT);
CREATE FUNCTION update_nsfw_levels_new(ids INTEGER[]) RETURNS VOID LANGUAGE SQL AS $$ SELECT $$;
`;

const FLAGGED = 51;
const FLAGGED_REMOVED = 52;
const OTHER_FLAG_REMOVED = 53;

let db: PGlite;

// One instance per file: a fresh PGlite per case is what times out under a full-suite run.
beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(SCHEMA);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

beforeEach(async () => {
  recordModActivity.mockClear();
  applyBlockSideEffects.mockClear();
  await db.exec(`TRUNCATE "Image", "Appeal", "User"`);
  await db.query(
    `INSERT INTO "Image" ("id", "userId", "needsReview", "blockedFor", "ingestion", "nsfwLevel") VALUES
      ($1, 7, 'csam', NULL, 'Scanned', 4),
      ($2, 8, 'csam', 'moderated', 'Blocked', 32),
      ($3, 9, 'appeal', 'moderated', 'Blocked', 32)`,
    [FLAGGED, FLAGGED_REMOVED, OTHER_FLAG_REMOVED]
  );
});

afterAll(async () => {
  dbHandle.current = null;
  await db.close();
});

const imageRow = async (id: number) =>
  (
    await db.query<{ needsReview: string | null; ingestion: string | null }>(
      `SELECT "needsReview", "ingestion" FROM "Image" WHERE "id" = $1`,
      [id]
    )
  ).rows[0];

/** A Pending appeal beside the flag cannot be opened today; seeded to prove neither path relies on that. */
const seedPendingAppeal = (imageId: number) =>
  db.query(`INSERT INTO "Appeal" ("userId", "entityType", "entityId") VALUES (7, 'Image', $1)`, [
    imageId,
  ]);

describe('blockImage', () => {
  it('keeps the review flag on the image it blocks', async () => {
    await blockImage({ imageId: FLAGGED, userId: 2 });

    expect(await imageRow(FLAGGED)).toEqual({ needsReview: 'csam', ingestion: 'Blocked' });
  });

  it('does not swap the review flag for the appeal flag', async () => {
    await seedPendingAppeal(FLAGGED);

    await blockImage({ imageId: FLAGGED, userId: 2 });

    expect(await imageRow(FLAGGED)).toEqual({ needsReview: 'csam', ingestion: 'Blocked' });
  });
});

// Removed with only the flag left: the flag's own queue lists it, and must not undo the removal.
describe('an image removed with only the review flag left', () => {
  it('is not put back live by accepting it, and the refusal reaches the caller', async () => {
    await expect(acceptImage({ imageId: FLAGGED_REMOVED, userId: 2 })).rejects.toBeInstanceOf(
      FlagOnlyRemovedError
    );

    expect(await imageRow(FLAGGED_REMOVED)).toEqual({ needsReview: 'csam', ingestion: 'Blocked' });
    expect(recordModActivity).not.toHaveBeenCalled();
  });

  // The main app's Unblock is an explicit decision to restore it, and must still work.
  it('is restored by an explicit unblock', async () => {
    await acceptImage({ imageId: FLAGGED_REMOVED, userId: 2, restoreRemoved: true });

    expect(await imageRow(FLAGGED_REMOVED)).toEqual({ needsReview: null, ingestion: 'Scanned' });
  });

  it('is accepted like any other image while it is still live', async () => {
    await acceptImage({ imageId: FLAGGED, userId: 2 });

    expect(await imageRow(FLAGGED)).toEqual({ needsReview: null, ingestion: 'Scanned' });
  });

  it('is not removed a second time', async () => {
    await blockImage({ imageId: FLAGGED_REMOVED, userId: 2 });

    expect(applyBlockSideEffects).not.toHaveBeenCalled();
    expect(recordModActivity).not.toHaveBeenCalled();
  });
});

describe('dismissReviewFlag', () => {
  it('clears the flag and leaves the image removed', async () => {
    expect(await dismissReviewFlag({ imageId: FLAGGED_REMOVED, userId: 2 })).toBe(true);

    expect(await imageRow(FLAGGED_REMOVED)).toEqual({ needsReview: null, ingestion: 'Blocked' });
  });

  // The purge reads `review`/`bulkRemove` rows as a moderator's takedown of the image; a dismissal
  // recorded as either would license destroying its stored bytes.
  it('records its own activity, not a takedown', async () => {
    await dismissReviewFlag({ imageId: FLAGGED_REMOVED, userId: 2 });

    expect(recordModActivity).toHaveBeenCalledTimes(1);
    expect(recordModActivity).toHaveBeenCalledWith({
      userId: 2,
      entityType: 'image',
      entityId: FLAGGED_REMOVED,
      activity: 'dismissReviewFlag',
    });
  });

  it('refuses an image that is not removed, which would otherwise go live', async () => {
    expect(await dismissReviewFlag({ imageId: FLAGGED, userId: 2 })).toBe(false);

    expect(await imageRow(FLAGGED)).toEqual({ needsReview: 'csam', ingestion: 'Scanned' });
    expect(recordModActivity).not.toHaveBeenCalled();
  });

  it('refuses any other flag', async () => {
    expect(await dismissReviewFlag({ imageId: OTHER_FLAG_REMOVED, userId: 2 })).toBe(false);

    expect(await imageRow(OTHER_FLAG_REMOVED)).toEqual({
      needsReview: 'appeal',
      ingestion: 'Blocked',
    });
  });
});

describe('resolveImageAppeal', () => {
  it('approving does not restore an image under the review flag', async () => {
    await seedPendingAppeal(FLAGGED_REMOVED);

    await resolveImageAppeal({
      imageId: FLAGGED_REMOVED,
      status: 'Approved',
      resolvedReason: 'misclassified',
      userId: 2,
    });

    expect(await imageRow(FLAGGED_REMOVED)).toEqual({ needsReview: 'csam', ingestion: 'Blocked' });
  });

  it('rejecting does not clear the review flag', async () => {
    await seedPendingAppeal(FLAGGED_REMOVED);

    await resolveImageAppeal({
      imageId: FLAGGED_REMOVED,
      status: 'Rejected',
      resolvedReason: 'violation-confirmed',
      userId: 2,
    });

    expect(await imageRow(FLAGGED_REMOVED)).toEqual({ needsReview: 'csam', ingestion: 'Blocked' });
  });
});
