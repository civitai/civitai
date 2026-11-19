import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
const sparkHooks = vi.hoisted(() => ({
  onStorySparked: vi.fn<(id: number) => Promise<void>>(async () => undefined),
  onStorySparkLost: vi.fn<(id: number) => Promise<void>>(async () => undefined),
  onStorySparkRemoved: vi.fn<(spark: object) => Promise<void>>(async () => undefined),
}));
vi.mock('~/server/events/points/hooks', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...sparkHooks,
}));

const { trackModActivity } = vi.hoisted(() => ({ trackModActivity: vi.fn() }));
vi.mock('~/server/services/moderator.service', () => ({ trackModActivity }));
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * Deleting a storyline, run as written against an in-process Postgres built from the
 * shipped storyline migrations, so the cascades and the refusals are the database's own.
 *
 * PGlite has one session, so nothing here interleaves two transactions. The delete's lock against
 * a concurrent chapter add was checked once against a real Postgres (see the PR).
 */

const { deleteStoryline, STORYLINE_DELETE_REFUSALS } = await import(
  '~/server/services/storyline.service'
);

const migration = (name: string) =>
  readFileSync(
    path.resolve(
      __dirname,
      `../../../../packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`
    ),
    'utf8'
  );

const db = { pg: null as unknown as PGlite };
const w = dbMock.dbWrite;

const OWNER = 1;
const CONTRIBUTOR = 2;
const MODERATOR = 3;

const rows = async <T>(sql: string, params: unknown[] = []) =>
  (await db.pg.query<T>(sql, params)).rows;

const storylineIds = async () =>
  (await rows<{ id: number }>(`SELECT id FROM "Storyline" ORDER BY id`)).map((r) => r.id);

let txQueue: Promise<unknown> = Promise.resolve();
const runTransaction = (fn: (tx: unknown) => Promise<unknown>) => {
  const run = txQueue.then(async () => {
    await db.pg.exec('BEGIN');
    try {
      const result = await fn(w);
      await db.pg.exec('COMMIT');
      return result;
    } catch (error) {
      await db.pg.exec('ROLLBACK');
      throw error;
    }
  });
  txQueue = run.catch(() => undefined);
  return run;
};

