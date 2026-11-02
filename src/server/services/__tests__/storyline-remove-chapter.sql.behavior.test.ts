import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

const { trackModActivity, bustFetchThroughCache } = vi.hoisted(() => ({
  trackModActivity: vi.fn(),
  bustFetchThroughCache: vi.fn(async () => undefined),
}));
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  bustFetchThroughCache,
}));
vi.mock('~/server/services/moderator.service', () => ({ trackModActivity }));
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * Removing one chapter from a storyline, run as written against an in-process Postgres built from
 * the shipped storyline migrations, so the cascades, the removedBy check and the refusals are the
 * database's own. PGlite has one session, so nothing here interleaves two transactions.
 */

const {
  addOwnerChapter,
  removeStorylineChapter,
  STORYLINE_CHAPTER_REMOVE_REFUSALS: REFUSED,
} = await import('~/server/services/storyline.service');

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
    CREATE TABLE "PostReport" ("postId" integer NOT NULL, "reportId" integer NOT NULL);
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
    // The constraint as production has it, so the widening below replaces it.
    '20260809040000_placement_removed_by_cosmetic_takedown',
    '20260809041000_validate_placement_removed_by_check',
    '20261214120000_placement_removed_by_placer',
    '20261214121000_validate_placement_removed_by_placer',
    '20261216120000_storyline_chapter_removal_hold',
    '20261216130000_storyline_held_chapter',
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

