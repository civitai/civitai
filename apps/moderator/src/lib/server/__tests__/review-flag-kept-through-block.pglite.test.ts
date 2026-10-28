import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ModActivity from '../mod-activity';
import type * as ThumbnailCache from '../thumbnail-cache';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * The moderator-only review flag holds a Blocked image back from the purge until its own queue or a
 * filed report settles it. These writers must leave it on unless they are that decision.
 */

// PGlite boots a WASM Postgres; under a full parallel run that alone can pass the default hook budget.
vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle, recordModActivity, applyBlockSideEffects, trackImageRestore } = vi.hoisted(
  () => ({
    dbHandle: { current: null as unknown },
    recordModActivity: vi.fn(async () => undefined),
    applyBlockSideEffects: vi.fn(async () => undefined),
    trackImageRestore: vi.fn(async () => undefined),
  })
);

vi.mock('../removal-hold', () => ({
  // No approved appeals here; the hold itself is covered by image-removal-confirmation.pglite.test.ts.
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
  applyBlockSideEffects,
  applyAcceptSideEffects: vi.fn(async () => undefined),
  applyVisibilitySideEffects: vi.fn(async () => undefined),
  refundAppealFee: vi.fn(async () => undefined),
  notifyAppealResolved: vi.fn(async () => undefined),
  emailAppealResolution: vi.fn(async () => undefined),
  trackImageRestore,
}));
vi.mock('../thumbnail-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof ThumbnailCache>()),
  invalidateThumbnails: vi.fn(async () => undefined),
}));
vi.mock('../tags-on-image.service', () => ({ upsertTagsOnImageNew: vi.fn() }));
// The single-row log is a spy; the in-transaction insert runs for real, so its row is read back below.
vi.mock('../mod-activity', async (importOriginal) => ({
  ...(await importOriginal<typeof ModActivity>()),
  recordModActivity,
}));
vi.mock('../search-index', () => ({ syncSearchIndex: vi.fn() }));

const {
  acceptImage,
  blockImage,
  dismissFromCsamQueue,
  dismissUserFromCsamQueue,
  FlagOnlyRemovedError,
  resolveImageAppeal,
} = await import('../image-moderation.service');

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
CREATE TABLE "JobQueue" ("type" TEXT, "entityType" TEXT, "entityId" INTEGER);
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
CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "email" TEXT, "username" TEXT);
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

const FLAGGED = 51;
const FLAGGED_REMOVED = 52;
const OTHER_FLAG_REMOVED = 53;

let db: PGlite;

// One instance per file: a fresh PGlite per case is what times out under a full-suite run.
beforeAll(async () => {
  db = await freshPglite();
  await db.exec(SCHEMA);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

beforeEach(async () => {
  recordModActivity.mockClear();
  applyBlockSideEffects.mockClear();
  trackImageRestore.mockClear();
  await db.exec(`TRUNCATE "Image", "Appeal", "User", "CsamQueueSetAside", "ModActivity"`);
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
    expect(trackImageRestore).toHaveBeenCalledWith({ imageId: FLAGGED_REMOVED, actorUserId: 2 });
  });

  it('is accepted like any other image while it is still live', async () => {
    await acceptImage({ imageId: FLAGGED, userId: 2 });

    expect(await imageRow(FLAGGED)).toEqual({ needsReview: null, ingestion: 'Scanned' });
    expect(trackImageRestore).not.toHaveBeenCalled();
  });

  it('logs no restore for a scanner block, which was never logged as a removal', async () => {
    await db.query(
      `INSERT INTO "Image" ("id", "userId", "needsReview", "blockedFor", "ingestion", "nsfwLevel")
       VALUES (54, 7, 'tag', 'AiNotVerified', 'Blocked', 32)`
    );
    await acceptImage({ imageId: 54, userId: 2 });

    expect(await imageRow(54)).toEqual({ needsReview: null, ingestion: 'Scanned' });
    expect(trackImageRestore).not.toHaveBeenCalled();
  });

  it('is not removed a second time', async () => {
    await blockImage({ imageId: FLAGGED_REMOVED, userId: 2 });

    expect(applyBlockSideEffects).not.toHaveBeenCalled();
    expect(recordModActivity).not.toHaveBeenCalled();
  });
});

