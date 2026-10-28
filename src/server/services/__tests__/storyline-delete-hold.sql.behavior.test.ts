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
 * The account-hold refusal through the real `accountHoldSql`, against a hold marker in the same
 * shape as production's (`EvidenceHold`, and the `EvidenceHeldUser` view over it). Deleting a storyline, run as written against an in-process Postgres built from the
 * shipped storyline migrations, so the cascades and the refusals are the database's own.
 *
 * PGlite has one session, so nothing here interleaves two transactions. The delete's lock against
 * a concurrent chapter add was checked once against a real Postgres (see the PR).
 */

const { LEGAL_HOLD_REFUSAL, OWNER_CONTENT_KEPT } = await import(
  '~/server/services/legal-hold.service'
);
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
    CREATE TABLE "Thread" ("id" serial PRIMARY KEY,
      "storylineId" integer REFERENCES "Storyline"("id") ON DELETE CASCADE, "commentId" integer);
    CREATE TABLE "CommentV2" ("id" serial PRIMARY KEY,
      "threadId" integer NOT NULL REFERENCES "Thread"("id") ON DELETE CASCADE,
      "userId" integer NOT NULL);
    ALTER TABLE "Thread" ADD FOREIGN KEY ("commentId") REFERENCES "CommentV2"("id") ON DELETE CASCADE;
    CREATE TABLE "CommentV3" ("id" serial PRIMARY KEY, "entityType" text NOT NULL,
      "entityId" integer NOT NULL, "userId" integer NOT NULL);
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
      INSERT INTO "Thread" (id, "commentId") VALUES (2, 1);
      INSERT INTO "CommentV2" (id, "threadId", "userId") VALUES (2, 2, ${REPLIER});
    `);
  });
  const hold = (userId: number) =>
    db.pg.exec(`INSERT INTO "EvidenceHold" ("userId", "releasedAt") VALUES (${userId}, NULL)`);

  it('deletes with no hold on anyone', async () => {
    await deleteStoryline({ id: 1, userId: OWNER });
    expect(await storylineIds()).toEqual([2]);
  });

  it('deletes when the only hold was released', async () => {
    await db.pg.exec(
      `INSERT INTO "EvidenceHold" ("userId", "releasedAt") VALUES (${REPLIER}, now())`
    );
    await deleteStoryline({ id: 1, userId: MODERATOR, isModerator: true });
    expect(await storylineIds()).toEqual([2]);
  });

  it('refuses a moderator, naming the hold, when a reply author is held', async () => {
    await hold(REPLIER);
    await expect(
      deleteStoryline({ id: 1, userId: MODERATOR, isModerator: true })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: LEGAL_HOLD_REFUSAL });
    expect(await storylineIds()).toEqual([1, 2]);
    expect(await rows(`SELECT id FROM "CommentV2" ORDER BY id`)).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('refuses the owner without naming the hold, when the owner is held', async () => {
    await hold(OWNER);
    await expect(deleteStoryline({ id: 1, userId: OWNER })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: OWNER_CONTENT_KEPT,
    });
    expect(await storylineIds()).toEqual([1, 2]);
  });
});
