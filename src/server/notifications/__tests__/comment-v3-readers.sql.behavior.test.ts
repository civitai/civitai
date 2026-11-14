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
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { FIXTURE, migration } from '~/server/services/__tests__/comment-v3-fixture';

// Against real Postgres, with rows inserted into CommentV3 directly.
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
  threadUrlMap,
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
const { countedTopLevelCommentSql } = await import('~/server/services/comment-count.sql');
const { getCommentMuted } = await import('~/server/services/commentv3/section.service');

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
ALTER TABLE "Image" ADD COLUMN "userId" int, ADD COLUMN "postId" int, ADD COLUMN index int;
ALTER TABLE "Post" ADD COLUMN "userId" int, ADD COLUMN "modelVersionId" int, ADD COLUMN title text,
  ADD COLUMN "publishedAt" timestamp DEFAULT '2020-01-01', ADD COLUMN "nsfwLevel" int NOT NULL DEFAULT 1;
CREATE TABLE "PostText"(id int PRIMARY KEY, "postId" int NOT NULL, index int NOT NULL,
  refused boolean NOT NULL DEFAULT false, "csamHeld" boolean NOT NULL DEFAULT false,
  "nsfwLevel" int NOT NULL DEFAULT 1);
ALTER TABLE "Model" ADD COLUMN name text, ADD COLUMN "userId" int, ADD COLUMN description text,
  ADD COLUMN "publishedAt" timestamp, ADD COLUMN "updatedAt" timestamp, ADD COLUMN status text,
  ADD COLUMN poi boolean NOT NULL DEFAULT false;
ALTER TABLE app_listings ADD COLUMN slug text;
CREATE TABLE "ModelVersion"(id int PRIMARY KEY, name text, "modelId" int);
CREATE TABLE "UserEngagement"("userId" int, "targetUserId" int, type text);
CREATE TABLE "UserNotificationSettings"("userId" int, type text);
INSERT INTO "Post"(id, "userId") VALUES (1, 1);
-- Text 50 sits after post 1's image 10 (index 0 = 0, the image sorts first).
INSERT INTO "PostText"(id, "postId", index) VALUES (50, 1, 0);
ALTER TABLE "Article" ADD COLUMN status text NOT NULL DEFAULT 'Published', ADD COLUMN "userId" int,
  -- Read by new-mention's article branch; no article here names anyone.
  ADD COLUMN title text NOT NULL DEFAULT '', ADD COLUMN content text NOT NULL DEFAULT '',
  ADD COLUMN "publishedAt" timestamp, ADD COLUMN "updatedAt" timestamp,
  ADD COLUMN "contentScannedAt" timestamp, ADD COLUMN ingestion text NOT NULL DEFAULT 'Scanned',
  ADD COLUMN "tosViolation" boolean NOT NULL DEFAULT false,
  ADD COLUMN unlisted boolean NOT NULL DEFAULT false,
  ADD COLUMN availability text NOT NULL DEFAULT 'Public', ADD COLUMN "nsfwLevel" int NOT NULL DEFAULT 1;
ALTER TABLE "User" ADD COLUMN "bannedAt" timestamp, ADD COLUMN "deletedAt" timestamp,
  ADD COLUMN muted boolean NOT NULL DEFAULT false, ADD COLUMN "browsingLevel" int NOT NULL DEFAULT 1;
INSERT INTO "Article"(id, "userId") VALUES (10, 1);
UPDATE "Image" SET "userId" = 1, "postId" = 1 WHERE id = 10;
UPDATE "Model" SET name = 'M', "userId" = 1, status = 'Published' WHERE id = 1;
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
// replies 201 (by 8, old id 101 — the same number as image comment 101) and 203 (by 10, old id 57),
// 202 (by 4), a v2 comment on the model thread with no old id, and 204, a deleted one. Comic chapter 77 and app listing 9 have a comment and a reply
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
  (203, 'model', 1, 200, NULL, 10, 'second model reply', 57, NULL, now()),
  (204, 'model', 1, NULL, NULL, 3, '', 58, now(), now()),
  (300, 'comicChapter', 77, NULL, NULL, 2, 'on a chapter', NULL, NULL, now()),
  (302, 'comicChapter', 77, 300, NULL, 3, 'chapter reply', NULL, NULL, now()),
  (301, 'appListing', 9, NULL, NULL, 2, 'on a listing', NULL, NULL, now()),
  (303, 'appListing', 9, 301, NULL, 3, 'listing reply', NULL, NULL, now()),
  (305, 'appListing', 10, NULL, NULL, 2, 'on a listing with no slug', NULL, NULL, now()),
  (306, 'appListing', 10, 305, NULL, 3, 'its reply', NULL, NULL, now());
