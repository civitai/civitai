import { PGlite } from '@electric-sql/pglite';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SqlRunner } from '~/server/services/commentv3/write.service';
import { FIXTURE, migration } from '~/server/services/__tests__/comment-v3-fixture';
import {
  deleteComments,
  getStoredComment,
  insertComment,
  isCommentWriteLocked,
  isTopicMuted,
  setCommentFlags,
  toggleCommentLock,
  toggleCommentMute,
  toggleTopicLock,
  toggleTopicMute,
  updateCommentContent,
} from '~/server/services/commentv3/write.service';

vi.setConfig({ hookTimeout: 120_000, testTimeout: 60_000 });

let pg: PGlite;
let db: SqlRunner;
beforeAll(async () => {
  pg = new PGlite({ extensions: { ltree } });
  await pg.exec(FIXTURE);
  await pg.exec(migration('20261110120000_comment_v3_schema'));
  await pg.exec(migration('20261120120000_comment_v3_mirror'));
  await pg.exec(migration('20261210120000_comment_v3_mirror_changed_columns'));
  await pg.exec(migration('20270101120000_comment_v3_old_table_triggers_off'));
  await pg.exec(migration('20270102120000_comment_v3_teardown'));
  await pg.exec(migration('20271114120000_comment_v3_metadata'));
  db = {
    query: async <R extends Record<string, unknown>>(sql: string, params?: unknown[]) =>
      (await pg.query<R>(sql, params)) as { rows: R[] },
  };
});
afterAll(async () => {
  await pg.close();
});

const one = async <T extends Record<string, unknown>>(sql: string) =>
  (await pg.query<T>(sql)).rows[0];
const commentCount = async (entityId: number) =>
  (
    await one<{ n: number }>(
      `SELECT "commentCount" AS n FROM "CommentTopic" WHERE "entityType" = 'article' AND "entityId" = ${entityId}`
    )
  )?.n;
const post = (entityId: number, userId: number, parentId?: number, content = 'hi') =>
  insertComment(db, { userId, entityType: 'article', entityId, parentId, content });