beforeAll(async () => {
  db.pg = new PGlite();
  await db.pg.exec(`
    CREATE TABLE "User" ("id" integer PRIMARY KEY);
    CREATE TABLE "Post" ("id" integer PRIMARY KEY, "userId" integer, "nsfwLevel" integer NOT NULL DEFAULT 0,
      "publishedAt" timestamp(3), "tosViolation" boolean NOT NULL DEFAULT false);
    CREATE TYPE "ReportStatus" AS ENUM ('Pending', 'Processing', 'Actioned', 'Unactioned');
    CREATE TABLE "Report" ("id" integer PRIMARY KEY, "status" "ReportStatus" NOT NULL DEFAULT 'Pending');
    CREATE TABLE "PlacementSpace" ("id" serial PRIMARY KEY, "surface" text NOT NULL,
      "entityType" text NOT NULL, "entityId" integer NOT NULL, "mode" text NOT NULL, "price" integer);
    CREATE TABLE "Placement" ("id" serial PRIMARY KEY, "surface" text NOT NULL,
      "targetType" text NOT NULL, "targetId" integer NOT NULL, "status" text NOT NULL,
      "amount" integer NOT NULL DEFAULT 0, "free" boolean NOT NULL DEFAULT false,
      "data" jsonb NOT NULL DEFAULT '{}');
    CREATE TABLE "PlacementTransaction" ("id" serial PRIMARY KEY,
      "placementId" integer NOT NULL REFERENCES "Placement"("id") ON DELETE CASCADE,
      "kind" text NOT NULL, "amount" integer NOT NULL, "transactionId" text);
    CREATE TYPE "EntityType" AS ENUM ('Post', 'Storyline');
    CREATE TYPE "AppealStatus" AS ENUM ('Pending', 'Approved', 'Rejected', 'Void');
    CREATE TABLE "Appeal" ("id" serial PRIMARY KEY, "entityType" "EntityType" NOT NULL,
      "entityId" integer NOT NULL, "status" "AppealStatus" NOT NULL DEFAULT 'Pending',
      "entityRemovedAt" timestamp(3));
  `);
  for (const name of [
    '20261023120000_storylines',
    '20261023130000_storyline_children_index',
    '20261023140000_storyline_engagement',
    '20261024120000_storyline_chapter_removed',
    '20261024150000_storyline_moderator_takedown',
    '20261024160000_storyline_minor_by_scan',
    '20261106120000_storyline_rejoin',
    '20261122120000_storyline_pending_chapter',
    '20261216130000_storyline_held_chapter',
    '20261222120000_held_storyline',
  ])
    await db.pg.exec(migration(name));
  await db.pg.exec(`
    INSERT INTO "User" (id) VALUES (1), (2), (3);
    -- What the real hold check reads (see storyline-delete-hold.sql.behavior.test.ts); empty here.
    CREATE TABLE "CsamReport" (id serial PRIMARY KEY, "userId" int, "reportSentAt" timestamp(3),
      "archivedAt" timestamp(3), details jsonb NOT NULL DEFAULT '{}', images jsonb NOT NULL DEFAULT '[]');
    CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int NOT NULL, "needsReview" text, "blockedFor" text);
    -- Its pictures, as the cover, hero and cover-upload migrations add them (spark: below).
    ALTER TABLE "Storyline" ADD COLUMN "coverImageId" int REFERENCES "Image"(id) ON DELETE SET NULL,
      ADD COLUMN "heroImageId" int REFERENCES "Image"(id) ON DELETE SET NULL;
    CREATE TABLE "StorylineCoverUpload" (
      "storylineId" int NOT NULL REFERENCES "Storyline"(id) ON DELETE CASCADE,
      "imageId" int NOT NULL REFERENCES "Image"(id) ON DELETE CASCADE,
      PRIMARY KEY ("storylineId", "imageId"));
    CREATE TABLE "EvidenceHold" ("userId" int NOT NULL, "releasedAt" timestamp(3));
    CREATE VIEW "EvidenceHeldUser" AS
      SELECT "userId" FROM "EvidenceHold" WHERE "releasedAt" IS NULL GROUP BY "userId";
    -- As production: a reply thread goes with its parent and root threads; a comment's delete
    -- only unlinks its reply thread.
    CREATE TABLE "Thread" ("id" serial PRIMARY KEY,
      "storylineId" integer REFERENCES "Storyline"("id") ON DELETE CASCADE, "commentId" integer,
      "parentThreadId" integer REFERENCES "Thread"("id") ON DELETE CASCADE,
      "rootThreadId" integer REFERENCES "Thread"("id") ON DELETE CASCADE, "metadata" jsonb);
    CREATE TABLE "CommentV2" ("id" serial PRIMARY KEY,
      "threadId" integer NOT NULL REFERENCES "Thread"("id") ON DELETE CASCADE,
      "userId" integer NOT NULL);
    ALTER TABLE "Thread" ADD FOREIGN KEY ("commentId") REFERENCES "CommentV2"("id") ON DELETE SET NULL;
    CREATE TABLE "CommentTopic" ("entityType" text NOT NULL,
      "entityId" integer NOT NULL REFERENCES "Storyline"("id") ON DELETE CASCADE,
      PRIMARY KEY ("entityId", "entityType"));
    CREATE TABLE "CommentV3" ("id" serial PRIMARY KEY, "entityType" text NOT NULL,
      "entityId" integer NOT NULL, "userId" integer NOT NULL,
      FOREIGN KEY ("entityId", "entityType") REFERENCES "CommentTopic" ("entityId", "entityType")
        ON DELETE CASCADE);
  `);
  // After "Image", which its foreign key needs.
  await db.pg.exec(migration('20261220120000_storyline_spark_image'));
});

afterAll(async () => {
  await db.pg.close();
});