-- Mutes: user 7 the whole of image 10, user 6 the conversation under 100, user 9 under 102.
INSERT INTO "CommentTopicMute"("userId", "entityType", "entityId") VALUES (7, 'image', 10);
INSERT INTO "CommentMute"("userId", "commentId") VALUES (6, 100), (9, 102);
-- Five reactions each on the model reply 201, the deleted model comment 204, image comment 100 and
-- the v2 comment 202 on the model thread.
INSERT INTO "CommentV3Reaction"("commentId", "userId", reaction)
  SELECT c, u, 'Like' FROM generate_series(1, 5) u, unnest(ARRAY[201, 204, 100, 202]) c;
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
  // Step 1 adds the enum value on its own: a value cannot be used in the transaction that adds it.
  const [addValue, partition] = migration('20270108094000_post_text_comment_type').split('\n-- 2.');
  await db.pg.exec(addValue);
  await db.pg.exec(`-- 2.${partition}`);
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
    expect(byId(103).details.commentParentId).toBe(101);
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
    // comment, the clamped 103 included beside 109. 202, a v2 comment on the model thread, shares no
    // conversation with the v1 comments there.
    expect(pairs(out)).toEqual([
      // The model replies 201 and 203 under 200, by their old ids.
      [57, 8],
      [100, 9],
      [100, 10],
      [101, 8],
      [101, 10],
      [103, 4],
      [104, 3],
      [105, 2],
      [105, 10],
      [107, 2],
      [107, 9],
      [107, 10],
      [109, 5],
    ]);
    const byId = (id: number) => out.find((r) => r.details.commentId === id)!;
    expect(byId(105).details).toMatchObject({ commentParentId: 10, commentParentType: 'image' });
    expect(byId(103).details.commentParentId).toBe(101);
    const modelReply = out.find((r) => r.details.commentId === 101 && r.userId === 10)!;
    expect(modelReply.details).toMatchObject({ modelId: 1, parentId: 55, parentType: 'comment' });
    expect(modelReply.details.threadType).toBeUndefined();
    expect(modelReply.dedupeKey).toBe('comment:v1:101');
  });

  it('the model page processors carry a comment’s old id, and its own where it has none', async () => {
    const comment = await emitted('new-comment');
    // 202 has no old id: a v2 comment on the model thread, as a comment written since the flip is.
    expect(pairs(comment)).toEqual([
      [55, 1],
      [202, 1],
    ]);
    const old = comment.find((c) => c.details.commentId === 55)!;
    expect(old.details.version).toBe(4);
    expect(old.key).toBe('new-comment-model:owner:v3:55');
    expect(old.dedupeKey).toBe('comment:v1:55');

    const response = await emitted('new-comment-response');
    expect(pairs(response)).toEqual([
      [57, 2],
      [101, 2],
    ]);
    expect(response.find((r) => r.details.commentId === 101)!.details).toMatchObject({
      version: 4,
      modelId: 1,
      parentId: 55,
    });

    const nested = await emitted('new-comment-nested');
    expect(pairs(nested)).toEqual([
      [57, 1],
      [101, 1],
    ]);
    expect(nested.every((n) => n.details.version === 4)).toBe(true);
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
    expect(out.find((r) => r.userId === 9)!.dedupeKey).toBe(
      response.find((r) => r.details.commentId === 101)!.dedupeKey
    );
  });

  it('new-mention stays quiet on an unpublished article, so the draft reaches nobody new', async () => {
    const mentioned = async () =>
      pairs(await run(mentionNotifications['new-mention'].prepareQuery)).filter(
        ([commentId]) => commentId === 400
      );
    await temporarily(
      `INSERT INTO "CommentV3"(id, "entityType", "entityId", "userId", content, "createdAt")
         VALUES (400, 'article', 10, 2, 'see "mention:9"', now())`,
      `DELETE FROM "CommentV3" WHERE id = 400`,
      async () => {
        expect(await mentioned()).toEqual([[400, 9]]);
        await temporarily(
          `UPDATE "Article" SET status = 'Draft' WHERE id = 10`,
          `UPDATE "Article" SET status = 'Published' WHERE id = 10`,
          async () => expect(await mentioned()).toEqual([])
        );
      }
    );
  });

  describe('on a storyline text', () => {
    // On text 50 (post 1, owner 1): 501 by 2 at the top; 502 by 3 answers it; 503 by the owner at
    // the top; 504 by 3 answers the owner's 503 and names user 9.
    const ours = (out: Emitted[]) => pairs(out).filter(([id]) => id >= 501 && id <= 504);
    const mentioned = async () => ours(await run(mentionNotifications['new-mention'].prepareQuery));
    const withTextComments = (check: () => Promise<void>) =>
      temporarily(
        `INSERT INTO "CommentTopic"("entityType", "entityId") VALUES ('postText', 50);
         INSERT INTO "CommentV3"(id, "entityType", "entityId", "parentId", "replyToId", "userId", content, "createdAt") VALUES
           (501, 'postText', 50, NULL, NULL, 2, 'a', now()), (502, 'postText', 50, 501, NULL, 3, 'b', now()),
           (503, 'postText', 50, NULL, NULL, 1, 'c', now()), (504, 'postText', 50, 503, NULL, 3, 'see "mention:9"', now())`,
        `DELETE FROM "CommentV3" WHERE id BETWEEN 501 AND 504;
         DELETE FROM "CommentTopic" WHERE "entityType" = 'postText'`,
        check
      );

    it('notifies, linked to the text slide on its anchor image (control)', async () => {
      await withTextComments(async () => {
        const replies = await emitted('new-comment-reply');
        expect(ours(replies)).toEqual([
          [502, 2],
          [504, 1],
        ]);
        expect(ours(await emitted('new-thread-response')).length).toBeGreaterThan(0);
        expect(await mentioned()).toEqual([[504, 9]]);
        const reply = replies.find((r) => r.details.commentId === 502)!;
        expect(threadUrlMap(reply.details)).toMatch(/^\/images\/10\?text=50&highlight=502&/);
        // Linkable, so it claims the comment's key.
        expect(reply.details.threadType).toBe('postText');
      });
    });

    it.each([
      ['refused', `UPDATE "PostText" SET refused = true WHERE id = 50`],
      ['held', `UPDATE "PostText" SET "csamHeld" = true WHERE id = 50`],
    ])('reach nobody once the text is %s, its owner included', async (_, change) => {
      await withTextComments(() =>
        temporarily(
          change,
          `UPDATE "PostText" SET refused = false, "csamHeld" = false WHERE id = 50`,
          async () => {
            expect(ours(await emitted('new-comment-reply'))).toEqual([]);
            expect(ours(await emitted('new-thread-response'))).toEqual([]);
            expect(await mentioned()).toEqual([]);
          }
        )
      );
    });

    it.each([
      [
        'unscanned',
        `UPDATE "PostText" SET "nsfwLevel" = 0 WHERE id = 50`,
        `UPDATE "PostText" SET "nsfwLevel" = 1 WHERE id = 50`,
      ],
      [
        'on an unpublished post',
        `UPDATE "Post" SET "publishedAt" = NULL WHERE id = 1`,
        `UPDATE "Post" SET "publishedAt" = '2020-01-01' WHERE id = 1`,
      ],
    ])('reach only the owner while the text is %s', async (_, change, undo) => {
      await withTextComments(() =>
        temporarily(change, undo, async () => {
          expect(ours(await emitted('new-comment-reply'))).toEqual([[504, 1]]);
          expect(ours(await emitted('new-thread-response'))).toEqual([]);
          expect(await mentioned()).toEqual([]);
        })
      );
    });

    it('is not linked, and claims no key, in a post with no image', async () => {
      await withTextComments(() =>
        temporarily(
          `UPDATE "Image" SET "postId" = NULL WHERE id = 10`,
          `UPDATE "Image" SET "postId" = 1 WHERE id = 10`,
          async () => {
            const reply = (await emitted('new-comment-reply')).find(
              (r) => r.details.commentId === 502
            );
            expect(reply?.details.threadType).toBe('comment');
          }
        )
      );
    });
  });

  it('replies on an unpublished article reach only its owner', async () => {
    // On article 10 (owner 1): 401 by 2 at the top; 402 by 3 answers 106 (by 10); 403 by the owner
    // answers 401; 404 by 3 answers the owner's 403, clamped under 401.
    const ours = (out: Emitted[]) => pairs(out).filter(([commentId]) => commentId >= 401);
    await temporarily(
      `INSERT INTO "CommentV3"(id, "entityType", "entityId", "parentId", "replyToId", "userId", content, "createdAt") VALUES
         (401, 'article', 10, NULL, NULL, 2, 'a', now()), (402, 'article', 10, 106, NULL, 3, 'b', now()),
         (403, 'article', 10, 401, NULL, 1, 'c', now()), (404, 'article', 10, 401, 403, 3, 'd', now())`,
      `DELETE FROM "CommentV3" WHERE id BETWEEN 401 AND 404`,
      async () => {
        expect(ours(await emitted('new-comment-reply'))).toEqual([
          [402, 10],
          [403, 2],
          [404, 1],
        ]);
        expect(ours(await emitted('new-thread-response')).length).toBeGreaterThan(0);
        await temporarily(
          `UPDATE "Article" SET status = 'Unpublished' WHERE id = 10`,
          `UPDATE "Article" SET status = 'Published' WHERE id = 10`,
          async () => {
            expect(ours(await emitted('new-comment-reply'))).toEqual([[404, 1]]);
            expect(ours(await emitted('new-thread-response'))).toEqual([]);
          }
        );
      }
    );
  });

  it.each([
    ['unpublished', `UPDATE "Model" SET status = 'Unpublished' WHERE id = 1`],
    ['POI', `UPDATE "Model" SET poi = true WHERE id = 1`],
  ])('replies on a model that is %s reach only its owner', async (_, change) => {
    const undo = `UPDATE "Model" SET status = 'Published', poi = false WHERE id = 1`;
    await temporarily(change, undo, async () => {
      expect(await emitted('new-comment-response')).toEqual([]);
      // 201, the model reply naming user 9, goes quiet; the image reply naming 10 does not.
      expect(pairs(await run(mentionNotifications['new-mention'].prepareQuery))).toEqual([
        [104, 10],
      ]);
      expect((await emitted('new-thread-response')).filter((t) => t.details.modelId === 1)).toEqual(
        []
      );
      expect(pairs(await emitted('new-comment-nested'))).toEqual([
        [57, 1],
        [101, 1],
      ]);
    });
  });

  it('the comment reaction milestone keys on the old ids, for live model comments only', async () => {
    const out = await run(reactionNotifications['comment-reaction-milestone'].prepareQuery);
    expect(out.map((r) => [r.userId, r.details])).toEqual([
      [8, { modelName: 'M', modelId: 1, rootCommentId: 55, commentId: 101, reactionCount: 5 }],
      [4, { modelName: 'M', modelId: 1, rootCommentId: 202, commentId: 202, reactionCount: 5 }],
    ]);
  });

  it('the model page processors honour the owner’s section mute and a thread mute', async () => {
    await temporarily(
      `INSERT INTO "CommentTopicMute"("userId", "entityType", "entityId") VALUES (1, 'model', 1)`,
      `DELETE FROM "CommentTopicMute" WHERE "userId" = 1 AND "entityType" = 'model'`,
      async () => {
        expect(await emitted('new-comment')).toEqual([]);
        expect(await emitted('new-comment-nested')).toEqual([]);
        // Replies still reach the author of the comment answered.
        expect(pairs(await emitted('new-comment-response'))).toHaveLength(2);
      }
    );
    // User 2 mutes their model comment 200: replies under it stop reaching them.
    await temporarily(
      `INSERT INTO "CommentMute"("userId", "commentId") VALUES (2, 200)`,
      `DELETE FROM "CommentMute" WHERE "userId" = 2`,
      async () => {
        expect(await emitted('new-comment-response')).toEqual([]);
      }
    );
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
  it('opens a clamped reply under its parent, where the v3 section lists it', async () => {
    await temporarily(
      `INSERT INTO "CommentV3"(id, "entityType", "entityId", "parentId", "replyToId", "userId", content) VALUES
         (1061, 'article', 10, 106, NULL, 2, 'article reply'),
         (1062, 'article', 10, 106, 1061, 3, 'clamped article reply'),
         (3021, 'comicChapter', 77, 300, 302, 4, 'clamped chapter reply')`,
      `DELETE FROM "CommentV3" WHERE id IN (3021, 1062, 1061)`,
      async () => {
        const out = await emitted('new-comment-reply');
        const reply = out.find((r) => r.details.commentId === 1062)!;
        // The v3 article section shows 106's replies, which is where 1062 sits.
        expect(reply.details).toMatchObject({ commentParentId: 106, commentParentType: 'comment' });
        // Not under 302, the comment it answers: the chapter's section also lists 300's replies.
        expect(out.find((r) => r.details.commentId === 3021)!.details.commentParentId).toBe(300);
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

  const ctx = {
    db: {
      user: {
        findMany: async ({ where }: { where: { id: { in: number[] } } }) =>
          where.id.in.map((id) => ({ id, username: `u${id}` })),
      },
    },
  } as never;
  const preview = async (notifications: { type: string; details: Record<string, unknown> }[]) => {
    await commentDetailFetcher.fetcher(notifications as never, ctx);
    return notifications.map((n) => [n.details.content, (n.details.actor as any)?.id]);
  };

  it('previews what each processor emits, whichever shape it is', async () => {
    const take = async (type: keyof typeof commentNotifications, commentId: number) => ({
      type,
      details: (await emitted(type)).find((r) => r.details.commentId === commentId)!.details,
    });
    // new-image-comment carries a modelId too (null here), and image comment 101 shares its number
    // with model reply 201's old id: neither may send the lookup down the model page's path. The
    // thread-response and mention types emit both shapes, so each is fed one of either.
    const threadResponses = await emitted('new-thread-response');
    const mentions = await run(mentionNotifications['new-mention'].prepareQuery);
    const notifications = [
      await take('new-image-comment', 100),
      await take('new-comment-reply', 101),
      await take('new-comment', 55),
      await take('new-comment-response', 101),
      ...[8, 10].map((userId) => ({
        type: 'new-thread-response',
        details: threadResponses.find((r) => r.details.commentId === 101 && r.userId === userId)!
          .details,
      })),
      ...[101, 104].map((commentId) => ({
        type: 'new-mention',
        details: mentions.find((r) => r.details.commentId === commentId)!.details,
      })),
    ];
    expect(await preview(notifications)).toEqual([
      ['top', 2],
      ['reply "mention:6"', 3],
      ['model top', 2],
      ['model reply "mention:9"', 8],
      ['reply "mention:6"', 3],
      ['model reply "mention:9"', 8],
      ['model reply "mention:9"', 8],
      ['second reply "mention:10"', 8],
    ]);
  });

  it('resolves historical rows of each version, and serves nothing of a removed comment', async () => {
    expect(
      await preview([
        // Versionless rows carry old v1 ids: 101 is model reply 201's, not image comment 101.
        { type: 'new-comment', details: { commentId: 55 } },
        { type: 'new-comment', details: { commentId: 101 } },
        // No comment has old id 100 or 202: neither image comment 100 nor the v2 model comment 202
        // may stand in, as a removed v1 comment's notification would otherwise show them.
        { type: 'new-comment', details: { commentId: 100 } },
        { type: 'new-comment', details: { commentId: 202 } },
        // A v2 image comment notification, with the modelId new-image-comment always stamped.
        { type: 'new-image-comment', details: { version: 2, commentId: 101, modelId: 1 } },
        { type: 'new-thread-response', details: { version: 3, commentId: 400 } },
        { type: 'new-thread-response', details: { version: 3, commentId: 401 } },
        { type: 'new-thread-response', details: { version: 3, commentId: 402 } },
        // A model comment with no old id is addressed by its own; image
        // comment 100 still may not stand in.
        { type: 'new-comment', details: { version: 4, commentId: 202 } },
        { type: 'new-comment', details: { version: 4, commentId: 100 } },
      ])
    ).toEqual([
      ['model top', 2],
      ['model reply "mention:9"', 8],
      [undefined, undefined],
      [undefined, undefined],
      ['reply "mention:6"', 3],
      [undefined, undefined],
      [undefined, undefined],
      [undefined, undefined],
      ['v2 on the model thread', 4],
      [undefined, undefined],
    ]);
  });
});

describe('the mute menu', () => {
  // getCommentMuted's raw queries, run here as Prisma would send them.
  const menu = (commentId: number, userId: number) => {
    dbMock.dbWrite.$queryRawUnsafe.mockImplementation(((sql: string, ...values: unknown[]) =>
      db.pg.query(sql, values).then((r) => r.rows)) as never);
    dbMock.dbWrite.$queryRaw.mockImplementation(((
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      const q = Prisma.sql(strings, ...values);
      return db.pg.query(q.text, q.values).then((r) => r.rows);
    }) as never);
    return getCommentMuted({ commentId, userId });
  };

  it("reports the user's own mute, one inherited from an ancestor, and none", async () => {
    expect(await menu(100, 6)).toEqual({ muted: true, viaAncestor: false, canMute: true });
    expect(await menu(102, 6)).toEqual({ muted: true, viaAncestor: true, canMute: true });
    expect(await menu(100, 9)).toEqual({ muted: false, viaAncestor: false, canMute: true });
  });
});

describe('the permalink row', () => {
  it('addresses a comic chapter by its project and position, and an app listing by its slug', async () => {
    // Chapter 77 sits at position 2 of project 5: the reader's third chapter.
    expect(buildCommentPermalink(await getCommentPermalinkRow(300))).toBe(
      '/comics/5/comic/3?highlight=300&commentParentType=comment&commentParentId=300'
    );
    expect(buildCommentPermalink(await getCommentPermalinkRow(301))).toBe(
      '/apps/store-preview/pixel-forge?highlight=301&commentParentType=comment&commentParentId=301'
    );
  });

  it('addresses a storyline text by the image before it, else the first after', async () => {
    // Post 1: image 10 (index 0), then text 50 (index 0), then image 911 (index 5); text 51 (index -1)
    // comes before every image.
    await temporarily(
      `INSERT INTO "Image"(id, "userId", "postId", index) VALUES (911, 1, 1, 5);
       INSERT INTO "PostText"(id, "postId", index) VALUES (51, 1, -1);
       INSERT INTO "CommentTopic"("entityType", "entityId") VALUES ('postText', 50), ('postText', 51);
       INSERT INTO "CommentV3"(id, "entityType", "entityId", "userId", content, "createdAt") VALUES
         (510, 'postText', 50, 2, 'a', now()), (511, 'postText', 51, 2, 'b', now())`,
      `DELETE FROM "CommentV3" WHERE id IN (510, 511);
       DELETE FROM "CommentTopic" WHERE "entityType" = 'postText';
       DELETE FROM "PostText" WHERE id = 51; DELETE FROM "Image" WHERE id = 911`,
      async () => {
        expect(buildCommentPermalink(await getCommentPermalinkRow(510))).toBe(
          '/images/10?text=50&highlight=510&commentParentType=comment&commentParentId=510'
        );
        expect(buildCommentPermalink(await getCommentPermalinkRow(511))).toBe(
          '/images/10?text=51&highlight=511&commentParentType=comment&commentParentId=511'
        );
        await temporarily(
          `UPDATE "Image" SET index = -2 WHERE id = 911`,
          `UPDATE "Image" SET index = 5 WHERE id = 911`,
          // Both images now sort before text 50; the later one (10, index 0) is its anchor still,
          // and text 51 (index -1) now follows image 911.
          async () => {
            expect(buildCommentPermalink(await getCommentPermalinkRow(510))).toMatch(
              /^\/images\/10\?/
            );
            expect(buildCommentPermalink(await getCommentPermalinkRow(511))).toMatch(
              /^\/images\/911\?/
            );
          }
        );
      }
    );
  });

  it('finds no row for a comment hidden for ToS, but for a moderator', async () => {
    // 400 is hidden for ToS, 401 only by the sweep (the detail fetcher's rows).
    expect(await getCommentPermalinkRow(400)).toBeUndefined();
    expect(await getCommentPermalinkRow(400, { includeHidden: true })).toMatchObject({ id: 400 });
    expect(await getCommentPermalinkRow(401)).toMatchObject({ id: 401 });
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
    // User 5's on article 10 was removed for ToS (400, in the detail fetcher's rows); user 7 still
    // has one there that is only hidden by the sweep.
    expect(await liveCommentsOn(5, { entityType: 'Article', entityId: 10 })).toBe(0);
    expect(await liveCommentsOn(7, { entityType: 'Article', entityId: 10 })).toBe(1);
  });
});

describe('the challenge comment count', () => {
  it('counts live top-level comments only: not replies, deleted ones, or ones hidden for ToS', async () => {
    await db.pg.exec(`
      INSERT INTO "Challenge" (id) VALUES (60);
      INSERT INTO "CommentTopic"("entityType", "entityId") VALUES ('challenge', 60);
      INSERT INTO "CommentV3"(id, "entityType", "entityId", "userId", content, "tosViolation", "deletedAt") VALUES
        (600, 'challenge', 60, 4, 'live', false, NULL),
        (601, 'challenge', 60, 5, 'hidden for ToS', true, NULL),
        (602, 'challenge', 60, 6, '', false, now());
      INSERT INTO "CommentV3"(id, "entityType", "entityId", "userId", content, "parentId") VALUES
        (603, 'challenge', 60, 7, 'a reply', 600);
    `);
    const where = countedTopLevelCommentSql(Prisma.raw('v'), 'challenge');
    const { rows } = await db.pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "CommentV3" v WHERE ${where.text} AND v."entityId" = 60`,
      where.values as unknown[]
    );
    expect(rows[0].n).toBe(1);
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

describe('a comment hidden for ToS', () => {
  beforeAll(async () => {
    await db.pg.exec(`
      INSERT INTO "ResourceReview" (id) VALUES (70);
      INSERT INTO "CommentTopic"("entityType", "entityId") VALUES ('review', 70);
      INSERT INTO "CommentV3"(id, "entityType", "entityId", "userId", content, "tosViolation") VALUES
        (610, 'image', 10, 8, 'hidden for ToS', true),
        (611, 'image', 10, 9, 'live', false),
        (612, 'review', 70, 8, 'hidden for ToS', true),
        (613, 'review', 70, 9, 'live', false);
    `);
  });

  it('notifies no one of it, as a deleted one notifies no one', async () => {
    const ids = pairs(await emitted('new-image-comment')).map(([id]) => id);
    expect(ids).toContain(611);
    expect(ids).not.toContain(610);
  });

  it('does not tell its author about later comments in the thread they were in', async () => {
    const replies = pairs(await emitted('new-thread-response')).filter(([id]) => id === 611);
    expect(replies.map(([, to]) => to)).not.toContain(8);
  });

  it('leaves the review comment count, as a deleted one does', async () => {
    const where = countedTopLevelCommentSql(Prisma.raw('v'), 'review');
    const { rows } = await db.pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "CommentV3" v WHERE ${where.text} AND v."entityId" = 70`,
      where.values as unknown[]
    );
    expect(rows[0].n).toBe(1);
  });
});
