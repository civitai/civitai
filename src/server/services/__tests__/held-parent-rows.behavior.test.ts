import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import {
  heldCopiesSchemaSql,
  heldStorylineCopiesSchemaSql,
} from '~/server/services/__tests__/held-copies.fixture';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ReactionService from '~/server/services/reaction.service';
import type * as ReportService from '~/server/services/report.service';
import { ReportEntity } from '~/shared/utils/report-helpers';

/**
 * A held author's own rows under a deleted parent (a bounty's entries, a model's reviews); their
 * comments going with the parent; and the gates that answer a comment hidden for ToS as missing to
 * members. Run on a Postgres stand-in with the real foreign keys.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

// What the handlers do once let through is their own suites'; here, whether they are let through.
const { toggleReaction, createReport } = vi.hoisted(() => ({
  toggleReaction: vi.fn(async () => 'created'),
  createReport: vi.fn(async () => ({ status: 'Pending' })),
}));
vi.mock('~/server/services/reaction.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactionService>()),
  toggleReaction,
}));
vi.mock('~/server/services/report.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ReportService>()),
  createReport,
}));

import {
  deleteResourceReview,
  deleteResourceReviews,
} from '~/server/services/resourceReview.service';
import { deleteImageById, deleteImages } from '~/server/services/image.service';
import { deletePost } from '~/server/services/post.service';
import { deleteBountyById, deleteSettledKeptBounties } from '~/server/services/bounty.service';
import { purgeReleasedHeldCopies } from '~/server/services/held-review.service';
import { SearchIndexUpdate } from '~/server/search-index/SearchIndexUpdate';
import { deleteBountyEntry } from '~/server/services/bountyEntry.service';
import { deleteArticleById } from '~/server/services/article.service';
import { toggleReview } from '~/server/services/user.service';
import { toggleReactionHandler } from '~/server/controllers/reaction.controller';
import { createReportHandler } from '~/server/controllers/report.controller';

const unpaidAwardMigration = readFileSync(
  path.join(
    __dirname,
    '../../../../packages/civitai-db-schema/prisma/migrations/20261217120000_bounty_unpaid_award/migration.sql'
  ),
  'utf8'
);
// deletePost asks it whether the post holds held text.
const postTextMigration = readFileSync(
  path.join(
    __dirname,
    '../../../../packages/civitai-db-schema/prisma/migrations/20270108093000_post_text/migration.sql'
  ),
  'utf8'
);
const TOPIC_ENTITY_TABLES = {
  image: 'Image',
  post: 'Post',
  review: 'ResourceReview',
  bounty: 'Bounty',
  bountyEntry: 'BountyEntry',
  article: 'Article',
};
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
  (await db.query<{ id: number }>(`SELECT id FROM "CommentV3" ORDER BY id`)).rows.map((r) => r.id);

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
      "modelId" int REFERENCES "Model"(id) ON DELETE CASCADE, "modelVersionId" int,
      "postId" int, "releasedAt" timestamp(3)
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
    CREATE TABLE "BountyBenefactor" (
      "bountyId" int NOT NULL REFERENCES "Bounty"(id) ON DELETE CASCADE, "userId" int,
      "unitAmount" int NOT NULL DEFAULT 0, "buzzTransactionId" text[] DEFAULT '{}'
    );
    CREATE TABLE "ModActivity" (
      id serial PRIMARY KEY, "userId" int, activity text NOT NULL, "entityType" text, "entityId" int,
      "createdAt" timestamp(3) NOT NULL DEFAULT now()
    );
    ${unpaidAwardMigration}
    CREATE TABLE "Article" (id int PRIMARY KEY, "userId" int NOT NULL, "coverId" int);
    CREATE TABLE "ImageConnection" ("imageId" int, "entityId" int, "entityType" text);
    -- As production: a topic partition per entity type, each going with its entity, and the
    -- comments with their topic.
    CREATE TABLE "CommentTopic" (
      "entityType" text NOT NULL, "entityId" int NOT NULL, locked boolean NOT NULL DEFAULT false,
      PRIMARY KEY ("entityId", "entityType")
    ) PARTITION BY LIST ("entityType");
    ${Object.entries(TOPIC_ENTITY_TABLES)
      .map(
        ([type, table]) => `
    CREATE TABLE "CommentTopic_${type}" PARTITION OF "CommentTopic" FOR VALUES IN ('${type}');
    ALTER TABLE "CommentTopic_${type}"
      ADD FOREIGN KEY ("entityId") REFERENCES "${table}"(id) ON DELETE CASCADE;`
      )
      .join('')}
    CREATE TABLE "CommentV3" (
      id int PRIMARY KEY, "entityType" text NOT NULL, "entityId" int NOT NULL, "userId" int NOT NULL,
      "parentId" int REFERENCES "CommentV3"(id) ON DELETE RESTRICT,
      "replyToId" int REFERENCES "CommentV3"(id) ON DELETE SET NULL,
      content text NOT NULL DEFAULT '', hidden boolean NOT NULL DEFAULT false,
      "tosViolation" boolean NOT NULL DEFAULT false, locked boolean NOT NULL DEFAULT false,
      "pinnedAt" timestamptz, "deletedAt" timestamptz, depth int NOT NULL DEFAULT 0,
      path text NOT NULL DEFAULT '', "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY ("entityId", "entityType") REFERENCES "CommentTopic" ON DELETE CASCADE
    );
  `);
  await db.exec(heldCopiesSchemaSql());
  await db.exec(heldStorylineCopiesSchemaSql());
  await db.exec(postTextMigration);
});
afterAll(() => db.close());

beforeEach(async () => {
  vi.clearAllMocks();
  await db.exec(`
    TRUNCATE "CommentTopic", "CommentV3", "ResourceReview", "Model", "PostText", "Post", "Image", "CsamReport",
      "EvidenceHold", "BountyEntry", "Bounty", "Article",
      "HeldResourceReview", "BountyBenefactor", "ModActivity", "BountyUnpaidAward";
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

/** Comments on `entityType` `parentId`: OTHER comments, and `replier` answers it. */
async function seedComments(entityType: string, parentId: number, replier: number) {
  await db.exec(`
    INSERT INTO "CommentTopic" ("entityType", "entityId") VALUES ('${entityType}', ${parentId});
    INSERT INTO "CommentV3" (id, "entityType", "entityId", "userId", "parentId") VALUES
      (1, '${entityType}', ${parentId}, ${OTHER}, NULL),
      (2, '${entityType}', ${parentId}, ${replier}, 1);
  `);
}

