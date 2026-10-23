import { PGlite } from '@electric-sql/pglite';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Dialect,
} from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FIXTURE, migration } from '~/server/services/__tests__/comment-v3-fixture';

// Against real Postgres, with rows inserted into CommentV3 directly, as a surface writes them after
// its flip.
vi.setConfig({ hookTimeout: 120_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ kysely: null as unknown }));
vi.mock('~/server/db/kyselyDb', () => ({
  get kyselyRead() {
    return holder.kysely;
  },
  get kyselyWrite() {
    return holder.kysely;
  },
}));

const { notCommentMuted } = await import('~/server/notifications/base.notifications');
const {
  commentNotifications,
  commentDedupeKey,
  commentDedupeKeyByShape,
  commentDedupeKeyIfAddressable,
} = await import('~/server/notifications/comment.notifications');
const { mentionNotifications } = await import('~/server/notifications/mention.notifications');
const { reactionNotifications } = await import('~/server/notifications/reaction.notifications');
const { commentDetailFetcher } = await import(
  '~/server/notifications/detail-fetchers/comment.detail-fetcher'
);
const { buildCommentPermalink, getCommentPermalinkRow } = await import(
  '~/server/utils/comment-permalink'
);
const { commentCountArgs, allCommentCountArgs, commentV3Counts } = await import(
  '~/server/services/bot-account-detection/cohort'
);
const { liveCommentsOn } = await import('~/server/events/points/hooks');

const db = { pg: null as unknown as PGlite };

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

