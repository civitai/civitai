import { PGlite } from '@electric-sql/pglite';
import { heldCopiesSchemaSql } from '~/server/services/__tests__/held-copies.fixture';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as CommentsV2Service from '~/server/services/commentsv2.service';
import type * as ReactionService from '~/server/services/reaction.service';
import type * as ReportService from '~/server/services/report.service';
import type * as BlockCheckService from '~/server/services/block-check.service';
import { ReportEntity } from '~/shared/utils/report-helpers';

/**
 * Deleting a parent row (a post, a model, a question...) cascades into its comment threads and every
 * comment in them, other people's included. A thread holding a held author's comment is detached
 * from the parent first, and is then unreachable from the site except for moderators. The SQL runs on
 * a Postgres stand-in with the real foreign keys, so the cascade is what decides.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

// What the handlers do once let through is their own suites'; here, whether they are let through.
const {
  deleteComment,
  upsertComment,
  toggleHideComment,
  togglePinComment,
  toggleThreadMute,
  toggleReaction,
  createReport,
} = vi.hoisted(() => ({
  deleteComment: vi.fn(async ({ id }: { id: number }) => ({ id })),
  upsertComment: vi.fn(async () => ({ id: 1 })),
  toggleHideComment: vi.fn(async () => ({ id: 1 })),
  togglePinComment: vi.fn(async () => ({ id: 1 })),
  toggleThreadMute: vi.fn(async () => true),
  toggleReaction: vi.fn(async () => 'created'),
  createReport: vi.fn(async () => ({ status: 'Pending' })),
}));
vi.mock('~/server/services/commentsv2.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CommentsV2Service>()),
  deleteComment,
  upsertComment,
  toggleHideComment,
  togglePinComment,
  toggleThreadMute,
}));
// The viewer owns the content every comment here hangs off, so the owner check lets them through.
vi.mock('~/server/services/block-check.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlockCheckService>()),
  getContentOwnerIdForComment: vi.fn(async () => ({ hidden: false, ownerId: 9 })),
}));
vi.mock('~/server/services/reaction.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactionService>()),
  toggleReaction,
}));
vi.mock('~/server/services/report.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ReportService>()),
  createReport,
}));

import { detachHeldThreadsCte, modelThreadParents } from '~/server/services/comment-thread-hold';
import { isCommentDetached, isThreadDetached } from '~/server/services/commentsv2.service';
import { deleteQuestion } from '~/server/services/question.service';
import { deleteAnswer } from '~/server/services/answer.service';
import {
  deleteResourceReview,
  deleteResourceReviews,
} from '~/server/services/resourceReview.service';
import { deleteImageById, deleteImages } from '~/server/services/image.service';
import { deletePost } from '~/server/services/post.service';
import { deleteBountyById } from '~/server/services/bounty.service';
import { purgeReleasedHeldCopies } from '~/server/services/held-review.service';
import { deleteBountyEntry } from '~/server/services/bountyEntry.service';
import { deleteArticleById } from '~/server/services/article.service';
import { toggleReview } from '~/server/services/user.service';
import {
  assertCommentEntityVisible,
  deleteCommentV2Handler,
  toggleHideCommentHandler,
  togglePinnedCommentHandler,
  upsertCommentV2Handler,
  getCommentHandler,
  toggleThreadMuteHandler,
} from '~/server/controllers/commentv2.controller';
import { toggleReactionHandler } from '~/server/controllers/reaction.controller';
import { createReportHandler } from '~/server/controllers/report.controller';

const OWNER = 1;
const HELD = 2; // named on a pending report
const OTHER = 3;
const MARKED = 4; // held only by a hold marker

let db: PGlite;
const run = (sql: Prisma.Sql) => db.query(sql.text, sql.values as unknown[]);
const asSql = (first: TemplateStringsArray | Prisma.Sql, values: unknown[]) =>
  Array.isArray(first)
    ? Prisma.sql(first as TemplateStringsArray, ...(values as never[]))
    : (first as Prisma.Sql);
const commentIds = async () =>
  (await db.query<{ id: number }>(`SELECT id FROM "CommentV2" ORDER BY id`)).rows.map((r) => r.id);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "CsamReport" (
      id serial PRIMARY KEY, "userId" int, "reportSentAt" timestamp(3), "archivedAt" timestamp(3),
      details jsonb NOT NULL DEFAULT '{}', images jsonb NOT NULL DEFAULT '[]'
    );
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL, "needsReview" text, "blockedFor" text,
      url text NOT NULL DEFAULT 'u', "postId" int, "nsfwLevel" int NOT NULL DEFAULT 1, metadata jsonb,
      ingestion text NOT NULL DEFAULT 'Scanned'
    );
    CREATE TYPE "UserEngagementType" AS ENUM ('Follow', 'Hide', 'Block');
    CREATE TABLE "User" (id int PRIMARY KEY, username text);
    CREATE TABLE "UserEngagement" ("userId" int, "targetUserId" int, type "UserEngagementType");
    CREATE TABLE "EvidenceHold" ("userId" int NOT NULL);
    CREATE VIEW "EvidenceHeldUser" AS SELECT "userId" FROM "EvidenceHold";
    CREATE TABLE "Post" (id int PRIMARY KEY, "userId" int NOT NULL, "nsfwLevel" int NOT NULL DEFAULT 1);
    CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int NOT NULL);
    CREATE TABLE "ResourceReview" (
      id int PRIMARY KEY, "userId" int NOT NULL,
      "modelId" int REFERENCES "Model"(id) ON DELETE CASCADE, "modelVersionId" int
    );
    CREATE TABLE "Question" (id int PRIMARY KEY, "userId" int NOT NULL);
    CREATE TABLE "Answer" (
      id int PRIMARY KEY, "userId" int NOT NULL,
      "questionId" int REFERENCES "Question"(id) ON DELETE CASCADE
    );
    CREATE DOMAIN "Availability" AS text;
    CREATE TABLE "File" (id serial PRIMARY KEY, "entityType" text, "entityId" int);
    CREATE TABLE "Bounty" (
      id int PRIMARY KEY, "userId" int, complete boolean NOT NULL DEFAULT true,
      refunded boolean NOT NULL DEFAULT true, poi boolean NOT NULL DEFAULT false,
      availability text NOT NULL DEFAULT 'Public', meta jsonb, "payoutRecordedAt" timestamp(3),
      "payoutSettledAt" timestamp(3), "payoutWinnerUserId" int
    );
    CREATE TABLE "BountyEntry" (
      id int PRIMARY KEY, "userId" int NOT NULL,
      "bountyId" int NOT NULL REFERENCES "Bounty"(id) ON DELETE CASCADE
    );
    CREATE TABLE "Article" (id int PRIMARY KEY, "userId" int NOT NULL, "coverId" int);
    CREATE TABLE "ImageConnection" ("imageId" int, "entityId" int, "entityType" text);
    CREATE TABLE "Thread" (
      id int PRIMARY KEY,
      "postId" int UNIQUE REFERENCES "Post"(id) ON DELETE CASCADE,
      "modelId" int UNIQUE REFERENCES "Model"(id) ON DELETE CASCADE,
      "reviewId" int UNIQUE REFERENCES "ResourceReview"(id) ON DELETE CASCADE,
      "questionId" int UNIQUE REFERENCES "Question"(id) ON DELETE CASCADE,
      "answerId" int UNIQUE REFERENCES "Answer"(id) ON DELETE CASCADE,
      "imageId" int UNIQUE REFERENCES "Image"(id) ON DELETE CASCADE,
      "bountyId" int UNIQUE REFERENCES "Bounty"(id) ON DELETE CASCADE,
      "bountyEntryId" int UNIQUE REFERENCES "BountyEntry"(id) ON DELETE CASCADE,
      "articleId" int UNIQUE REFERENCES "Article"(id) ON DELETE CASCADE,
      "parentThreadId" int REFERENCES "Thread"(id) ON DELETE CASCADE,
      "rootThreadId" int REFERENCES "Thread"(id) ON DELETE CASCADE,
      "commentId" int,
      "storylineId" int,
      "crucibleId" int,
      metadata jsonb NOT NULL DEFAULT '{}'
    );
    CREATE TABLE "CommentV2" (
      id int PRIMARY KEY, "userId" int NOT NULL,
      "threadId" int NOT NULL REFERENCES "Thread"(id) ON DELETE CASCADE,
      "tosViolation" boolean NOT NULL DEFAULT false
    );
    -- Stands in for the hold marker's delete trigger: a marked owner's image row is kept.
    CREATE FUNCTION keep_marked_image() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM "EvidenceHeldUser" h WHERE h."userId" = OLD."userId") THEN RETURN NULL; END IF;
      RETURN OLD;
    END $$;
    CREATE TRIGGER keep_marked_image BEFORE DELETE ON "Image"
      FOR EACH ROW EXECUTE FUNCTION keep_marked_image();
  `);
  await db.exec(heldCopiesSchemaSql());
});
afterAll(() => db.close());

beforeEach(async () => {
  vi.clearAllMocks();
  await db.exec(`
    TRUNCATE "CommentV2", "Thread", "Answer", "Question", "ResourceReview", "Model", "Post",
      "Image", "CsamReport", "EvidenceHold", "BountyEntry", "Bounty", "Article",
      "HeldResourceReview", "HeldAnswer";
    INSERT INTO "CsamReport" ("userId") VALUES (${HELD});
    INSERT INTO "EvidenceHold" VALUES (${MARKED});
  `);
  const viaStandIn = (async (first: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) =>
    (await run(asSql(first, values))).rows) as never;
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation(viaStandIn);
  vi.mocked(dbMock.dbRead.$queryRaw).mockImplementation(viaStandIn);
  vi.mocked(dbMock.dbWrite.$executeRaw).mockImplementation(
    (async (first: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) =>
      (await run(asSql(first, values))).affectedRows ?? 0) as never
  );
  // Statements in order on one connection, as the array form sends them.
  vi.mocked(dbMock.dbWrite.$transaction).mockImplementation((async (ops: unknown) =>
    typeof ops === 'function' ? ops(dbMock.dbWrite) : Promise.all(ops as unknown[])) as never);
  const deleteRow = (table: string) =>
    (async ({ where }: { where: { id: number } }) =>
      (await db.query(`DELETE FROM "${table}" WHERE id = $1 RETURNING *`, [where.id]))
        .rows[0]) as never;
  vi.mocked(dbMock.dbWrite.question.delete).mockImplementation(deleteRow('Question'));
  vi.mocked(dbMock.dbWrite.answer.delete).mockImplementation(deleteRow('Answer'));
  vi.mocked(dbMock.dbWrite.resourceReview.delete).mockImplementation(deleteRow('ResourceReview'));
  vi.mocked(dbMock.dbWrite.resourceReview.findMany).mockResolvedValue([]);
  vi.mocked(dbMock.dbWrite.bounty.delete).mockImplementation(deleteRow('Bounty'));
  vi.mocked(dbMock.dbWrite.bountyEntry.delete).mockImplementation(deleteRow('BountyEntry'));
  vi.mocked(dbMock.dbWrite.article.delete).mockImplementation(deleteRow('Article'));
  vi.mocked(dbMock.dbWrite.imageConnection.findMany).mockResolvedValue([]);
  vi.mocked(dbMock.dbWrite.resourceReview.deleteMany).mockImplementation((async ({
    where,
  }: {
    where: { id: { in: number[] } };
  }) => ({
    count: (await db.query(`DELETE FROM "ResourceReview" WHERE id = ANY($1)`, [where.id.in]))
      .affectedRows,
  })) as never);
});

/** A thread on `column` = `parentId`: OTHER comments, and `replier` answers in a reply thread. */
async function seedThread(column: string, parentId: number, replier: number) {
  await db.exec(`
    INSERT INTO "Thread" (id, "${column}") VALUES (100, ${parentId});
    INSERT INTO "CommentV2" (id, "userId", "threadId") VALUES (1, ${OTHER}, 100);
    INSERT INTO "Thread" (id, "rootThreadId", "parentThreadId", "commentId") VALUES (101, 100, 100, 1);
    INSERT INTO "CommentV2" (id, "userId", "threadId") VALUES (2, ${replier}, 101);
  `);
}

