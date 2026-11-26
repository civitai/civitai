import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import {
  DEFERRED_BLOCK_EFFECT_TABLE_SQL,
  SET_ASIDE_TABLE_SQL,
} from '../../../test/held-image-tables';
import type { DB } from '@civitai/db-schema/kysely';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Effects from '../image-moderation-effects';
import { pgliteDialect } from './abuse-detection-pglite.harness';

const { dbHandle, chQuery, chInsert } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  chQuery: vi.fn(),
  chInsert: vi.fn(async () => undefined),
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
vi.mock('../image-moderation-effects', async (importOriginal) => ({
  ...(await importOriginal<typeof Effects>()),
  refundAppealFee: vi.fn(async () => undefined),
  notifyAppealResolved: vi.fn(async () => undefined),
  emailAppealResolution: vi.fn(async () => undefined),
  applyVisibilitySideEffects: vi.fn(async () => undefined),
}));
// Writes the row for real: whether an image was reviewed before decides whether it is rescanned.
vi.mock('../mod-activity', () => ({
  recordModActivity: vi.fn(
    async (input: { entityType: string | null; entityId: number | null; activity: string }) => {
      await (dbHandle.current as Kysely<DB>)
        .insertInto('ModActivity')
        .values({
          entityType: input.entityType,
          entityId: input.entityId,
          activity: input.activity,
        })
        .execute();
    }
  ),
}));
// Disabling review tags writes TagsOnImageNew and recomputes; the recompute here is the stand-in's.
vi.mock('../tags-on-image.service', () => ({ upsertTagsOnImageNew: vi.fn(async () => undefined) }));
vi.mock('../search-index', () => ({ syncSearchIndex: vi.fn() }));
vi.mock('../cache', () => ({ bustCachedObject: vi.fn(async () => undefined) }));
vi.mock('../image-models-reindex', () => ({
  queueDocumentsForImageMinorChanges: vi.fn(async () => undefined),
}));
vi.mock('../thumbnail-cache', () => ({ invalidateThumbnails: vi.fn(async () => undefined) }));
vi.mock('../clickhouse', () => ({ getClickhouse: () => ({ query: chQuery, insert: chInsert }) }));

const { acceptImage, resolveImageAppeal } = await import('../image-moderation.service');
const { refundAppealFee, notifyAppealResolved } = await import('../image-moderation-effects');
const { queueDocumentsForImageMinorChanges } = await import('../image-models-reindex');
const { syncSearchIndex } = await import('../search-index');

// The stand-in keeps the real function's skip of nsfwLevelLocked rows; without it the reset assertions pass vacuously.
const SCHEMA = `
-- The real enum, so a write that does not cast to it fails here as it would in production.
CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
CREATE TABLE "Image" (
  "id" INTEGER PRIMARY KEY,
  "userId" INTEGER,
  "needsReview" TEXT,
  "blockedFor" TEXT,
  "ingestion" "ImageIngestionStatus",
  "metadata" JSONB,
  "pHash" BIGINT,
  "postId" INTEGER,
  "nsfwLevel" INTEGER NOT NULL DEFAULT 0,
  "nsfwLevelLocked" BOOLEAN NOT NULL DEFAULT FALSE,
  "scanJobs" JSONB
);
${SET_ASIDE_TABLE_SQL}
${DEFERRED_BLOCK_EFFECT_TABLE_SQL}
CREATE TABLE "ImageTagForReview" ("imageId" INTEGER, "tagId" INTEGER);
CREATE TABLE "TagsOnImageDetails" ("imageId" INTEGER, "tagId" INTEGER, "disabled" BOOLEAN);
CREATE TABLE "ModActivity" ("entityType" TEXT, "entityId" INTEGER, "activity" TEXT);
CREATE TABLE "JobQueue" ("type" TEXT, "entityType" TEXT, "entityId" INTEGER, "data" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  PRIMARY KEY ("entityType", "entityId", "type"));
CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "email" TEXT, "username" TEXT, "deletedAt" TIMESTAMP(3));
CREATE TABLE "Appeal" (
  "id" SERIAL PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'Pending',
  "resolvedBy" INTEGER,
  "resolvedAt" TIMESTAMP(3),
  "resolvedMessage" TEXT,
  "resolvedReason" TEXT,
  "internalNotes" TEXT,
  "buzzTransactionId" TEXT,
  "entityRemovedAt" TIMESTAMP(3)
);
CREATE FUNCTION update_nsfw_levels_new(ids INTEGER[]) RETURNS VOID LANGUAGE SQL AS $$
  UPDATE "Image" SET "nsfwLevel" = 1
  WHERE id = ANY(ids) AND NOT "nsfwLevelLocked" AND "ingestion" = 'Scanned' AND "blockedFor" IS NULL;
$$;
`;

