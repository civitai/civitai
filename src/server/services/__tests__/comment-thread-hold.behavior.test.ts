import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * Deleting a parent row (a post, a model, a question...) cascades into its comment threads and every
 * comment in them, other people's included. A thread holding a held author's comment is detached
 * from the parent first, and is then unreachable from the site except for moderators. The SQL runs on
 * a Postgres stand-in with the real foreign keys, so the cascade is what decides.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

import { detachHeldThreadsCte, modelThreadParents } from '~/server/services/comment-thread-hold';
import { isCommentDetached, isThreadDetached } from '~/server/services/commentsv2.service';
import { deleteQuestion } from '~/server/services/question.service';
import { deleteAnswer } from '~/server/services/answer.service';
import { deleteResourceReview } from '~/server/services/resourceReview.service';
import {
  assertCommentEntityVisible,
  getCommentHandler,
} from '~/server/controllers/commentv2.controller';

const OWNER = 1;
const HELD = 2; // named on a pending report
const OTHER = 3;
const MARKED = 4; // held only by a hold marker

let db: PGlite;
const run = (sql: Prisma.Sql) => db.query(sql.text, sql.values as unknown[]);
const asSql = (first: TemplateStringsArray | Prisma.Sql, values: unknown[]) =>
  Array.isArray(first)
    ? Prisma.sql(first as TemplateStringsArray, ...(values as never[]))
    : (first as Prisma.Sql);
