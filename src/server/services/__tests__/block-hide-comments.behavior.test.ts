import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * Runs the real bulk-hide SQL against an in-process Postgres, because the rule that matters —
 * only comments on sections the BLOCKER owns — lives in the WHERE clause, where a mocked query
 * cannot see it.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

vi.mock('~/server/db/pgDb', () => ({
  pgDbReadLong: {},
  pgDbWrite: {},
  pgDbRead: {
    connect: async () => ({
      query: (sql: string, params?: unknown[]) => holder.db.query(sql, params),
      release: () => undefined,
    }),
  },
}));

import {
  BLOCK_HIDE_MAX_COMMENTS,
  blockHideCandidatesSql,
  hideBlockedUserCommentsOnOwnContent,
  SECTION_OWNERS,
} from '~/server/services/block-hide-comments.service';
import { CommentEntityType } from '~/shared/utils/prisma/enums';

const BLOCKER = 1;
const BLOCKED = 2;
const OTHER_OWNER = 3;
const BYSTANDER = 4;

beforeAll(async () => {
  holder.db = new PGlite();
  // Every table the section-owner CASE names must exist, even for branches no row takes.
  const userOwned = [
    'Image',
    'Post',
    'Article',
    'Model',
    'ResourceReview',
    'Bounty',
    'BountyEntry',
    'Model3D',
    'Model3DReview',
    'ComicProject',
    'Crucible',
    'Storyline',
  ];
  await holder.db.exec(`
    ${userOwned.map((t) => `CREATE TABLE "${t}" (id int PRIMARY KEY, "userId" int);`).join('\n')}
    CREATE TABLE "Challenge" (id int PRIMARY KEY, "createdById" int);
    CREATE TABLE app_listings (serial_id int PRIMARY KEY, user_id int);
    CREATE TABLE "ComicChapter" (id int PRIMARY KEY, "projectId" int);
    CREATE TABLE "PostText" (id int PRIMARY KEY, "postId" int);
    CREATE TYPE "CommentEntityType" AS ENUM (${Object.values(CommentEntityType)
      .map((t) => `'${t}'`)
      .join(', ')});
    CREATE TABLE "CommentV3" (
      id int PRIMARY KEY, "userId" int, "entityType" "CommentEntityType", "entityId" int,
      hidden boolean NOT NULL DEFAULT false, "tosViolation" boolean NOT NULL DEFAULT false,
      "pinnedAt" timestamptz, "deletedAt" timestamptz, "updatedAt" timestamptz
    );
  `);
});

beforeEach(async () => {
  await holder.db.exec(`
    TRUNCATE "CommentV3", "Image", "Article", "Model", "Challenge", app_listings, "ComicProject",
      "ComicChapter";
    INSERT INTO "Image" (id, "userId") VALUES (10, ${BLOCKER}), (20, ${OTHER_OWNER});
    -- Model 20 shares an id with OTHER_OWNER's image 20: only the entity type tells them apart.
    INSERT INTO "Model" (id, "userId") VALUES (20, ${BLOCKER});
    INSERT INTO "Article" (id, "userId") VALUES (30, ${BLOCKER}), (31, ${OTHER_OWNER});
    INSERT INTO "Challenge" (id, "createdById") VALUES (40, ${BLOCKER});
    INSERT INTO app_listings (serial_id, user_id) VALUES (50, ${BLOCKER}), (51, ${OTHER_OWNER});
    INSERT INTO "ComicProject" (id, "userId") VALUES (60, ${BLOCKER}), (62, ${OTHER_OWNER});
    INSERT INTO "ComicChapter" (id, "projectId") VALUES (61, 60), (63, 62);

    INSERT INTO "CommentV3" (id, "userId", "entityType", "entityId", hidden, "deletedAt") VALUES
      -- The blocked user's live comments on the blocker's sections: hidden.
      (1001, ${BLOCKED}, 'image', 10, false, NULL),
      (1002, ${BLOCKED}, 'article', 30, false, NULL),
      (1003, ${BLOCKED}, 'challenge', 40, false, NULL),
      (1004, ${BLOCKED}, 'appListing', 50, false, NULL),
      (1005, ${BLOCKED}, 'comicChapter', 61, false, NULL),
      (1006, ${BLOCKED}, 'model', 20, false, NULL),
      -- Left alone: already hidden, deleted, a bystander's, and on OTHER_OWNER's sections.
      (2001, ${BLOCKED}, 'image', 10, true, NULL),
      (2002, ${BLOCKED}, 'article', 30, false, now()),
      (2003, ${BYSTANDER}, 'article', 30, false, NULL),
      (3001, ${BLOCKED}, 'image', 20, false, NULL),
      (3002, ${BLOCKED}, 'article', 31, false, NULL),
      (3003, ${BLOCKED}, 'appListing', 51, false, NULL),
      (3004, ${BLOCKED}, 'comicChapter', 63, false, NULL);
  `);

  // The writes are `setCommentFlags`, whose SQL runs as written.
  dbMock.dbWrite.$queryRawUnsafe.mockReset();
  dbMock.dbWrite.$queryRawUnsafe.mockImplementation(
    (async (sql: string, ...params: unknown[]) => (await holder.db.query(sql, params)).rows) as any
  );
});

