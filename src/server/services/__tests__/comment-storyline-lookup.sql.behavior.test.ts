import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { dbMock } from '~/__tests__/mocks';
import {
  getCommentCrucibleId,
  crucibleOfCommentSql,
  storylineOfCommentSql,
  storylineOfThreadSql,
} from '~/server/services/commentsv2.service';

/** Runs the real storyline lookup the reply gate depends on against an in-process Postgres. */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

let db: PGlite;

const storylineOf = async (sql: Prisma.Sql) => {
  const { rows } = await db.query<{ storylineId: number }>(sql.text, sql.values);
  return rows[0]?.storylineId ?? null;
};
const ofThread = (id: number) => storylineOf(storylineOfThreadSql(id));
const ofComment = (id: number) => storylineOf(storylineOfCommentSql(id));

beforeAll(async () => {
  db = new PGlite();
  // Storyline 1's thread 10 > comment 100 > reply thread 11 > comment 101 > reply thread 12, whose
  // rootThreadId is NULL as on some prod rows. Thread 13 lost its parent comment (commentId NULL)
  // but kept rootThreadId; thread 14 replies under it with no rootThreadId of its own. Image thread
  // 20 has a reply thread 21.
  await db.exec(`
    CREATE TABLE "Thread"(id int PRIMARY KEY, "storylineId" int, "imageId" int,
      "commentId" int, "rootThreadId" int, "crucibleId" int);
    CREATE TABLE "CommentV2"(id int PRIMARY KEY, "threadId" int);
    INSERT INTO "Thread" VALUES (10, 1, NULL, NULL, NULL), (20, NULL, 5, NULL, NULL);
    INSERT INTO "CommentV2" VALUES (100, 10), (200, 20);
    INSERT INTO "Thread" VALUES (11, NULL, NULL, 100, 10), (21, NULL, NULL, 200, 20);
    INSERT INTO "CommentV2" VALUES (101, 11), (201, 21);
    INSERT INTO "Thread" VALUES (12, NULL, NULL, 101, NULL), (13, NULL, NULL, NULL, 10);
    INSERT INTO "CommentV2" VALUES (102, 12), (103, 13);
    INSERT INTO "Thread" VALUES (14, NULL, NULL, 103, NULL);
    INSERT INTO "CommentV2" VALUES (104, 14);
    -- Crucible 7's thread 30 > comment 300 > reply thread 31 (no rootThreadId) > comment 301.
    INSERT INTO "Thread"(id, "crucibleId") VALUES (30, 7);
    INSERT INTO "CommentV2" VALUES (300, 30);
    INSERT INTO "Thread"(id, "commentId") VALUES (31, 300);
    INSERT INTO "CommentV2" VALUES (301, 31);
  `);
});

afterAll(async () => {
  await db.close();
});

describe('storyline above a comment thread', () => {
  it('is the thread’s own storyline', async () => {
    expect(await ofThread(10)).toBe(1);
  });

  it('is found from a reply thread', async () => {
    expect(await ofThread(11)).toBe(1);
    expect(await ofComment(101)).toBe(1);
  });

  it('is found up the stored chain when rootThreadId is NULL', async () => {
    expect(await ofThread(12)).toBe(1);
    expect(await ofComment(102)).toBe(1);
  });

  it('is found through rootThreadId when the chain is broken', async () => {
    expect(await ofThread(13)).toBe(1);
    expect(await ofComment(103)).toBe(1);
  });

  it('is found when the chain breaks above a reply with no rootThreadId', async () => {
    expect(await ofThread(14)).toBe(1);
    expect(await ofComment(104)).toBe(1);
  });

  it('is none for a thread outside any storyline, or a missing comment', async () => {
    expect(await ofThread(20)).toBeNull();
    expect(await ofComment(201)).toBeNull();
    expect(await ofComment(999)).toBeNull();
  });
});

describe('crucibleOfCommentSql', () => {
  const crucibleOf = async (commentId: number) => {
    const sql = crucibleOfCommentSql(commentId);
    const { rows } = await db.query<{ crucibleId: number }>(sql.text, sql.values);
    return rows[0]?.crucibleId ?? null;
  };

  it('finds the crucible above a reply, through a thread with no rootThreadId', async () => {
    expect(await crucibleOf(300)).toBe(7);
    expect(await crucibleOf(301)).toBe(7);
  });

  it('finds none above a comment outside any crucible', async () => {
    expect(await crucibleOf(201)).toBeNull();
  });

  it('is what getCommentCrucibleId answers', async () => {
    dbMock.dbRead.$queryRaw.mockImplementation(
      (async (sql: Prisma.Sql) => (await db.query(sql.text, sql.values)).rows) as never
    );

    expect(await getCommentCrucibleId(301)).toBe(7);
    expect(await getCommentCrucibleId(201)).toBeNull();
  });
});

describe('entity above a comment, at production shape', () => {
  // Many threads, a few dozen crucibles and storylines, the unique keys prod has, and a reply four
  // threads deep. Joined, the planner started from the unique key and read every crucible's thread.
  let big: PGlite;
  const plan = async (sql: Prisma.Sql) =>
    (await big.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql.text}`, sql.values)).rows
      .map((r) => r['QUERY PLAN'])
      .join('\n');

  beforeAll(async () => {
    big = new PGlite();
    await big.exec(`
      CREATE TABLE "Thread"(id int PRIMARY KEY, "storylineId" int UNIQUE, "imageId" int,
        "commentId" int UNIQUE, "rootThreadId" int, "crucibleId" int UNIQUE);
      CREATE TABLE "CommentV2"(id int PRIMARY KEY, "threadId" int);
      INSERT INTO "Thread"(id, "imageId") SELECT g, g FROM generate_series(1, 20000) g;
      INSERT INTO "CommentV2" SELECT g, g FROM generate_series(1, 20000) g;
      INSERT INTO "Thread"(id, "crucibleId") SELECT 30000 + g, g FROM generate_series(1, 80) g;
      INSERT INTO "Thread"(id, "storylineId") SELECT 40000 + g, g FROM generate_series(1, 80) g;
      INSERT INTO "CommentV2" VALUES (30001, 30001);
      INSERT INTO "Thread"(id, "commentId", "rootThreadId")
        VALUES (50001, 1, 1), (50002, 50001, 1), (50003, 50002, 1), (50004, 30001, 30001);
      INSERT INTO "CommentV2" VALUES (50001, 50001), (50002, 50002), (50003, 50003), (50004, 50004);
      ANALYZE;
    `);
  });

  afterAll(async () => {
    await big.close();
  });

  it('can see the unique keys the lookup must not start from', async () => {
    expect(
      await plan(Prisma.sql`SELECT id FROM "Thread" WHERE "crucibleId" IS NOT NULL`)
    ).toContain('Thread_crucibleId_key');
  });

  it('probes the chain by primary key, never scanning every crucible or storyline thread', async () => {
    for (const sql of [crucibleOfCommentSql(50003), storylineOfCommentSql(50003)]) {
      const text = await plan(sql);
      expect(text).toContain('Thread_pkey');
      expect(text).not.toMatch(/Thread_(crucibleId|storylineId)_key/);
    }
  });

  it('still answers through the chain at that shape', async () => {
    const sql = crucibleOfCommentSql(50004);
    expect((await big.query<{ crucibleId: number }>(sql.text, sql.values)).rows).toEqual([
      { crucibleId: 1 },
    ]);
  });
});