const commentIds = async () =>
  (await db.query<{ id: number }>(`SELECT id FROM "CommentV2" ORDER BY id`)).rows.map((r) => r.id);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "CsamReport" (
      id serial PRIMARY KEY, "userId" int, "reportSentAt" timestamp(3), "archivedAt" timestamp(3),
      details jsonb NOT NULL DEFAULT '{}', images jsonb NOT NULL DEFAULT '[]'
    );
    CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int NOT NULL, "needsReview" text, "blockedFor" text);
    CREATE TABLE "EvidenceHold" ("userId" int NOT NULL);
    CREATE VIEW "EvidenceHeldUser" AS SELECT "userId" FROM "EvidenceHold";
    CREATE TABLE "Post" (id int PRIMARY KEY, "userId" int NOT NULL);
    CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int NOT NULL);
    CREATE TABLE "ResourceReview" (
      id int PRIMARY KEY, "userId" int NOT NULL,
      "modelId" int REFERENCES "Model"(id) ON DELETE CASCADE
    );
    CREATE TABLE "Question" (id int PRIMARY KEY, "userId" int NOT NULL);
    CREATE TABLE "Answer" (
      id int PRIMARY KEY, "userId" int NOT NULL,
      "questionId" int REFERENCES "Question"(id) ON DELETE CASCADE
    );
    CREATE TABLE "Thread" (
      id int PRIMARY KEY,
      "postId" int UNIQUE REFERENCES "Post"(id) ON DELETE CASCADE,
      "modelId" int UNIQUE REFERENCES "Model"(id) ON DELETE CASCADE,
      "reviewId" int UNIQUE REFERENCES "ResourceReview"(id) ON DELETE CASCADE,
      "questionId" int UNIQUE REFERENCES "Question"(id) ON DELETE CASCADE,
      "answerId" int UNIQUE REFERENCES "Answer"(id) ON DELETE CASCADE,
      "parentThreadId" int REFERENCES "Thread"(id) ON DELETE CASCADE,
      "rootThreadId" int REFERENCES "Thread"(id) ON DELETE CASCADE,
      "commentId" int,
      "storylineId" int,
      metadata jsonb NOT NULL DEFAULT '{}'
    );
    CREATE TABLE "CommentV2" (
      id int PRIMARY KEY, "userId" int NOT NULL,
      "threadId" int NOT NULL REFERENCES "Thread"(id) ON DELETE CASCADE,
      "tosViolation" boolean NOT NULL DEFAULT false
    );
  `);
});
afterAll(() => db.close());

beforeEach(async () => {
  vi.clearAllMocks();
  await db.exec(`
    TRUNCATE "CommentV2", "Thread", "Answer", "Question", "ResourceReview", "Model", "Post",
      "CsamReport", "EvidenceHold";
    INSERT INTO "CsamReport" ("userId") VALUES (${HELD});
    INSERT INTO "EvidenceHold" VALUES (${MARKED});
  `);
  const viaStandIn = (async (first: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) =>
    (await run(asSql(first, values))).rows) as never;
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation(viaStandIn);
  vi.mocked(dbMock.dbRead.$queryRaw).mockImplementation(viaStandIn);
  vi.mocked(dbMock.dbWrite.$executeRaw).mockImplementation(
    (async (first: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) =>
      (await run(asSql(first, values))).affectedRows ?? 0) as never
  );
  // Statements in order on one connection, as the array form sends them.
  vi.mocked(dbMock.dbWrite.$transaction).mockImplementation((async (ops: unknown) =>
    Promise.all(ops as unknown[])) as never);
  const deleteRow = (table: string) =>
    (async ({ where }: { where: { id: number } }) =>
      (await db.query(`DELETE FROM "${table}" WHERE id = $1 RETURNING *`, [where.id]))
        .rows[0]) as never;
  vi.mocked(dbMock.dbWrite.question.delete).mockImplementation(deleteRow('Question'));
  vi.mocked(dbMock.dbWrite.answer.delete).mockImplementation(deleteRow('Answer'));
  vi.mocked(dbMock.dbWrite.resourceReview.delete).mockImplementation(deleteRow('ResourceReview'));
});

/** A thread on `column` = `parentId`: OTHER comments, and `replier` answers in a reply thread. */
async function seedThread(column: string, parentId: number, replier: number) {
  await db.exec(`
    INSERT INTO "Thread" (id, "${column}") VALUES (100, ${parentId});
    INSERT INTO "CommentV2" (id, "userId", "threadId") VALUES (1, ${OTHER}, 100);
    INSERT INTO "Thread" (id, "rootThreadId", "parentThreadId", "commentId") VALUES (101, 100, 100, 1);
    INSERT INTO "CommentV2" (id, "userId", "threadId") VALUES (2, ${replier}, 101);
  `);
}

describe('detaching held threads in the parent delete', () => {
  const deletePost = () =>
    run(Prisma.sql`
      WITH ${detachHeldThreadsCte({ postId: Prisma.sql`SELECT 10` }, true)}
      DELETE FROM "Post" WHERE id = 10`);

  it.each([
    ['named on a report', HELD],
    ['held by a marker', MARKED],
  ])('keeps a reply by an author %s, and the unheld comment it answers', async (_, replier) => {
    await db.exec(`INSERT INTO "Post" VALUES (10, ${OWNER})`);
    await seedThread('postId', 10, replier);

    await deletePost();

    expect((await db.query(`SELECT id FROM "Post"`)).rows).toEqual([]);
    expect(await commentIds()).toEqual([1, 2]);
    expect((await db.query(`SELECT "postId", metadata FROM "Thread" WHERE id = 100`)).rows).toEqual(
      [{ postId: null, metadata: expect.objectContaining({ detachedFrom: { postId: 10 } }) }]
    );
  });

  it('takes the thread with the post when no held author is in it (control)', async () => {
    await db.exec(`INSERT INTO "Post" VALUES (10, ${OWNER})`);
    await seedThread('postId', 10, OTHER);

    await deletePost();

    expect(await commentIds()).toEqual([]);
  });

  it('keeps a held reply in a thread linked to its comment only', async () => {
    await db.exec(`
      INSERT INTO "Post" VALUES (10, ${OWNER});
      INSERT INTO "Thread" (id, "postId") VALUES (100, 10);
      INSERT INTO "CommentV2" (id, "userId", "threadId") VALUES (1, ${OTHER}, 100);
      INSERT INTO "Thread" (id, "commentId") VALUES (101, 1);
      INSERT INTO "CommentV2" (id, "userId", "threadId") VALUES (2, ${HELD}, 101);
    `);

    await deletePost();

    expect(await commentIds()).toEqual([1, 2]);
  });

  it("keeps a held comment on another user's review of a deleted model", async () => {
    await db.exec(`
      INSERT INTO "Model" VALUES (20, ${OWNER});
      INSERT INTO "ResourceReview" VALUES (30, ${OTHER}, 20);
      INSERT INTO "Thread" (id, "reviewId") VALUES (100, 30);
      INSERT INTO "CommentV2" (id, "userId", "threadId") VALUES (1, ${HELD}, 100);
    `);

    await run(Prisma.sql`
      WITH ${detachHeldThreadsCte(modelThreadParents(Prisma.sql`SELECT 20`), true)}
      DELETE FROM "Model" WHERE id = 20`);

    expect((await db.query(`SELECT id FROM "ResourceReview"`)).rows).toEqual([]);
    expect(await commentIds()).toEqual([1]);
  });
});

describe('single deletes keep held threads', () => {
  it("keeps a held comment on another user's answer to a deleted question", async () => {
    await db.exec(`
      INSERT INTO "Question" VALUES (40, ${OWNER});
      INSERT INTO "Answer" VALUES (41, ${OTHER}, 40);
    `);
    await seedThread('answerId', 41, HELD);

    await deleteQuestion({ id: 40 });

    expect((await db.query(`SELECT id FROM "Question"`)).rows).toEqual([]);
    expect(await commentIds()).toEqual([1, 2]);
  });

  it('deletes an answer and the thread on it when no held author is in it (control)', async () => {
    await db.exec(`
      INSERT INTO "Question" VALUES (40, ${OTHER});
      INSERT INTO "Answer" VALUES (41, ${OWNER}, 40);
    `);
    await seedThread('answerId', 41, OTHER);

    await deleteAnswer({ id: 41 });

    expect((await db.query(`SELECT id FROM "Answer"`)).rows).toEqual([]);
    expect(await commentIds()).toEqual([]);
  });

  it('keeps a held reply on a deleted review', async () => {
    await db.exec(`
      INSERT INTO "Model" VALUES (20, ${OTHER});
      INSERT INTO "ResourceReview" VALUES (30, ${OWNER}, 20);
    `);
    await seedThread('reviewId', 30, HELD);

    await deleteResourceReview({ id: 30 }).catch(() => undefined);

    expect((await db.query(`SELECT id FROM "ResourceReview"`)).rows).toEqual([]);
    expect(await commentIds()).toEqual([1, 2]);
  });
});

describe('a detached thread is off the site', () => {
  beforeEach(async () => {
    await db.exec(`INSERT INTO "Post" VALUES (10, ${OWNER}), (11, ${OWNER})`);
    await seedThread('postId', 10, HELD);
    // A live thread on the other post, as a control.
    await db.exec(`
      INSERT INTO "Thread" (id, "postId") VALUES (200, 11);
      INSERT INTO "CommentV2" (id, "userId", "threadId") VALUES (3, ${OTHER}, 200);
      INSERT INTO "Thread" (id, "rootThreadId", "parentThreadId", "commentId") VALUES (201, 200, 200, 3);
    `);
    await run(Prisma.sql`
      WITH ${detachHeldThreadsCte({ postId: Prisma.sql`SELECT 10` }, true)}
      DELETE FROM "Post" WHERE id = 10`);
  });

  it('reads the detached tree as detached, from its root and from a reply in it', async () => {
    expect(await isThreadDetached(100)).toBe(true);
    expect(await isThreadDetached(101)).toBe(true);
    expect(await isCommentDetached(2)).toBe(true);
    expect(await isThreadDetached(200)).toBe(false);
    expect(await isCommentDetached(3)).toBe(false);
  });

  const ctx = (isModerator: boolean) =>
    ({ user: { id: 9, isModerator }, features: {}, req: {} } as never);

  it('refuses a detached comment by id to a member, and shows it to a moderator', async () => {
    vi.mocked(dbMock.dbRead.commentV2.findFirst).mockResolvedValue({
      id: 2,
      threadId: 101,
      user: { id: HELD },
    } as never);

    await expect(getCommentHandler({ ctx: ctx(false), input: { id: 2 } })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(getCommentHandler({ ctx: ctx(true), input: { id: 2 } })).resolves.toMatchObject({
      id: 2,
    });
  });

  it('refuses the replies of a detached comment to a member, and shows them to a moderator', async () => {
    await expect(
      assertCommentEntityVisible({ entityType: 'comment', entityId: 1 }, ctx(false))
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      assertCommentEntityVisible({ entityType: 'comment', entityId: 1 }, ctx(true))
    ).resolves.toBeUndefined();
    await expect(
      assertCommentEntityVisible({ entityType: 'comment', entityId: 3 }, ctx(false))
    ).resolves.toBeUndefined();
  });
});