describe('detaching held threads in the parent delete', () => {
  const deletePost = () =>
    run(Prisma.sql`
      WITH ${detachHeldThreadsCte({ postId: Prisma.sql`SELECT 10` }, true)}
      DELETE FROM "Post" WHERE id = 10`);

  it.each([
    ['named on a report', HELD],
    ['held by a marker', MARKED],
  ])('keeps a reply by an author %s, and the unheld comment it answers', async (_, replier) => {
    await db.exec(`INSERT INTO "Post" VALUES (10, ${OWNER})`);
    await seedThread('postId', 10, replier);

    await deletePost();

    expect((await db.query(`SELECT id FROM "Post"`)).rows).toEqual([]);
    expect(await commentIds()).toEqual([1, 2]);
    expect((await db.query(`SELECT "postId", metadata FROM "Thread" WHERE id = 100`)).rows).toEqual(
      [{ postId: null, metadata: expect.objectContaining({ detachedFrom: { postId: 10 } }) }]
    );
  });

  it('takes the thread with the post when no held author is in it (control)', async () => {
    await db.exec(`INSERT INTO "Post" VALUES (10, ${OWNER})`);
    await seedThread('postId', 10, OTHER);

    await deletePost();

    expect(await commentIds()).toEqual([]);
  });

  it('keeps a held reply in a thread linked to its comment only', async () => {
    await db.exec(`
      INSERT INTO "Post" VALUES (10, ${OWNER});
      INSERT INTO "Thread" (id, "postId") VALUES (100, 10);
      INSERT INTO "CommentV2" (id, "userId", "threadId") VALUES (1, ${OTHER}, 100);
      INSERT INTO "Thread" (id, "commentId") VALUES (101, 1);
      INSERT INTO "CommentV2" (id, "userId", "threadId") VALUES (2, ${HELD}, 101);
    `);

    await deletePost();

    expect(await commentIds()).toEqual([1, 2]);
  });

  it('keeps a held reply in a thread linked to its parent thread only', async () => {
    await db.exec(`
      INSERT INTO "Post" VALUES (10, ${OWNER});
      INSERT INTO "Thread" (id, "postId") VALUES (100, 10);
      INSERT INTO "CommentV2" (id, "userId", "threadId") VALUES (1, ${OTHER}, 100);
      INSERT INTO "Thread" (id, "parentThreadId") VALUES (101, 100);
      INSERT INTO "CommentV2" (id, "userId", "threadId") VALUES (2, ${HELD}, 101);
    `);

    await deletePost();

    expect(await commentIds()).toEqual([1, 2]);
  });

  it("keeps a held comment on another user's review of a deleted model", async () => {
    await db.exec(`
      INSERT INTO "Model" VALUES (20, ${OWNER});
      INSERT INTO "ResourceReview" VALUES (30, ${OTHER}, 20);
      INSERT INTO "Thread" (id, "reviewId") VALUES (100, 30);
      INSERT INTO "CommentV2" (id, "userId", "threadId") VALUES (1, ${HELD}, 100);
    `);

    await run(Prisma.sql`
      WITH ${detachHeldThreadsCte(modelThreadParents(Prisma.sql`SELECT 20`), true)}
      DELETE FROM "Model" WHERE id = 20`);

    expect((await db.query(`SELECT id FROM "ResourceReview"`)).rows).toEqual([]);
    expect(await commentIds()).toEqual([1]);
  });
});

