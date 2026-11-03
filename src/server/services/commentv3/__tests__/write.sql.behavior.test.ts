import { PGlite } from '@electric-sql/pglite';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SqlRunner } from '~/server/services/comment-v3-backfill.service';
import { FIXTURE, migration } from '~/server/services/__tests__/comment-v3-fixture';
import {
  deleteComments,
  getStoredComment,
  insertComment,
  isCommentWriteLocked,
  isV3WriteTarget,
  setCommentFlags,
  toggleCommentMute,
  toggleTopicLock,
  toggleTopicMute,
  updateCommentContent,
} from '~/server/services/commentv3/write.service';

// Against real Postgres with the production triggers (path, counts, the mirror's deferred count).
vi.setConfig({ hookTimeout: 120_000, testTimeout: 60_000 });

let pg: PGlite;
let db: SqlRunner;
beforeAll(async () => {
  pg = new PGlite({ extensions: { ltree } });
  await pg.exec(FIXTURE);
  await pg.exec(migration('20261110120000_comment_v3_schema'));
  await pg.exec(migration('20261120120000_comment_v3_mirror'));
  await pg.exec(migration('20261210120000_comment_v3_mirror_changed_columns'));
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

  it('an old-table update copies only what it changed, so it never undoes a CommentV3 edit', async () => {
    const thread = await one<{ id: number }>(
      `INSERT INTO "Thread"("articleId") VALUES (2) RETURNING id`
    );
    const old = await one<{ id: number }>(
      `INSERT INTO "CommentV2"(content, "userId", "threadId") VALUES ('in v2', 1, ${thread.id}) RETURNING id`
    );
    await updateCommentContent(db, { id: old.id, content: 'edited in v3' });
    await pg.exec(`UPDATE "CommentV2" SET hidden = true, "updatedAt" = now() WHERE id = ${old.id}`);
    expect(await getStoredComment(db, old.id)).toMatchObject({
      content: 'edited in v3',
      hidden: true,
    });
    await pg.exec(`UPDATE "CommentV2" SET content = 'edited in v2' WHERE id = ${old.id}`);
    expect(await getStoredComment(db, old.id)).toMatchObject({
      content: 'edited in v2',
      hidden: true,
    });
  });

  // A stale CommentV2 row would keep serving what was removed, and an update to it would make the
  // mirror copy a deleted comment back.
  it('keeps a comment’s CommentV2 row in step: edits, flags, and gone with the comment', async () => {
    const thread = await one<{ id: number }>(
      `INSERT INTO "Thread"("articleId") VALUES (3) RETURNING id`
    );
    const old = await one<{ id: number }>(
      `INSERT INTO "CommentV2"(content, "userId", "threadId") VALUES ('in v2', 1, ${thread.id}) RETURNING id`
    );
    const v2 = () =>
      one<{ content: string; tosViolation: boolean; pinnedAt: Date | null }>(
        `SELECT content, "tosViolation", "pinnedAt" FROM "CommentV2" WHERE id = ${old.id}`
      );

    await updateCommentContent(db, { id: old.id, content: 'edited' });
    expect(await setCommentFlags(db, [old.id], { tosViolation: true, pinned: true })).toHaveLength(
      1
    );
    expect(await v2()).toMatchObject({ content: 'edited', tosViolation: true });
    expect((await v2())?.pinnedAt).not.toBeNull();
    expect(await getStoredComment(db, old.id)).toMatchObject({
      content: 'edited',
      tosViolation: true,
    });

    await deleteComments(db, [old.id]);
    expect(await v2()).toBeUndefined();
    expect(await getStoredComment(db, old.id)).toBeUndefined();
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

  it('a commentv2 write target is a CommentV3 surface by its own row, not by what it is addressed as', async () => {
    const article = await post(1, 1);
    expect(await isV3WriteTarget(db, { entityType: 'article', entityId: 1 })).toBe(true);
    expect(await isV3WriteTarget(db, { entityType: 'comment', entityId: article.id })).toBe(true);
    expect(await isV3WriteTarget(db, { entityType: 'image', entityId: 10 })).toBe(false);
    expect(await isV3WriteTarget(db, { entityType: 'comment', entityId: 99_999 })).toBe(false);
  });
});
