import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * Runs the real bulk-hide SQL against an in-process Postgres, because the rule that matters —
 * only comments on sections the BLOCKER owns — lives in the WHERE clause, where a mocked query
 * cannot see it.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

// `afterRead` runs once the candidate read has returned, before any write: what lands in between.
const holder = vi.hoisted(() => ({
  db: null as unknown as PGlite,
  afterRead: null as null | (() => Promise<unknown>),
  read: false,
}));

vi.mock('~/server/db/pgDb', () => ({
  pgDbReadLong: {},
  pgDbWrite: {},
  pgDbRead: {
    connect: async () => ({
      query: async (sql: string, params?: unknown[]) => {
        const result = await holder.db.query(sql, params);
        // After the read's own transaction ends, so what runs here commits on its own.
        if (sql === 'COMMIT' && holder.read) {
          holder.read = false;
          // Once: the first read only.
          const run = holder.afterRead;
          holder.afterRead = null;
          await run?.();
        }
        if (sql.includes('WITH owned')) holder.read = true;
        return result;
      },
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
import { Prisma } from '@prisma/client';
import { restoreScamCase, runScamCleanup } from '~/server/services/scam-cleanup.service';

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
      "pinnedAt" timestamptz, "deletedAt" timestamptz, "updatedAt" timestamptz, "hiddenAt" timestamptz
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

  holder.afterRead = null;
  // The writes run their SQL as written.
  dbMock.dbWrite.$queryRawUnsafe.mockReset();
  dbMock.dbWrite.$queryRawUnsafe.mockImplementation(
    (async (sql: string, ...params: unknown[]) => (await holder.db.query(sql, params)).rows) as any
  );
  dbMock.dbWrite.$queryRaw.mockImplementation((async (first: never, ...values: unknown[]) => {
    const sql = Prisma.sql(first as unknown as TemplateStringsArray, ...(values as never[]));
    return (await holder.db.query(sql.text, sql.values as unknown[])).rows;
  }) as never);
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

  it('re-stamps the comments it would hide that are hidden already, and no others', async () => {
    const earlier = '2026-11-01T00:00:00.000Z';
    await holder.db.exec(`
      UPDATE "CommentV3" SET "hiddenAt" = '${earlier}' WHERE id = 2001;
      INSERT INTO "CommentV3" (id, "userId", "entityType", "entityId", hidden, "hiddenAt")
      VALUES (3005, ${BLOCKED}, 'image', 20, true, '${earlier}');`);
    await hideBlockedUserCommentsOnOwnContent({ ownerId: BLOCKER, blockedUserId: BLOCKED });
    const stamps = await holder.db.query<{ id: number; hidden: boolean; same: boolean }>(
      `SELECT id, hidden, "hiddenAt" = '${earlier}' AS same FROM "CommentV3" WHERE id IN (2001, 3005) ORDER BY id`
    );
    expect(stamps.rows).toEqual([
      { id: 2001, hidden: true, same: false },
      { id: 3005, hidden: true, same: true },
    ]);
  });

  it('after a block, a restore of an earlier hide passes its rows by', async () => {
    await holder.db.exec(`TRUNCATE "CommentV3";
      INSERT INTO "CommentV3" (id, "userId", "entityType", "entityId") VALUES (1001, ${BLOCKED}, 'image', 10);`);
    const record = await runScamCleanup('comments', BLOCKED);
    await hideBlockedUserCommentsOnOwnContent({ ownerId: BLOCKER, blockedUserId: BLOCKED });
    dbMock.dbWrite.userRestriction.findUnique.mockResolvedValueOnce({
      userId: BLOCKED,
      type: 'scam',
      triggers: [{ cleanup: record }],
    } as never);

    expect(await restoreScamCase(1)).toEqual({ restored: 0 });
    expect(await hiddenIds()).toEqual([1001]);
  });

  const cleanupRecord = async () => {
    const record = await runScamCleanup('comments', BLOCKED);
    dbMock.dbWrite.userRestriction.findUnique.mockResolvedValue({
      userId: BLOCKED,
      type: 'scam',
      triggers: [{ cleanup: record }],
    } as never);
  };

  it('a hide landing between the read and the write is stamped by the block', async () => {
    await holder.db.exec(`TRUNCATE "CommentV3";
      INSERT INTO "CommentV3" (id, "userId", "entityType", "entityId") VALUES (1001, ${BLOCKED}, 'image', 10);`);
    holder.afterRead = cleanupRecord;
    await hideBlockedUserCommentsOnOwnContent({ ownerId: BLOCKER, blockedUserId: BLOCKED });

    expect(await restoreScamCase(1)).toEqual({ restored: 0 });
    expect(await hiddenIds()).toEqual([1001]);
  });

  it('a restore landing between the read and the write still leaves the block hidden', async () => {
    await holder.db.exec(`TRUNCATE "CommentV3";
      INSERT INTO "CommentV3" (id, "userId", "entityType", "entityId") VALUES (1001, ${BLOCKED}, 'image', 10);`);
    await cleanupRecord();
    holder.afterRead = () => restoreScamCase(1);
    await hideBlockedUserCommentsOnOwnContent({ ownerId: BLOCKER, blockedUserId: BLOCKED });

    expect(await hiddenIds()).toEqual([1001]);
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

    // The ceiling counts candidates, and 2001, hidden already, is the first of them.
    expect(result).toEqual({ status: 'hidden', count: BLOCK_HIDE_MAX_COMMENTS - 1, capped: true });
    expect(dbMock.dbWrite.$queryRawUnsafe).toHaveBeenCalledTimes(10);
    // The ceiling's worth plus the one already hidden.
    const { rows } = await holder.db.query<{ n: number }>(
      `SELECT count(*)::int n FROM "CommentV3" WHERE "userId" = ${BLOCKED} AND hidden`
    );
    expect(rows[0].n).toBe(BLOCK_HIDE_MAX_COMMENTS);
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
      // Two batches landed; the first held 2001, hidden already.
    ).resolves.toEqual({ status: 'failed', count: 1999 });
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