describe('single deletes keep held threads', () => {
  it("keeps a held comment on another user's answer to a deleted question", async () => {
    await db.exec(`
      INSERT INTO "Question" VALUES (40, ${OWNER});
      INSERT INTO "Answer" VALUES (41, ${OTHER}, 40);
    `);
    await seedThread('answerId', 41, HELD);

    await deleteQuestion({ id: 40 });

    expect((await db.query(`SELECT id FROM "Question"`)).rows).toEqual([]);
    expect(await commentIds()).toEqual([1, 2]);
  });

  it('deletes an answer and the thread on it when no held author is in it (control)', async () => {
    await db.exec(`
      INSERT INTO "Question" VALUES (40, ${OTHER});
      INSERT INTO "Answer" VALUES (41, ${OWNER}, 40);
    `);
    await seedThread('answerId', 41, OTHER);

    await deleteAnswer({ id: 41 });

    expect((await db.query(`SELECT id FROM "Answer"`)).rows).toEqual([]);
    expect(await commentIds()).toEqual([]);
  });

  it('keeps a held reply on a deleted review', async () => {
    await db.exec(`
      INSERT INTO "Model" VALUES (20, ${OTHER});
      INSERT INTO "ResourceReview" VALUES (30, ${OWNER}, 20);
    `);
    await seedThread('reviewId', 30, HELD);

    await deleteResourceReview({ id: 30 }).catch(() => undefined);

    expect((await db.query(`SELECT id FROM "ResourceReview"`)).rows).toEqual([]);
    expect(await commentIds()).toEqual([1, 2]);
  });
});