const SETUP = `
ALTER TABLE "User" ADD COLUMN username text;
UPDATE "User" SET username = 'u' || id;
ALTER TABLE "Image" ADD COLUMN "userId" int, ADD COLUMN "postId" int;
ALTER TABLE "Post" ADD COLUMN "userId" int, ADD COLUMN "modelVersionId" int, ADD COLUMN title text;
ALTER TABLE "Model" ADD COLUMN name text, ADD COLUMN "userId" int, ADD COLUMN description text,
  ADD COLUMN "publishedAt" timestamp, ADD COLUMN "updatedAt" timestamp, ADD COLUMN status text;
ALTER TABLE app_listings ADD COLUMN slug text;
CREATE TABLE "ModelVersion"(id int PRIMARY KEY, name text, "modelId" int);
CREATE TABLE "UserEngagement"("userId" int, "targetUserId" int, type text);
CREATE TABLE "UserNotificationSettings"("userId" int, type text);
INSERT INTO "Post"(id, "userId") VALUES (1, 1);
INSERT INTO "Article" VALUES (10);
UPDATE "Image" SET "userId" = 1, "postId" = 1 WHERE id = 10;
UPDATE "Model" SET name = 'M', "userId" = 1 WHERE id = 1;
UPDATE app_listings SET slug = 'pixel-forge' WHERE serial_id = 9;
INSERT INTO app_listings(id, serial_id, slug) VALUES ('02ULID', 10, NULL);
-- User 6 has blocked user 3.
INSERT INTO "UserEngagement" VALUES (6, 3, 'Block');
`;
// Image 10 (owner 1): 100 by 2 at the top; 101 (by 3) answers it, 102 (by 4) answers 101, and 103
// (by 5) sits under 101 but answers 102 through replyToId, as the depth clamp writes it. 104 (by 8)
// answers 100; 109 (by 4) answers their own 102. 105 (by 9) and 107 (by 7) are more top-level
// comments, 108 (by 6) a deleted one, 110 (by 10) one written before the cursor.
// Article 10 shares the image's id: 106 (by 10). Model 1 (owner 1): 200 (by 2, old id 55), its
// reply 201 (by 8, old id 101 — the same number as image comment 101), and 202 (by 4), a v2 comment
// on the model thread with no old id. Comic chapter 77 and app listing 9 have a comment and a reply
// each; app listing 10 has no slug.
const COMMENTS = `
INSERT INTO "CommentTopic"("entityType", "entityId") VALUES ('image', 10), ('article', 10), ('model', 1),
  ('comicChapter', 77), ('appListing', 9), ('appListing', 10);
INSERT INTO "CommentV3"(id, "entityType", "entityId", "parentId", "replyToId", "userId", content, "legacyV1Id", "deletedAt", "createdAt") VALUES
  (100, 'image', 10, NULL, NULL, 2, 'top', NULL, NULL, now()),
  (101, 'image', 10, 100, NULL, 3, 'reply "mention:6"', NULL, NULL, now()),
  (102, 'image', 10, 101, NULL, 4, 'reply reply', NULL, NULL, now()),
  (103, 'image', 10, 101, 102, 5, 'clamped answer to 102', NULL, NULL, now()),
  (104, 'image', 10, 100, NULL, 8, 'second reply "mention:10"', NULL, NULL, now()),
  (105, 'image', 10, NULL, NULL, 9, 'second top', NULL, NULL, now()),
  (106, 'article', 10, NULL, NULL, 10, 'on the article', NULL, NULL, now()),
  (107, 'image', 10, NULL, NULL, 7, 'third top', NULL, NULL, now()),
  (108, 'image', 10, NULL, NULL, 6, '', NULL, now(), now()),
  (109, 'image', 10, 102, NULL, 4, 'answering myself', NULL, NULL, now()),
  (110, 'image', 10, NULL, NULL, 10, 'before the cursor', NULL, NULL, '1999-01-01'),
  (200, 'model', 1, NULL, NULL, 2, 'model top', 55, NULL, now()),
  (201, 'model', 1, 200, NULL, 8, 'model reply "mention:9"', 101, NULL, now()),
  (202, 'model', 1, NULL, NULL, 4, 'v2 on the model thread', NULL, NULL, now()),
  (300, 'comicChapter', 77, NULL, NULL, 2, 'on a chapter', NULL, NULL, now()),
  (302, 'comicChapter', 77, 300, NULL, 3, 'chapter reply', NULL, NULL, now()),
  (301, 'appListing', 9, NULL, NULL, 2, 'on a listing', NULL, NULL, now()),
  (303, 'appListing', 9, 301, NULL, 3, 'listing reply', NULL, NULL, now()),
  (305, 'appListing', 10, NULL, NULL, 2, 'on a listing with no slug', NULL, NULL, now()),
  (306, 'appListing', 10, 305, NULL, 3, 'its reply', NULL, NULL, now());
-- Mutes: user 7 the whole of image 10, user 6 the conversation under 100, user 9 under 102.
INSERT INTO "CommentTopicMute"("userId", "entityType", "entityId") VALUES (7, 'image', 10);
INSERT INTO "CommentMute"("userId", "commentId") VALUES (6, 100), (9, 102);
-- Five reactions on the model reply 201.
INSERT INTO "CommentV3Reaction"("commentId", "userId", reaction)
  SELECT 201, u, 'Like' FROM generate_series(1, 5) u;
`;

const rows = async <T = Record<string, unknown>>(sql: string) => (await db.pg.query<T>(sql)).rows;
const LAST_SENT = '2000-01-01T00:00:00.000Z';
type Emitted = { userId: number; key: string; dedupeKey: string | null; details: any };
type Query = (a: { lastSent: string }) => string;
const run = (query: unknown) => rows<Emitted>((query as Query)({ lastSent: LAST_SENT }));
const emitted = (type: keyof typeof commentNotifications) =>
  run(commentNotifications[type].prepareQuery);
const pairs = (out: Emitted[]) =>
  out
    .map((r) => [r.details.commentId as number, r.userId])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
const muted = async (recipient: number, commentId: number) =>
  (
    await rows<{ muted: boolean }>(
      `SELECT NOT ${notCommentMuted(
        String(recipient),
        'c'
      )} AS muted FROM "CommentV3" c WHERE c.id = ${commentId}`
    )
  )[0].muted;
/** Runs `change`, then `undo` however the assertions went, so one failure cannot leak into the rest. */
const temporarily = async (change: string, undo: string, check: () => Promise<void>) => {
  await db.pg.exec(change);
  try {
    await check();
  } finally {
    await db.pg.exec(undo);
  }
};

