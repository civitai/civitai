import { PGlite } from '@electric-sql/pglite';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FIXTURE, migration, statementsOf } from './comment-v3-fixture';

vi.setConfig({ hookTimeout: 120_000, testTimeout: 60_000 });

// Single session: the SKIP LOCKED yield, concurrent-copy wait and deadlock paths are not exercised.

// v1 1..3 on model 1 (2 and 3 reply to 1); v2 chain 1 > 2 > 3 plus root 4, on image 10.
const PRE_EXISTING = `
INSERT INTO "Comment"(content, "userId", "modelId", "createdAt", "updatedAt", "pinnedAt") VALUES ('v1 root', 1, 1, '2023-01-02 03:04:05', '2023-01-04 05:06:07', '2023-01-03 04:05:06');
INSERT INTO "Comment"(content, "userId", "modelId", "parentId") VALUES ('v1 reply a', 2, 1, 1), ('v1 reply b', 3, 1, 1);
INSERT INTO "Thread"("imageId") VALUES (10);
INSERT INTO "CommentV2"(content, "userId", "threadId") VALUES ('v2 root', 1, 1);
INSERT INTO "Thread"("commentId", "parentThreadId", "rootThreadId") VALUES (1, 1, 1);
INSERT INTO "CommentV2"(content, "userId", "threadId") VALUES ('v2 reply', 2, 2);
INSERT INTO "Thread"("commentId", "parentThreadId", "rootThreadId") VALUES (2, 2, 1);
INSERT INTO "CommentV2"(content, "userId", "threadId") VALUES ('v2 reply reply', 3, 3);
INSERT INTO "CommentV2"(content, "userId", "threadId") VALUES ('v2 other root', 4, 1);
UPDATE "CommentV2" SET "createdAt" = '2024-03-05 10:00:00', "updatedAt" = '2024-03-07 12:00:00', "pinnedAt" = '2024-03-06 11:00:00' WHERE id = 1;
`;

const db = { pg: null as unknown as PGlite };
const rows = async <T = Record<string, unknown>>(sql: string) => (await db.pg.query<T>(sql)).rows;
const one = async <T = Record<string, unknown>>(sql: string) => (await rows<T>(sql))[0];
const count = async (sql: string) =>
  (await one<{ n: number }>(`SELECT count(*)::int AS n ${sql}`)).n;
const v3 = async (id: number) =>
  one<{
    entityType: string;
    entityId: number;
    parentId: number | null;
    replyToId: number | null;
    path: string;
    depth: number;
    content: string;
    hidden: boolean;
    locked: boolean;
    tosViolation: boolean;
    deletedAt: Date | null;
    reactionCount: number;
    legacyV1Id: number | null;
    userId: number;
  }>(
    `SELECT "entityType","entityId","parentId","replyToId",path::text AS path,depth,content,hidden,locked,"tosViolation","deletedAt","reactionCount","legacyV1Id","userId" FROM "CommentV3" WHERE id = ${id}`
  );
const topic = (type: string, id: number) =>
  one<{ locked: boolean; commentCount: number }>(
    `SELECT locked, "commentCount" FROM "CommentTopic" WHERE "entityType" = '${type}' AND "entityId" = ${id}`
  );

beforeAll(async () => {
  db.pg = new PGlite({ extensions: { ltree } });
  // Non-UTC session, so a missing AT TIME ZONE 'UTC' shows up in the timestamp assertions.
  await db.pg.exec(`SET TIME ZONE 'Etc/GMT-5'`);
  await db.pg.exec(FIXTURE);
  await db.pg.exec(PRE_EXISTING);
  await db.pg.exec(migration('20261110120000_comment_v3_schema'));
  await db.pg.exec(migration('20261120120000_comment_v3_mirror'));
  // Explicit test ids would collide with low nextval values (renumbered v1 ids); move the sequence past them.
  await db.pg.exec(`SELECT setval('comment_shared_id_seq', 10000, true)`);
});

afterAll(async () => {
  await db.pg.close();
});