const IMAGE_ID = 41;
const PHASH = '1234567890';

let db: PGlite;

beforeEach(async () => {
  chQuery.mockReset();
  // The CSAM-entry lookup finds none; the live-row read finds the TOS entry.
  chQuery.mockImplementation(async ({ query }: { query: string }) => ({
    json: async () => (query.includes("= 'CSAM'") ? [] : [{ hash: PHASH, reason: 'TOS' }]),
  }));
  chInsert.mockClear();
  db = await freshPglite();
  await db.exec(SCHEMA);
  await db.query(
    `INSERT INTO "Image" ("id", "needsReview", "blockedFor", "ingestion", "pHash", "nsfwLevel", "nsfwLevelLocked")
     VALUES ($1, 'appeal', 'moderated', 'Blocked', $2, 32, TRUE)`,
    [IMAGE_ID, PHASH]
  );
  await db.query(
    `INSERT INTO "Appeal" ("userId", "entityType", "entityId") VALUES (7, 'Image', $1)`,
    [IMAGE_ID]
  );
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

const imageRow = async () =>
  (
    await db.query<{ ingestion: string; nsfwLevel: number; nsfwLevelLocked: boolean }>(
      `SELECT "ingestion", "nsfwLevel", "nsfwLevelLocked" FROM "Image" WHERE "id" = $1`,
      [IMAGE_ID]
    )
  ).rows[0];

const unblocklisted = () =>
  chInsert.mock.calls.flatMap(
    (args) => ((args as unknown[])[0] as { values: { hash: string; disabled?: boolean }[] }).values
  );

const approve = () =>
  resolveImageAppeal({
    imageId: IMAGE_ID,
    status: 'Approved',
    resolvedReason: 'misclassified',
    userId: 2,
  });

describe('approving an appeal on a rating-locked Blocked image', () => {
  it('resets the Blocked level so the recompute restores the real one', async () => {
    await approve();

    expect(await imageRow()).toEqual({
      ingestion: 'Scanned',
      nsfwLevel: 1,
      nsfwLevelLocked: false,
    });
  });

  it('takes the pHash off the blocklist', async () => {
    await approve();

    expect(unblocklisted()).toEqual([{ hash: PHASH, reason: 'TOS', disabled: true }]);
  });

  it('still refunds and notifies when the blocklist check fails, leaving the entry in place', async () => {
    chQuery.mockImplementation(async ({ query }: { query: string }) => {
      if (query.includes("= 'CSAM'")) throw new Error('Socket hang up');
      return { json: async () => [{ hash: PHASH, reason: 'TOS' }] };
    });
    vi.mocked(refundAppealFee).mockClear();
    vi.mocked(notifyAppealResolved).mockClear();

    await expect(approve()).resolves.toBeDefined();

    expect(unblocklisted()).toEqual([]);
    expect(refundAppealFee).toHaveBeenCalledTimes(1);
    expect(notifyAppealResolved).toHaveBeenCalledTimes(1);
  });

  it('restores the same row acceptImage does', async () => {
    await acceptImage({ imageId: IMAGE_ID, userId: 2 });
    const accepted = await imageRow();
    await db.query(
      `UPDATE "Image" SET "needsReview" = 'appeal', "blockedFor" = 'moderated', "ingestion" = 'Blocked',
         "nsfwLevel" = 32, "nsfwLevelLocked" = TRUE WHERE "id" = $1`,
      [IMAGE_ID]
    );
    await db.query(
      `INSERT INTO "Appeal" ("userId", "entityType", "entityId") VALUES (7, 'Image', $1)`,
      [IMAGE_ID]
    );

    await approve();

    expect(await imageRow()).toEqual(accepted);
  });
});

describe('approving an appeal on an image an account deletion blocked', () => {
  it.each([
    ['minor', 'minor'],
    ['poi', 'poi'],
    // The appeal is what the approval settles; a dismissed csam review is not put back.
    ['appeal', null],
    ['csam', null],
    ['not-a-review', null],
  ])('a recorded %s leaves the review flag %s, and the breadcrumbs go', async (review, flag) => {
    await db.query(
      `UPDATE "Image" SET "metadata" = jsonb_build_object(
         'accountDeletionPriorIngestion', 'Scanned',
         'accountDeletionPriorBlockedFor', NULL,
         'accountDeletionPriorNeedsReview', $2::text,
         'keep', 1)
       WHERE "id" = $1`,
      [IMAGE_ID, review]
    );

    await approve();

    const { rows } = await db.query<{
      needsReview: string | null;
      ingestion: string;
      metadata: unknown;
    }>(`SELECT "needsReview", "ingestion", "metadata" FROM "Image" WHERE "id" = $1`, [IMAGE_ID]);
    expect(rows[0]).toEqual({ needsReview: flag, ingestion: 'Scanned', metadata: { keep: 1 } });
  });
});

// Policy: LIFT_WHILE_OWNER_DELETED in @civitai/shared/account-deletion-grace: a deleted owner's image is never served.
describe('approving an appeal while the image owner is deleted', () => {
  const OWNER_ID = 7;
  const activities = async () =>
    (
      await db.query<{ activity: string }>(
        `SELECT "activity" FROM "ModActivity" WHERE "entityId" = $1 AND "activity" IN ('review', 'bulkRemove', 'reviewOwnerDeleted')`,
        [IMAGE_ID]
      )
    ).rows.map((r) => r.activity);
  beforeEach(() => vi.mocked(syncSearchIndex).mockClear());
  const seed = async (deletedAt: string | null) => {
    await db.query(`INSERT INTO "User" ("id", "deletedAt") VALUES ($1, $2)`, [OWNER_ID, deletedAt]);
    await db.query(
      `UPDATE "Image" SET "userId" = $2, "nsfwLevel" = 4, "metadata" = jsonb_build_object(
         'accountDeletionPriorIngestion', 'Blocked',
         'accountDeletionPriorBlockedFor', 'moderated',
         'accountDeletionPriorNeedsReview', 'minor',
         -- The grace block's recorded rating, a moderator's lock: it outlives the lift.
         'accountDeletionPriorNsfwLevel', 4,
         'accountDeletionPriorNsfwLevelLocked', true,
         'keep', 1)
       WHERE "id" = $1`,
      [IMAGE_ID, OWNER_ID]
    );
    await db.query(
      `INSERT INTO "JobQueue" ("type", "entityType", "entityId", "createdAt") VALUES ('BlockedImageDelete', 'Image', $1, '2026-01-01')`,
      [IMAGE_ID]
    );
  };
  const row = async () =>
    (
      await db.query<{
        ingestion: string;
        blockedFor: string | null;
        needsReview: string | null;
        metadata: unknown;
      }>(
        `SELECT "ingestion", "blockedFor", "needsReview", "metadata" FROM "Image" WHERE "id" = $1`,
        [IMAGE_ID]
      )
    ).rows[0];

  it('drops a recorded Blocked rating on the lift, so the restore re-rates the row', async () => {
    await seed('2026-11-20 00:00:00');
    await db.query(
      `UPDATE "Image" SET "metadata" = "metadata" || '{"accountDeletionPriorNsfwLevel": 32}' WHERE "id" = $1`,
      [IMAGE_ID]
    );

    await acceptImage({ imageId: IMAGE_ID, userId: 2 });

    const { metadata } = (await row()) as { metadata: Record<string, unknown> };
    expect(metadata).not.toHaveProperty('accountDeletionPriorNsfwLevel');
    expect(metadata).not.toHaveProperty('accountDeletionPriorNsfwLevelLocked');
    // Control: the lift was recorded.
    expect(metadata).toMatchObject({ accountDeletionPriorIngestion: 'Scanned' });
  });

  it('keeps it Blocked, recorded as Scanned for an account restore, and settles the appeal', async () => {
    await seed('2026-11-20 00:00:00');

    await expect(approve()).resolves.toBeDefined();

    expect(await row()).toEqual({
      ingestion: 'Blocked',
      blockedFor: 'moderated',
      needsReview: null,
      metadata: {
        keep: 1,
        accountDeletionPriorIngestion: 'Scanned',
        accountDeletionPriorBlockedFor: null,
        accountDeletionPriorNeedsReview: 'minor',
        accountDeletionPriorNsfwLevel: 4,
        accountDeletionPriorNsfwLevelLocked: true,
      },
    });
    const { rows } = await db.query<{ status: string }>(`SELECT "status" FROM "Appeal"`);
    expect(rows).toEqual([{ status: 'Approved' }]);
    // The rating lock stays and the purge clock starts again; the pHash leaves the blocklist.
    expect(await imageRow()).toMatchObject({ nsfwLevel: 32, nsfwLevelLocked: true });
    const queued = await db.query<{ fresh: boolean }>(
      `SELECT "createdAt" > now() - interval '1 hour' AS fresh FROM "JobQueue" WHERE "entityId" = $1`,
      [IMAGE_ID]
    );
    expect(queued.rows).toEqual([{ fresh: true }]);
    expect(unblocklisted()).toEqual([{ hash: PHASH, reason: 'TOS', disabled: true }]);
    expect(vi.mocked(syncSearchIndex).mock.calls.at(-1)?.[0]).toMatchObject({ action: 'delete' });
  });

  it('an accept also keeps it Blocked, restarts its purge clock and closes the appeal', async () => {
    await seed('2026-11-20 00:00:00');

    await acceptImage({ imageId: IMAGE_ID, userId: 2 });

    expect(await row()).toEqual({
      ingestion: 'Blocked',
      blockedFor: 'moderated',
      needsReview: null,
      metadata: {
        keep: 1,
        accountDeletionPriorIngestion: 'Scanned',
        accountDeletionPriorBlockedFor: null,
        accountDeletionPriorNeedsReview: 'minor',
        accountDeletionPriorNsfwLevel: 4,
        accountDeletionPriorNsfwLevelLocked: true,
      },
    });
    expect(await imageRow()).toMatchObject({ nsfwLevel: 32, nsfwLevelLocked: true });
    const queued = await db.query<{ fresh: boolean }>(
      `SELECT "createdAt" > now() - interval '1 hour' AS fresh FROM "JobQueue" WHERE "entityId" = $1`,
      [IMAGE_ID]
    );
    expect(queued.rows).toEqual([{ fresh: true }]);
    const { rows } = await db.query<{ status: string }>(`SELECT "status" FROM "Appeal"`);
    expect(rows).toEqual([{ status: 'Approved' }]);
    expect(vi.mocked(syncSearchIndex).mock.calls.at(-1)?.[0]).toMatchObject({ action: 'delete' });
    // No takedown activity ('review'), which the CDN sync and the purge read as a moderator removal.
    expect(await activities()).toEqual(['reviewOwnerDeleted']);
  });

  it('an accept restores it when the owner is not deleted', async () => {
    await seed(null);

    await acceptImage({ imageId: IMAGE_ID, userId: 2 });

    expect(await row()).toMatchObject({ ingestion: 'Scanned', blockedFor: null });
    expect(await activities()).toEqual(['review']);
  });

  it('restores it when the owner is not deleted', async () => {
    await seed(null);

    await approve();

    expect(await row()).toEqual({
      ingestion: 'Scanned',
      blockedFor: null,
      needsReview: 'minor',
      metadata: { keep: 1 },
    });
  });
});

describe('approving an appeal on an image whose metadata is not an object', () => {
  it('approves it and leaves the metadata as it was', async () => {
    await db.query(`UPDATE "Image" SET "metadata" = 'null'::jsonb WHERE "id" = $1`, [IMAGE_ID]);

    await approve();

    const { rows } = await db.query<{
      needsReview: string | null;
      ingestion: string;
      metadata: unknown;
    }>(`SELECT "needsReview", "ingestion", "metadata" FROM "Image" WHERE "id" = $1`, [IMAGE_ID]);
    expect(rows[0]).toEqual({ needsReview: null, ingestion: 'Scanned', metadata: null });
  });
});

describe('rejecting an appeal on a rating-locked Blocked image', () => {
  it('leaves the level, the lock and the blocklist alone', async () => {
    await resolveImageAppeal({
      imageId: IMAGE_ID,
      status: 'Rejected',
      resolvedReason: 'violation-confirmed',
      userId: 2,
    });

    expect(await imageRow()).toEqual({
      ingestion: 'Blocked',
      nsfwLevel: 32,
      nsfwLevelLocked: true,
    });
    expect(chInsert).not.toHaveBeenCalled();
  });
});

describe('approving when the moderator-only review flag holds the image', () => {
  it('is refused, and leaves it Blocked and locked', async () => {
    const { FLAG_KEPT_THROUGH_BLOCK } = await import('$lib/image-review');
    await db.query(`UPDATE "Image" SET "needsReview" = $2 WHERE "id" = $1`, [
      IMAGE_ID,
      FLAG_KEPT_THROUGH_BLOCK,
    ]);

    await expect(approve()).rejects.toThrow(/cannot put it back/);

    expect(await imageRow()).toEqual({
      ingestion: 'Blocked',
      nsfwLevel: 32,
      nsfwLevelLocked: true,
    });
    expect(chInsert).not.toHaveBeenCalled();
  });
});

describe('a restore that recomputes the level: models index', () => {
  it.each([
    ['an approved appeal', approve],
    ['an accept', () => acceptImage({ imageId: IMAGE_ID, userId: 2 })],
  ])('%s hands the re-rated image over', async (_, restore) => {
    vi.mocked(queueDocumentsForImageMinorChanges).mockClear();

    await restore();

    expect(queueDocumentsForImageMinorChanges).toHaveBeenCalledWith({ levelImageIds: [IMAGE_ID] });
  });
});

describe('a restore that leaves the image with no rating', () => {
  // As the real recompute does for an image with no live tags: it leaves the row as it is.
  beforeEach(async () => {
    await db.exec(`CREATE OR REPLACE FUNCTION update_nsfw_levels_new(ids INTEGER[]) RETURNS VOID
      LANGUAGE SQL AS $$ SELECT $$;`);
  });

  const queued = async () =>
    (
      await db.query(
        `SELECT 1 FROM "JobQueue" WHERE "type" = 'ImageScan' AND "entityType" = 'Image' AND "entityId" = $1`,
        [IMAGE_ID]
      )
    ).rows.length;

  it.each([
    ['an approved appeal', approve],
    ['an accept', () => acceptImage({ imageId: IMAGE_ID, userId: 2 })],
  ])('%s sends it back to the scanner instead of leaving it Scanned', async (_, restore) => {
    await restore();

    expect(await imageRow()).toEqual({ ingestion: 'Rescan', nsfwLevel: 0, nsfwLevelLocked: false });
    expect(await queued()).toBe(1);
  });

  const reviews = async () =>
    (
      await db.query(
        `SELECT 1 FROM "ModActivity" WHERE "entityType" = 'image' AND "entityId" = $1 AND "activity" = 'review'`,
        [IMAGE_ID]
      )
    ).rows.length;

  it('an accept still rescans: its own review row is written after the rescan', async () => {
    await acceptImage({ imageId: IMAGE_ID, userId: 2 });

    expect(await reviews()).toBe(1);
    expect(await imageRow()).toMatchObject({ ingestion: 'Rescan', nsfwLevel: 0 });
    expect(await queued()).toBe(1);
  });

  it.each([
    ['an approved appeal', approve],
    ['an accept', () => acceptImage({ imageId: IMAGE_ID, userId: 2 })],
  ])('%s does not re-audit an image a moderator reviewed before', async (_, restore) => {
    await db.query(`INSERT INTO "ModActivity" VALUES ('image', $1, 'review')`, [IMAGE_ID]);

    await restore();

    expect(await imageRow()).toMatchObject({ ingestion: 'Scanned', nsfwLevel: 0 });
    expect(await queued()).toBe(0);
  });

  it('keeps the ruling on an accept from the review queue: no rescan, nothing queued', async () => {
    // The accept disables the review tags; the row stays, so the scanner has tagged this image.
    await db.query(`INSERT INTO "ImageTagForReview" ("imageId", "tagId") VALUES ($1, 5)`, [
      IMAGE_ID,
    ]);
    await db.query(`INSERT INTO "TagsOnImageDetails" VALUES ($1, 5, TRUE)`, [IMAGE_ID]);

    await acceptImage({ imageId: IMAGE_ID, userId: 2 });

    expect(await imageRow()).toMatchObject({ ingestion: 'Scanned', nsfwLevel: 0 });
    expect(await queued()).toBe(0);
  });

  it('marks an image out of scan retries Error, with nothing queued', async () => {
    await db.query(`UPDATE "Image" SET "scanJobs" = '{"retryCount": 9}' WHERE id = $1`, [IMAGE_ID]);

    await approve();

    expect(await imageRow()).toEqual({ ingestion: 'Error', nsfwLevel: 0, nsfwLevelLocked: false });
    expect(await queued()).toBe(0);
  });

  it('leaves an image already queued for a scan queued once', async () => {
    await db.query(
      `INSERT INTO "JobQueue" ("type", "entityType", "entityId") VALUES ('ImageScan', 'Image', $1)`,
      [IMAGE_ID]
    );

    await approve();

    expect(await queued()).toBe(1);
  });

  it('keeps an image the recompute rates Scanned, with nothing queued (control)', async () => {
    await db.exec(`CREATE OR REPLACE FUNCTION update_nsfw_levels_new(ids INTEGER[]) RETURNS VOID
      LANGUAGE SQL AS $$ UPDATE "Image" SET "nsfwLevel" = 1 WHERE id = ANY(ids)
        AND NOT "nsfwLevelLocked" AND "ingestion" = 'Scanned' AND "blockedFor" IS NULL; $$;`);

    await approve();

    expect(await imageRow()).toMatchObject({ ingestion: 'Scanned', nsfwLevel: 1 });
    expect(await queued()).toBe(0);
  });
});