describe('dismissFromCsamQueue', () => {
  const setAside = async () =>
    (
      await db.query(
        'SELECT "imageId", "userId", "outcome", "moderatorId" FROM "CsamQueueSetAside" ORDER BY "imageId"'
      )
    ).rows;
  const activity = async () =>
    (await db.query('SELECT "userId", "activity", "entityType", "entityId" FROM "ModActivity"'))
      .rows;

  it('takes the image out as dismissed and leaves it flagged and removed', async () => {
    expect(await dismissFromCsamQueue({ imageId: FLAGGED_REMOVED, userId: 2 })).toBe(true);

    expect(await imageRow(FLAGGED_REMOVED)).toEqual({ needsReview: 'csam', ingestion: 'Blocked' });
    expect(await setAside()).toEqual([
      { imageId: FLAGGED_REMOVED, userId: 8, outcome: 'Dismissed', moderatorId: 2 },
    ]);
  });

  // The purge reads `review`/`bulkRemove` rows as a moderator's takedown of the image; a dismissal
  // recorded as either would license destroying its stored bytes.
  it('records its own activity, not a takedown', async () => {
    await dismissFromCsamQueue({ imageId: FLAGGED_REMOVED, userId: 2 });

    expect(await activity()).toEqual([
      {
        userId: 2,
        activity: 'dismissFromCsamQueue',
        entityType: 'image',
        entityId: FLAGGED_REMOVED,
      },
    ]);
  });

  it('leaves no dismissal behind when its activity row cannot be written', async () => {
    await db.exec(`
      CREATE FUNCTION refuse_activity() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'refused'; END $$;
      CREATE TRIGGER refuse_activity BEFORE INSERT ON "ModActivity"
        FOR EACH ROW EXECUTE FUNCTION refuse_activity();
    `);
    try {
      await expect(dismissFromCsamQueue({ imageId: FLAGGED_REMOVED, userId: 2 })).rejects.toThrow();
      expect(await setAside()).toEqual([]);
    } finally {
      await db.exec(
        'DROP TRIGGER refuse_activity ON "ModActivity"; DROP FUNCTION refuse_activity()'
      );
    }
  });

  it('is a no-op the second time', async () => {
    await dismissFromCsamQueue({ imageId: FLAGGED_REMOVED, userId: 2 });
    expect(await dismissFromCsamQueue({ imageId: FLAGGED_REMOVED, userId: 3 })).toBe(false);

    expect(await setAside()).toHaveLength(1);
    expect(await activity()).toHaveLength(1);
  });

  it('refuses an image that is not removed', async () => {
    expect(await dismissFromCsamQueue({ imageId: FLAGGED, userId: 2 })).toBe(false);

    expect(await imageRow(FLAGGED)).toEqual({ needsReview: 'csam', ingestion: 'Scanned' });
    expect(await setAside()).toEqual([]);
    expect(await activity()).toEqual([]);
  });

  it('refuses any other flag', async () => {
    expect(await dismissFromCsamQueue({ imageId: OTHER_FLAG_REMOVED, userId: 2 })).toBe(false);

    expect(await imageRow(OTHER_FLAG_REMOVED)).toEqual({
      needsReview: 'appeal',
      ingestion: 'Blocked',
    });
    expect(await setAside()).toEqual([]);
  });
});

describe('dismissUserFromCsamQueue', () => {
  // User 8: FLAGGED_REMOVED and 55 removed, 56 still live, 57 removed and already dismissed.
  beforeEach(async () => {
    await db.exec(`
      INSERT INTO "Image" ("id", "userId", "needsReview", "blockedFor", "ingestion", "nsfwLevel") VALUES
        (55, 8, 'csam', 'moderated', 'Blocked', 32),
        (56, 8, 'csam', NULL, 'Scanned', 4),
        (57, 8, 'csam', 'moderated', 'Blocked', 32);
      INSERT INTO "CsamQueueSetAside" ("imageId", "userId", "outcome", "moderatorId", "createdAt")
        VALUES (57, 8, 'Dismissed', 1, now());
    `);
  });
  const flags = async () =>
    (
      await db.query<{ id: number; needsReview: string | null }>(
        `SELECT id, "needsReview" FROM "Image" WHERE "userId" = 8 ORDER BY id`
      )
    ).rows;
  const dismissedIds = async () =>
    (
      await db.query<{ imageId: number }>(
        `SELECT "imageId" FROM "CsamQueueSetAside" WHERE outcome = 'Dismissed' ORDER BY 1`
      )
    ).rows.map((r) => r.imageId);
  const loggedIds = async () =>
    (
      await db.query<{ entityId: number }>(
        `SELECT "entityId" FROM "ModActivity" WHERE activity = 'dismissFromCsamQueue' ORDER BY 1`
      )
    ).rows.map((r) => r.entityId);

  it('dismisses every removed image not yet dismissed and keeps every flag', async () => {
    expect(await dismissUserFromCsamQueue({ userId: 8, expectedCount: 2, moderatorId: 2 })).toEqual(
      {
        ok: true,
        dismissed: 2,
        remaining: 1,
      }
    );

    expect(await flags()).toEqual([
      { id: FLAGGED_REMOVED, needsReview: 'csam' },
      { id: 55, needsReview: 'csam' },
      { id: 56, needsReview: 'csam' },
      { id: 57, needsReview: 'csam' },
    ]);
    expect(await dismissedIds()).toEqual([FLAGGED_REMOVED, 55, 57]);
    expect(await loggedIds()).toEqual([FLAGGED_REMOVED, 55]);
  });

  it('dismisses nothing when the count differs from what the moderator confirmed', async () => {
    expect(await dismissUserFromCsamQueue({ userId: 8, expectedCount: 3, moderatorId: 2 })).toEqual(
      {
        ok: false,
        reason: 'changed',
      }
    );

    expect(await dismissedIds()).toEqual([57]);
    expect(await loggedIds()).toEqual([]);
  });

  it('dismisses nothing when another moderator dismissed one of them first', async () => {
    // A row the read leaves out but the insert collides with, as a concurrent dismissal would.
    await db.exec(`
      INSERT INTO "CsamQueueSetAside" ("imageId", "userId", "outcome", "moderatorId", "createdAt")
        VALUES (55, 8, 'AfterReport', 1, now());
    `);
    expect(await dismissUserFromCsamQueue({ userId: 8, expectedCount: 2, moderatorId: 2 })).toEqual(
      {
        ok: false,
        reason: 'changed',
      }
    );

    expect(await dismissedIds()).toEqual([57]);
    expect(await loggedIds()).toEqual([]);
  });

  it('dismisses nothing before the table exists', async () => {
    await db.exec(`ALTER TABLE "CsamQueueSetAside" RENAME TO "CsamQueueSetAsideAway"`);
    try {
      expect(
        await dismissUserFromCsamQueue({ userId: 8, expectedCount: 2, moderatorId: 2 })
      ).toEqual({ ok: false, reason: 'unavailable' });
    } finally {
      await db.exec(`ALTER TABLE "CsamQueueSetAsideAway" RENAME TO "CsamQueueSetAside"`);
    }
    expect(await loggedIds()).toEqual([]);
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