describe('comment v3 mirror triggers', () => {
  it('captures the v1 id floor from the frozen old sequences and mirrors nothing retroactively', async () => {
    expect((await one<{ f: number }>('SELECT commentv3_v1_id_floor() AS f')).f).toBe(4);
    expect(await count('FROM "CommentV3"')).toBe(0);
  });

  it('a root thread creates its topic and a v2 comment lands with the same id', async () => {
    await db.pg.exec(`INSERT INTO "Thread"(id, "imageId") VALUES (4, 11)`);
    expect(await topic('image', 11)).toEqual({ locked: false, commentCount: 0 });

    await db.pg.exec(
      `INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (5, 'new root', 5, 4)`
    );
    expect(await v3(5)).toMatchObject({
      entityType: 'image',
      entityId: 11,
      parentId: null,
      path: '5',
      depth: 0,
    });
    expect((await topic('image', 11)).commentCount).toBe(1);

    await db.pg.exec(
      `INSERT INTO "Thread"(id, "commentId", "parentThreadId", "rootThreadId") VALUES (5, 5, 4, 4)`
    );
    await db.pg.exec(
      `INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (6, 'new reply', 6, 5)`
    );
    expect(await v3(6)).toMatchObject({ parentId: 5, path: '5.6', depth: 1 });
  });

  it('a reply under a pre-existing chain copies its ancestors, not its siblings, with UTC timestamps', async () => {
    // rootThreadId deliberately null: prod has child threads like that
    await db.pg.exec(`INSERT INTO "Thread"(id, "commentId", "parentThreadId") VALUES (6, 3, 3)`);
    await db.pg.exec(
      `INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (7, 'reply to old chain', 7, 6)`
    );
    expect(await v3(7)).toMatchObject({
      path: '1.2.3.7',
      depth: 3,
      entityId: 10,
      content: 'reply to old chain',
      userId: 7,
    });
    expect(await v3(1)).toMatchObject({ content: 'v2 root', userId: 1 });
    expect(await v3(2)).toMatchObject({ content: 'v2 reply', userId: 2 });
    expect(await v3(3)).toMatchObject({ content: 'v2 reply reply', userId: 3 });
    expect(await count('FROM "CommentV3" WHERE id = 4')).toBe(0);
    expect((await topic('image', 10)).commentCount).toBe(4);

    const copied = await one<{ createdAt: Date; pinnedAt: Date; updatedAt: Date }>(
      `SELECT "createdAt", "pinnedAt", "updatedAt" FROM "CommentV3" WHERE id = 1`
    );
    expect(copied.createdAt.toISOString()).toBe('2024-03-05T10:00:00.000Z');
    expect(copied.pinnedAt.toISOString()).toBe('2024-03-06T11:00:00.000Z');
    expect(copied.updatedAt.toISOString()).toBe('2024-03-07T12:00:00.000Z');
  });

  it('the migration ran with SET LOCAL, so the session keeps no lock_timeout', async () => {
    expect(await one('SHOW lock_timeout')).toEqual({ lock_timeout: '0' });
    const setLocal = statementsOf(migration('20261120120000_comment_v3_mirror')).find((s) =>
      s.startsWith('SET LOCAL lock_timeout')
    );
    expect(setLocal).toBeDefined();
    // Before BEGIN, SET LOCAL only warns and does nothing.
    const statements = statementsOf(migration('20261120120000_comment_v3_mirror'));
    expect(statements.indexOf(setLocal as string)).toBeGreaterThan(statements.indexOf('BEGIN;'));
    const inside = await db.pg.transaction(async (tx) => {
      await tx.exec(setLocal as string);
      return (await tx.query<{ lock_timeout: string }>('SHOW lock_timeout')).rows[0].lock_timeout;
    });
    expect(inside).not.toBe('0');
    expect(await one('SHOW lock_timeout')).toEqual({ lock_timeout: '0' });
  });

  it('every definer function pins its search_path and is not executable by other roles', async () => {
    const fns = await rows<{ proname: string; proconfig: string[] | null; executable: boolean }>(
      `SELECT proname, proconfig, has_function_privilege('public', oid, 'EXECUTE') AS executable
         FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace ORDER BY proname`
    );
    expect(fns.map((f) => f.proname)).toEqual([
      'commentv3_mirror_thread_mute_trigger',
      'commentv3_mirror_thread_trigger',
      'commentv3_mirror_v1_reaction_trigger',
      'commentv3_mirror_v1_report_trigger',
      'commentv3_mirror_v1_trigger',
      'commentv3_mirror_v2_reaction_trigger',
      'commentv3_mirror_v2_report_trigger',
      'commentv3_mirror_v2_trigger',
      'commentv3_topic_comment_count',
    ]);
    for (const f of fns) {
      expect(f.proconfig, f.proname).toEqual(['search_path=pg_catalog, public, pg_temp']);
      expect(f.executable, f.proname).toBe(false);
    }
  });

  it('a temp table cannot shadow the mirror target', async () => {
    await db.pg.exec(`CREATE TEMP TABLE "CommentV3"(id int)`);
    try {
      await db.pg.exec(
        `INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (8, 'not shadowed', 1, 4)`
      );
      expect(await count('FROM public."CommentV3" WHERE id = 8')).toBe(1);
      expect(await count('FROM pg_temp."CommentV3"')).toBe(0);
    } finally {
      await db.pg.exec(`DROP TABLE pg_temp."CommentV3"`);
    }
  });

  it('the topic count is applied at commit, not mid-transaction', async () => {
    const before = (await topic('image', 11)).commentCount;
    const mid = await db.pg.transaction(async (tx) => {
      await tx.exec(
        `INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (9, 'deferred', 5, 4)`
      );
      return (
        await tx.query<{ c: number }>(
          `SELECT "commentCount" AS c FROM "CommentTopic" WHERE "entityType" = 'image' AND "entityId" = 11`
        )
      ).rows[0].c;
    });
    expect(mid).toBe(before);
    expect((await topic('image', 11)).commentCount).toBe(before + 1);
  });

  it('the count decrement clamps at zero', async () => {
    await db.pg.exec(
      `INSERT INTO "Image" VALUES (25); INSERT INTO "Thread"(id, "imageId") VALUES (350, 25);
       INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (10, 'only', 1, 350);`
    );
    expect((await topic('image', 25)).commentCount).toBe(1);
    await db.pg.exec(
      `UPDATE "CommentTopic" SET "commentCount" = 0 WHERE "entityType" = 'image' AND "entityId" = 25`
    );
    await db.pg.exec(`DELETE FROM "CommentV2" WHERE id = 10`);
    expect((await topic('image', 25)).commentCount).toBe(0);
  });

  it('updates mirror the moderation columns, copy an unmirrored row, and ignore reactionCount', async () => {
    await db.pg.exec(
      `UPDATE "CommentV2" SET content = 'edited', hidden = true, "updatedAt" = now() WHERE id = 6`
    );
    expect(await v3(6)).toMatchObject({ content: 'edited', hidden: true });

    await db.pg.exec(`UPDATE "CommentV2" SET "tosViolation" = true WHERE id = 4`);
    expect(await v3(4)).toMatchObject({ tosViolation: true });

    // Prisma stamps updatedAt on every update, so a change to an uncarried column (nsfw) must still sync
    // it; reactionCount must not be copied.
    await db.pg.exec(`UPDATE "CommentV2" SET "reactionCount" = 3 WHERE id = 4`);
    await db.pg.exec(
      `UPDATE "CommentV2" SET nsfw = true, "updatedAt" = '2030-01-02 03:04:05' WHERE id = 4`
    );
    const stamped = await one<{ at: Date }>(
      `SELECT "updatedAt" AS at FROM "CommentV3" WHERE id = 4`
    );
    expect(stamped.at.toISOString()).toBe('2030-01-02T03:04:05.000Z');
    expect((await v3(4)).reactionCount).toBe(0);

    await db.pg.exec(`UPDATE "CommentV2" SET "pinnedAt" = '2031-02-03 04:05:06' WHERE id = 6`);
    const pinned = await one<{ at: Date }>(`SELECT "pinnedAt" AS at FROM "CommentV3" WHERE id = 6`);
    expect(pinned.at.toISOString()).toBe('2031-02-03T04:05:06.000Z');
  });

  it('runs every mirror for a role that can write the old tables but not the new ones', async () => {
    await db.pg.exec(`
      CREATE ROLE old_writer;
      GRANT SELECT, INSERT, UPDATE, DELETE ON "Thread", "CommentV2", "Comment", "CommentV2Reaction",
        "CommentReaction", "CommentV2Report", "CommentReport", "ThreadMute", "Image", "Model", "Report" TO old_writer;
      GRANT USAGE ON SEQUENCE "Thread_id_seq", comment_shared_id_seq, "CommentV2Reaction_id_seq",
        "CommentReaction_id_seq" TO old_writer;
    `);
    const statements: [label: string, sql: string][] = [
      ['thread', `INSERT INTO "Thread"(id, "imageId") VALUES (330, 13)`],
      [
        'v2 insert',
        `INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (3300, 'restricted', 1, 330)`,
      ],
      ['v2 update', `UPDATE "CommentV2" SET content = 'restricted edit' WHERE id = 3300`],
      [
        'reply thread',
        `INSERT INTO "Thread"(id, "commentId", "parentThreadId") VALUES (331, 3300, 330)`,
      ],
      ['thread lock', `UPDATE "Thread" SET locked = true WHERE id = 331`],
      [
        'v2 reaction',
        `INSERT INTO "CommentV2Reaction"("commentId", "userId", reaction) VALUES (3300, 2, 'Like')`,
      ],
      ['v2 report', `INSERT INTO "CommentV2Report"("commentV2Id", "reportId") VALUES (3300, 3)`],
      ['mute', `INSERT INTO "ThreadMute"("userId", "threadId") VALUES (2, 331)`],
      [
        'v1 insert',
        `INSERT INTO "Comment"(id, content, "userId", "modelId") VALUES (3301, 'restricted v1', 1, 2)`,
      ],
      [
        'v1 reaction',
        `INSERT INTO "CommentReaction"("commentId", "userId", reaction) VALUES (3301, 2, 'Like')`,
      ],
      ['v1 report', `INSERT INTO "CommentReport"("commentId", "reportId") VALUES (3301, 4)`],
      ['v2 reaction delete', `DELETE FROM "CommentV2Reaction" WHERE "commentId" = 3300`],
    ];
    try {
      await db.pg.exec('SET ROLE old_writer');
      await expect(db.pg.exec('SELECT 1 FROM "CommentV3"')).rejects.toThrow(/permission denied/);
      await expect(
        db.pg.exec(
          `INSERT INTO "CommentV3Reaction"("commentId", "userId", reaction) VALUES (5, 1, 'Like')`
        )
      ).rejects.toThrow(/permission denied/);
      for (const [label, sql] of statements) {
        await expect(db.pg.exec(sql), label).resolves.toBeDefined();
      }
    } finally {
      await db.pg.exec('RESET ROLE');
    }
    expect(await v3(3300)).toMatchObject({
      entityType: 'image',
      entityId: 13,
      content: 'restricted edit',
      locked: true,
      reactionCount: 0,
    });
    expect(await v3(3301)).toMatchObject({ entityType: 'model', entityId: 2, reactionCount: 1 });
    expect(await count(`FROM "CommentV3Report" WHERE "commentId" IN (3300, 3301)`)).toBe(2);
    expect(await count(`FROM "CommentMute" WHERE "userId" = 2 AND "commentId" = 3300`)).toBe(1);
  });

  it('deletes hard-delete a leaf, tombstone a parent, and collapse the tombstone with its last reply', async () => {
    await db.pg.exec(`DELETE FROM "CommentV2" WHERE id = 7`);
    expect(await count('FROM "CommentV3" WHERE id = 7')).toBe(0);
    expect((await v3(3)).deletedAt).toBeNull();

    await db.pg.exec(`UPDATE "CommentV2" SET hidden = true, "tosViolation" = true WHERE id = 2`);
    expect(await v3(2)).toMatchObject({ hidden: true, tosViolation: true });

    await db.pg.exec(`DELETE FROM "CommentV2" WHERE id = 2`);
    expect(await v3(2)).toMatchObject({ content: '', hidden: true, tosViolation: true });
    expect((await v3(2)).deletedAt).not.toBeNull();
    expect((await v3(3)).parentId).toBe(2);

    await db.pg.exec(`DELETE FROM "CommentV2" WHERE id = 3`);
    expect(await count('FROM "CommentV3" WHERE id IN (2, 3)')).toBe(0);
    expect((await v3(1)).deletedAt).toBeNull();
    expect((await topic('image', 10)).commentCount).toBe(2);

    // Thread 3's comment was deleted (SET NULL): a dead-parent thread.
    await db.pg.exec(
      `INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (3500, 'into dead thread', 1, 3)`
    );
    expect(await count('FROM "CommentV2" WHERE id = 3500')).toBe(1);
    expect(await count('FROM "CommentV3" WHERE id = 3500')).toBe(0);
    expect((await topic('image', 10)).commentCount).toBe(2);
  });

  it('clamps a reply past the depth cap, live and when copying ancestors', async () => {
    await db.pg.exec(
      `ALTER TABLE "CommentV2" DISABLE TRIGGER commentv3_mirror; ALTER TABLE "Thread" DISABLE TRIGGER commentv3_mirror;`
    );
    await db.pg.exec(
      `INSERT INTO "Article" VALUES (50); INSERT INTO "Thread"(id, "articleId") VALUES (100, 50);`
    );
    let thread = 100;
    try {
      for (let i = 0; i < 24; i++) {
        await db.pg.exec(
          `INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (${
            1000 + i
          }, 'deep ${i}', 1, ${thread});
           INSERT INTO "Thread"(id, "commentId", "parentThreadId") VALUES (${200 + i}, ${
            1000 + i
          }, ${thread});`
        );
        thread = 200 + i;
      }
    } finally {
      await db.pg.exec(
        `ALTER TABLE "CommentV2" ENABLE TRIGGER commentv3_mirror; ALTER TABLE "Thread" ENABLE TRIGGER commentv3_mirror;`
      );
    }

    await db.pg.exec(
      `INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (1024, 'deep 24', 2, ${thread})`
    );
    expect(await v3(1024)).toMatchObject({ depth: 20, parentId: 1019, replyToId: 1023 });
    expect(await v3(1020)).toMatchObject({ depth: 20, parentId: 1019, replyToId: null });
    expect(await v3(1021)).toMatchObject({ depth: 20, parentId: 1019, replyToId: 1020 });
    expect(await count(`FROM "CommentV3" WHERE "entityType" = 'article' AND "entityId" = 50`)).toBe(
      25
    );

    await db.pg.exec(`DELETE FROM "CommentV2" WHERE id = 1023`);
    expect(await v3(1023)).toBeDefined();
    expect((await v3(1023)).deletedAt).not.toBeNull();
    expect((await v3(1024)).replyToId).toBe(1023);
    // Collapse order: 1022 is only freed after 1023, behind the surviving tombstone 1019 (1020 and
    // 1021 are live).
    await db.pg.exec(`DELETE FROM "CommentV2" WHERE id = 1022`);
    await db.pg.exec(`DELETE FROM "CommentV2" WHERE id = 1019`);
    expect((await v3(1022)).deletedAt).not.toBeNull();
    expect((await v3(1019)).deletedAt).not.toBeNull();
    const childrenOf1019 = await count('FROM "CommentV3" WHERE "parentId" = 1019');
    await db.pg.exec(`DELETE FROM "CommentV2" WHERE id = 1024`);
    expect(await count('FROM "CommentV3" WHERE id IN (1022, 1023, 1024)')).toBe(0);
    expect((await v3(1021)).deletedAt).toBeNull();
    expect((await v3(1019)).deletedAt).not.toBeNull();
    expect(await count('FROM "CommentV3" WHERE "parentId" = 1019')).toBe(childrenOf1019 - 3);
  });

  it('resolves comic chapters and app listings to their surrogate ids and skips entity-less threads', async () => {
    await db.pg.exec(
      `INSERT INTO "Thread"(id, "questionId") VALUES (300, 1); INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (3000, 'q', 1, 300)`
    );
    expect(await count('FROM "CommentV3" WHERE id = 3000')).toBe(0);

    await db.pg.exec(
      `INSERT INTO "Thread"(id, "comicProjectId", "comicChapterPosition") VALUES (301, 5, 2); INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (3001, 'comic', 1, 301)`
    );
    expect(await v3(3001)).toMatchObject({ entityType: 'comicChapter', entityId: 77 });

    await db.pg.exec(
      `INSERT INTO "Thread"(id, "appListingId") VALUES (302, 9); INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (3002, 'app', 1, 302)`
    );
    expect(await v3(3002)).toMatchObject({ entityType: 'appListing', entityId: 9 });
  });

  it('a copied ancestor keeps its moderation flags', async () => {
    await db.pg.exec(
      `ALTER TABLE "CommentV2" DISABLE TRIGGER commentv3_mirror; ALTER TABLE "Thread" DISABLE TRIGGER commentv3_mirror;
       INSERT INTO "CommentV2"(id, content, "userId", "threadId", hidden, "tosViolation") VALUES (3200, 'flagged ancestor', 1, 4, true, true);
       INSERT INTO "Thread"(id, "commentId", "parentThreadId") VALUES (325, 3200, 4);
       ALTER TABLE "CommentV2" ENABLE TRIGGER commentv3_mirror; ALTER TABLE "Thread" ENABLE TRIGGER commentv3_mirror;`
    );
    await db.pg.exec(
      `INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (3201, 'reply to flagged', 2, 325)`
    );
    expect(await v3(3200)).toMatchObject({ hidden: true, tosViolation: true, parentId: null });
    expect(await v3(3201)).toMatchObject({
      parentId: 3200,
      hidden: false,
      content: 'reply to flagged',
      userId: 2,
    });

    await db.pg.exec(
      `ALTER TABLE "Comment" DISABLE TRIGGER commentv3_mirror;
       INSERT INTO "Comment"(id, content, "userId", "modelId", hidden, "tosViolation", locked) VALUES (3210, 'flagged v1', 1, 2, true, true, true);
       ALTER TABLE "Comment" ENABLE TRIGGER commentv3_mirror;`
    );
    await db.pg.exec(
      `INSERT INTO "Comment"(id, content, "userId", "modelId", "parentId") VALUES (3211, 'reply to flagged v1', 2, 2, 3210)`
    );
    const flaggedV1 = await one<{ id: number }>(
      `SELECT id FROM "CommentV3" WHERE "legacyV1Id" = 3210`
    );
    expect(await v3(flaggedV1.id)).toMatchObject({
      hidden: true,
      tosViolation: true,
      locked: true,
    });
    expect(await v3(3211)).toMatchObject({ parentId: flaggedV1.id, hidden: false, locked: false });
  });

  it('mirrors the entity lock onto the topic and a reply-thread lock onto the comment', async () => {
    await db.pg.exec(
      `INSERT INTO "Comment"(id, content, "userId", "modelId") VALUES (3250, 'on model 3', 1, 3)`
    );
    expect((await topic('model', 3)).locked).toBe(false);
    await db.pg.exec(`INSERT INTO "Thread"(id, "modelId", locked) VALUES (326, 3, true)`);
    expect((await topic('model', 3)).locked).toBe(true);
    // Topic dropped with the Thread trigger off, so the v1 insert must recreate it locked from the existing Thread.
    await db.pg.exec(`INSERT INTO "Thread"(id, "modelId", locked) VALUES (327, 4, true)`);
    await db.pg.exec(
      `ALTER TABLE "Thread" DISABLE TRIGGER commentv3_mirror; DELETE FROM "CommentTopic" WHERE "entityType" = 'model' AND "entityId" = 4; ALTER TABLE "Thread" ENABLE TRIGGER commentv3_mirror;`
    );
    await db.pg.exec(
      `INSERT INTO "Comment"(id, content, "userId", "modelId") VALUES (3251, 'on model 4', 1, 4)`
    );
    expect((await topic('model', 4)).locked).toBe(true);

    await db.pg.exec(`UPDATE "Thread" SET locked = true WHERE id = 4`);
    expect((await topic('image', 11)).locked).toBe(true);

    await db.pg.exec(`INSERT INTO "Thread"(id, "imageId", locked) VALUES (310, 12, true)`);
    expect((await topic('image', 12)).locked).toBe(true);

    await db.pg.exec(`UPDATE "Thread" SET locked = true WHERE id = 5`);
    expect((await v3(5)).locked).toBe(true);
    await db.pg.exec(`UPDATE "Thread" SET locked = false WHERE id = 5`);
    expect((await v3(5)).locked).toBe(false);

    await db.pg.exec(
      `INSERT INTO "Thread"(id, "commentId", "parentThreadId", locked) VALUES (322, 6, 4, true)`
    );
    expect((await v3(6)).locked).toBe(true);

    await db.pg.exec(
      `ALTER TABLE "CommentV2" DISABLE TRIGGER commentv3_mirror; ALTER TABLE "Thread" DISABLE TRIGGER commentv3_mirror;
       INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (3100, 'unmirrored a', 1, 4), (3101, 'unmirrored b', 1, 4);
       INSERT INTO "Thread"(id, "commentId", "parentThreadId") VALUES (320, 3100, 4), (321, 3101, 4);
       UPDATE "Thread" SET locked = true WHERE id = 321;
       ALTER TABLE "CommentV2" ENABLE TRIGGER commentv3_mirror; ALTER TABLE "Thread" ENABLE TRIGGER commentv3_mirror;`
    );
    await db.pg.exec(`UPDATE "Thread" SET locked = true WHERE id = 320`);
    expect(await v3(3100)).toMatchObject({ entityId: 11, locked: true });
    await db.pg.exec(`UPDATE "CommentV2" SET content = 'edited b' WHERE id = 3101`);
    expect(await v3(3101)).toMatchObject({ content: 'edited b', locked: true });
  });

  it('a new v1 row keeps its id and a pre-existing v1 parent is copied under a new one', async () => {
    await db.pg.exec(
      `INSERT INTO "Comment"(content, "userId", "modelId", "parentId") VALUES ('v1 new reply', 4, 1, 1)`
    );
    const { id } = await one<{ id: number }>(
      `SELECT id FROM "Comment" WHERE content = 'v1 new reply'`
    );
    const reply = await one<{ id: number; parentId: number }>(
      `SELECT id, "parentId" FROM "CommentV3" WHERE "legacyV1Id" = ${id}`
    );
    expect(reply.id).toBe(id);
    expect(await v3(id)).toMatchObject({
      entityType: 'model',
      entityId: 1,
      content: 'v1 new reply',
      userId: 4,
    });

    const parent = await one<{ id: number }>(`SELECT id FROM "CommentV3" WHERE "legacyV1Id" = 1`);
    expect(parent.id).not.toBe(1);
    expect(parent.id).toBeGreaterThan(10000);
    expect(reply.parentId).toBe(parent.id);
    expect((await v3(1)).legacyV1Id).toBeNull();
    const copiedParent = await one<{ createdAt: Date; pinnedAt: Date; updatedAt: Date }>(
      `SELECT "createdAt", "pinnedAt", "updatedAt" FROM "CommentV3" WHERE id = ${parent.id}`
    );
    expect(copiedParent.createdAt.toISOString()).toBe('2023-01-02T03:04:05.000Z');
    expect(copiedParent.pinnedAt.toISOString()).toBe('2023-01-03T04:05:06.000Z');
    expect(copiedParent.updatedAt.toISOString()).toBe('2023-01-04T05:06:07.000Z');

    // A v1 id AT the floor was allocated by the old sequence, so it is renumbered.
    await db.pg.exec(
      `INSERT INTO "Comment"(id, content, "userId", "modelId") VALUES (4, 'at floor', 1, 1)`
    );
    const atFloor = await one<{ id: number }>(`SELECT id FROM "CommentV3" WHERE "legacyV1Id" = 4`);
    expect(atFloor.id).not.toBe(4);
    expect(atFloor.id).toBeGreaterThan(10000);

    await expect(db.pg.exec(`UPDATE "Comment" SET "parentId" = NULL WHERE id = 2`)).rejects.toThrow(
      /cannot change parent/
    );
    await expect(db.pg.exec(`UPDATE "Comment" SET "modelId" = 2 WHERE id = 2`)).rejects.toThrow(
      /cannot change parent/
    );
    await db.pg.exec(
      `UPDATE "Comment" SET "parentId" = 1, "modelId" = 1, content = 'same place' WHERE id = 2`
    );
    expect(
      await one<{ content: string }>(`SELECT content FROM "CommentV3" WHERE "legacyV1Id" = 2`)
    ).toEqual({ content: 'same place' });

    await db.pg.exec(
      `UPDATE "Comment" SET locked = true, content = 'v1 edited', "updatedAt" = '2032-05-06 07:08:09' WHERE id = 1`
    );
    expect(await v3(parent.id)).toMatchObject({ locked: true, content: 'v1 edited' });
    const edited = await one<{ at: Date }>(
      `SELECT "updatedAt" AS at FROM "CommentV3" WHERE id = ${parent.id}`
    );
    expect(edited.at.toISOString()).toBe('2032-05-06T07:08:09.000Z');

    await db.pg.exec(
      `UPDATE "Comment" SET hidden = true, "tosViolation" = true, "pinnedAt" = '2035-01-01 01:01:01' WHERE id = 2`
    );
    const flagged = await one<{ hidden: boolean; tosViolation: boolean; pinnedAt: Date }>(
      `SELECT hidden, "tosViolation", "pinnedAt" FROM "CommentV3" WHERE "legacyV1Id" = 2`
    );
    expect(flagged).toMatchObject({ hidden: true, tosViolation: true });
    expect(flagged.pinnedAt.toISOString()).toBe('2035-01-01T01:01:01.000Z');
  });

  it('mirrors reactions both ways', async () => {
    await db.pg.exec(
      `INSERT INTO "CommentV2Reaction"("commentId", "userId", reaction, "createdAt", "updatedAt") VALUES (5, 8, 'Like', '2033-01-01 00:00:00', '2033-01-02 00:00:00')`
    );
    expect(
      await rows(
        `SELECT "createdAt", "updatedAt" FROM "CommentV3Reaction" WHERE "commentId" = 5 AND "userId" = 8 AND reaction = 'Like'`
      )
    ).toEqual([
      { createdAt: new Date('2033-01-01T00:00:00Z'), updatedAt: new Date('2033-01-02T00:00:00Z') },
    ]);
    expect((await v3(5)).reactionCount).toBe(1);
    await db.pg.exec(
      `UPDATE "CommentV2Reaction" SET reaction = 'Heart' WHERE "commentId" = 5 AND "userId" = 8`
    );
    expect(
      await rows(`SELECT reaction FROM "CommentV3Reaction" WHERE "commentId" = 5 AND "userId" = 8`)
    ).toEqual([{ reaction: 'Heart' }]);
    expect((await v3(5)).reactionCount).toBe(1);
    await db.pg.exec(`DELETE FROM "CommentV2Reaction" WHERE "commentId" = 5 AND "userId" = 8`);
    expect((await v3(5)).reactionCount).toBe(0);

    await db.pg.exec(
      `INSERT INTO "CommentReaction"("commentId", "userId", reaction, "createdAt", "updatedAt") VALUES (3, 9, 'Heart', '2033-03-03 03:03:03', '2033-03-04 04:04:04')`
    );
    const linked = await one<{ legacyV1Id: number; createdAt: Date; updatedAt: Date }>(
      `SELECT v3."legacyV1Id", r."createdAt", r."updatedAt" FROM "CommentV3Reaction" r JOIN "CommentV3" v3 ON v3.id = r."commentId" WHERE r."userId" = 9`
    );
    expect(linked.legacyV1Id).toBe(3);
    expect(linked.createdAt.toISOString()).toBe('2033-03-03T03:03:03.000Z');
    expect(linked.updatedAt.toISOString()).toBe('2033-03-04T04:04:04.000Z');
    await db.pg.exec(`DELETE FROM "CommentReaction" WHERE "userId" = 9`);
    expect(await count(`FROM "CommentV3Reaction" WHERE "userId" = 9`)).toBe(0);
  });

  it('mirrors report links, v1 through legacyV1Id', async () => {
    await db.pg.exec(`INSERT INTO "CommentV2Report"("commentV2Id", "reportId") VALUES (5, 1)`);
    expect(await one(`SELECT "commentId" FROM "CommentV3Report" WHERE "reportId" = 1`)).toEqual({
      commentId: 5,
    });

    const parent = await one<{ id: number }>(`SELECT id FROM "CommentV3" WHERE "legacyV1Id" = 1`);
    await db.pg.exec(`INSERT INTO "CommentReport"("commentId", "reportId") VALUES (1, 2)`);
    expect(await one(`SELECT "commentId" FROM "CommentV3Report" WHERE "reportId" = 2`)).toEqual({
      commentId: parent.id,
    });

    await db.pg.exec(`DELETE FROM "CommentV2Report" WHERE "reportId" = 1`);
    expect(await count(`FROM "CommentV3Report" WHERE "reportId" = 1`)).toBe(0);
  });

  it('splits thread mutes into comment and topic mutes and drops entity-less ones', async () => {
    await db.pg.exec(
      `INSERT INTO "ThreadMute"("userId", "threadId", "mutedAt") VALUES (3, 5, '2034-02-02 02:02:02')`
    );
    expect(
      await rows(`SELECT "mutedAt" FROM "CommentMute" WHERE "userId" = 3 AND "commentId" = 5`)
    ).toEqual([{ mutedAt: new Date('2034-02-02T02:02:02Z') }]);
    await db.pg.exec(
      `INSERT INTO "ThreadMute"("userId", "threadId", "mutedAt") VALUES (3, 4, '2034-03-03 03:03:03')`
    );
    expect(
      await rows(
        `SELECT "mutedAt" FROM "CommentTopicMute" WHERE "userId" = 3 AND "entityType" = 'image' AND "entityId" = 11`
      )
    ).toEqual([{ mutedAt: new Date('2034-03-03T03:03:03Z') }]);

    await db.pg.exec(`DELETE FROM "ThreadMute" WHERE "userId" = 3`);
    expect(await count(`FROM "CommentMute" WHERE "userId" = 3`)).toBe(0);
    expect(await count(`FROM "CommentTopicMute" WHERE "userId" = 3`)).toBe(0);

    await db.pg.exec(`INSERT INTO "ThreadMute"("userId", "threadId") VALUES (3, 300)`);
    expect(await count(`FROM "CommentTopicMute" WHERE "userId" = 3`)).toBe(0);
  });

  it('a reaction, report link or mute on an unmirrored comment copies the comment first', async () => {
    await db.pg.exec(
      `ALTER TABLE "CommentV2" DISABLE TRIGGER commentv3_mirror; ALTER TABLE "Thread" DISABLE TRIGGER commentv3_mirror;
       ALTER TABLE "Comment" DISABLE TRIGGER commentv3_mirror;
       INSERT INTO "CommentV2"(id, content, "userId", "threadId", "reactionCount") VALUES (7000, 'react me', 1, 4, 9), (7001, 'report me', 1, 4, 0), (7002, 'mute me', 1, 4, 0);
       INSERT INTO "Thread"(id, "commentId", "parentThreadId") VALUES (702, 7002, 4);
       INSERT INTO "Comment"(id, content, "userId", "modelId") VALUES (7003, 'report me v1', 1, 2);
       ALTER TABLE "CommentV2" ENABLE TRIGGER commentv3_mirror; ALTER TABLE "Thread" ENABLE TRIGGER commentv3_mirror;
       ALTER TABLE "Comment" ENABLE TRIGGER commentv3_mirror;`
    );
    expect(await count('FROM "CommentV3" WHERE id IN (7000, 7001, 7002)')).toBe(0);

    await db.pg.exec(
      `INSERT INTO "CommentV2Reaction"("commentId", "userId", reaction) VALUES (7000, 2, 'Like')`
    );
    expect(await v3(7000)).toMatchObject({ entityId: 11, reactionCount: 1 });

    await db.pg.exec(`INSERT INTO "CommentV2Report"("commentV2Id", "reportId") VALUES (7001, 5)`);
    expect(await v3(7001)).toMatchObject({ entityId: 11 });
    expect(await count(`FROM "CommentV3Report" WHERE "reportId" = 5 AND "commentId" = 7001`)).toBe(
      1
    );

    await db.pg.exec(`INSERT INTO "ThreadMute"("userId", "threadId") VALUES (2, 702)`);
    expect(await v3(7002)).toMatchObject({ entityId: 11 });
    expect(await count(`FROM "CommentMute" WHERE "userId" = 2 AND "commentId" = 7002`)).toBe(1);

    await db.pg.exec(`INSERT INTO "CommentReport"("commentId", "reportId") VALUES (7003, 6)`);
    const v1 = await one<{ id: number }>(`SELECT id FROM "CommentV3" WHERE "legacyV1Id" = 7003`);
    expect(
      await count(`FROM "CommentV3Report" WHERE "reportId" = 6 AND "commentId" = ${v1.id}`)
    ).toBe(1);
  });

  it('a v1 delete cascades its replies and an unmirrored v1 delete is a no-op', async () => {
    const modelCount = (await topic('model', 2)).commentCount;
    await db.pg.exec(`
      INSERT INTO "Comment"(id, content, "userId", "modelId") VALUES (6000, 'v1 root', 1, 2);
      INSERT INTO "Comment"(id, content, "userId", "modelId", "parentId") VALUES (6001, 'v1 reply', 2, 2, 6000), (6002, 'v1 reply', 3, 2, 6000);
    `);
    expect(await v3(6001)).toMatchObject({
      parentId: 6000,
      legacyV1Id: 6001,
      content: 'v1 reply',
      userId: 2,
    });
    expect(await v3(6000)).toMatchObject({ content: 'v1 root', userId: 1 });
    expect((await topic('model', 2)).commentCount).toBe(modelCount + 3);
    await db.pg.exec(`DELETE FROM "Comment" WHERE id = 6001`);
    expect(await count('FROM "CommentV3" WHERE id = 6001')).toBe(0);
    expect((await v3(6000)).deletedAt).toBeNull();
    await db.pg.exec(`DELETE FROM "Comment" WHERE id = 6000`);
    expect(await count('FROM "CommentV3" WHERE id IN (6000, 6002)')).toBe(0);
    expect((await topic('model', 2)).commentCount).toBe(modelCount);

    await db.pg.exec(`ALTER TABLE "Comment" DISABLE TRIGGER commentv3_mirror;
      INSERT INTO "Comment"(id, content, "userId", "modelId") VALUES (6003, 'never mirrored', 1, 2);
      ALTER TABLE "Comment" ENABLE TRIGGER commentv3_mirror;`);
    const before = await count('FROM "CommentV3"');
    await db.pg.exec(`DELETE FROM "Comment" WHERE id = 6003`);
    expect(await count('FROM "CommentV3"')).toBe(before);
  });

  it("a user's content wipe tombstones only what other users replied to", async () => {
    await db.pg.exec(`
      INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (5000, 'wipe root', 10, 4);
      INSERT INTO "Thread"(id, "commentId", "parentThreadId", "rootThreadId") VALUES (400, 5000, 4, 4);
      INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (5001, 'other reply', 1, 400);
      INSERT INTO "Thread"(id, "commentId", "parentThreadId", "rootThreadId") VALUES (401, 5001, 400, 4);
      INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (5002, 'wipe leaf', 10, 401);
    `);
    await db.pg.exec(`DELETE FROM "CommentV2" WHERE "userId" = 10`);
    expect(
      await rows(
        `SELECT id, "deletedAt" IS NOT NULL AS tomb FROM "CommentV3" WHERE id IN (5000, 5001, 5002) ORDER BY id`
      )
    ).toEqual([
      { id: 5000, tomb: true },
      { id: 5001, tomb: false },
    ]);
  });

  it('entity, model and thread deletes cascade cleanly through both sides', async () => {
    expect(
      await count(`FROM "CommentV3" WHERE "entityType" = 'image' AND "entityId" = 11`)
    ).toBeGreaterThan(0);
    // A mute whose Thread row is already gone when its own cascade delete fires.
    await db.pg.exec(`INSERT INTO "ThreadMute"("userId", "threadId") VALUES (4, 5)`);
    expect(await count(`FROM "CommentMute" WHERE "userId" = 4`)).toBe(1);
    await db.pg.exec(`DELETE FROM "Image" WHERE id = 11`);
    expect(await count(`FROM "CommentMute" WHERE "userId" = 4`)).toBe(0);
    expect(await count(`FROM "CommentV3" WHERE "entityType" = 'image' AND "entityId" = 11`)).toBe(
      0
    );
    expect(
      await count(`FROM "CommentTopic" WHERE "entityType" = 'image' AND "entityId" = 11`)
    ).toBe(0);

    expect(
      await count(`FROM "CommentV3" WHERE "entityType" = 'model' AND "entityId" = 1`)
    ).toBeGreaterThan(0);
    await db.pg.exec(`DELETE FROM "Model" WHERE id = 1`);
    expect(await count(`FROM "CommentV3" WHERE "entityType" = 'model' AND "entityId" = 1`)).toBe(0);

    await db.pg.exec(`DELETE FROM "Thread" WHERE id = 100`);
    expect(await count(`FROM "CommentV3" WHERE "entityType" = 'article' AND "entityId" = 50`)).toBe(
      0
    );
    expect((await topic('article', 50)).commentCount).toBe(0);
  });

  it('a locked root thread from before the mirror locks the topic its first comment creates', async () => {
    await db.pg.exec(
      `ALTER TABLE "Thread" DISABLE TRIGGER commentv3_mirror;
       INSERT INTO "Thread"(id, "imageId", locked) VALUES (360, 16, true);
       ALTER TABLE "Thread" ENABLE TRIGGER commentv3_mirror;`
    );
    expect(
      await count(`FROM "CommentTopic" WHERE "entityType" = 'image' AND "entityId" = 16`)
    ).toBe(0);
    await db.pg.exec(
      `INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (3600, 'under old lock', 1, 360)`
    );
    expect((await topic('image', 16)).locked).toBe(true);

    await db.pg.exec(`UPDATE "Thread" SET locked = false WHERE id = 360`);
    expect((await topic('image', 16)).locked).toBe(false);
  });

  it('resolves every entity type and climbs a reply chain', async () => {
    const cases: [column: string, type: string, id: number][] = [
      ['"postId"', 'post', 1],
      ['"articleId"', 'article', 2],
      ['"reviewId"', 'review', 1],
      ['"bountyId"', 'bounty', 1],
      ['"bountyEntryId"', 'bountyEntry', 1],
      ['"challengeId"', 'challenge', 1],
      ['"model3dId"', 'model3d', 1],
      ['"model3dReviewId"', 'model3dReview', 1],
      ['"crucibleId"', 'crucible', 1],
    ];
    await db.pg.exec(
      `INSERT INTO "Post" VALUES (1); INSERT INTO "ResourceReview" VALUES (1); INSERT INTO "Bounty" VALUES (1);
       INSERT INTO "BountyEntry" VALUES (1); INSERT INTO "Challenge" VALUES (1); INSERT INTO "Model3D" VALUES (1);
       INSERT INTO "Model3DReview" VALUES (1); INSERT INTO "Crucible" VALUES (1);`
    );
    for (const [i, [column, type, id]] of cases.entries()) {
      await db.pg.exec(`INSERT INTO "Thread"(id, ${column}) VALUES (${370 + i}, ${id})`);
      expect(
        await one(
          `SELECT "entityType", "entityId" FROM commentv3_thread_entity((SELECT t FROM "Thread" t WHERE id = ${
            370 + i
          }))`
        ),
        type
      ).toEqual({ entityType: type, entityId: id });
      expect(await topic(type, id), type).toEqual({ locked: false, commentCount: 0 });
    }
    expect(
      await one(
        `SELECT "entityType", "entityId", "rootLocked" FROM commentv3_thread_entity((SELECT t FROM "Thread" t WHERE id = 370))`
      )
    ).toEqual({ entityType: 'post', entityId: 1, rootLocked: false });
    // The climb the backfill relies on: a reply thread two levels down, rootThreadId null throughout.
    await db.pg.exec(
      `INSERT INTO "Thread"(id, "imageId", locked) VALUES (390, 17, true);
       INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (3900, 'root', 1, 390);
       INSERT INTO "Thread"(id, "commentId", "parentThreadId") VALUES (391, 3900, 390);
       INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (3901, 'reply', 1, 391);
       INSERT INTO "Thread"(id, "commentId", "parentThreadId") VALUES (392, 3901, 391);`
    );
    expect(
      await one(
        `SELECT "entityType", "entityId", "rootLocked" FROM commentv3_thread_entity((SELECT t FROM "Thread" t WHERE id = 392))`
      )
    ).toEqual({ entityType: 'image', entityId: 17, rootLocked: true });
  });

  it('a mirror row that already exists (a backfilled one) does not fail the old-side write', async () => {
    await db.pg.exec(`
      INSERT INTO "Thread"(id, "imageId") VALUES (410, 18);
      INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (4100, 'seeded', 1, 410);
      INSERT INTO "Thread"(id, "commentId", "parentThreadId") VALUES (411, 4100, 410);
      INSERT INTO "CommentV3Reaction"("commentId", "userId", reaction) VALUES (4100, 6, 'Like');
      INSERT INTO "CommentV3Report"("reportId", "commentId") VALUES (8, 4100);
      INSERT INTO "CommentMute"("userId", "commentId") VALUES (6, 4100);
      INSERT INTO "CommentTopicMute"("userId", "entityType", "entityId") VALUES (6, 'image', 18);
    `);
    await db.pg.exec(`
      INSERT INTO "CommentV2Reaction"("commentId", "userId", reaction) VALUES (4100, 6, 'Like');
      INSERT INTO "CommentV2Report"("commentV2Id", "reportId") VALUES (4100, 8);
      INSERT INTO "ThreadMute"("userId", "threadId") VALUES (6, 411), (6, 410);
    `);
    expect(await count(`FROM "CommentV3Reaction" WHERE "commentId" = 4100 AND "userId" = 6`)).toBe(
      1
    );
    expect(await count(`FROM "CommentV3Report" WHERE "reportId" = 8`)).toBe(1);
    expect(await count(`FROM "CommentMute" WHERE "userId" = 6 AND "commentId" = 4100`)).toBe(1);
    expect(await count(`FROM "CommentTopicMute" WHERE "userId" = 6 AND "entityId" = 18`)).toBe(1);

    // The v1 side, where the mirror id is the v1 id above the floor.
    await db.pg.exec(`
      INSERT INTO "Comment"(id, content, "userId", "modelId") VALUES (4110, 'seeded v1', 1, 2);
      INSERT INTO "CommentV3Reaction"("commentId", "userId", reaction) VALUES (4110, 6, 'Like');
      INSERT INTO "CommentV3Report"("reportId", "commentId") VALUES (10, 4110);
    `);
    await db.pg.exec(`
      INSERT INTO "CommentReaction"("commentId", "userId", reaction) VALUES (4110, 6, 'Like');
      INSERT INTO "CommentReport"("commentId", "reportId") VALUES (4110, 10);
    `);
    expect(await count(`FROM "CommentV3Reaction" WHERE "commentId" = 4110 AND "userId" = 6`)).toBe(
      1
    );
    expect(await count(`FROM "CommentV3Report" WHERE "reportId" = 10`)).toBe(1);
  });

  it('null moderation flags on the old side mirror as false', async () => {
    await db.pg.exec(`
      INSERT INTO "CommentV2"(id, content, "userId", "threadId", hidden) VALUES (4120, 'null hidden', 1, 410, NULL);
      INSERT INTO "Comment"(id, content, "userId", "modelId", hidden, locked) VALUES (4121, 'null flags', 1, 2, NULL, NULL);
    `);
    expect(await v3(4120)).toMatchObject({ hidden: false });
    expect(await v3(4121)).toMatchObject({ hidden: false, locked: false });
    await db.pg.exec(
      `UPDATE "CommentV2" SET hidden = NULL, content = 'still null' WHERE id = 4120`
    );
    await db.pg.exec(
      `UPDATE "Comment" SET hidden = NULL, locked = NULL, content = 'still null' WHERE id = 4121`
    );
    expect(await v3(4120)).toMatchObject({ hidden: false, content: 'still null' });
    expect(await v3(4121)).toMatchObject({ hidden: false, locked: false, content: 'still null' });
  });

  it('unlocking the reply thread of an unmirrored comment copies nothing', async () => {
    await db.pg.exec(
      `ALTER TABLE "CommentV2" DISABLE TRIGGER commentv3_mirror; ALTER TABLE "Thread" DISABLE TRIGGER commentv3_mirror;
       INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (4130, 'unmirrored', 1, 410);
       INSERT INTO "Thread"(id, "commentId", "parentThreadId", locked) VALUES (413, 4130, 410, true);
       ALTER TABLE "CommentV2" ENABLE TRIGGER commentv3_mirror; ALTER TABLE "Thread" ENABLE TRIGGER commentv3_mirror;`
    );
    await db.pg.exec(`UPDATE "Thread" SET locked = false WHERE id = 413`);
    expect(await count('FROM "CommentV3" WHERE id = 4130')).toBe(0);
  });

  it('v2 report re-points and v1 reaction updates follow the old side', async () => {
    await db.pg.exec(`
      INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (4101, 'a', 1, 410), (4102, 'b', 1, 410);
      INSERT INTO "CommentV2Report"("commentV2Id", "reportId") VALUES (4101, 9);
      UPDATE "CommentV2Report" SET "commentV2Id" = 4102 WHERE "reportId" = 9;
    `);
    expect(await one(`SELECT "commentId" FROM "CommentV3Report" WHERE "reportId" = 9`)).toEqual({
      commentId: 4102,
    });

    await db.pg.exec(`
      INSERT INTO "Comment"(id, content, "userId", "modelId") VALUES (4103, 'v1 reacted', 1, 2);
      INSERT INTO "CommentReaction"("commentId", "userId", reaction) VALUES (4103, 6, 'Like');
      UPDATE "CommentReaction" SET reaction = 'Cry' WHERE "commentId" = 4103 AND "userId" = 6;
    `);
    expect(
      await rows(
        `SELECT reaction FROM "CommentV3Reaction" WHERE "commentId" = 4103 AND "userId" = 6`
      )
    ).toEqual([{ reaction: 'Cry' }]);
    expect((await v3(4103)).reactionCount).toBe(1);
  });

  it('v1 report links follow deletes and re-points', async () => {
    await db.pg.exec(
      `INSERT INTO "Comment"(id, content, "userId", "modelId") VALUES (3950, 'reported', 1, 2), (3951, 'reported too', 1, 2);
       INSERT INTO "CommentReport"("commentId", "reportId") VALUES (3950, 7)`
    );
    expect(await one(`SELECT "commentId" FROM "CommentV3Report" WHERE "reportId" = 7`)).toEqual({
      commentId: 3950,
    });
    await db.pg.exec(`UPDATE "CommentReport" SET "commentId" = 3951 WHERE "reportId" = 7`);
    expect(await one(`SELECT "commentId" FROM "CommentV3Report" WHERE "reportId" = 7`)).toEqual({
      commentId: 3951,
    });
    await db.pg.exec(`DELETE FROM "CommentReport" WHERE "reportId" = 7`);
    expect(await count(`FROM "CommentV3Report" WHERE "reportId" = 7`)).toBe(0);
  });

  it('a comment whose entity is already gone is left unmirrored, and the old-side write succeeds', async () => {
    // A Thread pointing at a missing entity cannot exist through the FK; replica mode bypasses it.
    await db.pg.exec(
      `SET session_replication_role = replica;
       INSERT INTO "Thread"(id, "imageId") VALUES (380, 99999);
       SET session_replication_role = origin;`
    );
    await db.pg.exec(
      `INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (3800, 'orphan entity', 1, 380)`
    );
    expect(await count(`FROM "CommentV2" WHERE id = 3800`)).toBe(1);
    expect(await count(`FROM "CommentV3" WHERE id = 3800`)).toBe(0);
    expect(
      await count(`FROM "CommentTopic" WHERE "entityType" = 'image' AND "entityId" = 99999`)
    ).toBe(0);
  });

  it('no mirror trigger was left disabled', async () => {
    expect(
      await count(`FROM pg_trigger WHERE tgname = 'commentv3_mirror' AND tgenabled <> 'O'`)
    ).toBe(0);
  });

  it('installs atomically: a failure at the last trigger leaves nothing behind', async () => {
    // psql -f autocommits each statement, so the file's own BEGIN/COMMIT is the only atomicity.
    const fresh = new PGlite({ extensions: { ltree } });
    try {
      await fresh.exec(FIXTURE);
      await fresh.exec(migration('20261110120000_comment_v3_schema'));
      await fresh.exec(
        `CREATE TRIGGER commentv3_mirror AFTER INSERT ON "ThreadMute" FOR EACH ROW EXECUTE FUNCTION update_thread_comment_count()`
      );
      const statements = statementsOf(migration('20261120120000_comment_v3_mirror'));
      expect(statements[0]).toBe('BEGIN;');
      expect(statements.at(-1)).toBe('COMMIT;');
      const lastTrigger = statements.findIndex((s) =>
        /^CREATE TRIGGER commentv3_mirror\s+AFTER INSERT OR DELETE\s+ON "ThreadMute"/.test(s)
      );
      expect(lastTrigger).toBeGreaterThan(0);
      const afterLastTrigger = statements.slice(lastTrigger + 1, -1);
      expect(afterLastTrigger.length).toBeGreaterThan(0);
      expect(afterLastTrigger.filter((s) => !s.startsWith('REVOKE'))).toEqual([]);
      let failed: unknown;
      let failedAt = -1;
      for (const [i, statement] of statements.entries()) {
        try {
          await fresh.exec(statement);
        } catch (e) {
          failed = e;
          failedAt = i;
          break;
        }
      }
      expect(String(failed)).toMatch(/already exists/);
      expect(failedAt).toBe(lastTrigger);
      await fresh.exec('ROLLBACK');
      expect(
        (
          await fresh.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_proc WHERE proname LIKE 'commentv3\\_%' AND proname NOT IN ('commentv3_set_path', 'commentv3_topic_comment_count', 'commentv3_reaction_count')`
          )
        ).rows[0].n
      ).toBe(0);
      expect(
        (
          await fresh.query<{ d: boolean }>(
            `SELECT tgdeferrable AS d FROM pg_trigger WHERE tgname = 'commentv3_topic_comment_count'`
          )
        ).rows
      ).toEqual([{ d: false }]);
    } finally {
      await fresh.close();
    }
  });

  it('takes the floor from whichever old sequence is higher', async () => {
    const fresh = new PGlite({ extensions: { ltree } });
    try {
      await fresh.exec(FIXTURE);
      await fresh.exec(`INSERT INTO "Comment"(content, "userId", "modelId") SELECT 'v1', 1, 1 FROM generate_series(1, 6);
        INSERT INTO "Thread"("imageId") VALUES (10);
        INSERT INTO "CommentV2"(content, "userId", "threadId") VALUES ('v2', 1, 1), ('v2', 1, 1);`);
      await fresh.exec(migration('20261110120000_comment_v3_schema'));
      await fresh.exec(migration('20261120120000_comment_v3_mirror'));
      expect(
        (await fresh.query<{ f: number }>('SELECT commentv3_v1_id_floor() AS f')).rows[0].f
      ).toBe(6);
    } finally {
      await fresh.close();
    }
  });

  it('refuses to install on a database where a v1 id above the floor is also a v2 id', async () => {
    const fresh = new PGlite({ extensions: { ltree } });
    try {
      await fresh.exec(FIXTURE);
      await fresh.exec(`INSERT INTO "Comment"(id, content, "userId", "modelId") VALUES (7, 'v1', 1, 1);
        INSERT INTO "Thread"("imageId") VALUES (10);
        INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (7, 'v2', 1, 1);`);
      await fresh.exec(migration('20261110120000_comment_v3_schema'));
      await expect(fresh.exec(migration('20261120120000_comment_v3_mirror'))).rejects.toThrow(
        /share ids above the floor/
      );
    } finally {
      await fresh.close();
    }
  });
});
