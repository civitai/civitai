import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { storylineOfThreadSql } from '~/server/services/commentsv2.service';

/** Runs the real storyline lookup the reply gate depends on against an in-process Postgres. */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

let db: PGlite;

const storylineOf = async (seed: string) => {
  const sql = storylineOfThreadSql(seed);
  const { rows } = await db.query<{ storylineId: number }>(sql.text, sql.values);
  return rows[0]?.storylineId ?? null;
};
const ofThread = (id: number) => storylineOf(String(id));
const ofComment = (id: number) =>
  storylineOf(`(SELECT c."threadId" FROM "CommentV2" c WHERE c.id = ${id})`);

beforeAll(async () => {
  db = new PGlite();
  // Storyline 1's thread 10 > comment 100 > reply thread 11 > comment 101 > reply thread 12, whose
  // rootThreadId is NULL as on some prod rows. Thread 13 lost its parent comment (commentId NULL)
  // but kept rootThreadId. Image thread 20 has a reply thread 21.
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

  it('is none for a thread outside any storyline, or a missing comment', async () => {
    expect(await ofThread(20)).toBeNull();
    expect(await ofComment(201)).toBeNull();
    expect(await ofComment(999)).toBeNull();
  });
});