describe("a held author's rows under a deleted parent", () => {
  const rows = async (sql: string) => (await db.query(sql)).rows;

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

  const keptBounty = () =>
    rows(`SELECT id, "userId", availability, meta->>'removedWithOwner' AS removed,
      meta->>'availabilityBeforeRemoval' AS before, (meta->>'userIdBeforeRemoval')::int AS owner
      FROM "Bounty"`);
  const searchDeletes = () =>
    vi.mocked(SearchIndexUpdate.queueUpdate).mock.calls.flatMap(([{ items }]) => items);

  beforeEach(() => {
    vi.spyOn(SearchIndexUpdate, 'queueUpdate').mockResolvedValue(undefined as never);
  });

  it.each([
    ['named on a report', HELD],
    ['held by the marker', MARKED],
  ])(
    'keeps, hidden and out of search, a deleted bounty an author %s entered, with the entry',
    async (_, entrant) => {
      await seedEnteredBounty(entrant);

      await deleteBountyById({ id: 60, isModerator: true, userId: 1 });

      expect(await keptBounty()).toEqual([
        {
          id: 60,
          userId: null,
          availability: 'Private',
          removed: 'true',
          before: 'Public',
          owner: OWNER,
        },
      ]);
      expect(await rows(`SELECT id FROM "BountyEntry"`)).toEqual([{ id: 61 }]);
      expect(searchDeletes()).toEqual([{ id: 60, action: 'Delete' }]);
    }
  );

  it('keeps the first removal record when a kept bounty is deleted again', async () => {
    await seedEnteredBounty(HELD);

    await deleteBountyById({ id: 60, isModerator: true, userId: 1 });
    await deleteBountyById({ id: 60, isModerator: true, userId: 1 });

    expect(await keptBounty()).toEqual([
      expect.objectContaining({ userId: null, before: 'Public', owner: OWNER }),
    ]);
  });

  it('drops the copies of an author whose hold ended, and keeps those still held', async () => {
    await db.exec(`
      INSERT INTO "HeldResourceReview" (id, "modelId", "modelVersionId", "userId", rating,
        recommended, exclude, nsfw, "tosViolation", "createdAt", "updatedAt")
        SELECT u, 1, 1, u, 5, true, false, false, false, now(), now()
        FROM unnest(ARRAY[${HELD}, ${MARKED}, ${OTHER}]) u;
    `);
    const left = async () => ({
      reviews: (await rows(`SELECT "userId" FROM "HeldResourceReview" ORDER BY 1`)).map(
        (r) => r.userId
      ),
    });

    expect(await purgeReleasedHeldCopies()).toMatchObject({ reviews: 1 });
    expect(await left()).toEqual({ reviews: [HELD, MARKED] });

    await db.exec(`DELETE FROM "CsamReport"; DELETE FROM "EvidenceHold";`);
    expect(await purgeReleasedHeldCopies()).toMatchObject({ reviews: 2 });
    expect(await left()).toEqual({ reviews: [] });
  });

  it.each([
    ['the entrant', HELD, []],
    ['the entrant, while its owner is held', HELD, [OWNER]],
  ])(
    'deletes a kept bounty once %s is released, and not before',
    async (_, entrant, heldOwners) => {
      await seedEnteredBounty(entrant);
      await deleteBountyById({ id: 60, isModerator: true, userId: 1 });
      for (const owner of heldOwners)
        await db.exec(`INSERT INTO "CsamReport" ("userId") VALUES (${owner})`);

      expect(await deleteSettledKeptBounties()).toBe(0);
      await db.exec(`DELETE FROM "CsamReport" WHERE "userId" = ${entrant}`);
      expect(await deleteSettledKeptBounties()).toBe(heldOwners.length ? 0 : 1);
      expect((await rows(`SELECT id FROM "Bounty"`)).length).toBe(heldOwners.length ? 1 : 0);

      await db.exec(`DELETE FROM "CsamReport" WHERE "userId" = ANY(ARRAY[${heldOwners}]::int[])`);
      await deleteSettledKeptBounties();
      expect(await rows(`SELECT id FROM "Bounty"`)).toEqual([]);
    }
  );

  it('deletes a bounty only an unheld user entered, with the entry (control)', async () => {
    await seedEnteredBounty(OTHER);

    await deleteBountyById({ id: 60, isModerator: true, userId: 1 });

    expect(await rows(`SELECT id FROM "Bounty"`)).toEqual([]);
    expect(await rows(`SELECT id FROM "BountyEntry"`)).toEqual([]);
    expect(searchDeletes()).toEqual([]);
  });

  describe('an award recorded for manual resolution', () => {
    const SUPPORTER = 7;
    const recordAward = (resolved = false, userId = SUPPORTER, bountyId = 60) =>
      db.query(
        `INSERT INTO "BountyUnpaidAward" ("bountyId", "userId", "unitAmount", "recordedById",
          "resolvedAt") VALUES ($1, $2, 100, 1, $3)`,
        [bountyId, userId, resolved ? new Date() : null]
      );
    const resolveAward = () =>
      db.query(`UPDATE "BountyUnpaidAward" SET ruling = 'paid_winner', "resolvedAt" = now()`);
    /** The ModActivity record of an award made before the table existed. */
    const recordLegacy = (userId = SUPPORTER, entityId = 60, entityType = 'bounty') =>
      db.query(
        `INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId")
          VALUES ($1, 'bountyAwardUnpaid', $2, $3)`,
        [userId, entityType, entityId]
      );
    const seedReleased = () =>
      db.exec(`
        INSERT INTO "Bounty" (id, "userId", meta, "payoutRecordedAt", "payoutSettledAt")
          VALUES (60, ${OWNER}, '{"removedWithOwner": true}', now(), now());
        INSERT INTO "BountyBenefactor" ("bountyId", "userId", "unitAmount", "buzzTransactionId")
          VALUES (60, ${SUPPORTER}, 100, ARRAY['bounty-60-7-1']);`);
    const withoutTable = async (run: () => Promise<unknown>) => {
      await db.exec(`ALTER TABLE "BountyUnpaidAward" RENAME TO "BountyUnpaidAwardAside"`);
      try {
        await run();
      } finally {
        await db.exec(`ALTER TABLE "BountyUnpaidAwardAside" RENAME TO "BountyUnpaidAward"`);
      }
    };

    it('hides a bounty a moderator deletes, at once and out of search, until it is resolved', async () => {
      await seedEnteredBounty(OTHER);
      await recordAward();

      await deleteBountyById({ id: 60, isModerator: true, userId: 1 });
      expect(await keptBounty()).toEqual([
        expect.objectContaining({ userId: null, availability: 'Private', owner: OWNER }),
      ]);
      expect(searchDeletes()).toEqual([{ id: 60, action: 'Delete' }]);

      await resolveAward();
      expect(await deleteSettledKeptBounties()).toBe(1);
      expect(await rows(`SELECT id FROM "Bounty"`)).toEqual([]);
    });

    it('keeps a settled kept bounty from the cleanup job, and its supporter rows', async () => {
      await seedReleased();
      await recordAward();
      expect(await deleteSettledKeptBounties()).toBe(0);
      expect(await rows(`SELECT "userId" FROM "BountyBenefactor"`)).toEqual([
        { userId: SUPPORTER },
      ]);

      await resolveAward();
      expect(await deleteSettledKeptBounties()).toBe(1);
    });

    it.each([
      ['a resolved award', () => recordAward(true)],
      ['an open award on another bounty', () => recordAward(false, SUPPORTER, 61)],
      [
        'a pre-table record that has a row in the table',
        async () => {
          await recordLegacy();
          await recordAward(true);
        },
      ],
      ['a pre-table record on another bounty', () => recordLegacy(SUPPORTER, 61)],
      [
        'a pre-table record on another entity with the same id',
        () => recordLegacy(SUPPORTER, 60, 'model'),
      ],
      [
        'another activity',
        () =>
          db.query(`INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId")
          VALUES (${SUPPORTER}, 'bountyAwardResolved', 'bounty', 60)`),
      ],
    ])('deletes a settled kept bounty with %s (control)', async (_, seed) => {
      await seedReleased();
      await seed();
      expect(await deleteSettledKeptBounties()).toBe(1);
    });

    it.each([
      ['no row in the table', async () => undefined],
      ['only another supporter resolved in the table', () => recordAward(true, OTHER)],
    ])('keeps a settled kept bounty with a pre-table record and %s', async (_, seed) => {
      await seedReleased();
      await recordLegacy();
      await seed();
      expect(await deleteSettledKeptBounties()).toBe(0);
    });

    it('fails closed without the table: a pre-table record keeps the bounty, and nothing throws', async () => {
      await seedReleased();
      await recordLegacy();
      await withoutTable(async () => {
        expect(await deleteSettledKeptBounties()).toBe(0);
        await db.exec(`DELETE FROM "ModActivity"`);
        expect(await deleteSettledKeptBounties()).toBe(1);
      });
    });

    it('backfills a pre-table record once, as open, with its amount, charge, owner and winner', async () => {
      await seedReleased();
      await db.exec(`UPDATE "Bounty" SET "userId" = NULL, "payoutWinnerUserId" = ${OTHER},
        meta = '{"removedWithOwner": true, "userIdBeforeRemoval": ${OWNER}}' WHERE id = 60`);
      await db.exec(`INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId", "createdAt")
        VALUES (${SUPPORTER}, 'bountyAwardUnpaid', 'bounty', 60, '2026-11-01T02:00:00Z'),
          (${SUPPORTER}, 'bountyAwardUnpaid', 'bounty', 60, '2026-11-01T01:00:00Z')`);
      await db.exec(unpaidAwardMigration);
      await db.exec(unpaidAwardMigration);
      expect(
        await rows(`SELECT "bountyId", "userId", "unitAmount", "buzzTransactionIds", "ownerId",
          "winnerUserId", "recordedById", "recordedAt", "resolvedAt" FROM "BountyUnpaidAward"`)
      ).toEqual([
        {
          bountyId: 60,
          userId: SUPPORTER,
          unitAmount: 100,
          buzzTransactionIds: ['bounty-60-7-1'],
          ownerId: OWNER,
          winnerUserId: OTHER,
          recordedById: null,
          recordedAt: new Date('2026-11-01T01:00:00Z'),
          resolvedAt: null,
        },
      ]);
      expect(await deleteSettledKeptBounties()).toBe(0);
    });

    it('backfills a supporter row with no charge array as an empty one', async () => {
      await seedReleased();
      await db.exec(`UPDATE "BountyBenefactor" SET "buzzTransactionId" = NULL`);
      await recordLegacy();
      await db.exec(unpaidAwardMigration);
      expect(await rows(`SELECT "buzzTransactionIds" FROM "BountyUnpaidAward"`)).toEqual([
        { buzzTransactionIds: [] },
      ]);
    });

    it('does not reopen a resolved award when the backfill runs again', async () => {
      await seedReleased();
      await recordLegacy();
      await db.exec(unpaidAwardMigration);
      await resolveAward();
      await db.exec(unpaidAwardMigration);
      expect(await rows(`SELECT ruling FROM "BountyUnpaidAward"`)).toEqual([
        { ruling: 'paid_winner' },
      ]);
      expect(await deleteSettledKeptBounties()).toBe(1);
    });
  });
});