beforeAll(async () => {
  db.pg = new PGlite({ extensions: { ltree } });
  await db.pg.exec(FIXTURE);
  await db.pg.exec(SETUP);
  await db.pg.exec(migration('20261110120000_comment_v3_schema'));
  await db.pg.exec(migration('20261120120000_comment_v3_mirror'));
  await db.pg.exec(COMMENTS);
  holder.kysely = new Kysely({ dialect: dialect(db.pg) });
});

afterAll(async () => {
  await db.pg.close();
});

describe('notCommentMuted', () => {
  it('a section mute suppresses every comment on that entity, and only that entity', async () => {
    expect(await muted(7, 100)).toBe(true);
    expect(await muted(7, 102)).toBe(true);
    // Article 10 shares the image's id.
    expect(await muted(7, 106)).toBe(false);
  });

  it('a mute on a comment suppresses the conversation under it, at any depth', async () => {
    expect(await muted(6, 101)).toBe(true);
    expect(await muted(6, 102)).toBe(true);
    expect(await muted(6, 103)).toBe(true);
  });

  it('does not suppress a notification about the muted comment itself', async () => {
    expect(await muted(6, 100)).toBe(false);
  });

  it('a clamped reply is suppressed by a mute on the comment it answers, off its path', async () => {
    // 103's path runs through 101, not 102; only replyToId links it to the muted comment.
    expect(await muted(9, 103)).toBe(true);
    expect(await muted(9, 101)).toBe(false);
  });

  it("another user's mute suppresses nothing", async () => {
    expect(await muted(8, 100)).toBe(false);
    expect(await muted(8, 102)).toBe(false);
    expect(await muted(8, 103)).toBe(false);
  });
});