describe('a detached thread is off the site', () => {
  beforeEach(async () => {
    await db.exec(`INSERT INTO "Post" VALUES (10, ${OWNER}), (11, ${OWNER})`);
    await seedThread('postId', 10, HELD);
    // A live thread on the other post, as a control.
    await db.exec(`
      INSERT INTO "Thread" (id, "postId") VALUES (200, 11);
      INSERT INTO "CommentV2" (id, "userId", "threadId") VALUES (3, ${OTHER}, 200);
      INSERT INTO "Thread" (id, "rootThreadId", "parentThreadId", "commentId") VALUES (201, 200, 200, 3);
    `);
    await run(Prisma.sql`
      WITH ${detachHeldThreadsCte({ postId: Prisma.sql`SELECT 10` }, true)}
      DELETE FROM "Post" WHERE id = 10`);
  });

  it('reads a thread linked to it by its parent thread only as detached', async () => {
    await db.exec(`
      INSERT INTO "Thread" (id, "parentThreadId") VALUES (103, 101);
      INSERT INTO "CommentV2" (id, "userId", "threadId") VALUES (9, ${OTHER}, 103);
    `);
    expect(await isThreadDetached(103)).toBe(true);
    expect(await isCommentDetached(9)).toBe(true);
  });

  it('reads the detached tree as detached, from its root and from a reply in it', async () => {
    expect(await isThreadDetached(100)).toBe(true);
    expect(await isThreadDetached(101)).toBe(true);
    expect(await isCommentDetached(2)).toBe(true);
    expect(await isThreadDetached(200)).toBe(false);
    expect(await isCommentDetached(3)).toBe(false);
  });

  /** 110 reply threads below `root` (past the depth cap), each under the last one's comment; returns the deepest comment. */
  async function longChain(root: number, linkRoot: boolean) {
    await db.exec(`
      DO $$
      DECLARE th int := ${root}; c int;
      BEGIN
        FOR i IN 1..110 LOOP
          c := ${root} * 1000 + i;
          INSERT INTO "CommentV2" (id, "userId", "threadId") VALUES (c, ${OTHER}, th);
          INSERT INTO "Thread" (id, "commentId", "rootThreadId")
            VALUES (c, c, ${linkRoot ? root : 'NULL'}) RETURNING id INTO th;
        END LOOP;
        INSERT INTO "CommentV2" (id, "userId", "threadId") VALUES (${root} * 1000 + 999, ${OTHER}, th);
      END $$;`);
    return root * 1000 + 999;
  }

  it('reads a comment past the depth cap below a detached root, with no root link, as detached', async () => {
    expect(await isCommentDetached(await longChain(100, false))).toBe(true);
  });

  it('reads a deep comment on a live thread that links its root as live (control)', async () => {
    expect(await isCommentDetached(await longChain(200, true))).toBe(false);
  });

  it('refuses a comment past the depth cap whose root it cannot reach, even on a live thread', async () => {
    expect(await isCommentDetached(await longChain(200, false))).toBe(true);
  });

  const ctx = (isModerator: boolean) =>
    ({ user: { id: 9, isModerator }, features: {}, req: {} } as never);

  it('refuses a detached comment by id to a member, and shows it to a moderator', async () => {
    vi.mocked(dbMock.dbRead.commentV2.findFirst).mockResolvedValue({
      id: 2,
      threadId: 101,
      user: { id: HELD },
    } as never);

    await expect(getCommentHandler({ ctx: ctx(false), input: { id: 2 } })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(getCommentHandler({ ctx: ctx(true), input: { id: 2 } })).resolves.toMatchObject({
      id: 2,
    });
  });

  it('refuses the replies of a detached comment to a member, and shows them to a moderator', async () => {
    await expect(
      assertCommentEntityVisible({ entityType: 'comment', entityId: 1 }, ctx(false))
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      assertCommentEntityVisible({ entityType: 'comment', entityId: 1 }, ctx(true))
    ).resolves.toBeUndefined();
    await expect(
      assertCommentEntityVisible({ entityType: 'comment', entityId: 3 }, ctx(false))
    ).resolves.toBeUndefined();
  });
});

/**
 * A tree on `column` = `parentId`: comment 1 by OTHER in the root thread, 2 by OTHER replying to it,
 * and 3 by `deepest` replying to 2, in a thread whose parent (the thread on 2) is not its root.
 */
async function seedNested(column: string, parentId: number, deepest: number) {
  await db.exec(`
    INSERT INTO "Thread" (id, "${column}") VALUES (100, ${parentId});
    INSERT INTO "CommentV2" (id, "userId", "threadId") VALUES (1, ${OTHER}, 100);
    INSERT INTO "Thread" (id, "rootThreadId", "parentThreadId", "commentId") VALUES (101, 100, 100, 1);
    INSERT INTO "CommentV2" (id, "userId", "threadId") VALUES (2, ${OTHER}, 101);
    INSERT INTO "Thread" (id, "rootThreadId", "parentThreadId", "commentId") VALUES (102, 100, 101, 2);
    INSERT INTO "CommentV2" (id, "userId", "threadId") VALUES (3, ${deepest}, 102);
  `);
}
/** A root thread with one comment, by `author`, and no replies. */
async function seedRootOnly(column: string, parentId: number, author: number) {
  await db.exec(`
    INSERT INTO "Thread" (id, "${column}") VALUES (100, ${parentId});
    INSERT INTO "CommentV2" (id, "userId", "threadId") VALUES (1, ${author}, 100);
  `);
}

describe('the production delete paths keep held threads', () => {
  const sites = {
    deleteImageById: {
      column: 'imageId',
      parentId: 50,
      seedParent: () => db.exec(`INSERT INTO "Image" (id, "userId") VALUES (50, ${OWNER})`),
      run: () => deleteImageById({ id: 50, updatePost: false }),
      parentGone: async () => (await db.query(`SELECT id FROM "Image"`)).rows.length === 0,
    },
    toggleReview: {
      column: 'reviewId',
      parentId: 30,
      seedParent: () =>
        db.exec(`
          INSERT INTO "Model" VALUES (20, ${OTHER});
          INSERT INTO "ResourceReview" VALUES (30, ${OWNER}, 20, 21);`),
      run: () => toggleReview({ modelId: 20, userId: OWNER, setTo: false }).catch(() => undefined),
      parentGone: async () => (await db.query(`SELECT id FROM "ResourceReview"`)).rows.length === 0,
    },
    deleteResourceReviews: {
      column: 'reviewId',
      parentId: 30,
      seedParent: () =>
        db.exec(`
          INSERT INTO "Model" VALUES (20, ${OTHER});
          INSERT INTO "ResourceReview" VALUES (30, ${OWNER}, 20, 21);`),
      run: () => deleteResourceReviews({ ids: [30] }).catch(() => undefined),
      parentGone: async () => (await db.query(`SELECT id FROM "ResourceReview"`)).rows.length === 0,
    },
    deleteImages: {
      column: 'imageId',
      parentId: 50,
      seedParent: () => db.exec(`INSERT INTO "Image" (id, "userId") VALUES (50, ${OWNER})`),
      run: () => deleteImages([50], false).catch(() => undefined),
      parentGone: async () => (await db.query(`SELECT id FROM "Image"`)).rows.length === 0,
    },
    deleteBountyById: {
      column: 'bountyId',
      parentId: 60,
      seedParent: async () => {
        await db.exec(`INSERT INTO "Bounty" (id, "userId") VALUES (60, ${OWNER})`);
        vi.mocked(dbMock.dbRead.bounty.findUnique).mockResolvedValue({
          userId: OWNER,
          expiresAt: new Date(),
        } as never);
        // The delete re-reads the row under its lock; no payout is recorded on it.
        vi.mocked(dbMock.dbWrite.bounty.findUnique).mockResolvedValue({
          id: 60,
          userId: OWNER,
          payoutRecordedAt: null,
          payoutSettledAt: null,
        } as never);
      },
      run: () => deleteBountyById({ id: 60, isModerator: true }),
      parentGone: async () => (await db.query(`SELECT id FROM "Bounty"`)).rows.length === 0,
    },
    deleteBountyEntry: {
      column: 'bountyEntryId',
      parentId: 61,
      seedParent: async () => {
        await db.exec(`
          INSERT INTO "Bounty" (id, "userId") VALUES (60, ${OTHER});
          INSERT INTO "BountyEntry" VALUES (61, ${OWNER}, 60);`);
        vi.mocked(dbMock.dbRead.bountyEntry.findUniqueOrThrow).mockResolvedValue({
          id: 61,
          bountyId: 60,
          userId: OWNER,
          bounty: { complete: true },
        } as never);
      },
      run: () => deleteBountyEntry({ id: 61, isModerator: true }),
      parentGone: async () => (await db.query(`SELECT id FROM "BountyEntry"`)).rows.length === 0,
    },
    deleteArticleById: {
      column: 'articleId',
      parentId: 70,
      seedParent: async () => {
        await db.exec(`INSERT INTO "Article" (id, "userId") VALUES (70, ${OWNER})`);
        vi.mocked(dbMock.dbWrite.article.findUnique).mockResolvedValue({ userId: OWNER } as never);
      },
      run: () => deleteArticleById({ id: 70, userId: OWNER }),
      parentGone: async () => (await db.query(`SELECT id FROM "Article"`)).rows.length === 0,
    },
    deletePost: {
      column: 'postId',
      parentId: 10,
      seedParent: () => db.exec(`INSERT INTO "Post" VALUES (10, ${OWNER})`),
      run: () => deletePost({ id: 10, isModerator: true }).catch(() => undefined),
      parentGone: async () => (await db.query(`SELECT id FROM "Post"`)).rows.length === 0,
    },
  };

  describe.each(Object.entries(sites))('%s', (_name, site) => {
    it('keeps a held reply nested below unheld ones, with the comments it answers', async () => {
      await site.seedParent();
      await seedNested(site.column, site.parentId, HELD);

      await site.run();

      expect(await site.parentGone()).toBe(true);
      expect(await commentIds()).toEqual([1, 2, 3]);
      expect(await isCommentDetached(3)).toBe(true);
    });

    it('keeps a held comment alone in a root thread', async () => {
      await site.seedParent();
      await seedRootOnly(site.column, site.parentId, HELD);

      await site.run();

      expect(await site.parentGone()).toBe(true);
      expect(await commentIds()).toEqual([1]);
    });

    it('takes an unheld tree with the parent (control)', async () => {
      await site.seedParent();
      await seedNested(site.column, site.parentId, OTHER);

      await site.run();

      expect(await site.parentGone()).toBe(true);
      expect(await commentIds()).toEqual([]);
    });
  });

  it("keeps a held thread on a deleted bounty entry's image", async () => {
    await db.exec(`
      INSERT INTO "Bounty" (id, "userId") VALUES (60, ${OTHER});
      INSERT INTO "BountyEntry" VALUES (61, ${OWNER}, 60);
      INSERT INTO "Image" (id, "userId") VALUES (50, ${OWNER});
      INSERT INTO "ImageConnection" VALUES (50, 61, 'BountyEntry');`);
    await seedNested('imageId', 50, HELD);
    vi.mocked(dbMock.dbRead.bountyEntry.findUniqueOrThrow).mockResolvedValue({
      id: 61,
      bountyId: 60,
      userId: OWNER,
      bounty: { complete: true },
    } as never);
    vi.mocked(dbMock.dbWrite.imageConnection.findMany).mockResolvedValue([
      { imageId: 50 },
    ] as never);
    vi.mocked(dbMock.dbWrite.image.deleteMany).mockImplementation((async ({
      where,
    }: {
      where: { id: { in: number[] } };
    }) => ({
      count: (await db.query(`DELETE FROM "Image" WHERE id = ANY($1)`, [where.id.in])).affectedRows,
    })) as never);

    await deleteBountyEntry({ id: 61, isModerator: true });

    expect((await db.query(`SELECT id FROM "Image"`)).rows).toEqual([]);
    expect(await commentIds()).toEqual([1, 2, 3]);
    expect(await isCommentDetached(3)).toBe(true);
  });

  it('keeps a held thread on an image of a deleted post', async () => {
    await db.exec(`
      INSERT INTO "Post" VALUES (10, ${OWNER});
      INSERT INTO "Image" (id, "userId", "postId") VALUES (50, ${OWNER}, 10);
    `);
    await seedNested('imageId', 50, HELD);

    await deletePost({ id: 10, isModerator: true }).catch(() => undefined);

    expect((await db.query(`SELECT id FROM "Image"`)).rows).toEqual([]);
    expect(await commentIds()).toEqual([1, 2, 3]);
  });

  // The shop-artwork check reads these off the deleted row: missing, a blocked image reads as a
  // plain owner delete and its object is kept.
  it('returns the block markers of the image it deletes', async () => {
    await db.exec(`
      INSERT INTO "Image" (id, "userId", ingestion, "needsReview", "blockedFor")
      VALUES (50, ${OWNER}, 'Blocked', 'csam', 'tos')
    `);

    expect(await deleteImageById({ id: 50, updatePost: false })).toMatchObject({
      userId: OWNER,
      ingestion: 'Blocked',
      needsReview: 'csam',
      blockedFor: 'tos',
    });
  });

  it('leaves an image the hold marker trigger keeps with its thread on it', async () => {
    await db.exec(`INSERT INTO "Image" (id, "userId") VALUES (50, ${MARKED})`);
    await seedNested('imageId', 50, HELD);

    await deleteImageById({ id: 50, updatePost: false });

    expect((await db.query(`SELECT id FROM "Image"`)).rows).toEqual([{ id: 50 }]);
    expect(
      (await db.query(`SELECT "imageId", metadata FROM "Thread" WHERE id = 100`)).rows
    ).toEqual([{ imageId: 50, metadata: {} }]);
  });
});

describe("a held author's rows under a deleted parent", () => {
  const rows = async (sql: string) => (await db.query(sql)).rows;

  it("copies the held authors' answers to a deleted question, and no one else's", async () => {
    await db.exec(`
      INSERT INTO "Question" (id, "userId") VALUES (40, ${OWNER});
      INSERT INTO "Answer" (id, "userId", "questionId", content) VALUES
        (41, ${HELD}, 40, 'held'), (42, ${OTHER}, 40, 'other'), (43, ${MARKED}, 40, 'marked');
    `);

    await deleteQuestion({ id: 40 });

    expect(await rows(`SELECT id FROM "Answer"`)).toEqual([]);
    expect(
      await rows(`SELECT id, "userId", content, "holdReasons" FROM "HeldAnswer" ORDER BY id`)
    ).toEqual([
      { id: 41, userId: HELD, content: 'held', holdReasons: ['report'] },
      { id: 43, userId: MARKED, content: 'marked', holdReasons: ['hold-marker'] },
    ]);
  });

  async function seedEnteredBounty(entrant: number) {
    await db.exec(`
      INSERT INTO "Bounty" (id, "userId") VALUES (60, ${OWNER});
      INSERT INTO "BountyEntry" VALUES (61, ${entrant}, 60);`);
    vi.mocked(dbMock.dbRead.bounty.findUnique).mockResolvedValue({
      userId: OWNER,
      expiresAt: new Date(),
    } as never);
    vi.mocked(dbMock.dbWrite.bounty.findUnique).mockResolvedValue({
      id: 60,
      userId: OWNER,
      payoutRecordedAt: null,
      payoutSettledAt: null,
    } as never);
  }

  it.each([
    ['named on a report', HELD],
    ['held by the marker', MARKED],
  ])('keeps, hidden, a deleted bounty an author %s entered, with the entry', async (_, entrant) => {
    await seedEnteredBounty(entrant);

    await deleteBountyById({ id: 60, isModerator: true });

    expect(
      await rows(`SELECT id, availability, meta->>'removedWithOwner' AS removed,
        meta->>'availabilityBeforeRemoval' AS before FROM "Bounty"`)
    ).toEqual([{ id: 60, availability: 'Private', removed: 'true', before: 'Public' }]);
    expect(await rows(`SELECT id FROM "BountyEntry"`)).toEqual([{ id: 61 }]);
  });

  it('drops the copies of an author whose hold ended, and keeps those still held', async () => {
    await db.exec(`
      INSERT INTO "HeldResourceReview" (id, "modelId", "modelVersionId", "userId", rating,
        recommended, exclude, nsfw, "tosViolation", "createdAt", "updatedAt")
        SELECT u, 1, 1, u, 5, true, false, false, false, now(), now()
        FROM unnest(ARRAY[${HELD}, ${MARKED}, ${OTHER}]) u;
      INSERT INTO "HeldAnswer" (id, "questionId", "userId", content, "createdAt", "updatedAt")
        SELECT u, 1, u, '', now(), now() FROM unnest(ARRAY[${HELD}, ${MARKED}, ${OTHER}]) u;
    `);
    const left = async () => ({
      reviews: (await rows(`SELECT "userId" FROM "HeldResourceReview" ORDER BY 1`)).map(
        (r) => r.userId
      ),
      answers: (await rows(`SELECT "userId" FROM "HeldAnswer" ORDER BY 1`)).map((r) => r.userId),
    });

    expect(await purgeReleasedHeldCopies()).toEqual({ reviews: 1, answers: 1 });
    expect(await left()).toEqual({ reviews: [HELD, MARKED], answers: [HELD, MARKED] });

    await db.exec(`DELETE FROM "CsamReport"; DELETE FROM "EvidenceHold";`);
    expect(await purgeReleasedHeldCopies()).toEqual({ reviews: 2, answers: 2 });
    expect(await left()).toEqual({ reviews: [], answers: [] });
  });

  it('deletes a bounty only an unheld user entered, with the entry (control)', async () => {
    await seedEnteredBounty(OTHER);

    await deleteBountyById({ id: 60, isModerator: true });

    expect(await rows(`SELECT id FROM "Bounty"`)).toEqual([]);
    expect(await rows(`SELECT id FROM "BountyEntry"`)).toEqual([]);
  });
});

describe('a member cannot act on a detached comment', () => {
  beforeEach(async () => {
    await db.exec(`INSERT INTO "Post" VALUES (10, ${OWNER}), (11, ${OWNER})`);
    await seedThread('postId', 10, HELD);
    // 4 is hidden for ToS, which is also how an author's delete keeps a comment for a hold.
    await db.exec(`
      INSERT INTO "Thread" (id, "postId") VALUES (200, 11);
      INSERT INTO "CommentV2" (id, "userId", "threadId") VALUES (3, ${OTHER}, 200);
      INSERT INTO "CommentV2" (id, "userId", "threadId", "tosViolation") VALUES (4, ${OTHER}, 200, true);
    `);
    // Only the selected columns, as Prisma returns them: a gate that forgets to select its column
    // reads it as undefined.
    vi.mocked(dbMock.dbWrite.commentV2.findUnique).mockImplementation((async (args: {
      where: { id: number };
      select?: Record<string, boolean>;
    }) => {
      const query = `SELECT * FROM "CommentV2" WHERE id = $1`;
      const row = (await db.query<Record<string, unknown>>(query, [args.where.id])).rows[0];
      if (!row || !args.select) return row;
      return Object.fromEntries(Object.keys(args.select).map((k) => [k, row[k]]));
    }) as never);
    await run(Prisma.sql`
      WITH ${detachHeldThreadsCte({ postId: Prisma.sql`SELECT 10` }, true)}
      DELETE FROM "Post" WHERE id = 10`);
  });

  const track = new Proxy({}, { get: () => async () => undefined });
  const ctx = (isModerator: boolean) =>
    ({ user: { id: 9, isModerator }, track, features: {}, req: {} } as never);
  const acts = {
    delete: {
      handler: (id: number, mod: boolean) =>
        deleteCommentV2Handler({ ctx: ctx(mod), input: { id } }),
      service: deleteComment,
    },
    'thread mute': {
      handler: (id: number, mod: boolean) =>
        toggleThreadMuteHandler({ ctx: ctx(mod), input: { commentId: id } }),
      service: toggleThreadMute,
    },
    reaction: {
      handler: (id: number, mod: boolean) =>
        toggleReactionHandler({
          ctx: ctx(mod),
          input: { entityType: 'comment', entityId: id, reaction: 'Like' } as never,
        }),
      service: toggleReaction,
    },
    report: {
      handler: (id: number, mod: boolean) =>
        createReportHandler({
          ctx: ctx(mod),
          input: { type: ReportEntity.CommentV2, id, reason: 'TOSViolation', details: {} } as never,
        }),
      service: createReport,
    },
  };
  const writes = {
    delete: acts.delete,
    reaction: acts.reaction,
    report: acts.report,
    edit: {
      handler: (id: number, mod: boolean) =>
        upsertCommentV2Handler({
          ctx: ctx(mod),
          input: { id, entityType: 'model', entityId: 1, content: 'edited' } as never,
        }),
      service: upsertComment,
    },
    reply: {
      handler: (id: number, mod: boolean) =>
        upsertCommentV2Handler({
          ctx: ctx(mod),
          input: { entityType: 'comment', entityId: id, content: 'reply' } as never,
        }),
      service: upsertComment,
    },
    hide: {
      handler: (id: number, mod: boolean) =>
        toggleHideCommentHandler({ ctx: ctx(mod), input: { id } }),
      service: toggleHideComment,
    },
    pin: {
      handler: (id: number, mod: boolean) =>
        togglePinnedCommentHandler({ ctx: ctx(mod), input: { id } }),
      service: togglePinComment,
    },
  };

  describe.each(Object.entries(writes))('%s', (_name, act) => {
    it('refuses a member a comment hidden for ToS, as if it were gone', async () => {
      await expect(act.handler(4, false)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(act.service).not.toHaveBeenCalled();
    });

    it('lets a moderator act on a comment hidden for ToS', async () => {
      await act.handler(4, true).catch(() => undefined);
      expect(act.service).toHaveBeenCalled();
    });

    it('lets a member act on a live comment (control)', async () => {
      await act.handler(3, false).catch(() => undefined);
      expect(act.service).toHaveBeenCalled();
    });
  });

  describe.each(Object.entries(acts))('%s', (_name, act) => {
    it('refuses a member a detached comment, as if it were gone', async () => {
      await expect(act.handler(2, false)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(act.service).not.toHaveBeenCalled();
    });

    it('lets a moderator act on it', async () => {
      await act.handler(2, true).catch(() => undefined);
      expect(act.service).toHaveBeenCalled();
    });

    it('lets a member act on a live comment (control)', async () => {
      await act.handler(3, false).catch(() => undefined);
      expect(act.service).toHaveBeenCalled();
    });
  });

  // A moderator's delete of someone else's comment is not its author's, so a ToS restore may undo it.
  it.each([
    [false, true],
    [true, false],
  ])("marks a delete as the author's only for a member (moderator %s)", async (mod, byAuthor) => {
    await acts.delete.handler(3, mod);
    expect(deleteComment).toHaveBeenCalledWith(expect.objectContaining({ id: 3, byAuthor }));
  });

  // A missing comment gets this from the block check; a detached one must not read differently.
  it('refuses a reaction on a detached comment with the missing-comment message', async () => {
    await expect(acts.reaction.handler(2, false)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'No comment with id 2',
    });
  });

  it('shows a member a live comment by id (control)', async () => {
    vi.mocked(dbMock.dbRead.commentV2.findFirst).mockResolvedValue({
      id: 3,
      threadId: 200,
      user: { id: OTHER },
    } as never);

    await expect(getCommentHandler({ ctx: ctx(false), input: { id: 3 } })).resolves.toMatchObject({
      id: 3,
    });
  });
});