describe("a held author's comments go with their parent", () => {
  const rows = async (sql: string) => (await db.query(sql)).rows;
  const reviewParent = () =>
    db.exec(`
      INSERT INTO "Model" VALUES (20, ${OTHER});
      INSERT INTO "ResourceReview" VALUES (30, ${OWNER}, 20, 21);`);
  const imageParent = () => db.exec(`INSERT INTO "Image" (id, "userId") VALUES (50, ${OWNER})`);
  const bountyParent = async () => {
    await db.exec(`INSERT INTO "Bounty" (id, "userId") VALUES (60, ${OWNER})`);
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
  };
  const bountyEntryParent = async () => {
    await db.exec(`
      INSERT INTO "Bounty" (id, "userId") VALUES (60, ${OTHER});
      INSERT INTO "BountyEntry" VALUES (61, ${OWNER}, 60);`);
    vi.mocked(dbMock.dbRead.bountyEntry.findUniqueOrThrow).mockResolvedValue({
      id: 61,
      bountyId: 60,
      userId: OWNER,
      bounty: { complete: true },
    } as never);
  };
  const articleParent = async () => {
    await db.exec(`
      INSERT INTO "Article" (id, "userId") VALUES (70, ${OWNER});`);
    vi.mocked(dbMock.dbWrite.article.findUnique).mockResolvedValue({ userId: OWNER } as never);
  };

  // [site, parent table, comment entity type, parent id, seed the parent, delete it]
  const sites: [string, string, string, number, () => Promise<unknown>, () => Promise<unknown>][] =
    [
      [
        'deleteImageById',
        'Image',
        'image',
        50,
        imageParent,
        () => deleteImageById({ id: 50, updatePost: false }),
      ],
      [
        'deleteImages',
        'Image',
        'image',
        50,
        imageParent,
        () => deleteImages([50], false).catch(() => undefined),
      ],
      [
        'deletePost',
        'Post',
        'post',
        10,
        () => db.exec(`INSERT INTO "Post" VALUES (10, ${OWNER})`),
        () => deletePost({ id: 10, isModerator: true }).catch(() => undefined),
      ],
      [
        'deleteBountyById',
        'Bounty',
        'bounty',
        60,
        bountyParent,
        () => deleteBountyById({ id: 60, isModerator: true, userId: 1 }),
      ],
      [
        'deleteBountyEntry',
        'BountyEntry',
        'bountyEntry',
        61,
        bountyEntryParent,
        () => deleteBountyEntry({ id: 61, isModerator: true }),
      ],
      [
        'deleteArticleById',
        'Article',
        'article',
        70,
        articleParent,
        () => deleteArticleById({ id: 70, userId: OWNER }),
      ],
      [
        'toggleReview',
        'ResourceReview',
        'review',
        30,
        reviewParent,
        () => toggleReview({ modelId: 20, userId: OWNER, setTo: false }).catch(() => undefined),
      ],
      [
        'deleteResourceReview',
        'ResourceReview',
        'review',
        30,
        reviewParent,
        () => deleteResourceReview({ id: 30 }).catch(() => undefined),
      ],
      [
        'deleteResourceReviews',
        'ResourceReview',
        'review',
        30,
        reviewParent,
        () => deleteResourceReviews({ ids: [30] }).catch(() => undefined),
      ],
    ];

  it.each(sites)(
    '%s takes its comments with a held reply among them, and keeps no detached copy',
    async (_, table, entityType, parentId, seed, remove) => {
      await seed();
      await seedComments(entityType, parentId, HELD);

      await remove();

      expect(await rows(`SELECT id FROM "${table}"`)).toEqual([]);
      expect(await commentIds()).toEqual([]);
    }
  );

  it('leaves a held reply on a parent it does not delete (control)', async () => {
    await db.exec(`INSERT INTO "Post" VALUES (10, ${OWNER}), (11, ${OWNER})`);
    await seedComments('post', 11, HELD);

    await deletePost({ id: 10, isModerator: true }).catch(() => undefined);

    expect(await rows(`SELECT id FROM "Post"`)).toEqual([{ id: 11 }]);
    expect(await commentIds()).toEqual([1, 2]);
  });

  it('refuses a post holding held text, for a moderator too, and keeps both', async () => {
    await db.exec(`
      INSERT INTO "Post" VALUES (10, ${OWNER});
      INSERT INTO "PostText" ("postId", "userId", "index", content, "csamHeld", "updatedAt")
      VALUES (10, ${OWNER}, 0, 'x', true, now());
    `);

    await expect(deletePost({ id: 10, isModerator: true })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringMatching(/held for review/),
    });

    expect(await rows(`SELECT id FROM "Post"`)).toEqual([{ id: 10 }]);
    expect(await rows(`SELECT "postId" AS id FROM "PostText"`)).toEqual([{ id: 10 }]);
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
});

describe('a member cannot act on a comment hidden for ToS', () => {
  beforeEach(async () => {
    await db.exec(`INSERT INTO "Post" VALUES (10, ${OWNER}), (11, ${OWNER})`);
    // 4 is hidden for ToS.
    await db.exec(`
      INSERT INTO "CommentTopic" ("entityType", "entityId") VALUES ('post', 11);
      INSERT INTO "CommentV3" (id, "entityType", "entityId", "userId", "tosViolation") VALUES
        (3, 'post', 11, ${OTHER}, false), (4, 'post', 11, ${OTHER}, true);
    `);
    vi.mocked(dbMock.dbWrite.$queryRawUnsafe).mockImplementation(
      (async (sql: string, ...params: unknown[]) => (await db.query(sql, params)).rows) as never
    );
    // Post 11 is published and rated, so its thread is readable.
    vi.mocked(dbMock.dbRead.post.findFirst).mockResolvedValue({ id: 11 } as never);
  });

  const track = new Proxy({}, { get: () => async () => undefined });
  const ctx = (isModerator: boolean) =>
    ({ user: { id: 9, isModerator }, track, features: {}, req: {} } as never);
  const writes = {
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
          input: { type: ReportEntity.CommentV3, id, reason: 'TOSViolation', details: {} } as never,
        }),
      service: createReport,
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
});