beforeEach(async () => {
  await db.pg.exec(`
    DELETE FROM "Appeal";
    DELETE FROM "CommentV3";
    DELETE FROM "CommentTopic";
    DELETE FROM "CommentV2";
    DELETE FROM "Thread";
    DELETE FROM "StorylineReport";
    DELETE FROM "HeldStoryline";
    DELETE FROM "HeldStorylineChapter";
    DELETE FROM "HeldStorylineChapterEdge";
    DELETE FROM "HeldStorylineBranchChoice";
    DELETE FROM "HeldStorylineCreateClick";
    DELETE FROM "Report";
    DELETE FROM "PlacementTransaction";
    DELETE FROM "Placement";
    DELETE FROM "PlacementSpace";
    DELETE FROM "StorylinePendingChapter";
    DELETE FROM "StorylineCollaborator";
    DELETE FROM "StorylineChapterEdge";
    DELETE FROM "StorylineChapter";
    DELETE FROM "Storyline";
    DELETE FROM "Post";
    INSERT INTO "Storyline" (id, "userId", title, "maxNsfwLevel", "updatedAt") VALUES
      (1, ${OWNER}, 'A story with no story', 1, now()),
      (2, ${OWNER}, 'Someone else is reading this one', 1, now());
  `);
  const raw = pgliteRaw(db.pg);
  w.$transaction.mockImplementation(runTransaction as never);
  w.$queryRaw.mockImplementation(raw.queryRaw as never);
  w.$executeRaw.mockImplementation(raw.executeRaw as never);
  trackModActivity.mockReset();
});

const addRootChapter = (storylineId = 1, { postId = null as number | null } = {}) =>
  db.pg.query(
    `INSERT INTO "StorylineChapter" (id, "storylineId", "userId", depth, "postId")
     VALUES ($1, $2, ${OWNER}, 0, $3)`,
    [storylineId * 10, storylineId, postId]
  );

