import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { storylineOfCommentSql, storylineOfThreadSql } from '~/server/services/commentsv2.service';

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
      "commentId" int, "rootThreadId" int);
    CREATE TABLE "CommentV2"(id int PRIMARY KEY, "threadId" int);
    INSERT INTO "Thread" VALUES (10, 1, NULL, NULL, NULL), (20, NULL, 5, NULL, NULL);
    INSERT INTO "CommentV2" VALUES (100, 10), (200, 20);
    INSERT INTO "Thread" VALUES (11, NULL, NULL, 100, 10), (21, NULL, NULL, 200, 20);
    INSERT INTO "CommentV2" VALUES (101, 11), (201, 21);
    INSERT INTO "Thread" VALUES (12, NULL, NULL, 101, NULL), (13, NULL, NULL, NULL, 10);
    INSERT INTO "CommentV2" VALUES (102, 12), (103, 13);
    INSERT INTO "Thread" VALUES (14, NULL, NULL, 103, NULL);
    INSERT INTO "CommentV2" VALUES (104, 14);
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