describe('comment v3 writes', () => {
  it('a first comment creates its topic, and replies nest under their parent', async () => {
    const root = await post(1, 1);
    expect(root).toMatchObject({ entityType: 'article', entityId: 1, parentId: null, depth: 0 });
    const reply = await post(1, 2, root.id);
    const nested = await post(1, 3, reply.id);
    expect(nested).toMatchObject({
      parentId: reply.id,
      depth: 2,
      path: `${root.id}.${reply.id}.${nested.id}`,
    });
    expect(await commentCount(1)).toBe(3);
  });

  it('stores the metadata it is given as JSON, and none when it has none', async () => {
    const timed = await insertComment(db, {
      userId: 1,
      entityType: 'article',
      entityId: 1,
      content: 'at 0:42',
      metadata: { timestampSec: 42 },
    });
    const plain = await post(1, 1);
    const stored = async (id: number) =>
      (await one<{ metadata: unknown }>(`SELECT metadata FROM "CommentV3" WHERE id = ${id}`))
        ?.metadata;
    expect(await stored(timed.id)).toEqual({ timestampSec: 42 });
    expect(await stored(plain.id)).toBeNull();
  });

  it('refuses a reply to a comment on another article, to a deleted one, or on a missing article', async () => {
    const other = await post(2, 1);
    await expect(post(1, 2, other.id)).rejects.toThrow(/no longer exists/);
    const gone = await post(2, 1);
    const kept = await post(2, 2, gone.id);
    await deleteComments(db, [gone.id]);
    await expect(post(2, 3, gone.id)).rejects.toThrow(/no longer exists/);
    expect(await getStoredComment(db, kept.id)).toMatchObject({ parentId: gone.id });
    await expect(post(999, 1)).rejects.toThrow(/no longer exists/);
  });

  it('a lock on the article or on any comment above refuses the write; a sibling chain stays open', async () => {
    const a = await post(3, 1);
    const b = await post(3, 2, a.id);
    const c = await post(3, 3, b.id);
    const sibling = await post(3, 4);
    await pg.exec(`UPDATE "CommentV3" SET locked = true WHERE id = ${a.id}`);
    await expect(post(3, 5, c.id)).rejects.toThrow('comment thread locked');
    await expect(post(3, 5, sibling.id)).resolves.toMatchObject({ parentId: sibling.id });

    expect(await toggleTopicLock(db, { entityType: 'article', entityId: 3 })).toEqual({
      locked: true,
    });
    await expect(post(3, 5)).rejects.toThrow('comment thread locked');
    await expect(post(3, 5, sibling.id)).rejects.toThrow('comment thread locked');
    expect(await toggleTopicLock(db, { entityType: 'article', entityId: 3 })).toEqual({
      locked: false,
    });
    await expect(post(3, 5)).resolves.toBeDefined();
  });

  it('locking an article with no comments creates its topic locked', async () => {
    await pg.exec(`INSERT INTO "Article" VALUES (40)`);
    expect(await toggleTopicLock(db, { entityType: 'article', entityId: 40 })).toEqual({
      locked: true,
    });
    await expect(post(40, 1)).rejects.toThrow('comment thread locked');
    await expect(toggleTopicLock(db, { entityType: 'article', entityId: 41 })).rejects.toThrow(
      /No article/
    );
  });

  it('a reply past the depth cap attaches at the cap and answers its parent through replyToId', async () => {
    await pg.exec(`INSERT INTO "Article" VALUES (20)`);
    let parent = await post(20, 1);
    const chain = [parent];
    while (parent.depth < 20) {
      parent = await post(20, 1, parent.id);
      chain.push(parent);
    }
    const deep = await post(20, 2, parent.id);
    expect(deep).toMatchObject({ parentId: chain[19].id, replyToId: parent.id, depth: 20 });
  });

  it('delete: a childless comment goes, one with replies is a tombstone that collapses with its last reply', async () => {
    await pg.exec(`INSERT INTO "Article" VALUES (30)`);
    const root = await post(30, 1, undefined, 'root');
    const reply = await post(30, 2, root.id);
    const lone = await post(30, 3);
    expect(await commentCount(30)).toBe(3);
    await pg.exec(`INSERT INTO "Report" (id) VALUES (301), (302);
      INSERT INTO "CommentV3Report" ("reportId", "commentId") VALUES (301, ${root.id}), (302, ${reply.id})`);
    const reportedIds = async () =>
      (
        await pg.query<{ commentId: number }>(
          `SELECT "commentId" FROM "CommentV3Report" ORDER BY 1`
        )
      ).rows.map((r) => r.commentId);

    expect(await deleteComments(db, [lone.id])).toEqual([
      { id: lone.id, userId: 3, entityType: 'article', entityId: 30 },
    ]);
    expect(await getStoredComment(db, lone.id)).toBeUndefined();

    expect(await deleteComments(db, [root.id])).toEqual([
      { id: root.id, userId: 1, entityType: 'article', entityId: 30 },
    ]);
    const tombstone = await getStoredComment(db, root.id);
    expect(tombstone).toMatchObject({ content: '', userId: 1 });
    expect(tombstone?.deletedAt).not.toBeNull();
    expect(await updateCommentContent(db, { id: root.id, content: 'back' })).toBeUndefined();
    expect(await commentCount(30)).toBe(2);
    // The tombstone's report goes with it, as a hard delete's would; the reply's stays.
    expect(await reportedIds()).toEqual([reply.id]);

    // Deleting the tombstone again changes nothing and is not a second removal.
    expect(await deleteComments(db, [root.id])).toEqual([]);

    expect(await deleteComments(db, [reply.id])).toEqual([
      { id: reply.id, userId: 2, entityType: 'article', entityId: 30 },
    ]);
    expect(await getStoredComment(db, root.id)).toBeUndefined();
    expect(await commentCount(30)).toBe(0);
  });

  it('delete: a comment a clamped reply answers is kept as a tombstone until that reply goes', async () => {
    await pg.exec(`INSERT INTO "Article" VALUES (31)`);
    const root = await post(31, 1);
    const sibling = await post(31, 2, root.id);
    const answering = await insertComment(db, {
      userId: 3,
      entityType: 'article',
      entityId: 31,
      parentId: root.id,
      content: 'answers the sibling',
    });
    await pg.exec(`UPDATE "CommentV3" SET "replyToId" = ${sibling.id} WHERE id = ${answering.id}`);
    await deleteComments(db, [sibling.id]);
    expect(await getStoredComment(db, sibling.id)).toMatchObject({ content: '' });
    await deleteComments(db, [answering.id]);
    expect(await getStoredComment(db, sibling.id)).toBeUndefined();
    expect(await getStoredComment(db, root.id)).toMatchObject({ deletedAt: null });
  });

  it('delete: a comment and its whole thread in one call all go, each counted once', async () => {
    await pg.exec(`INSERT INTO "Article" VALUES (32)`);
    const root = await post(32, 1);
    const reply = await post(32, 2, root.id);
    const nested = await post(32, 3, reply.id);
    const other = await post(32, 4, root.id);
    const removed = await deleteComments(db, [nested.id, root.id, reply.id]);
    expect(removed.map((r) => r.id).sort()).toEqual([root.id, reply.id, nested.id].sort());
    // The root keeps a reply that was not deleted, so it stays as a placeholder.
    expect(await getStoredComment(db, root.id)).toMatchObject({ content: '' });
    expect(await getStoredComment(db, reply.id)).toBeUndefined();
    await deleteComments(db, [other.id]);
    expect(await getStoredComment(db, root.id)).toBeUndefined();
    expect(await commentCount(32)).toBe(0);
  });

  it('an edit changes content and moves updatedAt', async () => {
    const c = await post(1, 4, undefined, 'before');
    await pg.exec(`UPDATE "CommentV3" SET "updatedAt" = '2020-01-01' WHERE id = ${c.id}`);
    const edited = await updateCommentContent(db, { id: c.id, content: 'after' });
    expect(edited).toMatchObject({ content: 'after' });
    expect(edited?.updatedAt.getTime()).toBeGreaterThan(new Date('2021-01-01').getTime());
  });

  it('flags report only the rows they changed, and a repeated pin keeps its first time', async () => {
    const a = await post(1, 5);
    const b = await post(1, 6);
    expect(await setCommentFlags(db, [a.id, b.id], { hidden: true })).toHaveLength(2);
    expect(await setCommentFlags(db, [a.id, b.id], { hidden: true })).toEqual([]);
    expect(await setCommentFlags(db, [a.id], { tosViolation: true })).toEqual([
      { id: a.id, userId: 5 },
    ]);
    await setCommentFlags(db, [b.id], { pinned: true });
    const pinnedAt = (await getStoredComment(db, b.id))?.pinnedAt;
    expect(pinnedAt).not.toBeNull();
    expect(await setCommentFlags(db, [b.id], { pinned: true })).toEqual([]);
    expect((await getStoredComment(db, b.id))?.pinnedAt).toEqual(pinnedAt);
    await setCommentFlags(db, [b.id], { pinned: false });
    expect((await getStoredComment(db, b.id))?.pinnedAt).toBeNull();
  });

  it('mutes toggle, and a section with no comments can be muted', async () => {
    const c = await post(1, 7);
    expect(await toggleCommentMute(db, { userId: 8, commentId: c.id })).toEqual({ muted: true });
    expect(await toggleCommentMute(db, { userId: 8, commentId: c.id })).toEqual({ muted: false });
    const topic = { userId: 8, entityType: 'article', entityId: 2 };
    expect(await toggleTopicMute(db, topic)).toEqual({ muted: true });
    expect(await toggleTopicMute(db, { ...topic, entityId: 3 })).toEqual({ muted: true });
    expect(await toggleTopicMute(db, topic)).toEqual({ muted: false });
  });

  it('a mute is the caller’s alone: one user’s toggle never lifts another’s', async () => {
    const c = await post(1, 8);
    await toggleCommentMute(db, { userId: 8, commentId: c.id });
    expect(await toggleCommentMute(db, { userId: 9, commentId: c.id })).toEqual({ muted: true });
    expect(await toggleCommentMute(db, { userId: 8, commentId: c.id })).toEqual({ muted: false });
    const topic = { entityType: 'article', entityId: 4 };
    await toggleTopicMute(db, { ...topic, userId: 8 });
    expect(await toggleTopicMute(db, { ...topic, userId: 9 })).toEqual({ muted: true });
    expect(await toggleTopicMute(db, { ...topic, userId: 8 })).toEqual({ muted: false });
  });

  it('a section reads as muted only to the user who muted it, and only that section', async () => {
    const topic = { entityType: 'article', entityId: 5 };
    await toggleTopicMute(db, { ...topic, userId: 8 });
    expect(await isTopicMuted(db, { ...topic, userId: 8 })).toBe(true);
    expect(await isTopicMuted(db, { ...topic, userId: 9 })).toBe(false);
    expect(await isTopicMuted(db, { ...topic, entityId: 6, userId: 8 })).toBe(false);
    expect(await isTopicMuted(db, { ...topic, entityType: 'post', userId: 8 })).toBe(false);
  });

  it('a comment lock toggles, and refuses replies anywhere below it', async () => {
    await pg.exec(`INSERT INTO "Article" VALUES (34)`);
    const root = await post(34, 1);
    const reply = await post(34, 2, root.id);
    expect(await toggleCommentLock(db, root.id)).toEqual({ id: root.id, locked: true });
    await expect(post(34, 3, reply.id)).rejects.toThrow('comment thread locked');
    expect(await toggleCommentLock(db, root.id)).toEqual({ id: root.id, locked: false });
    await expect(post(34, 3, reply.id)).resolves.toMatchObject({ parentId: reply.id });
  });

  it('counts reactions as they are added and removed, never below zero', async () => {
    await pg.exec(`INSERT INTO "Article" VALUES (36)`);
    const c = await post(36, 1);
    const count = async () =>
      (await one<{ n: number }>(`SELECT "reactionCount" AS n FROM "CommentV3" WHERE id = ${c.id}`))
        .n;
    await pg.exec(
      `INSERT INTO "CommentV3Reaction"("commentId", "userId", reaction) VALUES (${c.id}, 2, 'Like'), (${c.id}, 3, 'Heart')`
    );
    expect(await count()).toBe(2);
    await pg.exec(`DELETE FROM "CommentV3Reaction" WHERE "commentId" = ${c.id} AND "userId" = 2`);
    expect(await count()).toBe(1);
    await pg.exec(`UPDATE "CommentV3" SET "reactionCount" = 0 WHERE id = ${c.id}`);
    await pg.exec(`DELETE FROM "CommentV3Reaction" WHERE "commentId" = ${c.id}`);
    expect(await count()).toBe(0);
  });

  it('never counts a topic below zero', async () => {
    await pg.exec(`INSERT INTO "Article" VALUES (37)`);
    const c = await post(37, 1);
    await pg.exec(
      `UPDATE "CommentTopic" SET "commentCount" = 0 WHERE "entityType" = 'article' AND "entityId" = 37`
    );
    await deleteComments(db, [c.id]);
    expect(await commentCount(37)).toBe(0);
  });

  it('delete: a pinned comment kept as a tombstone loses its pin', async () => {
    await pg.exec(`INSERT INTO "Article" VALUES (35)`);
    const root = await post(35, 1);
    await post(35, 2, root.id);
    await setCommentFlags(db, [root.id], { pinned: true });
    expect((await getStoredComment(db, root.id))?.pinnedAt).not.toBeNull();
    await deleteComments(db, [root.id]);
    expect(await getStoredComment(db, root.id)).toMatchObject({ content: '', pinnedAt: null });
  });

  it('an edit is refused under a locked ancestor or topic, as the update handler asks', async () => {
    await pg.exec(`INSERT INTO "Article" VALUES (33)`);
    const root = await post(33, 1);
    const reply = await post(33, 2, root.id);
    const parentPath = reply.path.split('.').slice(0, -1).join('.');
    const locked = () =>
      isCommentWriteLocked(db, { entityType: 'article', entityId: 33, path: parentPath });
    expect(await locked()).toBe(false);
    await pg.exec(`UPDATE "CommentV3" SET locked = true WHERE id = ${root.id}`);
    expect(await locked()).toBe(true);
    await pg.exec(`UPDATE "CommentV3" SET locked = false WHERE id = ${root.id}`);
    await toggleTopicLock(db, { entityType: 'article', entityId: 33 });
    expect(await locked()).toBe(true);
  });
});