describe('deleteStoryline', () => {
  it('deletes an empty storyline and nothing else', async () => {
    await db.pg.exec(`
      INSERT INTO "PlacementSpace" (surface, "entityType", "entityId", mode, price) VALUES
        ('storyline', 'storyline', 1, 'review', 50),
        ('storyline', 'storyline', 2, 'review', 50),
        ('storyline', 'user', 1, 'review', 25);
      INSERT INTO "StorylineCollaborator" ("storylineId", "userId") VALUES (1, ${CONTRIBUTOR});
    `);

    expect(await deleteStoryline({ id: 1, userId: OWNER })).toEqual({ id: 1 });

    expect(await storylineIds()).toEqual([2]);
    // Read before the delete, which leaves nothing to read.
    expect(sparkHooks.onStorySparkRemoved).toHaveBeenCalledWith({ actorId: OWNER, imageId: null });
    expect(await rows(`SELECT * FROM "StorylineCollaborator"`)).toEqual([]);
    // The storyline's own price goes with it; another storyline's and the owner's default stay.
    expect(
      await rows(`SELECT "entityType", "entityId" FROM "PlacementSpace" ORDER BY "entityType"`)
    ).toEqual([
      { entityType: 'storyline', entityId: 2 },
      { entityType: 'user', entityId: 1 },
    ]);
  });

  it('hands the spark it read before the delete to the points hook', async () => {
    await db.pg.exec(`
      INSERT INTO "Image" (id, "userId") VALUES (900, ${CONTRIBUTOR}) ON CONFLICT DO NOTHING;
      UPDATE "Storyline" SET "sparkImageId" = 900 WHERE id = 1;
    `);

    await deleteStoryline({ id: 1, userId: OWNER });

    expect(sparkHooks.onStorySparkRemoved).toHaveBeenCalledWith({ actorId: OWNER, imageId: 900 });
  });

  it('unlinks a chapter-1 draft, which stays an ordinary draft', async () => {
    await db.pg.exec(`
      INSERT INTO "Post" (id, "userId") VALUES (500, ${OWNER});
      INSERT INTO "StorylinePendingChapter" ("postId", "storylineId", "userId") VALUES (500, 1, ${OWNER});
    `);

    await deleteStoryline({ id: 1, userId: OWNER });

    expect(await rows(`SELECT * FROM "StorylinePendingChapter"`)).toEqual([]);
    expect(await rows(`SELECT id FROM "Post"`)).toEqual([{ id: 500 }]);
  });

  describe('a storyline with chapters', () => {
    // Two chapters, chapter 2 continuing chapter 1 through a placement, on published posts.
    beforeEach(async () => {
      await db.pg.exec(`
        INSERT INTO "Post" (id, "userId", "nsfwLevel", "publishedAt") VALUES
          (501, ${OWNER}, 1, '2026-10-01'), (502, ${CONTRIBUTOR}, 1, '2026-10-02');
        INSERT INTO "StorylineChapter" (id, "storylineId", "userId", depth, "postId", "placementId")
          VALUES (10, 1, ${OWNER}, 0, 501, NULL), (11, 1, ${CONTRIBUTOR}, 1, 502, 900);
        INSERT INTO "StorylineChapterEdge" ("chapterId", "storylineId", "parentChapterId")
          VALUES (11, 1, 10);
        INSERT INTO "Placement" (id, surface, "targetType", "targetId", status, amount, data)
          VALUES (900, 'storyline', 'post', 501, 'approved', 100, '{"postId": 502}');
        INSERT INTO "PlacementTransaction" ("placementId", kind, amount, "transactionId") VALUES
          (900, 'holdPrincipal', 100, 'placement-900-holdPrincipal'),
          (900, 'toOwner', 100, 'placement-900-toOwner');
      `);
    });
    const posts = () =>
      rows(
        `SELECT id, "userId", "nsfwLevel", "publishedAt", "tosViolation" FROM "Post" ORDER BY id`
      );

    it('a moderator deletes it and every post stays exactly as it was', async () => {
      const before = await posts();

      expect(await deleteStoryline({ id: 1, userId: MODERATOR, isModerator: true })).toEqual({
        id: 1,
      });

      expect(await storylineIds()).toEqual([2]);
      expect(await rows(`SELECT id FROM "StorylineChapter"`)).toEqual([]);
      expect(await rows(`SELECT * FROM "StorylineChapterEdge"`)).toEqual([]);
      expect(before).toHaveLength(2);
      expect(await posts()).toEqual(before);
    });

    it('refuses while a paid continuation is pending, and keeps everything', async () => {
      await db.pg.exec(`
        INSERT INTO "Post" (id, "userId") VALUES (503, ${CONTRIBUTOR});
        INSERT INTO "Placement" (id, surface, "targetType", "targetId", status, amount, data)
          VALUES (901, 'storyline', 'post', 502, 'pending', 100, '{"postId": 503}');
        -- Hold claimed but not yet receipted, so only the pending status refuses it.
        INSERT INTO "PlacementTransaction" ("placementId", kind, amount) VALUES (901, 'holdPrincipal', 100);
      `);

      await expect(deleteStoryline({ id: 1, userId: OWNER })).rejects.toThrow(
        STORYLINE_DELETE_REFUSALS.paidContinuations
      );
      expect(await storylineIds()).toEqual([1, 2]);
      expect(await rows(`SELECT id FROM "StorylineChapter" ORDER BY id`)).toEqual([
        { id: 10 },
        { id: 11 },
      ]);
    });

    it("refuses while an approved continuation's payout has not been paid", async () => {
      await db.pg.exec(
        `UPDATE "PlacementTransaction" SET "transactionId" = NULL WHERE kind = 'toOwner'`
      );
      await expect(deleteStoryline({ id: 1, userId: OWNER })).rejects.toThrow(
        STORYLINE_DELETE_REFUSALS.paidContinuations
      );
      expect(await storylineIds()).toEqual([1, 2]);
    });

    it('refuses while a funded continuation has no payout planned', async () => {
      await db.pg.exec(`DELETE FROM "PlacementTransaction" WHERE kind = 'toOwner'`);
      await expect(deleteStoryline({ id: 1, userId: OWNER })).rejects.toThrow(
        STORYLINE_DELETE_REFUSALS.paidContinuations
      );
      expect(await storylineIds()).toEqual([1, 2]);
    });

    // Its parent chapter's post was deleted, so only the chapter's placementId ties it here.
    it("refuses while an approved continuation is unpaid and its parent's post is gone", async () => {
      await db.pg.exec(`
        UPDATE "Placement" SET "targetId" = 999 WHERE id = 900;
        UPDATE "StorylineChapter" SET "postId" = NULL WHERE id = 10;
        UPDATE "PlacementTransaction" SET "transactionId" = NULL WHERE kind = 'toOwner';
      `);
      await expect(deleteStoryline({ id: 1, userId: OWNER })).rejects.toThrow(
        STORYLINE_DELETE_REFUSALS.paidContinuations
      );
      expect(await storylineIds()).toEqual([1, 2]);
    });

    it('lets an unpriced pending continuation through', async () => {
      await db.pg.exec(`
        INSERT INTO "Placement" (id, surface, "targetType", "targetId", status, amount)
          VALUES (903, 'storyline', 'post', 502, 'pending', 0);
      `);
      await deleteStoryline({ id: 1, userId: MODERATOR, isModerator: true });
      expect(await storylineIds()).toEqual([2]);
    });

    it('is kept from its owner once a paid continuation is approved', async () => {
      await expect(deleteStoryline({ id: 1, userId: OWNER })).rejects.toThrow(
        STORYLINE_DELETE_REFUSALS.owner
      );
      expect(await storylineIds()).toEqual([1, 2]);
    });

    for (const status of ['expired', 'declined'])
      it(`its owner deletes it when its only paid continuation was ${status}`, async () => {
        await db.pg.exec(`UPDATE "Placement" SET status = '${status}' WHERE id = 900`);
        await deleteStoryline({ id: 1, userId: OWNER });
        expect(await storylineIds()).toEqual([2]);
      });

    it('its owner deletes it, posts kept, when no continuation was paid', async () => {
      await db.pg.exec(`DELETE FROM "Placement"`);
      const before = await posts();
      await deleteStoryline({ id: 1, userId: OWNER });
      expect(await storylineIds()).toEqual([2]);
      expect(await posts()).toEqual(before);
    });

    it("ignores another storyline's pending continuation", async () => {
      await db.pg.exec(`
        INSERT INTO "Post" (id, "userId") VALUES (601, ${OWNER});
        INSERT INTO "StorylineChapter" (id, "storylineId", "userId", depth, "postId")
          VALUES (20, 2, ${OWNER}, 0, 601);
        INSERT INTO "Placement" (id, surface, "targetType", "targetId", status, amount)
          VALUES (902, 'storyline', 'post', 601, 'pending', 100);
      `);
      await deleteStoryline({ id: 1, userId: MODERATOR, isModerator: true });
      expect(await storylineIds()).toEqual([2]);
    });
  });

  // A chapter whose post was deleted keeps its row with postId NULL; it goes like any other.
  it('deletes a storyline whose only chapter is a tombstone', async () => {
    await addRootChapter(1);
    await db.pg.exec(`UPDATE "StorylineChapter" SET "removedAt" = now() WHERE id = 10`);

    await deleteStoryline({ id: 1, userId: OWNER });
    expect(await storylineIds()).toEqual([2]);
  });

  // Answered as a storyline that does not exist, so a delete cannot be probed from outside.
  it('refuses anyone but the owner or a moderator as not found', async () => {
    await expect(deleteStoryline({ id: 1, userId: CONTRIBUTOR })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Storyline not found',
    });
    expect(await storylineIds()).toEqual([1, 2]);
  });

  it("lets a moderator delete someone else's storyline, and logs it in the same transaction", async () => {
    await deleteStoryline({ id: 1, userId: MODERATOR, isModerator: true });

    expect(await storylineIds()).toEqual([2]);
    expect(trackModActivity).toHaveBeenCalledTimes(1);
    expect(trackModActivity).toHaveBeenCalledWith(
      MODERATOR,
      { entityType: 'storyline', entityId: 1, activity: 'delete' },
      w
    );
  });

  it("does not log the owner's own delete, moderator or not", async () => {
    await deleteStoryline({ id: 1, userId: OWNER, isModerator: true });
    expect(await storylineIds()).toEqual([2]);
    expect(trackModActivity).not.toHaveBeenCalled();
  });

  describe('a reported storyline', () => {
    const report = (status: string) =>
      db.pg.exec(`
        INSERT INTO "Report" (id, status) VALUES (70, '${status}');
        INSERT INTO "StorylineReport" ("storylineId", "reportId") VALUES (1, 70);
      `);

    it('is deleted by its owner while the report is open, the report kept open on a copy', async () => {
      await report('Pending');
      await deleteStoryline({ id: 1, userId: OWNER });
      expect(await storylineIds()).toEqual([2]);
      expect(
        await rows(`SELECT "reportId", "storylineId", "heldStorylineId", "storylineTitle"
          FROM "StorylineReport"`)
      ).toEqual([
        {
          reportId: 70,
          storylineId: null,
          heldStorylineId: 1,
          storylineTitle: 'A story with no story',
        },
      ]);
      expect(await rows(`SELECT id, status FROM "Report"`)).toEqual([
        { id: 70, status: 'Pending' },
      ]);
      expect(await rows(`SELECT id, "reportIds", "holdReasons" FROM "HeldStoryline"`)).toEqual([
        { id: 1, reportIds: [70], holdReasons: ['open-report'] },
      ]);
    });

    it('can be deleted by a moderator while the report is open', async () => {
      await report('Processing');
      await deleteStoryline({ id: 1, userId: MODERATOR, isModerator: true });
      expect(await storylineIds()).toEqual([2]);
    });

    it("a moderator's delete marks the open report actioned, and leaves a resolved one", async () => {
      await report('Pending');
      await db.pg.exec(`
        INSERT INTO "Report" (id, status) VALUES (71, 'Unactioned');
        INSERT INTO "StorylineReport" ("storylineId", "reportId") VALUES (1, 71);
      `);
      await deleteStoryline({ id: 1, userId: MODERATOR, isModerator: true });
      expect(await rows(`SELECT id, status FROM "Report" ORDER BY id`)).toEqual([
        { id: 70, status: 'Actioned' },
        { id: 71, status: 'Unactioned' },
      ]);
    });

    it('can be deleted by its owner once the report is resolved, keeping no copy', async () => {
      await report('Unactioned');
      await deleteStoryline({ id: 1, userId: OWNER });
      expect(await storylineIds()).toEqual([2]);
      expect(await rows(`SELECT id FROM "HeldStoryline"`)).toEqual([]);
      expect(
        await rows(
          `SELECT "storylineId", "heldStorylineId", "storylineTitle" FROM "StorylineReport"`
        )
      ).toEqual([
        { storylineId: null, heldStorylineId: null, storylineTitle: 'A story with no story' },
      ]);
    });
  });

  describe('a taken-down storyline', () => {
    beforeEach(async () => {
      await db.pg.exec(
        `UPDATE "Storyline" SET "tosViolation" = true, "tosViolationByModerator" = true WHERE id = 1`
      );
    });

    it('is kept from its owner, keeping the takedown on record', async () => {
      await expect(deleteStoryline({ id: 1, userId: OWNER })).rejects.toThrow(
        STORYLINE_DELETE_REFUSALS.owner
      );
      expect(await storylineIds()).toEqual([1, 2]);
    });

    it('is kept from its owner when the owner is a moderator', async () => {
      await expect(deleteStoryline({ id: 1, userId: OWNER, isModerator: true })).rejects.toThrow(
        STORYLINE_DELETE_REFUSALS.owner
      );
      expect(await storylineIds()).toEqual([1, 2]);
    });

    it('can be deleted by a moderator', async () => {
      await deleteStoryline({ id: 1, userId: MODERATOR, isModerator: true });
      expect(await storylineIds()).toEqual([2]);
    });

    it("is kept from a moderator while the owner's appeal is open", async () => {
      await db.pg.exec(`INSERT INTO "Appeal" ("entityType", "entityId") VALUES ('Storyline', 1)`);
      await expect(
        deleteStoryline({ id: 1, userId: MODERATOR, isModerator: true })
      ).rejects.toThrow(STORYLINE_DELETE_REFUSALS.appealOpen);
      expect(await storylineIds()).toEqual([1, 2]);
    });

    it('can be deleted by a moderator once the appeal is ruled on', async () => {
      await db.pg.exec(
        `INSERT INTO "Appeal" ("entityType", "entityId", status) VALUES ('Storyline', 1, 'Rejected')`
      );
      await deleteStoryline({ id: 1, userId: MODERATOR, isModerator: true });
      expect(await storylineIds()).toEqual([2]);
    });
  });

  it('says not found for a storyline that is gone', async () => {
    await deleteStoryline({ id: 1, userId: OWNER });
    await expect(deleteStoryline({ id: 1, userId: OWNER })).rejects.toThrow('Storyline not found');
  });
});