const hiddenIds = async () =>
  (
    await holder.db.query<{ id: number }>(`SELECT id FROM "CommentV3" WHERE hidden ORDER BY id`)
  ).rows.map((r) => r.id);

describe('hideBlockedUserCommentsOnOwnContent', () => {
  it("hides exactly the blocked user's comments on the blocker's sections", async () => {
    const result = await hideBlockedUserCommentsOnOwnContent({
      ownerId: BLOCKER,
      blockedUserId: BLOCKED,
    });

    expect(result).toEqual({ status: 'hidden', count: 6, capped: false });
    expect(await hiddenIds()).toEqual([1001, 1002, 1003, 1004, 1005, 1006, 2001]);
  });

  it("hides on another owner's sections only when they are the blocker", async () => {
    await hideBlockedUserCommentsOnOwnContent({ ownerId: OTHER_OWNER, blockedUserId: BLOCKED });

    expect(await hiddenIds()).toEqual([2001, 3001, 3002, 3003, 3004]);
  });

  it('stops at the row ceiling, in batches, and says so', async () => {
    await holder.db.exec(`
      INSERT INTO "CommentV3" (id, "userId", "entityType", "entityId")
      SELECT g, ${BLOCKED}, 'image', 10 FROM generate_series(20000, 20000 + ${BLOCK_HIDE_MAX_COMMENTS}) g;
    `);

    const result = await hideBlockedUserCommentsOnOwnContent({
      ownerId: BLOCKER,
      blockedUserId: BLOCKED,
    });

    expect(result).toEqual({ status: 'hidden', count: BLOCK_HIDE_MAX_COMMENTS, capped: true });
    expect(dbMock.dbWrite.$queryRawUnsafe).toHaveBeenCalledTimes(10);
    // The ceiling's worth plus the one already hidden.
    const { rows } = await holder.db.query<{ n: number }>(
      `SELECT count(*)::int n FROM "CommentV3" WHERE "userId" = ${BLOCKED} AND hidden`
    );
    expect(rows[0].n).toBe(BLOCK_HIDE_MAX_COMMENTS + 1);
  });

  it('reports the rows already hidden when a later batch fails', async () => {
    await holder.db.exec(`
      INSERT INTO "CommentV3" (id, "userId", "entityType", "entityId")
      SELECT g, ${BLOCKED}, 'image', 10 FROM generate_series(20000, 22999) g;
    `);
    const translate = dbMock.dbWrite.$queryRawUnsafe.getMockImplementation()!;
    dbMock.dbWrite.$queryRawUnsafe
      .mockImplementationOnce(translate)
      .mockImplementationOnce(translate)
      .mockRejectedValueOnce(new Error('canceling statement'));

    await expect(
      hideBlockedUserCommentsOnOwnContent({ ownerId: BLOCKER, blockedUserId: BLOCKED })
    ).resolves.toEqual({ status: 'failed', count: 2000 });
  });

  it('reports failure instead of throwing when a write fails', async () => {
    dbMock.dbWrite.$queryRawUnsafe.mockRejectedValue(new Error('canceling statement'));

    await expect(
      hideBlockedUserCommentsOnOwnContent({ ownerId: BLOCKER, blockedUserId: BLOCKED })
    ).resolves.toEqual({ status: 'failed', count: 0 });
  });
});

