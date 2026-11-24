import type { PGlite } from '@electric-sql/pglite';
import { MOD_ACTION } from '@civitai/moderation';
import { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import type * as ThumbnailCache from '../thumbnail-cache';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * The main app's Unblock is an explicit restore, so it may put back an image a review queue cannot.
 * A CSAM block is the exception: it is lifted only through its own review, never by this restore.
 */

vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle, replicaHandle } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  // Set to stand in for a replica that has not caught up; null reads the primary.
  replicaHandle: { current: null as unknown },
}));

vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return replicaHandle.current ?? dbHandle.current;
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

const { modActions } = await import('../mod-actions/registry');
const { trackImageRestore } = await import('../image-moderation-effects');

const SCHEMA = `
CREATE TYPE "EntityType" AS ENUM ('Image', 'Post', 'Model');
CREATE TYPE "AppealStatus" AS ENUM ('Pending', 'Approved', 'Rejected');
CREATE DOMAIN "ImageIngestionStatus" AS TEXT;
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
  "scannedAt" TIMESTAMP(3),
  "scanJobs" JSONB
);
CREATE TABLE "ImageTagForReview" ("imageId" INTEGER, "tagId" INTEGER);
CREATE TABLE "TagsOnImageDetails" ("imageId" INTEGER, "tagId" INTEGER, "disabled" BOOLEAN);
CREATE TABLE "ModActivity" ("entityType" TEXT, "entityId" INTEGER, "activity" TEXT);
CREATE TABLE "JobQueue" ("type" TEXT, "entityType" TEXT, "entityId" INTEGER, "data" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  PRIMARY KEY ("entityType", "entityId", "type"));
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
CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "deletedAt" TIMESTAMP(3), "email" TEXT, "username" TEXT);
-- Rates a restored image as its tags would: an untagged one would go back to the scanner.
CREATE FUNCTION update_nsfw_levels_new(ids INTEGER[]) RETURNS VOID LANGUAGE SQL AS $$
  UPDATE "Image" SET "nsfwLevel" = 1
  WHERE id = ANY(ids) AND NOT "nsfwLevelLocked" AND "ingestion" = 'Scanned' AND "blockedFor" IS NULL;
$$;
`;

const CSAM = 1;
const MODERATED = 2;

let db: PGlite;
let laggingReplica: PGlite;

beforeAll(async () => {
  db = await freshPglite();
  await db.exec(SCHEMA);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
  laggingReplica = await freshPglite();
  await laggingReplica.exec(SCHEMA);
});

beforeEach(async () => {
  await db.exec(`
    TRUNCATE "Image", "ImageTagForReview", "User", "JobQueue";
    INSERT INTO "Image" ("id", "userId", "ingestion", "blockedFor", "nsfwLevel", "needsReview") VALUES
      (${CSAM}, 7, 'Blocked', 'CSAM', 32, 'csam'),
      (${MODERATED}, 8, 'Blocked', 'moderated', 32, NULL);
  `);
  replicaHandle.current = null;
});

afterAll(async () => {
  dbHandle.current = null;
  replicaHandle.current = null;
  await db.close();
  await laggingReplica.close();
});

const row = async (id: number) =>
  (
    await db.query<{ ingestion: string; blockedFor: string | null; needsReview: string | null }>(
      `SELECT "ingestion", "blockedFor", "needsReview" FROM "Image" WHERE "id" = $1`,
      [id]
    )
  ).rows[0];

const unblock = (ids: number[]) =>
  modActions[MOD_ACTION.imageModerate].handler({ ids, reviewAction: 'unblock', userId: 2 });