describe('notification queries on CommentV3', () => {
  it('new-comment-reply tells the author of the comment answered, with a link into the conversation', async () => {
    const out = await emitted('new-comment-reply');
    // 103 answers 102 (by 4), not its parent 101 (by 3). Not: the self-answer 109, the model reply
    // 201 (the model page's own processors), and 306 on a listing with no slug.
    expect(pairs(out)).toEqual([
      [101, 2],
      [102, 3],
      [103, 4],
      [104, 2],
      [302, 2],
      [303, 2],
    ]);
    const byId = (id: number) => out.find((r) => r.details.commentId === id)!;
    expect(byId(101).key).toBe('new-comment-reply:owner:v3:101');
    expect(byId(101).dedupeKey).toBe('comment:v2:101');
    expect(byId(101).details).toMatchObject({
      version: 3,
      threadType: 'image',
      threadParentId: 10,
      commentParentId: 100,
      commentParentType: 'comment',
    });
    expect(byId(103).details.commentParentId).toBe(102);
    expect(byId(302).details).toMatchObject({ threadType: 'comicProject', threadParentId: 5 });
    expect(byId(303).details).toMatchObject({
      threadType: 'appListing',
      appListingSlug: 'pixel-forge',
    });
  });

  it('new-image-comment tells the image owner about live top-level comments since the cursor', async () => {
    expect(pairs(await emitted('new-image-comment'))).toEqual([
      [100, 1],
      [105, 1],
      [107, 1],
    ]);
  });

  it('new-thread-response reaches the others in the same conversation', async () => {
    const out = await emitted('new-thread-response');
    // Top level on image 10: 100 (by 2), 105 (by 9), 107 (by 7) and the older 110 (by 10), with
    // user 7's section mute and the deleted 108 left out. Replies: everyone answering the same
    // comment, the clamped 103 included beside 109. 202 is a v2 comment on the model thread.
    expect(pairs(out)).toEqual([
      [100, 9],
      [100, 10],
      [101, 8],
      [103, 4],
      [104, 3],
      [105, 2],
      [105, 10],
      [107, 2],
      [107, 9],
      [107, 10],
      [109, 5],
      [202, 2],
    ]);
    const byId = (id: number) => out.find((r) => r.details.commentId === id)!;
    expect(byId(105).details).toMatchObject({ commentParentId: 10, commentParentType: 'image' });
    expect(byId(103).details.commentParentId).toBe(102);
    expect(byId(202).details).toMatchObject({ threadType: 'model', threadParentId: 1 });
  });

  it('the model page processors carry the old ids, and only for comments with one', async () => {
    const comment = await emitted('new-comment');
    expect(pairs(comment)).toEqual([[55, 1]]);
    expect(comment[0].key).toBe('new-comment-model:owner:v3:55');
    expect(comment[0].dedupeKey).toBe('comment:v1:55');

    const response = await emitted('new-comment-response');
    expect(pairs(response)).toEqual([[101, 2]]);
    expect(response[0].details).toMatchObject({ modelId: 1, parentId: 55 });

    expect(pairs(await emitted('new-comment-nested'))).toEqual([[101, 1]]);
  });

  it('new-mention notifies the named, keyed as the comment it is in, and honours a block', async () => {
    const out = await run(mentionNotifications['new-mention'].prepareQuery);
    // 101 names user 6, who blocked its author 3.
    expect(pairs(out)).toEqual([
      [101, 9],
      [104, 10],
    ]);
    const replies = await emitted('new-comment-reply');
    const response = await emitted('new-comment-response');
    // The same comment claims the same key, whichever processor reaches the user first.
    expect(out.find((r) => r.userId === 10)!.dedupeKey).toBe(
      replies.find((r) => r.details.commentId === 104)!.dedupeKey
    );
    expect(out.find((r) => r.userId === 9)!.dedupeKey).toBe(response[0].dedupeKey);
  });

  it('the comment reaction milestone keys on the old ids', async () => {
    const out = await run(reactionNotifications['comment-reaction-milestone'].prepareQuery);
    expect(out.map((r) => [r.userId, r.details])).toEqual([
      [8, { modelName: 'M', modelId: 1, rootCommentId: 55, commentId: 101, reactionCount: 5 }],
    ]);
  });

  it('a mute by the recipient drops only their notification', async () => {
    // User 3 mutes their own comment 101: replies under it stop reaching them, nothing else moves.
    await temporarily(
      `INSERT INTO "CommentMute"("userId", "commentId") VALUES (3, 101)`,
      `DELETE FROM "CommentMute" WHERE "userId" = 3`,
      async () => {
        const replies = await emitted('new-comment-reply');
        expect(replies.find((r) => r.details.commentId === 102)).toBeUndefined();
        expect(replies.find((r) => r.details.commentId === 103)?.userId).toBe(4);
      }
    );
  });

  it('a deleted comment notifies nobody, and its author hears nothing about replies to it', async () => {
    await temporarily(
      `UPDATE "CommentV3" SET "deletedAt" = now() WHERE id IN (100, 105)`,
      `UPDATE "CommentV3" SET "deletedAt" = NULL WHERE id IN (100, 105)`,
      async () => {
        const replies = await emitted('new-comment-reply');
        expect(replies.filter((r) => [101, 104].includes(r.details.commentId))).toEqual([]);
        expect(pairs(await emitted('new-image-comment'))).toEqual([[107, 1]]);
      }
    );
  });
});

describe('dedupe keys', () => {
  const key = async (expr: string, details: Record<string, unknown>) =>
    (
      await rows<{ k: string | null }>(
        `SELECT ${expr} AS k FROM (SELECT '${JSON.stringify(details)}'::jsonb AS details) x`
      )
    )[0].k;

  it('a thread-addressed comment keys the same in the shape-picking and the owner processors', async () => {
    const details = { version: 3, threadType: 'appListing', commentId: 9 };
    expect(await key(commentDedupeKeyByShape, details)).toBe(
      await key(commentDedupeKey('v2'), details)
    );
    expect(await key(commentDedupeKeyIfAddressable, details)).toBe('comment:v2:9');
  });

  it('an unaddressable thread claims no key', async () => {
    expect(
      await key(commentDedupeKeyIfAddressable, { threadType: 'comment', commentId: 9 })
    ).toBeNull();
  });
});

