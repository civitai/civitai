import { PGlite } from '@electric-sql/pglite';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import {
  type DatabaseConnection,
  type Dialect,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ThreadSort } from '~/server/common/enums';
import { FIXTURE, migration } from '~/server/services/__tests__/comment-v3-fixture';
import {
  type CommentV3Db,
  type CommentV3Page,
  type CommentV3Viewer,
  getCommentLock,
  getCommentReplies,
  getCommentSection,
  getCommentThread,
} from '~/server/services/commentv3/read.service';

// Against real Postgres, with CommentV3 rows as the mirror or the v3 write path stores them.
vi.setConfig({ hookTimeout: 120_000, testTimeout: 60_000 });

const dialect = (pg: PGlite): Dialect => {
  const connection: DatabaseConnection = {
    async executeQuery(compiled) {
      const result = await pg.query(compiled.sql, compiled.parameters as unknown[]);
      return { rows: result.rows as never[], numAffectedRows: BigInt(result.affectedRows ?? 0) };
    },
    // eslint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const noop = async () => undefined;
  return {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => ({
      init: noop,
      acquireConnection: async () => connection,
      beginTransaction: noop,
      commitTransaction: noop,
      rollbackTransaction: noop,
      releaseConnection: noop,
      destroy: noop,
    }),
    createIntrospector: (k) => new PostgresIntrospector(k),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  };
};

// Article 10, oldest first: 100 (by 2) carries the big thread, 200 (by 3), 300 (by 6, whom the viewer
// excludes), 400 (removed for ToS, with a reply 401), 500 (a tombstone with a live reply 501), 550 (a
// tombstone whose only reply 551 is removed for ToS), 600 (pinned, newest), 700 (hidden) and 800.
// Deleted after those, each holding a live reply a reader must not reach through it: 560 (above 552,
// removed for ToS, above 553), 570 (itself removed for ToS before it was deleted, above 571) and 580
// (by the excluded user 6, above 581). Under 100: 101-106; under 101: 107-115 and 116, a clamped reply answering 107.
// Under 200: 201, and 202 by user 6 with its own reply 203. Article 11 holds 900.
const at = (minute: number) =>
  `'2025-01-01 00:00:00+00'::timestamptz + interval '${minute} minutes'`;
const SETUP = `
ALTER TABLE "User" ADD COLUMN username text, ADD COLUMN "deletedAt" timestamp, ADD COLUMN image text;
UPDATE "User" SET username = 'u' || id;
INSERT INTO "Article" VALUES (10);
INSERT INTO "CommentTopic"("entityType", "entityId") VALUES ('article', 10);
INSERT INTO "CommentV3"(id, "entityType", "entityId", "parentId", "replyToId", "userId", content, "createdAt", "pinnedAt", hidden, "tosViolation", "deletedAt") VALUES
  (100, 'article', 10, NULL, NULL, 2, 'big thread', ${at(1)}, NULL, false, false, NULL),
  (200, 'article', 10, NULL, NULL, 3, 'small thread', ${at(2)}, NULL, false, false, NULL),
  (300, 'article', 10, NULL, NULL, 6, 'by an excluded user', ${at(3)}, NULL, false, false, NULL),
  (400, 'article', 10, NULL, NULL, 4, 'removed', ${at(4)}, NULL, false, true, NULL),
  (500, 'article', 10, NULL, NULL, 5, '', ${at(5)}, NULL, false, false, now()),
  (600, 'article', 10, NULL, NULL, 7, 'pinned', ${at(60)}, ${at(61)}, false, false, NULL),
  (700, 'article', 10, NULL, NULL, 8, 'hidden', ${at(7)}, NULL, true, false, NULL),
  (800, 'article', 10, NULL, NULL, 9, 'plain', ${at(8)}, NULL, false, false, NULL);
INSERT INTO "CommentV3"(id, "entityType", "entityId", "parentId", "userId", content, "createdAt")
  SELECT 100 + g, 'article', 10, 100, 1 + g % 5, 'reply ' || (100 + g), ${at(
    10
  )} + g * interval '1 minute' FROM generate_series(1, 6) g;
INSERT INTO "CommentV3"(id, "entityType", "entityId", "parentId", "userId", content, "createdAt")
  SELECT 100 + g, 'article', 10, 101, 1 + g % 5, 'reply ' || (100 + g), ${at(
    20
  )} + g * interval '1 minute' FROM generate_series(7, 15) g;
INSERT INTO "CommentV3"(id, "entityType", "entityId", "parentId", "replyToId", "userId", content, "createdAt") VALUES
  (116, 'article', 10, 101, 107, 2, 'clamped', ${at(40)}),
  (201, 'article', 10, 200, NULL, 4, 'reply 201', ${at(41)}),
  (202, 'article', 10, 200, NULL, 6, 'reply by the excluded user', ${at(42)}),
  (203, 'article', 10, 202, NULL, 4, 'under the excluded reply', ${at(43)}),
  (501, 'article', 10, 500, NULL, 4, 'under a tombstone', ${at(44)}),
  (401, 'article', 10, 400, NULL, 2, 'under a ToS removal', ${at(46)});
INSERT INTO "CommentV3"(id, "entityType", "entityId", "parentId", "userId", content, "createdAt", "tosViolation", "deletedAt") VALUES
  (550, 'article', 10, NULL, 5, '', ${at(6)}, false, now()),
  (551, 'article', 10, 550, 4, 'removed under a tombstone', ${at(47)}, true, NULL),
  (560, 'article', 10, NULL, 5, '', ${at(50)}, false, now()),
  (552, 'article', 10, 560, 4, 'removed', ${at(51)}, true, NULL),
  (553, 'article', 10, 552, 2, 'under a removal under a tombstone', ${at(52)}, false, NULL),
  (570, 'article', 10, NULL, 5, 'removed, then deleted', ${at(53)}, true, now()),
  (571, 'article', 10, 570, 2, 'under it', ${at(54)}, false, NULL);
INSERT INTO "CommentV3"(id, "entityType", "entityId", "parentId", "userId", content, "createdAt", "deletedAt") VALUES
  (580, 'article', 10, NULL, 6, '', ${at(55)}, now()),
  (581, 'article', 10, 580, 2, 'under an excluded author', ${at(56)}, NULL);
INSERT INTO "Article" VALUES (11);
INSERT INTO "CommentTopic"("entityType", "entityId") VALUES ('article', 11);
INSERT INTO "CommentV3"(id, "entityType", "entityId", "parentId", "userId", content, "createdAt")
  VALUES (900, 'article', 11, NULL, 4, 'on another article', ${at(45)});
INSERT INTO "CommentV3Reaction"("commentId", "userId", reaction)
  SELECT 100, u, 'Like'::"ReviewReactions" FROM generate_series(1, 5) u
  UNION ALL SELECT 100, u, 'Heart'::"ReviewReactions" FROM generate_series(1, 2) u;
`;

let pg: PGlite;
let db: CommentV3Db;
beforeAll(async () => {
  pg = new PGlite({ extensions: { ltree } });
  await pg.exec(FIXTURE);
  await pg.exec(migration('20261110120000_comment_v3_schema'));
  await pg.exec(SETUP);
  db = new Kysely({ dialect: dialect(pg) }) as unknown as CommentV3Db;
});
afterAll(async () => {
  await pg.close();
});

const ARTICLE = { entityType: 'article', entityId: 10 };
const onArticle = { sort: ThreadSort.Oldest, entity: ARTICLE };
const reader: CommentV3Viewer = { userId: 1, isModerator: false, excludedUserIds: [6] };
const moderator: CommentV3Viewer = { userId: 9, isModerator: true, excludedUserIds: [] };
const section = (
  viewer: CommentV3Viewer,
  opts: Partial<Parameters<typeof getCommentSection>[3]> = {}
) =>
  getCommentSection(db, ARTICLE, viewer, {
    sort: ThreadSort.Oldest,
    replyDepth: 10,
    budget: 12,
    repliesPerRoot: 10,
    repliesPerParent: 5,
    ...opts,
  });
const ids = (page: CommentV3Page) => page.comments.map((c) => c.id);
const item = (page: CommentV3Page, id: number) => page.comments.find((c) => c.id === id)!;

describe('getCommentSection', () => {
  it('fills a page to the budget in rendered comments, so a big thread leaves room for fewer top-level comments', async () => {
    const page = await section(reader);
    // Pinned first; then 100, which costs 11 (itself and 10 opened replies). 200 would pass 12.
    expect(page.rootIds).toEqual([600, 100]);
    expect(page.comments).toHaveLength(12);
    // Shallowest first, five per parent: 101-105 under 100, then 107-111 under 101.
    expect(page.children[100]).toEqual({
      ids: [101, 102, 103, 104, 105],
      nextCursor: expect.any(String),
    });
    expect(page.children[101].ids).toEqual([107, 108, 109, 110, 111]);
    expect(page.nextCursor).not.toBeNull();

    const next = await section(reader, { cursor: page.nextCursor! });
    // 300 (excluded author) and 400 (ToS) are left out with what is under them; 500, deleted, stays
    // for its reply; 550, deleted with nothing this reader may see below it, does not.
    expect(next.rootIds).toEqual([200, 500, 700, 800]);
    expect(ids(next)).toEqual([200, 500, 700, 800, 201, 501]);
    expect(next.nextCursor).toBeNull();
  });

  it('a large budget takes every top-level comment, and the pinned one only once', async () => {
    const page = await section(reader, { budget: 100 });
    expect(page.rootIds).toEqual([600, 100, 200, 500, 700, 800]);
    expect(page.nextCursor).toBeNull();
  });

  it('opens at most the per-root cap under one comment, shallowest first', async () => {
    const page = await section(reader, { repliesPerRoot: 7, budget: 100 });
    expect(page.children[100].ids).toEqual([101, 102, 103, 104, 105]);
    expect(page.children[101].ids).toEqual([107, 108]);
  });

  it('always shows at least one top-level comment, however big its thread', async () => {
    const page = await section(reader, { budget: 2 });
    expect(page.rootIds).toEqual([600, 100]);
  });

  it('sends every rendered comment its reply count, counting only what this viewer may see', async () => {
    const page = await section(reader, { budget: 100 });
    expect(item(page, 100).replyCount).toBe(6);
    expect(item(page, 101).replyCount).toBe(10);
    expect(item(page, 200).replyCount).toBe(1);
    expect(item(page, 800).replyCount).toBe(0);
    const mod = await section(moderator, { budget: 100 });
    expect(item(mod, 200).replyCount).toBe(2);
  });

  it('sends reaction counts and the viewer’s own reactions, never the reactors', async () => {
    const page = await section(reader);
    expect(item(page, 100).reactions).toEqual({ Like: 5, Dislike: 0, Laugh: 0, Cry: 0, Heart: 2 });
    expect(item(page, 100).myReactions.sort()).toEqual(['Heart', 'Like']);
    expect(item(page, 600).myReactions).toEqual([]);
    const signedOut = await section({ isModerator: false, excludedUserIds: [] });
    expect(item(signedOut, 100).myReactions).toEqual([]);
  });

  it('keeps hidden comments as placeholders, and shows moderators what readers do not', async () => {
    const page = await section(reader, { budget: 100 });
    expect(item(page, 700).hidden).toBe(true);
    const mod = await section(moderator, { budget: 100 });
    expect(mod.rootIds).toEqual([600, 100, 200, 300, 400, 500, 550, 700, 800, 560, 570, 580]);
    expect(ids(mod)).toEqual(expect.arrayContaining([202, 203, 401, 551]));
  });

  it('keeps a deleted comment as a placeholder for its replies, without its author or reactions', async () => {
    const page = await section(reader, { budget: 100 });
    expect(item(page, 500)).toMatchObject({
      deleted: true,
      user: null,
      content: '',
      replyCount: 1,
    });
    expect(item(page, 500).myReactions).toEqual([]);
    expect(page.children[500].ids).toEqual([501]);
    expect(item(page, 100)).toMatchObject({ deleted: false, user: { id: 2 } });
  });

  it('never opens through a deleted comment what a ToS removal or an excluded author hid', async () => {
    const page = await section(reader, { budget: 100 });
    for (const id of [560, 553, 570, 571, 580, 581]) expect(ids(page)).not.toContain(id);
    expect(await getCommentThread(db, 571, reader, onArticle)).toBeNull();
    // A deleted row carries none of what it was: content, author, or the flags it was removed with.
    const mod = await section(moderator, { budget: 100 });
    expect(item(mod, 570)).toMatchObject({ deleted: true, content: '', tosViolation: false });
  });

  it('orders newest first and by reactions, and opens no replies at depth 0', async () => {
    expect((await section(reader, { sort: ThreadSort.Newest, budget: 100 })).rootIds).toEqual([
      600, 800, 700, 500, 200, 100,
    ]);
    expect(
      (await section(reader, { sort: ThreadSort.MostReactions, budget: 100 })).rootIds.slice(0, 2)
    ).toEqual([600, 100]);
    const flat = await section(reader, { replyDepth: 0, budget: 100 });
    expect(ids(flat)).toEqual([600, 100, 200, 500, 700, 800]);
  });

  it.each([ThreadSort.Oldest, ThreadSort.Newest, ThreadSort.MostReactions])(
    'pages through every top-level comment once in %s order',
    async (sort) => {
      const all = (await section(reader, { sort, replyDepth: 0, budget: 100 })).rootIds;
      const paged: number[] = [];
      let cursor: string | undefined;
      do {
        const next = await section(reader, { sort, replyDepth: 0, budget: 2, cursor });
        paged.push(...next.rootIds);
        cursor = next.nextCursor ?? undefined;
      } while (cursor);
      expect(paged).toEqual(all);
    }
  );

  it('refuses a malformed cursor', async () => {
    await expect(section(reader, { cursor: 'nonsense' })).rejects.toThrow('bad cursor');
  });
});

describe('getCommentReplies', () => {
  it('pages one comment’s replies and continues where the section stopped', async () => {
    const page = await section(reader);
    const rest = await getCommentReplies(db, 101, reader, {
      sort: ThreadSort.Oldest,
      cursor: page.children[101].nextCursor!,
    });
    expect(ids(rest)).toEqual([112, 113, 114, 115, 116]);
    expect(item(rest, 116).replyToId).toBe(107);
    expect(rest.children[101].nextCursor).toBeNull();

    const first = await getCommentReplies(db, 101, reader, { sort: ThreadSort.Oldest, limit: 4 });
    expect(ids(first)).toEqual([107, 108, 109, 110]);
    const second = await getCommentReplies(db, 101, reader, {
      sort: ThreadSort.Oldest,
      limit: 4,
      cursor: first.children[101].nextCursor!,
    });
    expect(ids(second)).toEqual([111, 112, 113, 114]);
  });
});

describe('getCommentThread', () => {
  it('focuses a deep comment with the ids above it and its first replies', async () => {
    const thread = await getCommentThread(db, 101, reader, onArticle);
    expect(thread).toMatchObject({ entityType: 'article', entityId: 10, ancestorIds: [100] });
    expect(thread!.comment.id).toBe(101);
    expect(ids(thread!.replies).slice(0, 3)).toEqual([107, 108, 109]);
    expect((await getCommentThread(db, 107, reader, onArticle))!.ancestorIds).toEqual([100, 101]);
  });

  it('finds a reply under a deleted comment, and the placeholder above it', async () => {
    expect((await getCommentThread(db, 501, reader, onArticle))!.ancestorIds).toEqual([500]);
    const deleted = await getCommentThread(db, 500, reader, onArticle);
    expect(deleted!.comment).toMatchObject({ deleted: true, user: null });
    expect(ids(deleted!.replies)).toEqual([501]);
  });

  it('finds nothing removed for ToS, by someone the viewer excludes, or under either', async () => {
    expect(await getCommentThread(db, 400, reader, onArticle)).toBeNull();
    expect(await getCommentThread(db, 401, reader, onArticle)).toBeNull();
    expect(await getCommentThread(db, 300, reader, onArticle)).toBeNull();
    expect(await getCommentThread(db, 550, reader, onArticle)).toBeNull();
    expect(await getCommentThread(db, 401, moderator, onArticle)).not.toBeNull();
    expect(ids(await getCommentReplies(db, 400, reader, { sort: ThreadSort.Oldest }))).toEqual([]);
  });

  it('finds nothing when the comment belongs to another entity than the page asking', async () => {
    expect(await getCommentThread(db, 900, reader, onArticle)).toBeNull();
    expect(
      await getCommentThread(db, 900, reader, {
        sort: ThreadSort.Oldest,
        entity: { entityType: 'article', entityId: 11 },
      })
    ).not.toBeNull();
  });
});

describe('getCommentLock', () => {
  it('is locked by the topic, or by the comment or any ancestor', async () => {
    expect(await getCommentLock(db, ARTICLE, 107)).toEqual({ locked: false });
    await pg.exec(`UPDATE "CommentV3" SET locked = true WHERE id = 101`);
    try {
      expect(await getCommentLock(db, ARTICLE, 107)).toEqual({ locked: true });
      expect(await getCommentLock(db, ARTICLE, 102)).toEqual({ locked: false });
    } finally {
      await pg.exec(`UPDATE "CommentV3" SET locked = false WHERE id = 101`);
    }
    await pg.exec(`UPDATE "CommentTopic" SET locked = true WHERE "entityType" = 'article'`);
    try {
      expect(await getCommentLock(db, ARTICLE)).toEqual({ locked: true });
    } finally {
      await pg.exec(`UPDATE "CommentTopic" SET locked = false WHERE "entityType" = 'article'`);
    }
  });
});