describe('imageModerate unblock of a CSAM-blocked image', () => {
  it('leaves the CSAM block, restores the rest of the batch and says what it skipped', async () => {
    const answer = await unblock([CSAM, MODERATED]).catch((e: unknown) => e);

    expect(await row(CSAM)).toEqual({
      ingestion: 'Blocked',
      blockedFor: 'CSAM',
      needsReview: 'csam',
    });
    // Control: the other image in the same batch is restored.
    expect(await row(MODERATED)).toEqual({
      ingestion: 'Scanned',
      blockedFor: null,
      needsReview: null,
    });
    // A 409 is what makes the main app show the moderator the image is still down.
    expect(answer).toMatchObject({
      status: 409,
      message: `Image ${CSAM} was not restored: it can only be restored through its own review. Image ${MODERATED} was restored.`,
    });
  });

  it('answers as before when nothing in the batch is CSAM-blocked', async () => {
    await expect(unblock([MODERATED])).resolves.toEqual({ count: 1, restored: 1, kept: 0 });
  });

  // Policy: LIFT_WHILE_OWNER_DELETED in @civitai/shared/account-deletion-grace: a deleted owner's image is never served.
  it('counts an image kept blocked for its deleted owner apart from the restored ones', async () => {
    await db.exec(`INSERT INTO "User" ("id", "deletedAt") VALUES (8, now())`);

    await expect(unblock([MODERATED])).resolves.toEqual({ count: 1, restored: 0, kept: 1 });
    expect(await row(MODERATED)).toMatchObject({ ingestion: 'Blocked' });
  });
});

describe('imageModerate unblock when the replica has not caught up', () => {
  it('reads the primary for the image, its review tags and the restore event', async () => {
    await db.exec(`INSERT INTO "ImageTagForReview" ("imageId", "tagId") VALUES (${MODERATED}, 5);`);
    // What the (mocked) tag upsert leaves: the review tag, disabled. A tagged image is not rescanned.
    await db.exec(`INSERT INTO "TagsOnImageDetails" VALUES (${MODERATED}, 5, TRUE);`);
    replicaHandle.current = new Kysely({ dialect: pgliteDialect(laggingReplica) });
    vi.mocked(trackImageRestore).mockClear();

    await expect(unblock([MODERATED])).resolves.toEqual({ count: 1, restored: 1, kept: 0 });
    expect(await row(MODERATED)).toEqual({
      ingestion: 'Scanned',
      blockedFor: null,
      needsReview: null,
    });
    // Consumed only if the tag read went to the primary; the replica has none.
    const pending = await db.query(`SELECT 1 FROM "ImageTagForReview" WHERE "imageId" = $1`, [
      MODERATED,
    ]);
    expect(pending.rows).toHaveLength(0);
    // By identity: vitest's deep equality calls any two Kysely instances equal.
    expect(trackImageRestore).toHaveBeenCalledTimes(1);
    const restoreEvent = vi.mocked(trackImageRestore).mock.lastCall?.[0];
    expect(restoreEvent?.imageId).toBe(MODERATED);
    expect(restoreEvent?.db).toBe(dbHandle.current);
  });

  it('names every image a batch left down', async () => {
    const OTHER_CSAM = 3;
    await db.exec(`
      INSERT INTO "Image" ("id", "userId", "ingestion", "blockedFor", "nsfwLevel", "needsReview")
      VALUES (${OTHER_CSAM}, 9, 'Blocked', 'CSAM', 32, 'csam');
    `);
    const answer = await unblock([CSAM, OTHER_CSAM, MODERATED]).catch((e: unknown) => e);

    expect(answer).toMatchObject({
      status: 409,
      message: `Images ${CSAM}, ${OTHER_CSAM} were not restored: each can only be restored through its own review. Image ${MODERATED} was restored.`,
    });
  });

  it('answers 409 for an id on neither, naming what it did restore', async () => {
    const MISSING = 999;
    const answer = await unblock([MISSING, MODERATED]).catch((e: unknown) => e);

    expect(answer).toMatchObject({
      status: 409,
      message: `Image ${MISSING} was not found. Image ${MODERATED} was restored.`,
    });
  });
});
