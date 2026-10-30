import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

const { trackModActivity } = vi.hoisted(() => ({ trackModActivity: vi.fn() }));
vi.mock('~/server/services/moderator.service', () => ({ trackModActivity }));
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * Removing one chapter from a storyline, run as written against an in-process Postgres built from
 * the shipped storyline migrations, so the cascades, the removedBy check and the refusals are the
 * database's own. PGlite has one session, so nothing here interleaves two transactions.
 */

const { removeStorylineChapter, STORYLINE_CHAPTER_REMOVE_REFUSALS: REFUSED } = await import(
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
      "data" jsonb NOT NULL DEFAULT '{}', "removedBy" text, "takenDownAt" timestamp(3),
      "takenDownById" integer);
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
    '20261214120000_placement_removed_by_placer',
    '20261214121000_validate_placement_removed_by_placer',
  ])
    await db.pg.exec(migration(name));
  await db.pg.exec(`
    INSERT INTO "User" (id) VALUES (1), (2), (3);
    -- What the real hold check reads (see storyline-delete-hold.sql.behavior.test.ts); empty here.
    CREATE TABLE "CsamReport" (id serial PRIMARY KEY, "userId" int, "reportSentAt" timestamp(3),
      "archivedAt" timestamp(3), details jsonb NOT NULL DEFAULT '{}', images jsonb NOT NULL DEFAULT '[]');
    CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int NOT NULL, "needsReview" text, "blockedFor" text);
    CREATE TABLE "EvidenceHold" ("userId" int NOT NULL, "releasedAt" timestamp(3));
    CREATE VIEW "EvidenceHeldUser" AS
      SELECT "userId" FROM "EvidenceHold" WHERE "releasedAt" IS NULL GROUP BY "userId";
    -- As production: a reply thread goes with its parent and root threads; a comment's delete
    -- only unlinks its reply thread.
    CREATE TABLE "Thread" ("id" serial PRIMARY KEY,
      "storylineId" integer REFERENCES "Storyline"("id") ON DELETE CASCADE, "commentId" integer,
      "parentThreadId" integer REFERENCES "Thread"("id") ON DELETE CASCADE,
      "rootThreadId" integer REFERENCES "Thread"("id") ON DELETE CASCADE);
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

const CHAPTER_2 = 11;
const chapterIds = async () =>
  (await rows<{ id: number }>(`SELECT id FROM "StorylineChapter" ORDER BY id`)).map((r) => r.id);
const placement900 = async () =>
  (
    await rows<{ status: string; removedBy: string | null; takenDownById: number | null }>(
      `SELECT status, "removedBy", "takenDownById" FROM "Placement" WHERE id = 900`
    )
  )[0];
const posts = () =>
  rows(`SELECT id, "userId", "nsfwLevel", "publishedAt", "tosViolation" FROM "Post" ORDER BY id`);
const remove = (userId: number, isModerator = false) =>
  removeStorylineChapter({ chapterId: CHAPTER_2, userId, isModerator });

describe('removeStorylineChapter', () => {
  // Chapter 2 continues chapter 1 through a paid, approved and settled placement, on published posts.
  beforeEach(async () => {
    await db.pg.exec(`
      INSERT INTO "Post" (id, "userId", "nsfwLevel", "publishedAt") VALUES
        (501, ${OWNER}, 1, '2026-10-01'), (502, ${CONTRIBUTOR}, 1, '2026-10-02');
      INSERT INTO "StorylineChapter" (id, "storylineId", "userId", depth, "postId", "placementId")
        VALUES (10, 1, ${OWNER}, 0, 501, NULL), (11, 1, ${CONTRIBUTOR}, 1, 502, 900);
      INSERT INTO "StorylineChapterEdge" ("chapterId", "storylineId", "parentChapterId", canon)
        VALUES (11, 1, 10, true);
      INSERT INTO "Placement" (id, surface, "targetType", "targetId", status, amount, data)
        VALUES (900, 'storyline', 'post', 501, 'approved', 100, '{"postId": 502}');
      INSERT INTO "PlacementTransaction" ("placementId", kind, amount, "transactionId") VALUES
        (900, 'holdPrincipal', 100, 'placement-900-holdPrincipal'),
        (900, 'toOwner', 100, 'placement-900-toOwner');
    `);
  });

  it('its author removes it: the post is untouched and the placement records who', async () => {
    const before = await posts();
    expect(await remove(CONTRIBUTOR)).toEqual({ storylineId: 1, chapterId: CHAPTER_2 });

    expect(await chapterIds()).toEqual([10]);
    expect(await rows(`SELECT * FROM "StorylineChapterEdge"`)).toEqual([]);
    expect(await posts()).toEqual(before);
    expect(await placement900()).toEqual({
      status: 'removed',
      removedBy: 'placer',
      takenDownById: CONTRIBUTOR,
    });
    expect(trackModActivity).not.toHaveBeenCalled();
  });

  it('a moderator removes it, logged as a moderator action', async () => {
    await remove(MODERATOR, true);
    expect(await chapterIds()).toEqual([10]);
    expect((await placement900()).removedBy).toBe('moderator');
    expect(trackModActivity).toHaveBeenCalledWith(
      MODERATOR,
      { entityType: 'storyline', entityId: 1, activity: 'removeChapter' },
      expect.anything()
    );
  });

  it('its owner removes an unpaid chapter', async () => {
    await db.pg.exec(`UPDATE "Placement" SET amount = 0, free = true WHERE id = 900`);
    await remove(OWNER);
    expect(await chapterIds()).toEqual([10]);
    expect((await placement900()).removedBy).toBe('owner');
  });

  it('its owner removes a chapter of their own that no placement added', async () => {
    await db.pg.exec(
      `UPDATE "StorylineChapter" SET "userId" = ${OWNER}, "placementId" = NULL WHERE id = 11`
    );
    await remove(OWNER);
    expect(await chapterIds()).toEqual([10]);
    expect((await placement900()).status).toBe('approved');
  });

  it('keeps a chapter someone paid to add from its owner', async () => {
    await expect(remove(OWNER)).rejects.toThrow(REFUSED.paidByContributor);
    expect(await chapterIds()).toEqual([10, 11]);
    expect((await placement900()).status).toBe('approved');
  });

  it('refuses anyone else', async () => {
    await expect(remove(99)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await chapterIds()).toEqual([10, 11]);
  });

  it('refuses while a chapter continues from it', async () => {
    await db.pg.exec(`
      INSERT INTO "StorylineChapter" (id, "storylineId", "userId", depth) VALUES (12, 1, ${OWNER}, 2);
      INSERT INTO "StorylineChapterEdge" ("chapterId", "storylineId", "parentChapterId") VALUES (12, 1, 11);
    `);
    await expect(remove(MODERATOR, true)).rejects.toThrow(REFUSED.hasChildren);
    expect(await chapterIds()).toEqual([10, 11, 12]);
  });

  it('refuses while a continuation of it waits for review', async () => {
    await db.pg.exec(`
      INSERT INTO "Placement" (id, surface, "targetType", "targetId", status, amount, free)
        VALUES (901, 'storyline', 'post', 502, 'pending', 0, true);
    `);
    await expect(remove(CONTRIBUTOR)).rejects.toThrow(REFUSED.waiting);
    expect(await chapterIds()).toEqual([10, 11]);
  });

  it("refuses while its own payment's payout has not been paid", async () => {
    await db.pg.exec(
      `UPDATE "PlacementTransaction" SET "transactionId" = NULL WHERE kind = 'toOwner'`
    );
    await expect(remove(MODERATOR, true)).rejects.toThrow(REFUSED.paidContinuation);
    expect(await chapterIds()).toEqual([10, 11]);
    expect((await placement900()).status).toBe('approved');
  });

  it('refuses chapter 1', async () => {
    await expect(removeStorylineChapter({ chapterId: 10, userId: OWNER })).rejects.toThrow(
      REFUSED.firstChapter
    );
  });

  it('keeps a taken-down storyline from all but a moderator', async () => {
    await db.pg.exec(`UPDATE "Storyline" SET "tosViolation" = true WHERE id = 1`);
    await expect(remove(CONTRIBUTOR)).rejects.toThrow(REFUSED.takenDown);
    await remove(MODERATOR, true);
    expect(await chapterIds()).toEqual([10]);
  });
});