describe('20270101120000_comment_v3_old_table_triggers_off', () => {
  const OLD_TABLES = [
    'Thread',
    'CommentV2',
    'Comment',
    'CommentV2Reaction',
    'CommentReaction',
    'CommentV2Report',
    'CommentReport',
    'ThreadMute',
  ];
  let old: PGlite;
  // 20270101120000 drops the mirror and moderation-scan triggers; the count triggers stay.
  const triggersOn = async (table: string) =>
    (
      await old.query<{ tgname: string }>(
        `SELECT tgname FROM pg_trigger WHERE tgrelid = $1::regclass
           AND (tgname = 'commentv3_mirror' OR tgname LIKE 'trg_moderation%') ORDER BY tgname`,
        [`"${table}"`]
      )
    ).rows.map((r) => r.tgname);
  const v3Reactions = async () =>
    (
      await old.query<{ userId: number; reaction: string }>(
        `SELECT "userId", reaction FROM "CommentV3Reaction" ORDER BY "userId"`
      )
    ).rows;

  beforeAll(async () => {
    old = new PGlite({ extensions: { ltree } });
    await old.exec(FIXTURE);
    await old.exec(migration('20261110120000_comment_v3_schema'));
    await old.exec(migration('20261120120000_comment_v3_mirror'));
    await old.exec(migration('20261210120000_comment_v3_mirror_changed_columns'));
    // Stand-ins for the old tables' moderation triggers (20250521094141_add_clavata_moderation).
    await old.exec(`
      CREATE FUNCTION fake_moderation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
      CREATE TRIGGER trg_moderation_comment AFTER INSERT ON "Comment" FOR EACH ROW EXECUTE FUNCTION fake_moderation();
      CREATE TRIGGER trg_moderation_commentv2 AFTER INSERT ON "CommentV2" FOR EACH ROW EXECUTE FUNCTION fake_moderation();
      INSERT INTO "Thread"("articleId") VALUES (1);
      INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES (500, 'old', 1, 1);
      INSERT INTO "CommentV2Reaction"("commentId", "userId", reaction) VALUES (500, 2, 'Like');
    `);
  });
  afterAll(async () => {
    await old.close();
  });

  it('starts from the mirror following every old table, and the moderation triggers in place', async () => {
    for (const table of OLD_TABLES) expect(await triggersOn(table)).toContain('commentv3_mirror');
    expect(await triggersOn('Comment')).toContain('trg_moderation_comment');
    expect(await triggersOn('CommentV2')).toContain('trg_moderation_commentv2');
    expect(await v3Reactions()).toEqual([{ userId: 2, reaction: 'Like' }]);
  });

  it('leaves no mirror or moderation trigger on an old table, and an old reaction write no longer reaches CommentV3', async () => {
    await old.exec(migration('20270101120000_comment_v3_old_table_triggers_off'));
    await old.exec(`
      INSERT INTO "CommentV2Reaction"("commentId", "userId", reaction) VALUES (500, 3, 'Heart');
      DELETE FROM "CommentV2Reaction" WHERE "userId" = 2;
    `);
    expect(await v3Reactions()).toEqual([{ userId: 2, reaction: 'Like' }]);

    const left = await Promise.all(OLD_TABLES.map(async (t) => [t, await triggersOn(t)]));
    expect(left).toEqual(OLD_TABLES.map((t) => [t, []]));
  });
});