const cleanTables = () =>
  db.pg.exec(`
    DELETE FROM "StorylineChapterRemovalHold";
    DELETE FROM "HeldStorylineChapter";
    DELETE FROM "HeldStorylineChapterEdge";
    DELETE FROM "HeldStorylineBranchChoice";
    DELETE FROM "HeldStorylineCreateClick";
    DELETE FROM "StorylineBranchChoice";
    DELETE FROM "StorylineCreateClick";
    DELETE FROM "EvidenceHold";
    DELETE FROM "Appeal";
    DELETE FROM "CommentV3";
    DELETE FROM "CommentTopic";
    DELETE FROM "CommentV2";
    DELETE FROM "Thread";
    DELETE FROM "StorylineReport";
    DELETE FROM "PostReport";
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

beforeEach(async () => {
  await cleanTables();
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
  const seed = () =>
    db.pg.exec(`
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
  const resetFixture = async () => {
    await cleanTables();
    await seed();
  };
  beforeEach(() => seed());

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

  // The parent's fork shares change once a way on from it is gone.
  it("refreshes the parent's reader split", async () => {
    bustFetchThroughCache.mockClear();
    await remove(CONTRIBUTOR);
    expect(bustFetchThroughCache.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringMatching(/:10$/),
    ]);
  });

  it('a moderator removes it as a tombstone, logged as a moderator action', async () => {
    await remove(MODERATOR, true);
    expect(
      await rows(
        `SELECT id, "postId", "removedAt" IS NOT NULL AS removed FROM "StorylineChapter" ORDER BY id`
      )
    ).toEqual([
      { id: 10, postId: 501, removed: false },
      { id: 11, postId: 502, removed: true },
    ]);
    expect((await placement900()).removedBy).toBe('moderator');
    expect(trackModActivity).toHaveBeenCalledTimes(1);
    expect(trackModActivity).toHaveBeenCalledWith(
      MODERATOR,
      { entityType: 'storyline', entityId: 1, activity: 'removeChapter' },
      expect.anything()
    );
  });

  // Nothing can continue a tombstone, so the main route must not end at one: "Add to a
  // storyline" would have no end to add to.
  describe('the main route afterwards', () => {
    const canonOf = async (chapterId: number) =>
      (
        await rows<{ canon: boolean }>(
          `SELECT canon FROM "StorylineChapterEdge" WHERE "chapterId" = $1`,
          [chapterId]
        )
      )[0]?.canon;

    it('ends at the parent of a canon tip a moderator removed', async () => {
      await remove(MODERATOR, true);
      expect(await canonOf(CHAPTER_2)).toBe(false);
    });

    it('walks up past a tombstone when its owner deletes the leaf under it', async () => {
      await db.pg.exec(`
        INSERT INTO "Post" (id, "userId", "nsfwLevel", "publishedAt") VALUES
          (503, ${OWNER}, 1, '2026-10-03');
        INSERT INTO "StorylineChapter" (id, "storylineId", "userId", depth, "postId")
          VALUES (12, 1, ${OWNER}, 2, 503);
        INSERT INTO "StorylineChapterEdge" ("chapterId", "storylineId", "parentChapterId", canon)
          VALUES (12, 1, 11, true);
        UPDATE "StorylineChapter" SET "removedAt" = now() WHERE id = 11;
      `);

      await removeStorylineChapter({ chapterId: 12, userId: OWNER, isModerator: false });

      expect(await chapterIds()).toEqual([10, 11]);
      expect(await canonOf(CHAPTER_2)).toBe(false);
    });
  });

  it('leaves a placement that is no longer approved as it is', async () => {
    await db.pg.exec(
      `UPDATE "Placement" SET status = 'removed', "removedBy" = 'moderator', "takenDownById" = ${MODERATOR} WHERE id = 900`
    );
    await remove(CONTRIBUTOR);
    expect(await chapterIds()).toEqual([10]);
    expect(await placement900()).toEqual({
      status: 'removed',
      removedBy: 'moderator',
      takenDownById: MODERATOR,
    });
  });

  it('its owner removes an unpaid chapter', async () => {
    await db.pg.exec(`UPDATE "Placement" SET amount = 0 WHERE id = 900`);
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
    await expect(remove(OWNER)).rejects.toThrow(REFUSED.moderatorOnly);
    expect(await chapterIds()).toEqual([10, 11]);
    expect((await placement900()).status).toBe('approved');
  });

  describe('when its owner or author must be kept for records', () => {
    const READER = 3;
    const keep = (userId: number) =>
      db.pg.exec(`INSERT INTO "EvidenceHold" ("userId", "releasedAt") VALUES (${userId}, NULL)`);
    // A reader's choice into chapter 2 and their ask for a tool after it, which its delete cascades.
    const seedReaders = () =>
      db.pg.exec(`
        UPDATE "Placement" SET amount = 0 WHERE id = 900;
        INSERT INTO "StorylineBranchChoice" ("userId", "parentChapterId", "chapterId")
          VALUES (${READER}, 10, 11);
        INSERT INTO "StorylineCreateClick" ("userId", "parentChapterId") VALUES (${READER}, 11);
      `);
    const copies = async () => ({
      chapters: await rows(
        `SELECT id, "storylineId", "postId", "userId", depth, "placementId", "removedAt",
          "ownerId", "authorId", "holdReasons", "heldAt" IS NOT NULL AS "hasHeldAt"
         FROM "HeldStorylineChapter"`
      ),
      edges: await rows(
        `SELECT "storylineId", "chapterId", "parentChapterId", canon, "ownerId", "authorId"
         FROM "HeldStorylineChapterEdge"`
      ),
      choices: await rows(
        `SELECT "userId", "parentChapterId", "chapterId", "ownerId", "authorId"
         FROM "HeldStorylineBranchChoice"`
      ),
      clicks: await rows(
        `SELECT "userId", "parentChapterId", "ownerId", "authorId" FROM "HeldStorylineCreateClick"`
      ),
    });
    const noCopies = { chapters: [], edges: [], choices: [], clicks: [] };
    const copiesOfChapter2 = {
      chapters: [
        {
          id: 11,
          storylineId: 1,
          postId: 502,
          userId: CONTRIBUTOR,
          depth: 1,
          placementId: 900,
          removedAt: null,
          ownerId: OWNER,
          authorId: CONTRIBUTOR,
          holdReasons: null,
          hasHeldAt: true,
        },
      ],
      edges: [
        {
          storylineId: 1,
          chapterId: 11,
          parentChapterId: 10,
          canon: true,
          ownerId: OWNER,
          authorId: CONTRIBUTOR,
        },
      ],
      choices: [
        {
          userId: READER,
          parentChapterId: 10,
          chapterId: 11,
          ownerId: OWNER,
          authorId: CONTRIBUTOR,
        },
      ],
      clicks: [{ userId: READER, parentChapterId: 11, ownerId: OWNER, authorId: CONTRIBUTOR }],
    };
    // Everything the remover, a reader or a timing could tell apart.
    const removeAndObserve = async (remover: number) => {
      bustFetchThroughCache.mockClear();
      w.$queryRaw.mockClear();
      w.$executeRaw.mockClear();
      const response = await remove(remover);
      return {
        response,
        chapters: await rows(`SELECT id, "removedAt" FROM "StorylineChapter" ORDER BY id`),
        edges: await rows(`SELECT "chapterId", "parentChapterId" FROM "StorylineChapterEdge"`),
        choices: await rows(`SELECT "userId" FROM "StorylineBranchChoice"`),
        clicks: await rows(`SELECT "userId" FROM "StorylineCreateClick"`),
        placement: await placement900(),
        cacheBusts: bustFetchThroughCache.mock.calls.map((c) => String(c[0])),
        statements: w.$queryRaw.mock.calls.length + w.$executeRaw.mock.calls.length,
        modActivity: trackModActivity.mock.calls.length,
      };
    };

    for (const [whose, keptUser, remover] of [
      ['its owner', OWNER, OWNER],
      ['its author', CONTRIBUTOR, CONTRIBUTOR],
      ['its author, removed by the owner', CONTRIBUTOR, OWNER],
      ['its owner, removed by the author', OWNER, CONTRIBUTOR],
    ] as const)
      it(`for ${whose}: the same hard delete as anyone's, with copies kept`, async () => {
        await seedReaders();
        const unkept = await removeAndObserve(remover);
        expect(await copies()).toEqual(noCopies);

        await resetFixture();
        await seedReaders();
        await keep(keptUser);
        const kept = await removeAndObserve(remover);

        expect(kept).toEqual(unkept);
        expect(kept.chapters).toEqual([{ id: 10, removedAt: null }]);
        expect(kept.cacheBusts).toEqual([expect.stringMatching(/:10$/)]);
        expect(await copies()).toEqual(copiesOfChapter2);
      });

    it('copies nothing once nobody needs it kept', async () => {
      await seedReaders();
      await db.pg.exec(
        `INSERT INTO "EvidenceHold" ("userId", "releasedAt") VALUES (${CONTRIBUTOR}, now())`
      );
      await remove(CONTRIBUTOR);
      expect(await chapterIds()).toEqual([10]);
      expect(await copies()).toEqual(noCopies);
    });

    // Decided after the removal's reads, so a change made while it runs still counts.
    it('copies it when that changes after the removal has read the chapter', async () => {
      await seedReaders();
      try {
        await db.pg.exec(`
          CREATE FUNCTION keep_contributor() RETURNS trigger AS $$
          BEGIN
            INSERT INTO "EvidenceHold" ("userId", "releasedAt") VALUES (${CONTRIBUTOR}, NULL);
            RETURN NEW;
          END $$ LANGUAGE plpgsql;
          CREATE TRIGGER keep_contributor BEFORE UPDATE ON "Placement"
            FOR EACH ROW EXECUTE FUNCTION keep_contributor();
        `);
        await remove(CONTRIBUTOR);
      } finally {
        await db.pg.exec(`
          DROP TRIGGER IF EXISTS keep_contributor ON "Placement";
          DROP FUNCTION IF EXISTS keep_contributor();
        `);
      }
      expect(await chapterIds()).toEqual([10]);
      expect(await copies()).toEqual(copiesOfChapter2);
    });

    // Ruling: the copy is written by the DELETE statement itself, never a statement before it, so
    // no change between the two can delete a chapter without keeping its copy. Don't split it out.
    it('writes the copies in the DELETE statement itself', async () => {
      await seedReaders();
      await keep(CONTRIBUTOR);
      w.$executeRaw.mockClear();
      await remove(CONTRIBUTOR);
      // A tagged template or a Prisma.sql object, whichever the call was made with.
      const statements = w.$executeRaw.mock.calls.map(([first]) =>
        Array.isArray(first) ? first.join('?') : (first as { sql: string }).sql
      );
      const touchingCopies = statements.filter((sql) => /"Held/.test(sql));
      expect(touchingCopies).toHaveLength(1);
      for (const part of [
        'INSERT INTO "HeldStorylineChapter"',
        'INSERT INTO "HeldStorylineChapterEdge"',
        'INSERT INTO "HeldStorylineBranchChoice"',
        'INSERT INTO "HeldStorylineCreateClick"',
      ])
        expect(touchingCopies[0]).toContain(part);
      expect(touchingCopies[0]).toMatch(/\)\s*DELETE FROM "StorylineChapter" WHERE id = \?\s*$/);
    });

    it("leaves a moderator's removal a tombstone, with no copies", async () => {
      await seedReaders();
      await keep(CONTRIBUTOR);
      await keep(OWNER);
      await remove(MODERATOR, true);
      expect(
        await rows(
          `SELECT id, "removedAt" IS NOT NULL AS removed FROM "StorylineChapter" ORDER BY id`
        )
      ).toEqual([
        { id: 10, removed: false },
        { id: 11, removed: true },
      ]);
      expect(await copies()).toEqual(noCopies);
    });

    it('records the removal for moderators while a report is open, as it would otherwise', async () => {
      await seedReaders();
      await keep(CONTRIBUTOR);
      await db.pg.exec(`
        INSERT INTO "Report" (id, status) VALUES (76, 'Pending');
        INSERT INTO "PostReport" ("postId", "reportId") VALUES (502, 76);
      `);
      await remove(CONTRIBUTOR);
      expect(await chapterIds()).toEqual([10]);
      expect(await copies()).toEqual(copiesOfChapter2);
      expect(
        await rows(`SELECT "removedByRole", "reportIds" FROM "StorylineChapterRemovalHold"`)
      ).toEqual([{ removedByRole: 'author', reportIds: [76] }]);
    });
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

  it('refuses while a draft continuing it is linked, and keeps the draft', async () => {
    await db.pg.exec(`
      INSERT INTO "Post" (id, "userId") VALUES (503, ${CONTRIBUTOR});
      INSERT INTO "StorylinePendingChapter" ("postId", "storylineId", "parentChapterId", "userId")
        VALUES (503, 1, 11, ${CONTRIBUTOR});
    `);
    await expect(remove(OWNER, true)).rejects.toThrow(REFUSED.waiting);
    expect(await chapterIds()).toEqual([10, 11]);
    expect(await rows(`SELECT "postId" FROM "StorylinePendingChapter"`)).toEqual([{ postId: 503 }]);
  });

  it("refuses while its own payment's payout has not been paid", async () => {
    await db.pg.exec(
      `UPDATE "PlacementTransaction" SET "transactionId" = NULL WHERE kind = 'toOwner'`
    );
    await expect(remove(MODERATOR, true)).rejects.toThrow(REFUSED.paidContinuation);
    expect(await chapterIds()).toEqual([10, 11]);
    expect((await placement900()).status).toBe('approved');
  });

  describe('during an open report', () => {
    const holds = () =>
      rows(
        `SELECT "storylineId", "storylineTitle", "chapterId", "postId", "chapterUserId", depth, "placementId",
          "parentChapterIds", "removedById", "removedByRole", "reportIds" FROM "StorylineChapterRemovalHold"`
      );
    const openPostReport = () =>
      db.pg.exec(`
        INSERT INTO "Report" (id, status) VALUES (70, 'Pending');
        INSERT INTO "PostReport" ("postId", "reportId") VALUES (502, 70);
      `);

    it("an author's removal is removed as usual, and recorded for moderators", async () => {
      await openPostReport();
      expect(await remove(CONTRIBUTOR)).toEqual({ storylineId: 1, chapterId: CHAPTER_2 });
      expect(await chapterIds()).toEqual([10]);
      expect(await holds()).toEqual([
        {
          storylineId: 1,
          storylineTitle: 'A story with no story',
          chapterId: CHAPTER_2,
          postId: 502,
          chapterUserId: CONTRIBUTOR,
          depth: 1,
          placementId: 900,
          parentChapterIds: [10],
          removedById: CONTRIBUTOR,
          removedByRole: 'author',
          reportIds: [70],
        },
      ]);
    });

    it('records a report on the storyline too, for the owner', async () => {
      await db.pg.exec(`
        UPDATE "Placement" SET amount = 0 WHERE id = 900;
        INSERT INTO "Report" (id, status) VALUES (72, 'Processing');
        INSERT INTO "StorylineReport" ("reportId", "storylineId") VALUES (72, 1);
      `);
      await remove(OWNER);
      expect(await holds()).toMatchObject([{ removedByRole: 'owner', reportIds: [72] }]);
    });

    it('records nothing when no report is open', async () => {
      await db.pg.exec(`
        INSERT INTO "Report" (id, status) VALUES (71, 'Actioned');
        INSERT INTO "PostReport" ("postId", "reportId") VALUES (502, 71);
      `);
      await remove(CONTRIBUTOR);
      expect(await holds()).toEqual([]);
    });

    // Everything any view of the storyline reads is the same, and so is the answer.
    it('leaves the storyline exactly as an unreported removal does', async () => {
      const state = () =>
        Promise.all([
          rows(
            `SELECT id, "storylineId", "postId", "userId", depth, "placementId", "removedAt"
             FROM "StorylineChapter" ORDER BY id`
          ),
          rows(
            `SELECT "chapterId", "parentChapterId", canon FROM "StorylineChapterEdge"
             ORDER BY "chapterId", "parentChapterId"`
          ),
          rows(`SELECT id, status, "removedBy", "takenDownById" FROM "Placement" ORDER BY id`),
          rows(`SELECT * FROM "Post" ORDER BY id`),
        ]);
      const run = async () => {
        bustFetchThroughCache.mockClear();
        const response = await remove(CONTRIBUTOR);
        const busts = bustFetchThroughCache.mock.calls.map((c) => String(c[0]));
        return { response, state: await state(), busts };
      };
      const reports = () => rows(`SELECT * FROM "Report" ORDER BY id`);
      const unreported = await run();
      await resetFixture();
      await openPostReport();
      const reportsBefore = await reports();
      const reported = await run();
      expect(reported).toEqual(unreported);
      expect(unreported.busts).toHaveLength(1);
      expect(await reports()).toEqual(reportsBefore);
      expect(await holds()).toHaveLength(1);
    });

    it('leaves the post free to be added again, as after any removal', async () => {
      // `addOwnerChapter`'s Prisma reads and writes, on the same tables.
      w.post.findUnique.mockImplementation((async ({ where }: { where: { id: number } }) => {
        const [row] = await rows<Record<string, unknown> & { chapterId: number | null }>(
          `SELECT p."userId", p."nsfwLevel", p."publishedAt", p."tosViolation", c.id AS "chapterId"
           FROM "Post" p LEFT JOIN "StorylineChapter" c ON c."postId" = p.id WHERE p.id = $1`,
          [where.id]
        );
        if (!row) return null;
        const { chapterId, ...rest } = row;
        return { ...rest, storylineChapter: chapterId ? { id: chapterId } : null };
      }) as never);
      w.storylineChapter.findUnique.mockImplementation((async ({
        where,
      }: {
        where: { id: number };
      }) => {
        const [row] = await rows<Record<string, unknown>>(
          `SELECT c.id, c."storylineId", c.depth, c."removedAt", st."userId", st."maxNsfwLevel",
             st."minorByScan", st."tosViolation"
           FROM "StorylineChapter" c JOIN "Storyline" st ON st.id = c."storylineId" WHERE c.id = $1`,
          [where.id]
        );
        if (!row) return null;
        const { userId, maxNsfwLevel, minorByScan, tosViolation, ...chapter } = row;
        return { ...chapter, storyline: { userId, maxNsfwLevel, minorByScan, tosViolation } };
      }) as never);
      w.storylineChapter.create.mockImplementation(
        (async ({
          data,
        }: {
          data: { storylineId: number; postId: number; userId: number; depth: number };
        }) =>
          (
            await rows(
              `INSERT INTO "StorylineChapter" ("storylineId", "postId", "userId", depth)
             VALUES ($1, $2, $3, $4) RETURNING id`,
              [data.storylineId, data.postId, data.userId, data.depth]
            )
          )[0]) as never
      );
      w.storylineChapterEdge.create.mockImplementation(
        (async ({
          data,
        }: {
          data: { storylineId: number; chapterId: number; parentChapterId: number; canon: boolean };
        }) =>
          (
            await rows(
              `INSERT INTO "StorylineChapterEdge" ("storylineId", "chapterId", "parentChapterId", canon)
             VALUES ($1, $2, $3, $4) RETURNING *`,
              [data.storylineId, data.chapterId, data.parentChapterId, data.canon]
            )
          )[0]) as never
      );
      w.storylineChapterEdge.findFirst.mockImplementation(
        (async ({ where }: { where: { parentChapterId: number } }) =>
          (
            await rows(
              `SELECT "chapterId" FROM "StorylineChapterEdge" WHERE "parentChapterId" = $1 AND canon`,
              [where.parentChapterId]
            )
          )[0] ?? null) as never
      );
      // The owner's own chapter, so the owner can add its post back.
      await db.pg.exec(`
        UPDATE "Post" SET "userId" = ${OWNER} WHERE id = 502;
        UPDATE "StorylineChapter" SET "userId" = ${OWNER}, "placementId" = NULL WHERE id = 11;
      `);
      const addBack = () => addOwnerChapter({ parentChapterId: 10, postId: 502, userId: OWNER });
      await expect(addBack()).rejects.toThrow('This post is already in a storyline');

      await openPostReport();
      await remove(OWNER);
      expect(await holds()).toHaveLength(1);
      const { chapterId } = await addBack();
      expect(
        await rows(`SELECT id, "postId", depth FROM "StorylineChapter" ORDER BY depth`)
      ).toEqual([
        { id: 10, postId: 501, depth: 0 },
        { id: chapterId, postId: 502, depth: 1 },
      ]);
    });

    it('records nothing for a report on another post or storyline', async () => {
      await db.pg.exec(`
        INSERT INTO "Report" (id, status) VALUES (74, 'Pending'), (75, 'Pending');
        INSERT INTO "PostReport" ("postId", "reportId") VALUES (501, 74);
        INSERT INTO "StorylineReport" ("reportId", "storylineId") VALUES (75, 2);
      `);
      await remove(CONTRIBUTOR);
      expect(await holds()).toEqual([]);
    });

    // Deliberate: a moderator's own storyline or chapter is theirs as a user, so they get the owner
    // or author path. The moderator path (tombstone, mod log) is for other people's content. See
    // the PR that added chapter removal before changing it.
    it('a moderator who owns the storyline removes as its owner, recorded like any owner', async () => {
      await db.pg.exec(`
        UPDATE "Placement" SET amount = 0 WHERE id = 900;
        UPDATE "Storyline" SET "userId" = ${MODERATOR} WHERE id = 1;
      `);
      await openPostReport();
      await remove(MODERATOR, true);
      expect(await chapterIds()).toEqual([10]);
      expect((await placement900()).removedBy).toBe('owner');
      expect(trackModActivity).not.toHaveBeenCalled();
      expect(await holds()).toMatchObject([{ removedById: MODERATOR, removedByRole: 'owner' }]);
    });

    it('keeps a paid chapter from a moderator who owns the storyline, as from any owner', async () => {
      await db.pg.exec(`UPDATE "Storyline" SET "userId" = ${MODERATOR} WHERE id = 1`);
      await expect(remove(MODERATOR, true)).rejects.toThrow(REFUSED.moderatorOnly);
      expect(await chapterIds()).toEqual([10, 11]);
    });

    it("leaves a moderator's removal unrecorded, a tombstone as always", async () => {
      await openPostReport();
      await remove(MODERATOR, true);
      expect(await holds()).toEqual([]);
    });
  });

  it('gives the same unsettled-payment refusal whether or not a report is open', async () => {
    await db.pg.exec(
      `UPDATE "PlacementTransaction" SET "transactionId" = NULL WHERE kind = 'toOwner'`
    );
    await expect(remove(CONTRIBUTOR)).rejects.toThrow(REFUSED.paidContinuation);
    await db.pg.exec(`
      INSERT INTO "Report" (id, status) VALUES (73, 'Pending');
      INSERT INTO "PostReport" ("postId", "reportId") VALUES (502, 73);
    `);
    await expect(remove(CONTRIBUTOR)).rejects.toThrow(REFUSED.paidContinuation);
  });

  it('refuses chapter 1', async () => {
    await expect(removeStorylineChapter({ chapterId: 10, userId: OWNER })).rejects.toThrow(
      REFUSED.firstChapter
    );
  });

  it('keeps a taken-down storyline from all but a moderator', async () => {
    await db.pg.exec(`UPDATE "Storyline" SET "tosViolation" = true WHERE id = 1`);
    await expect(remove(CONTRIBUTOR)).rejects.toThrow(REFUSED.moderatorOnly);
    await remove(MODERATOR, true);
    expect(
      await rows(`SELECT "removedAt" IS NOT NULL AS removed FROM "StorylineChapter" WHERE id = 11`)
    ).toEqual([{ removed: true }]);
  });

  it("refuses a chapter a moderator already took down, so its post can't come back", async () => {
    await db.pg.exec(`UPDATE "StorylineChapter" SET "removedAt" = now() WHERE id = 11`);
    await expect(remove(CONTRIBUTOR)).rejects.toThrow(REFUSED.removed);
    expect(await chapterIds()).toEqual([10, 11]);
  });
});