describe('SECTION_OWNERS', () => {
  // A comment section with no owner here is never hidden on a block.
  it('resolves an owner for every comment entity type', () => {
    expect(Object.keys(SECTION_OWNERS).sort()).toEqual(Object.values(CommentEntityType).sort());
  });

  // Each type's sections live in their own table, keyed by their own owner column. Every type gets
  // its own section ids, so an arm reading the wrong table finds no section with that id.
  const SECTIONS: [CommentEntityType, string][] = [
    [
      'image',
      `INSERT INTO "Image" (id, "userId") VALUES (:mine, ${BLOCKER}), (:theirs, ${OTHER_OWNER})`,
    ],
    [
      'post',
      `INSERT INTO "Post" (id, "userId") VALUES (:mine, ${BLOCKER}), (:theirs, ${OTHER_OWNER})`,
    ],
    [
      'article',
      `INSERT INTO "Article" (id, "userId") VALUES (:mine, ${BLOCKER}), (:theirs, ${OTHER_OWNER})`,
    ],
    [
      'model',
      `INSERT INTO "Model" (id, "userId") VALUES (:mine, ${BLOCKER}), (:theirs, ${OTHER_OWNER})`,
    ],
    [
      'review',
      `INSERT INTO "ResourceReview" (id, "userId") VALUES (:mine, ${BLOCKER}), (:theirs, ${OTHER_OWNER})`,
    ],
    [
      'bounty',
      `INSERT INTO "Bounty" (id, "userId") VALUES (:mine, ${BLOCKER}), (:theirs, ${OTHER_OWNER})`,
    ],
    [
      'bountyEntry',
      `INSERT INTO "BountyEntry" (id, "userId") VALUES (:mine, ${BLOCKER}), (:theirs, ${OTHER_OWNER})`,
    ],
    [
      'model3d',
      `INSERT INTO "Model3D" (id, "userId") VALUES (:mine, ${BLOCKER}), (:theirs, ${OTHER_OWNER})`,
    ],
    [
      'model3dReview',
      `INSERT INTO "Model3DReview" (id, "userId") VALUES (:mine, ${BLOCKER}), (:theirs, ${OTHER_OWNER})`,
    ],
    [
      'challenge',
      `INSERT INTO "Challenge" (id, "createdById") VALUES (:mine, ${BLOCKER}), (:theirs, ${OTHER_OWNER})`,
    ],
    [
      'appListing',
      `INSERT INTO app_listings (serial_id, user_id) VALUES (:mine, ${BLOCKER}), (:theirs, ${OTHER_OWNER})`,
    ],
    [
      'crucible',
      `INSERT INTO "Crucible" (id, "userId") VALUES (:mine, ${BLOCKER}), (:theirs, ${OTHER_OWNER})`,
    ],
    [
      'storyline',
      `INSERT INTO "Storyline" (id, "userId") VALUES (:mine, ${BLOCKER}), (:theirs, ${OTHER_OWNER})`,
    ],
    [
      'postText',
      `INSERT INTO "Post" (id, "userId") VALUES (:mine, ${BLOCKER}), (:theirs, ${OTHER_OWNER});
       INSERT INTO "PostText" (id, "postId") VALUES (:mine, :mine), (:theirs, :theirs)`,
    ],
    [
      'comicChapter',
      `INSERT INTO "ComicProject" (id, "userId") VALUES (:mine, ${BLOCKER}), (:theirs, ${OTHER_OWNER});
       INSERT INTO "ComicChapter" (id, "projectId") VALUES (:mine, :mine), (:theirs, :theirs)`,
    ],
  ];
  const mine = (i: number) => 500 + i;
  const theirs = (i: number) => 700 + i;

  beforeEach(async () => {
    await holder.db.exec(`
      TRUNCATE "CommentV3", "Image", "Post", "Article", "Model", "ResourceReview", "Bounty",
        "BountyEntry", "Model3D", "Model3DReview", "Challenge", app_listings, "Crucible",
        "Storyline", "ComicProject", "ComicChapter", "PostText";
      ${SECTIONS.map(([, sql], i) =>
        sql.replaceAll(':mine', String(mine(i))).replaceAll(':theirs', String(theirs(i)))
      ).join(';\n')};
      INSERT INTO "CommentV3" (id, "userId", "entityType", "entityId") VALUES
      ${SECTIONS.map(
        ([type], i) =>
          `(${mine(i)}, ${BLOCKED}, '${type}', ${mine(i)}), (${theirs(
            i
          )}, ${BLOCKED}, '${type}', ${theirs(i)})`
      ).join(',\n')};
    `);
  });

  it('covers every comment entity type', () => {
    expect(SECTIONS.map(([type]) => type).sort()).toEqual(Object.values(CommentEntityType).sort());
  });

  it("hides the comment on the blocker's section of every type, and none on another owner's", async () => {
    await hideBlockedUserCommentsOnOwnContent({ ownerId: BLOCKER, blockedUserId: BLOCKED });

    const { rows } = await holder.db.query<{ entityType: string; id: number }>(
      `SELECT "entityType", id FROM "CommentV3" WHERE hidden ORDER BY id`
    );
    expect(rows).toEqual(SECTIONS.map(([type], i) => ({ entityType: type, id: mine(i) })));
  });
});
