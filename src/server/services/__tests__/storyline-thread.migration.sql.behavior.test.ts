import { PGlite } from '@electric-sql/pglite';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FIXTURE, migration, statementsOf } from './comment-v3-fixture';

vi.setConfig({ hookTimeout: 120_000, testTimeout: 60_000 });

const STORYLINE_THREAD = '20261126120000_storyline_thread';

const db = { pg: null as unknown as PGlite };
const rows = async <T = Record<string, unknown>>(sql: string) => (await db.pg.query<T>(sql)).rows;
const one = async <T = Record<string, unknown>>(sql: string) => (await rows<T>(sql))[0];
const count = async (sql: string) =>
  (await one<{ n: number }>(`SELECT count(*)::int AS n ${sql}`)).n;
const entityOf = (threadId: number) =>
  one(
    `SELECT "entityType", "entityId" FROM commentv3_thread_entity((SELECT t FROM "Thread" t WHERE id = ${threadId}))`
  );

// As the release captain applies it: psql autocommit, one statement per round trip.
const apply = async () => {
  for (const statement of statementsOf(migration(STORYLINE_THREAD))) await db.pg.exec(statement);
};

beforeAll(async () => {
  db.pg = new PGlite({ extensions: { ltree } });
  await db.pg.exec(FIXTURE);
  await db.pg.exec(`CREATE TABLE "Storyline"(id serial PRIMARY KEY);`);
  await db.pg.exec(migration('20261110120000_comment_v3_schema'));
  await db.pg.exec(migration('20261120120000_comment_v3_mirror'));
  await db.pg.exec(`SELECT setval('comment_shared_id_seq', 10000, true)`);
  // Rows that exist before the migration, which it must leave alone.
  await db.pg.exec(`INSERT INTO "Thread"(id, "imageId") VALUES (500, 10)`);
  await apply();
});

afterAll(async () => {
  await db.pg.close();
});

describe('storyline thread migration', () => {
  it('is re-runnable', async () => {
    await expect(apply()).resolves.toBeUndefined();
  });

  it('adds a unique, cascading Thread.storylineId and no row carries it', async () => {
    expect(await count(`FROM "Thread" WHERE "storylineId" IS NOT NULL`)).toBe(0);
    const fk = await one<{ def: string; validated: boolean }>(
      `SELECT pg_get_constraintdef(oid) AS def, convalidated AS validated
         FROM pg_constraint WHERE conname = 'Thread_storylineId_fkey'`
    );
    expect(fk.def).toContain('REFERENCES "Storyline"(id) ON UPDATE CASCADE ON DELETE CASCADE');
    expect(fk.validated).toBe(true);
    const index = await one<{ def: string; valid: boolean }>(
      `SELECT pg_get_indexdef(i.indexrelid) AS def, i.indisvalid AS valid
         FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = 'Thread_storylineId_key'`
    );
    expect(index.def).toMatch(/CREATE UNIQUE INDEX .* \("storylineId"\)/);
    expect(index.valid).toBe(true);

    await db.pg.exec(
      `INSERT INTO "Storyline"(id) VALUES (1); INSERT INTO "Thread"(id, "storylineId") VALUES (510, 1)`
    );
    await expect(db.pg.exec(`INSERT INTO "Thread"("storylineId") VALUES (1)`)).rejects.toThrow(
      /duplicate key/
    );
    await expect(db.pg.exec(`INSERT INTO "Thread"("storylineId") VALUES (999)`)).rejects.toThrow(
      /foreign key/
    );
  });

  it('existing threads resolve as before, never to storyline', async () => {
    expect(await entityOf(500)).toEqual({ entityType: 'image', entityId: 10 });
    expect(
      await count(`FROM "Thread" t, LATERAL commentv3_thread_entity(t) e WHERE e."entityType" = 'storyline'
                    AND t."storylineId" IS NULL`)
    ).toBe(0);
  });

  it('mirrors a storyline comment and a reply into the storyline partition', async () => {
    await db.pg.exec(
      `INSERT INTO "Storyline"(id) VALUES (2); INSERT INTO "Thread"(id, "storylineId") VALUES (520, 2)`
    );
    expect(await entityOf(520)).toEqual({ entityType: 'storyline', entityId: 2 });
    await db.pg.exec(
      `INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (5200, 'root', 1, 520);
       INSERT INTO "Thread"(id, "commentId", "parentThreadId", "rootThreadId") VALUES (521, 5200, 520, 520);
       INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (5201, 'reply', 2, 521);`
    );
    expect(await entityOf(521)).toEqual({ entityType: 'storyline', entityId: 2 });
    expect(
      await rows(
        `SELECT id, "entityType", "entityId", "parentId" FROM "CommentV3" WHERE id IN (5200, 5201) ORDER BY id`
      )
    ).toEqual([
      { id: 5200, entityType: 'storyline', entityId: 2, parentId: null },
      { id: 5201, entityType: 'storyline', entityId: 2, parentId: 5200 },
    ]);
    expect(
      await one(`SELECT "commentCount" FROM "CommentTopic_storyline" WHERE "entityId" = 2`)
    ).toEqual({ commentCount: 2 });
  });

  it('deleting a storyline takes its thread, comments and topic with it', async () => {
    await db.pg.exec(
      `INSERT INTO "Storyline"(id) VALUES (3); INSERT INTO "Thread"(id, "storylineId") VALUES (530, 3);
       INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (5300, 'root', 1, 530);
       INSERT INTO "Thread"(id, "commentId", "parentThreadId", "rootThreadId") VALUES (531, 5300, 530, 530);
       INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (5301, 'reply', 2, 531);`
    );
    expect(
      await count(`FROM "CommentV3" WHERE "entityType" = 'storyline' AND "entityId" = 3`)
    ).toBe(2);

    await db.pg.exec(`DELETE FROM "Storyline" WHERE id = 3`);
    expect(await count(`FROM "Thread" WHERE id IN (530, 531)`)).toBe(0);
    expect(await count(`FROM "CommentV2" WHERE id IN (5300, 5301)`)).toBe(0);
    expect(
      await count(`FROM "CommentTopic" WHERE "entityType" = 'storyline' AND "entityId" = 3`)
    ).toBe(0);
    expect(
      await count(`FROM "CommentV3" WHERE "entityType" = 'storyline' AND "entityId" = 3`)
    ).toBe(0);
  });
});
