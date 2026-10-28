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

const { LEGAL_HOLD_REFUSAL } = await import('~/server/services/legal-hold.service');
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
  ])
    await db.pg.exec(migration(name));
  await db.pg.exec(`
    INSERT INTO "User" (id) VALUES (1), (2), (3);
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
      "entityId" integer NOT NULL, "userId" integer NOT NULL, "parentId" integer, "replyToId" integer,
      FOREIGN KEY ("entityId", "entityType") REFERENCES "CommentTopic" ("entityId", "entityType")
        ON DELETE CASCADE);
    -- As production: a parent with replies cannot be deleted on its own.
    ALTER TABLE "CommentV3" ADD FOREIGN KEY ("parentId") REFERENCES "CommentV3" ("id") ON DELETE RESTRICT;
    ALTER TABLE "CommentV3" ADD FOREIGN KEY ("replyToId") REFERENCES "CommentV3" ("id") ON DELETE SET NULL;
  `);
});

afterAll(async () => {
  await db.pg.close();
});

beforeEach(async () => {
  await db.pg.exec(`
    DELETE FROM "Appeal";
    DELETE FROM "EvidenceHold";
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

describe('deleteStoryline under a real account hold', () => {
  const REPLIER = 4;
  // A thread with a comment, and that comment's reply thread with a reply by REPLIER.
  beforeEach(async () => {
    await db.pg.exec(`
      INSERT INTO "Thread" (id, "storylineId") VALUES (1, 1);
      INSERT INTO "CommentV2" (id, "threadId", "userId") VALUES (1, 1, ${CONTRIBUTOR});
      INSERT INTO "Thread" (id, "commentId", "parentThreadId", "rootThreadId") VALUES (2, 1, 1, 1);
      INSERT INTO "CommentV2" (id, "threadId", "userId") VALUES (2, 2, ${REPLIER});
    `);
  });
  const hold = (userId: number) =>
    db.pg.exec(`INSERT INTO "EvidenceHold" ("userId", "releasedAt") VALUES (${userId}, NULL)`);

  it('deletes with no hold on anyone, comments and all', async () => {
    await deleteStoryline({ id: 1, userId: OWNER });
    expect(await storylineIds()).toEqual([2]);
    expect(await rows(`SELECT id FROM "CommentV2"`)).toEqual([]);
  });

  for (const [who, userId] of [
    ['the owner', OWNER],
    ['the author of a comment on its thread', CONTRIBUTOR],
  ] as const)
    it(`refuses a moderator when ${who} is held, and nothing goes`, async () => {
      await hold(userId);
      await expect(
        deleteStoryline({ id: 1, userId: MODERATOR, isModerator: true })
      ).rejects.toMatchObject({ code: 'FORBIDDEN', message: LEGAL_HOLD_REFUSAL });
      expect(await storylineIds()).toEqual([1, 2]);
      expect(await rows(`SELECT id FROM "CommentV2" ORDER BY id`)).toEqual([{ id: 1 }, { id: 2 }]);
    });

  it('refuses a moderator when the author of a comment on its topic is held', async () => {
    await db.pg.exec(`
      INSERT INTO "CommentTopic" ("entityType", "entityId") VALUES ('storyline', 1);
      INSERT INTO "CommentV3" (id, "entityType", "entityId", "userId") VALUES (20, 'storyline', 1, 9);
    `);
    await hold(9);
    await expect(
      deleteStoryline({ id: 1, userId: MODERATOR, isModerator: true })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: LEGAL_HOLD_REFUSAL });
    expect(await rows(`SELECT id FROM "CommentV3"`)).toEqual([{ id: 20 }]);
  });

  // A comment's reply thread with no parent or root link does not cascade; it is still walked,
  // which can only refuse more than the cascade needs.
  it('refuses when the held author is in a reply thread linked only through its comment', async () => {
    await db.pg.exec(`
      INSERT INTO "Thread" (id, "commentId", "parentThreadId", "rootThreadId") VALUES (8, 1, NULL, NULL);
      INSERT INTO "CommentV2" (id, "threadId", "userId") VALUES (8, 8, 8);
    `);
    await hold(8);
    await expect(
      deleteStoryline({ id: 1, userId: MODERATOR, isModerator: true })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: LEGAL_HOLD_REFUSAL });
  });

  it('deletes a storyline whose comment topic holds a comment and a reply to it', async () => {
    await db.pg.exec(`
      INSERT INTO "CommentTopic" ("entityType", "entityId") VALUES ('storyline', 1);
      INSERT INTO "CommentV3" (id, "entityType", "entityId", "userId") VALUES (10, 'storyline', 1, ${CONTRIBUTOR});
      INSERT INTO "CommentV3" (id, "entityType", "entityId", "userId", "parentId", "replyToId")
        VALUES (11, 'storyline', 1, ${REPLIER}, 10, 10);
    `);
    await deleteStoryline({ id: 1, userId: OWNER });
    expect(await storylineIds()).toEqual([2]);
    expect(await rows(`SELECT id FROM "CommentV3"`)).toEqual([]);
  });

  it('deletes when the only hold was released', async () => {
    await db.pg.exec(
      `INSERT INTO "EvidenceHold" ("userId", "releasedAt") VALUES (${REPLIER}, now())`
    );
    await deleteStoryline({ id: 1, userId: MODERATOR, isModerator: true });
    expect(await storylineIds()).toEqual([2]);
  });

  // A reply thread whose comment was deleted keeps its parent and root links, which cascade.
  it('refuses a moderator when the held author is in a reply thread its comment no longer links', async () => {
    await db.pg.exec(`
      INSERT INTO "Thread" (id, "commentId", "parentThreadId", "rootThreadId") VALUES (3, NULL, 1, 1);
      INSERT INTO "CommentV2" (id, "threadId", "userId") VALUES (3, 3, 5);
    `);
    await hold(5);
    await expect(
      deleteStoryline({ id: 1, userId: MODERATOR, isModerator: true })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: LEGAL_HOLD_REFUSAL });
    expect(await rows(`SELECT id FROM "CommentV2" ORDER BY id`)).toEqual([
      { id: 1 },
      { id: 2 },
      { id: 3 },
    ]);
  });

  it('refuses when the held author is in a thread linked to it by its root alone', async () => {
    await db.pg.exec(`
      INSERT INTO "Thread" (id, "commentId", "parentThreadId", "rootThreadId") VALUES (4, NULL, NULL, 1);
      INSERT INTO "CommentV2" (id, "threadId", "userId") VALUES (4, 4, 6);
    `);
    await hold(6);
    await expect(
      deleteStoryline({ id: 1, userId: MODERATOR, isModerator: true })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: LEGAL_HOLD_REFUSAL });
  });

  it('refuses when the held author is two threads down, through a parent at each step', async () => {
    await db.pg.exec(`
      INSERT INTO "Thread" (id, "commentId", "parentThreadId", "rootThreadId") VALUES
        (5, NULL, 1, NULL), (6, NULL, 5, NULL);
      INSERT INTO "CommentV2" (id, "threadId", "userId") VALUES (6, 6, 7);
    `);
    await hold(7);
    await expect(
      deleteStoryline({ id: 1, userId: MODERATOR, isModerator: true })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: LEGAL_HOLD_REFUSAL });
  });

  it('is stopped by a hold placed after its check, by the delete itself', async () => {
    await db.pg.exec(`
      INSERT INTO "PlacementSpace" (surface, "entityType", "entityId", mode, price)
        VALUES ('storyline', 'storyline', 1, 'review', 50);
      INSERT INTO "Report" (id, status) VALUES (70, 'Pending');
      INSERT INTO "StorylineReport" ("storylineId", "reportId") VALUES (1, 70);
    `);
    const raw = pgliteRaw(db.pg);
    w.$executeRaw.mockImplementation((async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      if (strings.join('?').includes('DELETE FROM "Storyline"')) await hold(REPLIER);
      return raw.executeRaw(strings, ...values);
    }) as never);
    await expect(
      deleteStoryline({ id: 1, userId: MODERATOR, isModerator: true })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: LEGAL_HOLD_REFUSAL });
    expect(await storylineIds()).toEqual([1, 2]);
    expect(await rows(`SELECT id FROM "CommentV2" ORDER BY id`)).toEqual([{ id: 1 }, { id: 2 }]);
    // The writes before the refused DELETE are rolled back with it.
    expect(await rows(`SELECT "entityId" FROM "PlacementSpace"`)).toEqual([{ entityId: 1 }]);
    expect(await rows(`SELECT id, status FROM "Report"`)).toEqual([{ id: 70, status: 'Pending' }]);
  });

  it('refuses a moderator, naming the hold, when a reply author is held', async () => {
    await hold(REPLIER);
    await expect(
      deleteStoryline({ id: 1, userId: MODERATOR, isModerator: true })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: LEGAL_HOLD_REFUSAL });
    expect(await storylineIds()).toEqual([1, 2]);
    expect(await rows(`SELECT id FROM "CommentV2" ORDER BY id`)).toEqual([{ id: 1 }, { id: 2 }]);
  });

  // The owner cannot tell a hold from the other reasons they may not delete.
  it('refuses a held owner exactly as an owner with an open report', async () => {
    const refusal = (fn: () => Promise<unknown>) =>
      fn().then(
        () => null,
        (e: { code: string; message: string }) => ({ code: e.code, message: e.message })
      );

    await hold(OWNER);
    const held = await refusal(() => deleteStoryline({ id: 1, userId: OWNER }));
    expect(await storylineIds()).toEqual([1, 2]);
    await db.pg.exec(`DELETE FROM "EvidenceHold"`);

    await db.pg.exec(`
      INSERT INTO "Report" (id, status) VALUES (70, 'Pending');
      INSERT INTO "StorylineReport" ("storylineId", "reportId") VALUES (1, 70);
    `);
    const reported = await refusal(() => deleteStoryline({ id: 1, userId: OWNER }));
    expect(await storylineIds()).toEqual([1, 2]);

    expect(held).toEqual({ code: 'BAD_REQUEST', message: STORYLINE_DELETE_REFUSALS.owner });
    expect(reported).toEqual(held);
  });
});