describe('the detail fetcher', () => {
  beforeAll(async () => {
    await db.pg.exec(`
      INSERT INTO "CommentV3"(id, "entityType", "entityId", "userId", content, "tosViolation", hidden, "deletedAt") VALUES
        (400, 'article', 10, 5, 'removed for ToS', true, false, NULL),
        (401, 'article', 10, 7, 'hidden by the sweep', false, true, NULL),
        (402, 'article', 10, 7, '', false, false, now());
    `);
  });

  it('resolves every version from CommentV3 and serves nothing of a removed comment', async () => {
    const ctx = {
      db: {
        user: {
          findMany: async ({ where }: { where: { id: { in: number[] } } }) =>
            where.id.in.map((id) => ({ id, username: `u${id}` })),
        },
      },
    } as never;
    const notifications = [
      // Versionless rows carry old v1 ids: 101 is model reply 201's, not image comment 101.
      { id: 1, type: 'new-comment', details: { commentId: 55 } },
      { id: 2, type: 'new-comment', details: { commentId: 101 } },
      { id: 3, type: 'new-image-comment', details: { version: 2, commentId: 101 } },
      // A model-page notification since Phase 3 carries a version and the old id.
      { id: 4, type: 'new-comment-response', details: { version: 3, modelId: 1, commentId: 101 } },
      { id: 5, type: 'new-thread-response', details: { version: 3, commentId: 400 } },
      { id: 6, type: 'new-thread-response', details: { version: 3, commentId: 401 } },
      { id: 7, type: 'new-thread-response', details: { version: 3, commentId: 402 } },
    ] as never as { details: Record<string, unknown> }[];
    await commentDetailFetcher.fetcher(notifications as never, ctx);
    expect(notifications.map((n) => [n.details.content, (n.details.actor as any)?.id])).toEqual([
      ['model top', 2],
      ['model reply "mention:9"', 8],
      ['reply "mention:6"', 3],
      ['model reply "mention:9"', 8],
      [undefined, undefined],
      [undefined, undefined],
      [undefined, undefined],
    ]);
  });
});

describe('the permalink row', () => {
  it('addresses a comic chapter by its project and an app listing by its slug', async () => {
    expect(buildCommentPermalink(await getCommentPermalinkRow(300))).toBe(
      '/comics/5?highlight=300&commentParentType=comment&commentParentId=300'
    );
    expect(buildCommentPermalink(await getCommentPermalinkRow(301))).toBe(
      '/apps/store-preview/pixel-forge?highlight=301&commentParentType=comment&commentParentId=301'
    );
  });

  it('finds no row for a deleted comment, and no link for a listing with no slug', async () => {
    expect(await getCommentPermalinkRow(108)).toBeUndefined();
    expect(buildCommentPermalink(await getCommentPermalinkRow(305))).toBeNull();
  });
});

describe('the points hook', () => {
  it("counts the actor's live comments on the entity at any depth, and nothing else", async () => {
    // User 4: 102 and 109 under image 10 (202 is on the model).
    expect(await liveCommentsOn(4, { entityType: 'Image', entityId: 10 })).toBe(2);
    // Same id, other entity type.
    expect(await liveCommentsOn(10, { entityType: 'Article', entityId: 10 })).toBe(1);
    expect(await liveCommentsOn(10, { entityType: 'Image', entityId: 10 })).toBe(1);
    // User 6's only comment is deleted.
    expect(await liveCommentsOn(6, { entityType: 'Image', entityId: 10 })).toBe(0);
  });
});

describe('the bot cohort comment counts', () => {
  beforeAll(async () => {
    await db.pg.exec(`
      INSERT INTO "CommentV3"(id, "entityType", "entityId", "userId", content, "tosViolation", hidden) VALUES
        (500, 'article', 10, 9, 'removed for ToS', true, false),
        (501, 'article', 10, 9, 'hidden', false, true);
    `);
  });

  it('counts what is on the page and what the account has, never a deletion', async () => {
    // User 9: the live 105, and the ToS-removed and hidden 500 and 501.
    expect(await commentV3Counts.groupBy(commentCountArgs([9]))).toEqual([
      { userId: 9, _count: { _all: 1 } },
    ]);
    expect(await commentV3Counts.groupBy(allCommentCountArgs([9]))).toEqual([
      { userId: 9, _count: { _all: 3 } },
    ]);
    // User 6's only comment is deleted: no row at all.
    expect(await commentV3Counts.groupBy(allCommentCountArgs([6]))).toEqual([]);
  });
});