describe('20270102120000_comment_v3_teardown', () => {
  let old: PGlite;
  const ids = async (sql: string) =>
    (await old.query<{ id: number }>(sql)).rows.map((r) => Number(r.id));

  beforeAll(async () => {
    old = new PGlite({ extensions: { ltree } });
    await old.exec(FIXTURE);
    await old.exec(migration('20261110120000_comment_v3_schema'));
    await old.exec(migration('20261120120000_comment_v3_mirror'));
    await old.exec(migration('20261210120000_comment_v3_mirror_changed_columns'));
    await old.exec(migration('20261217120000_comment_v3_removed_by_author'));
    await old.exec(migration('20270101120000_comment_v3_old_table_triggers_off'));
    await old.exec(`
      INSERT INTO "Thread"(id, "questionId") VALUES (1, 7);
      INSERT INTO "Thread"(id, "rootThreadId", "parentThreadId") VALUES (2, 1, 1);
      INSERT INTO "Thread"(id, "clubPostId") VALUES (3, 9);
      INSERT INTO "CommentV2"(id, content, "userId", "threadId") VALUES
        (900, 'question comment', 1, 1), (901, 'reply', 2, 2), (902, 'club post comment', 1, 3);
      INSERT INTO "CommentV2Reaction"("commentId", "userId", reaction) VALUES (900, 3, 'Like'), (902, 3, 'Like');
      INSERT INTO "CommentV2Report"("commentV2Id", "reportId") VALUES (901, 1);
      INSERT INTO "KeyValue" VALUES ('comment-v3-parity:last', '{}'), ('unrelated', '{}');
      INSERT INTO "CommentTopic"("entityType", "entityId") VALUES ('article', 1);
      INSERT INTO "CommentV3"(id, "entityType", "entityId", "userId", content) VALUES (950, 'article', 1, 1, 'kept');
      INSERT INTO "CommentV3Reaction"("commentId", "userId", reaction) VALUES (950, 2, 'Like');
      CREATE SCHEMA archive;
      CREATE TABLE archive."CommentV2"(id integer);
    `);
    await old.exec(migration('20270102120000_comment_v3_teardown'));
  });
  afterAll(async () => {
    await old.close();
  });

  it('drops the old tables, the parity row and removedByAuthor, and keeps the id sequence CommentV3 draws from', async () => {
    const { rows } = await old.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_class WHERE relnamespace = 'public'::regnamespace
         AND relname IN ('Thread', 'Comment', 'CommentV2', 'ThreadMute', 'CommentReaction',
           'CommentV2Reaction', 'CommentReport', 'CommentV2Report')`
    );
    expect(rows[0].n).toBe(0);
    expect((await old.query<{ key: string }>(`SELECT key FROM "KeyValue"`)).rows).toEqual([
      { key: 'unrelated' },
    ]);
    expect(
      await ids(
        `SELECT 1 AS id FROM information_schema.columns WHERE table_name = 'CommentV3' AND column_name = 'removedByAuthor'`
      )
    ).toEqual([]);
    expect(
      await ids(`SELECT 1 AS id FROM pg_class WHERE relname = 'comment_shared_id_seq'`)
    ).toEqual([1]);
    expect(await ids(`SELECT 1 AS id FROM pg_namespace WHERE nspname = 'archive'`)).toEqual([]);
  });

  it('leaves CommentV3 and its reactions as they were', async () => {
    expect(await ids(`SELECT id FROM "CommentV3"`)).toEqual([950]);
    expect(await ids(`SELECT "commentId" AS id FROM "CommentV3Reaction"`)).toEqual([950]);
  });

  it('sets its lock timeout for its own transaction only', async () => {
    expect(
      (await old.query<{ lock_timeout: string }>('SHOW lock_timeout')).rows[0].lock_timeout
    ).toBe('0');
  });
});
