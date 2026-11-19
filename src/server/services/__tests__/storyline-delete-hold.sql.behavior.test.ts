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
 * Deleting a storyline under an account hold, through the real hold helpers, in an in-process
 * Postgres built from the shipped storyline migrations plus hold tables shaped like production's.
 */

const { deleteStoryline } = await import('~/server/services/storyline.service');

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
    CREATE TABLE "CommentTopic" ("entityType" text NOT NULL,
      "entityId" integer NOT NULL REFERENCES "Storyline"("id") ON DELETE CASCADE,
      PRIMARY KEY ("entityId", "entityType"));
    CREATE TABLE "CommentV3" ("id" serial PRIMARY KEY, "entityType" text NOT NULL,
      "entityId" integer NOT NULL, "userId" integer NOT NULL, "parentId" integer, "replyToId" integer,
      FOREIGN KEY ("entityId", "entityType") REFERENCES "CommentTopic" ("entityId", "entityType")
        ON DELETE CASCADE);
    -- As production: a parent with replies cannot be deleted on its own.
    ALTER TABLE "CommentV3" ADD FOREIGN KEY ("parentId") REFERENCES "CommentV3" ("id") ON DELETE RESTRICT;
    ALTER TABLE "CommentV3" ADD FOREIGN KEY ("replyToId") REFERENCES "CommentV3" ("id") ON DELETE SET NULL;
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
    DELETE FROM "EvidenceHold";
    DELETE FROM "StorylineCoverUpload";
    DELETE FROM "Image";
    DELETE FROM "StorylineCreateClick";
    DELETE FROM "StorylineBranchChoice";
    DELETE FROM "CommentV3";
    DELETE FROM "CommentTopic";
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

describe('deleteStoryline under a real account hold', () => {
  const REPLIER = 4;
  const READER = 5;
  // Two chapters (1 by the owner, 2 by CONTRIBUTOR) on published posts with images, a reader's
  // branch choice and create click, and a comment by CONTRIBUTOR with a reply by REPLIER.
  const seedStoryline = () =>
    db.pg.exec(`
      INSERT INTO "User" (id) VALUES (4), (5), (6), (7), (8), (9) ON CONFLICT DO NOTHING;
      INSERT INTO "Post" (id, "userId", "publishedAt") VALUES
        (501, ${OWNER}, '2026-10-01'), (502, ${CONTRIBUTOR}, '2026-10-02');
      INSERT INTO "Image" (id, "userId") VALUES (601, ${OWNER}), (602, ${CONTRIBUTOR});
      INSERT INTO "StorylineChapter" (id, "storylineId", "userId", depth, "postId")
        VALUES (10, 1, ${OWNER}, 0, 501), (11, 1, ${CONTRIBUTOR}, 1, 502);
      INSERT INTO "StorylineChapterEdge" ("chapterId", "storylineId", "parentChapterId", canon)
        VALUES (11, 1, 10, true);
      INSERT INTO "StorylineBranchChoice" ("userId", "parentChapterId", "chapterId")
        VALUES (${READER}, 10, 11);
      INSERT INTO "StorylineCreateClick" ("userId", "parentChapterId") VALUES (${READER}, 11);
      INSERT INTO "CommentTopic" ("entityType", "entityId") VALUES ('storyline', 1);
      INSERT INTO "CommentV3" (id, "entityType", "entityId", "userId", "parentId") VALUES
        (1, 'storyline', 1, ${CONTRIBUTOR}, NULL), (2, 'storyline', 1, ${REPLIER}, 1);
    `);
  beforeEach(seedStoryline);
  const hold = (userId: number) =>
    db.pg.exec(`INSERT INTO "EvidenceHold" ("userId", "releasedAt") VALUES (${userId}, NULL)`);
  const reportIt = (id = 70) =>
    db.pg.exec(`
      INSERT INTO "Report" (id, status) VALUES (${id}, 'Pending');
      INSERT INTO "StorylineReport" ("storylineId", "reportId") VALUES (1, ${id});
    `);
  const heldCopy = async () => ({
    storyline: await rows(
      `SELECT id, "userId", title, "deletedById", "reportIds", "commenterIds", "holdReasons"
       FROM "HeldStoryline"`
    ),
    chapters: await rows(
      `SELECT id, "storylineId", "postId", "userId", "ownerId", "authorId"
       FROM "HeldStorylineChapter" ORDER BY id`
    ),
    edges: await rows(
      `SELECT "chapterId", "parentChapterId", canon FROM "HeldStorylineChapterEdge" ORDER BY "chapterId"`
    ),
    choices: await rows(
      `SELECT "userId", "parentChapterId", "chapterId" FROM "HeldStorylineBranchChoice"`
    ),
    clicks: await rows(`SELECT "userId", "parentChapterId" FROM "HeldStorylineCreateClick"`),
  });
  const fullCopy = (holdReasons: string[], extra: Record<string, unknown> = {}) => ({
    storyline: [
      {
        id: 1,
        userId: OWNER,
        title: 'A story with no story',
        deletedById: OWNER,
        reportIds: [],
        commenterIds: [CONTRIBUTOR, REPLIER],
        holdReasons,
        ...extra,
      },
    ],
    chapters: [
      { id: 10, storylineId: 1, postId: 501, userId: OWNER, ownerId: OWNER, authorId: OWNER },
      {
        id: 11,
        storylineId: 1,
        postId: 502,
        userId: CONTRIBUTOR,
        ownerId: OWNER,
        authorId: CONTRIBUTOR,
      },
    ],
    edges: [{ chapterId: 11, parentChapterId: 10, canon: true }],
    choices: [{ userId: READER, parentChapterId: 10, chapterId: 11 }],
    clicks: [{ userId: READER, parentChapterId: 11 }],
  });
  const noCopy = { storyline: [], chapters: [], edges: [], choices: [], clicks: [] };
  const comments = () => rows<{ id: number }>(`SELECT id FROM "CommentV3" ORDER BY id`);
  const outcome = (fn: () => Promise<unknown>) =>
    fn().then(
      (value) => JSON.stringify({ value }),
      (e: { name: string; code: string; message: string }) =>
        JSON.stringify({ error: { name: e.name, code: e.code, message: e.message } })
    );

  it('deletes with no hold or report, comments and all, and keeps no copy', async () => {
    await deleteStoryline({ id: 1, userId: OWNER });
    expect(await storylineIds()).toEqual([2]);
    expect(await comments()).toEqual([]);
    expect(await heldCopy()).toEqual(noCopy);
  });

  it("deletes a held owner's storyline with a full copy, posts and images untouched", async () => {
    const before = {
      posts: await rows(`SELECT * FROM "Post" ORDER BY id`),
      images: await rows(`SELECT * FROM "Image" ORDER BY id`),
    };
    await hold(OWNER);
    expect(await deleteStoryline({ id: 1, userId: OWNER })).toEqual({ id: 1 });
    expect(await storylineIds()).toEqual([2]);
    expect(await heldCopy()).toEqual(fullCopy(['owner', 'chapter-author']));
    expect(await comments()).toEqual([]);
    expect(before.posts).toHaveLength(2);
    expect(before.images).toHaveLength(2);
    expect({
      posts: await rows(`SELECT * FROM "Post" ORDER BY id`),
      images: await rows(`SELECT * FROM "Image" ORDER BY id`),
    }).toEqual(before);
  });

  it("records its pictures and drafts in the copy, and keeps one for a held draft's author", async () => {
    await db.pg.exec(`
      INSERT INTO "Post" (id, "userId") VALUES (503, 9);
      INSERT INTO "Image" (id, "userId") VALUES (603, ${OWNER}), (604, ${OWNER});
      UPDATE "Storyline" SET "coverImageId" = 601, "heroImageId" = 603, "sparkImageId" = 604 WHERE id = 1;
      INSERT INTO "StorylineCoverUpload" ("storylineId", "imageId") VALUES (1, 603), (1, 604);
      INSERT INTO "StorylinePendingChapter" ("postId", "storylineId", "userId") VALUES (503, 1, 9);
    `);
    await hold(9);
    await deleteStoryline({ id: 1, userId: OWNER });
    expect(
      await rows(`SELECT "pendingPostIds", "pendingAuthorIds", "coverImageId", "heroImageId",
        "sparkImageId", "coverUploadImageIds", "holdReasons" FROM "HeldStoryline"`)
    ).toEqual([
      {
        pendingPostIds: [503],
        pendingAuthorIds: [9],
        coverImageId: 601,
        heroImageId: 603,
        sparkImageId: 604,
        coverUploadImageIds: [603, 604],
        holdReasons: ['pending-author'],
      },
    ]);
    // The draft and the pictures stay.
    expect(await rows(`SELECT id FROM "Post" WHERE id = 503`)).toEqual([{ id: 503 }]);
    expect(await rows(`SELECT id FROM "Image" ORDER BY id`)).toEqual([
      { id: 601 },
      { id: 602 },
      { id: 603 },
      { id: 604 },
    ]);
  });

  it("copies everything when only a chapter's author is held", async () => {
    await hold(CONTRIBUTOR);
    await deleteStoryline({ id: 1, userId: OWNER });
    expect((await heldCopy()).chapters).toHaveLength(2);
    expect((await heldCopy()).storyline).toMatchObject([{ holdReasons: ['chapter-author'] }]);
  });

  it("copies everything when a chapter is a moderator's tombstone", async () => {
    await db.pg.exec(`UPDATE "StorylineChapter" SET "removedAt" = now() WHERE id = 11`);
    await deleteStoryline({ id: 1, userId: OWNER });
    expect(await heldCopy()).toEqual(fullCopy(['tombstone']));
  });

  it('a moderator deletes it too, answering the open report, with a full copy', async () => {
    await reportIt();
    await hold(OWNER);
    await deleteStoryline({ id: 1, userId: MODERATOR, isModerator: true });
    expect(await storylineIds()).toEqual([2]);
    expect(await heldCopy()).toEqual(
      fullCopy(['open-report', 'owner', 'chapter-author'], {
        deletedById: MODERATOR,
        reportIds: [70],
      })
    );
    expect(await rows(`SELECT id, status FROM "Report"`)).toEqual([{ id: 70, status: 'Actioned' }]);
  });

  // Comments are not kept for a hold: a held commenter neither keeps a copy nor their comments.
  it("deletes a held commenter's comments with it, keeping no copy", async () => {
    await hold(REPLIER);
    await deleteStoryline({ id: 1, userId: OWNER });
    expect(await storylineIds()).toEqual([2]);
    expect(await comments()).toEqual([]);
    expect(await heldCopy()).toEqual(noCopy);
  });

  it('records every commenter in a copy kept for another reason', async () => {
    await db.pg.exec(
      `INSERT INTO "CommentV3" (id, "entityType", "entityId", "userId") VALUES (20, 'storyline', 1, 9)`
    );
    await reportIt();
    await deleteStoryline({ id: 1, userId: OWNER });
    expect((await heldCopy()).storyline).toMatchObject([
      { commenterIds: [CONTRIBUTOR, REPLIER, 9], holdReasons: ['open-report'] },
    ]);
  });

  it('copies everything when a hold lands after the checks, by the delete statement itself', async () => {
    const raw = pgliteRaw(db.pg);
    w.$executeRaw.mockImplementation((async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      if (strings.join('?').includes('DELETE FROM "Storyline"')) await hold(OWNER);
      return raw.executeRaw(strings, ...values);
    }) as never);
    await deleteStoryline({ id: 1, userId: OWNER });
    expect(await storylineIds()).toEqual([2]);
    expect(await heldCopy()).toEqual(fullCopy(['owner', 'chapter-author']));
  });

  // Ruling: the copy is written by the DELETE statement itself, never a statement before it.
  it('writes every copy in the DELETE statement itself', async () => {
    await hold(OWNER);
    w.$executeRaw.mockClear();
    await deleteStoryline({ id: 1, userId: OWNER });
    const statements = w.$executeRaw.mock.calls.map(([first]) =>
      Array.isArray(first) ? first.join('?') : (first as { sql: string }).sql
    );
    const touchingCopies = statements.filter((sql) => /"Held/.test(sql));
    expect(touchingCopies).toHaveLength(1);
    for (const part of [
      'INSERT INTO "HeldStoryline"',
      'INSERT INTO "HeldStorylineChapter"',
      'INSERT INTO "HeldStorylineChapterEdge"',
      'INSERT INTO "HeldStorylineBranchChoice"',
      'INSERT INTO "HeldStorylineCreateClick"',
      'UPDATE "StorylineReport"',
    ])
      expect(touchingCopies[0]).toContain(part);
    expect(touchingCopies[0]).toContain('DELETE FROM "Storyline" WHERE id =');
  });

  describe('the owner cannot tell what was kept', () => {
    // The owner's answer to a delete, then to a second delete, under each condition.
    const ownerSees = async () => [
      await outcome(() => deleteStoryline({ id: 1, userId: OWNER })),
      await outcome(() => deleteStoryline({ id: 1, userId: OWNER })),
    ];

    it('answers alike reported or not, held or not, the first time and the second', async () => {
      const plain = await ownerSees();
      expect(await heldCopy()).toEqual(noCopy);

      // The whole storyline again: chapters, readers' rows and comments.
      const seeds = async () => {
        await db.pg.exec(`
          DELETE FROM "HeldStoryline"; DELETE FROM "HeldStorylineChapter";
          DELETE FROM "HeldStorylineChapterEdge"; DELETE FROM "HeldStorylineBranchChoice";
          DELETE FROM "HeldStorylineCreateClick"; DELETE FROM "StorylineReport";
          DELETE FROM "Report"; DELETE FROM "EvidenceHold"; DELETE FROM "CommentV3";
          DELETE FROM "CommentTopic"; DELETE FROM "Image"; DELETE FROM "Post";
          INSERT INTO "Storyline" (id, "userId", title, "maxNsfwLevel", "updatedAt")
            VALUES (1, ${OWNER}, 'A story with no story', 1, now());
        `);
        await seedStoryline();
      };
      await seeds();
      await reportIt();
      const reported = await ownerSees();
      expect((await heldCopy()).chapters).toHaveLength(2);

      await seeds();
      await hold(OWNER);
      const held = await ownerSees();
      expect((await heldCopy()).chapters).toHaveLength(2);

      expect(plain[0]).toBe(JSON.stringify({ value: { id: 1 } }));
      expect(plain[1]).toContain('NOT_FOUND');
      expect(reported).toEqual(plain);
      expect(held).toEqual(plain);
    });

    it('answers anyone else not found, reported or not, deleted or not', async () => {
      const stranger = () => outcome(() => deleteStoryline({ id: 1, userId: CONTRIBUTOR }));
      const unreported = await stranger();
      await reportIt();
      const reported = await stranger();
      await hold(OWNER);
      const held = await stranger();
      await deleteStoryline({ id: 1, userId: OWNER });
      const deleted = await stranger();
      const missing = await outcome(() => deleteStoryline({ id: 999, userId: CONTRIBUTOR }));
      expect(unreported).toContain('NOT_FOUND');
      for (const answer of [reported, held, deleted, missing]) expect(answer).toBe(unreported);
    });

    it('fails a copy that cannot be written as any failed delete fails, and keeps everything', async () => {
      await db.pg.exec(`
        INSERT INTO "PlacementSpace" (surface, "entityType", "entityId", mode, price)
          VALUES ('storyline', 'storyline', 1, 'review', 50);
        ALTER TABLE "HeldStoryline" ADD CONSTRAINT "no_copies" CHECK (false) NOT VALID;
      `);
      try {
        await hold(OWNER);
        const copyFailed = await outcome(() => deleteStoryline({ id: 1, userId: OWNER }));
        expect(await storylineIds()).toEqual([1, 2]);
        expect(await rows(`SELECT "entityId" FROM "PlacementSpace"`)).toEqual([{ entityId: 1 }]);
        expect(await comments()).toEqual([{ id: 1 }, { id: 2 }]);
        await db.pg.exec(`DELETE FROM "EvidenceHold"`);

        // An unheld owner's delete failing for any other reason.
        await db.pg.exec(`
          CREATE FUNCTION refuse_delete() RETURNS trigger LANGUAGE plpgsql AS
            $$ BEGIN RAISE EXCEPTION 'no'; END $$;
          CREATE TRIGGER refuse_delete BEFORE DELETE ON "Storyline"
            FOR EACH ROW EXECUTE FUNCTION refuse_delete();
        `);
        const deleteFailed = await outcome(() => deleteStoryline({ id: 1, userId: OWNER }));
        expect(copyFailed).toContain('INTERNAL_SERVER_ERROR');
        expect(copyFailed).toBe(deleteFailed);
      } finally {
        await db.pg.exec(`
          ALTER TABLE "HeldStoryline" DROP CONSTRAINT IF EXISTS "no_copies";
          DROP TRIGGER IF EXISTS refuse_delete ON "Storyline";
          DROP FUNCTION IF EXISTS refuse_delete();
        `);
      }
    });
  });
});
