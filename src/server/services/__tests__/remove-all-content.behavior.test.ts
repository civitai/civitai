import { imageUseTablesSql } from '@civitai/db-queries/test/image-uses';
import { DELETED_ROW_COLUMNS_SQL } from './deleted-row-columns.fixture';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import { Prisma } from '@prisma/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

/**
 * The two account-wide content wipes. Their deletes run as SQL against a Postgres stand-in;
 * `removeAllContent` and the delete-user-images endpoint are the real code.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { holder, indexes, metrics, session, pictures, tracked, docStore } = vi.hoisted(() => ({
  holder: { db: null as unknown as PGlite },
  indexes: Object.fromEntries(
    ['models', 'imagesMetrics', 'articles', 'collections', 'bounties', 'users'].map((name) => [
      name,
      { queueUpdate: vi.fn<(rows: { id: number; action: string }[]) => Promise<undefined>>() },
    ])
  ),
  metrics: {
    user: { queueUpdate: vi.fn<(ids: unknown) => Promise<undefined>>() },
    article: { queueUpdate: vi.fn<(ids: unknown) => Promise<undefined>>() },
  },
  session: {
    user: { id: 9, isModerator: true, bannedAt: null } as Record<string, unknown> | null,
  },
  pictures: { refresh: vi.fn<(ids: unknown) => Promise<undefined>>(async () => undefined) },
  tracked: vi.fn<(activity: unknown) => undefined>(() => undefined),
  docStore: {
    wipeAccount: vi.fn(async (_userId: number) => ({ namespaces: [], failures: [] })),
  },
}));

const { payout, searchQueue } = vi.hoisted(() => ({
  payout: { settles: false as boolean | 'throws', claimed: [] as number[] },
  searchQueue: vi.fn(async (_args: { indexName: string; items: unknown[] }) => undefined),
}));
vi.mock('~/server/services/bounty.service', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  // Each writes the payout columns as the real one does, so a re-run reads the state it left.
  settleBountyPayout: vi.fn(async (id: number) => {
    if (payout.settles === 'throws') throw new Error('buzz down');
    if (payout.settles)
      await holder.db.query(
        `UPDATE "Bounty" SET "payoutSettledAt" = "payoutRecordedAt" WHERE id = $1`,
        [id]
      );
    return payout.settles;
  }),
  refundUnpayableBountyAward: vi.fn(async () => false),
  claimBountyRefundForDelete: vi.fn(async (id: number) => {
    payout.claimed.push(id);
    await holder.db.query(
      `UPDATE "Bounty" SET complete = true, refunded = true, "payoutRecordedAt" = now() WHERE id = $1`,
      [id]
    );
    return { owed: true, firstAttempt: true };
  }),
}));
vi.mock('~/server/search-index/SearchIndexUpdate', () => ({
  SearchIndexUpdate: { queueUpdate: searchQueue },
}));

const { bustMvCache, contentCounts } = vi.hoisted(() => ({
  bustMvCache: vi.fn(async () => undefined),
  contentCounts: { refresh: vi.fn(async () => undefined) },
}));
vi.mock('~/server/services/model-version.service', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  bustMvCache,
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  profilePictureCache: pictures,
  userContentOverviewCache: contentCounts,
}));
vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  Tracker: class {
    userActivity = tracked;
  },
}));

vi.mock('~/server/search-index', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  modelsSearchIndex: indexes.models,
  imagesMetricsSearchIndex: indexes.imagesMetrics,
  articlesSearchIndex: indexes.articles,
  collectionsSearchIndex: indexes.collections,
  bountiesSearchIndex: indexes.bounties,
  usersSearchIndex: indexes.users,
}));
vi.mock('~/server/metrics', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  userMetrics: metrics.user,
  articleMetrics: metrics.article,
}));
// The DELETE `deleteImages` issues, with its `onlyWhere`; storage and caches are not under test.
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  deleteImages: vi.fn(async (ids: number[], opts?: { onlyWhere?: Prisma.Sql }) => {
    if (!ids.length) return [];
    const where = opts?.onlyWhere ? Prisma.sql`AND (${opts.onlyWhere})` : Prisma.empty;
    const sql = Prisma.sql`DELETE FROM "Image" WHERE id = ANY(${ids}::int[]) ${where} RETURNING id`;
    return (await holder.db.query(sql.text, sql.values)).rows;
  }),
}));
vi.mock('~/server/services/auction.service', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  refundBidsForVersions: vi.fn(async () => ({
    bidsDeleted: [] as number[],
    recurringBidsDeleted: [] as number[],
    refundFailed: [] as string[],
  })),
}));
vi.mock('~/server/services/apps/user-storage-purge.service', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  purgeUserAppStorageForAccountWipe: vi.fn(async ({ targetUserId }: { targetUserId: number }) => ({
    userId: targetUserId,
    purgeBatchId: 'apg_test',
    results: [],
    failures: [],
    unmappedSchemas: [],
    schemasTruncated: false,
    totals: { appCount: 0, deletedRowCount: 0, deletedBytes: 0 },
  })),
}));
vi.mock('~/server/services/apps/doc-store-maintenance.instance', () => ({
  getDocStoreMaintenance: () => docStore,
}));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: async () => session,
}));

import { ProfileArchiveRefusedError, removeAllContent } from '~/server/services/user.service';
import { PURGE_ARCHIVE_REFUSAL } from '@civitai/shared/account-action-texts';
import {
  deleteSettledKeptBounties,
  retryUnsettledBountyPayouts,
} from '~/server/services/bounty.service';
import { deleteImages } from '~/server/services/image.service';
import { FEEDBACK_CAPTURE_OWNER_ID } from '@civitai/shared/feedback-capture';
import { refundBidsForVersions } from '~/server/services/auction.service';
import { purgeUserAppStorageForAccountWipe } from '~/server/services/apps/user-storage-purge.service';
import deleteUserImages from '~/server/api-routes/mod/delete-user-images';
import removeAllContentWebhook from '~/server/api-routes/mod/remove-all-content';

const CLEAN = 1;
const REPORTED = 2; // named on a pending report
const OTHER = 3;
const BYSTANDER = 9;
// CLEAN's rows, seeded first; each table's ids start apart so an id names one table.
const COLLECTION = 300;
const ARTICLE = 500;
const MODEL = 700;
const BOUNTY = 900;
const MODEL_VERSION = (modelId: number) => modelId * 10;
const EVIDENCE = [
  'BountyEntry',
  'Bounty',
  'ResourceReview',
  'Article',
  'Post',
  'Model',
  'ChatMessage',
  'ChatMember',
];
/** Every table seeded with one row per account. */
const SEEDED_TABLES = EVIDENCE;
// Kept as data with no code for them: the wipe leaves these rows alone.
const QA_DATA = ['Question', 'Answer'];

/** Fails the wipe's read of which of its models are gone. */
let failGoneModels = false;
/** Rows the primary has and the replica does not yet: made inside replication lag. */
let notYetOnReplica: number[] = [];

const run = (sql: Prisma.Sql) => holder.db.query(sql.text, sql.values);
const asSql = (first: TemplateStringsArray | Prisma.Sql, values: unknown[]) =>
  Array.isArray(first)
    ? Prisma.sql(first as TemplateStringsArray, ...(values as never[]))
    : (first as Prisma.Sql);

beforeAll(async () => {
  holder.db = new PGlite({ extensions: { ltree } });
  await holder.db.exec(`
    CREATE TABLE "CsamReport" (
      id serial PRIMARY KEY, "userId" int, "reportSentAt" timestamp(3), "archivedAt" timestamp(3),
      details jsonb NOT NULL DEFAULT '{}', images jsonb NOT NULL DEFAULT '[]'
    );
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL, "postId" int, "needsReview" text, "blockedFor" text,
      minor boolean NOT NULL DEFAULT false
    );
    CREATE TABLE "User" (id int PRIMARY KEY, meta jsonb DEFAULT '{}', "bannedAt" timestamp(3));
    ${[...SEEDED_TABLES, ...QA_DATA]
      .map((t) => `CREATE TABLE "${t}" (id serial PRIMARY KEY, "userId" int NOT NULL);`)
      .join('\n')}
    ALTER TABLE "Post" ADD COLUMN "publishedAt" timestamp, ADD COLUMN metadata jsonb;
    CREATE TABLE "BountyBenefactor" ("awardedToId" int REFERENCES "BountyEntry"(id) ON DELETE SET NULL);
    ALTER TABLE "BountyBenefactor" ADD COLUMN "bountyId" int REFERENCES "Bounty"(id) ON DELETE CASCADE;
    ALTER TABLE "BountyEntry" ADD COLUMN "bountyId" int REFERENCES "Bounty"(id) ON DELETE CASCADE;
    ALTER TABLE "Answer" ADD COLUMN "questionId" int REFERENCES "Question"(id) ON DELETE CASCADE;
    ALTER TABLE "ResourceReview" ADD COLUMN "modelId" int REFERENCES "Model"(id) ON DELETE CASCADE;
    ALTER TABLE "Model" ADD COLUMN "deletedAt" timestamp(3), ADD COLUMN "updatedAt" timestamp(3);
    CREATE DOMAIN "Availability" AS text;
    ALTER TABLE "Bounty" ADD COLUMN availability "Availability" NOT NULL DEFAULT 'Public',
      ADD COLUMN meta jsonb, ADD COLUMN "payoutSettledAt" timestamp(3),
      ADD COLUMN "payoutRecordedAt" timestamp(3), ADD COLUMN "payoutWinnerUserId" int,
      ADD COLUMN complete boolean NOT NULL DEFAULT false,
      ADD COLUMN refunded boolean NOT NULL DEFAULT false;
    CREATE TABLE "File" (id serial PRIMARY KEY, "entityType" text, "entityId" int);
    CREATE DOMAIN "ArticleStatus" AS text;
    ALTER TABLE "Article" ADD COLUMN status "ArticleStatus" NOT NULL DEFAULT 'Published',
      ADD COLUMN "updatedAt" timestamp(3), ADD COLUMN "scheduledAt" timestamp(3), ADD COLUMN metadata jsonb;
    CREATE TABLE "ModActivity" (
      id serial PRIMARY KEY, "userId" int, activity text NOT NULL, "entityType" text, "entityId" int,
      "createdAt" timestamp(3) NOT NULL DEFAULT now()
    );
    ALTER TABLE "BountyBenefactor" ADD COLUMN "userId" int,
      ADD COLUMN "unitAmount" int NOT NULL DEFAULT 0,
      ADD COLUMN "buzzTransactionId" text[] NOT NULL DEFAULT '{}';
    -- As production: a topic goes with its entity (a partition per entity type, each with its
    -- cascading key; the rest share one with none here), its comments with it, and a comment with
    -- replies cannot be deleted on its own.
    CREATE TABLE "CommentTopic" (
      "entityType" text NOT NULL, "entityId" int NOT NULL, PRIMARY KEY ("entityId", "entityType")
    ) PARTITION BY LIST ("entityType");
    ${Object.entries({ post: 'Post', review: 'ResourceReview', article: 'Article', model: 'Model' })
      .map(
        ([type, table]) => `
    CREATE TABLE "CommentTopic_${type}" PARTITION OF "CommentTopic" FOR VALUES IN ('${type}');
    ALTER TABLE "CommentTopic_${type}"
      ADD FOREIGN KEY ("entityId") REFERENCES "${table}"(id) ON DELETE CASCADE;`
      )
      .join('')}
    CREATE TABLE "CommentTopic_other" PARTITION OF "CommentTopic" DEFAULT;
    CREATE TABLE "Collection" (id serial PRIMARY KEY, "userId" int NOT NULL);
    CREATE EXTENSION ltree;
    CREATE TABLE "CommentV3" (
      id int PRIMARY KEY, "entityType" text NOT NULL, "entityId" int NOT NULL,
      "parentId" int REFERENCES "CommentV3"(id) ON DELETE RESTRICT,
      "replyToId" int, path ltree NOT NULL, "rootId" int GENERATED ALWAYS AS (ltree2text(subpath(path, 0, 1))::int) STORED, "userId" int NOT NULL, content text NOT NULL,
      "tosViolation" boolean NOT NULL DEFAULT false, "deletedAt" timestamptz, "updatedAt" timestamptz,
      "legacyV1Id" int, "pinnedAt" timestamptz,
      FOREIGN KEY ("entityId", "entityType") REFERENCES "CommentTopic" ON DELETE CASCADE
    );
    CREATE TABLE "CommentV3Report" (
      "reportId" int PRIMARY KEY, "commentId" int NOT NULL REFERENCES "CommentV3"(id) ON DELETE CASCADE
    );
    CREATE TABLE "CommentV3Reaction" (
      "commentId" int NOT NULL REFERENCES "CommentV3"(id) ON DELETE CASCADE, "userId" int NOT NULL
    );
    CREATE TYPE "ModelStatus" AS ENUM (
      'Draft', 'Training', 'Published', 'Scheduled', 'Unpublished', 'UnpublishedViolation',
      'GatherInterest', 'Deleted'
    );
    ALTER TABLE "Model" ADD COLUMN status text NOT NULL DEFAULT 'Published', ADD COLUMN meta jsonb;
    CREATE TABLE "ModelVersion" (
      id serial PRIMARY KEY, "modelId" int NOT NULL, status text NOT NULL DEFAULT 'Published'
    );
  `);
  await holder.db.exec(`
    CREATE TYPE "EntityType" AS ENUM ('Image', 'Post');
    CREATE TYPE "JobQueueType" AS ENUM ('PendingDelete', 'ImageStorageDelete', 'UpdateNsfwLevel', 'CdnAccessSync');
    CREATE TABLE "JobQueue" (
      "entityId" int NOT NULL, "entityType" "EntityType" NOT NULL, type "JobQueueType" NOT NULL,
      data jsonb, "createdAt" timestamp NOT NULL DEFAULT now(),
      UNIQUE ("entityType", "entityId", type)
    );
  `);
  await holder.db.exec(imageUseTablesSql);
  await holder.db.exec(
    readFileSync(
      path.resolve(
        __dirname,
        '../../../../packages/civitai-db-schema/prisma/migrations/20261217120000_bounty_unpaid_award/migration.sql'
      ),
      'utf8'
    )
  );
  await holder.db.exec(
    readFileSync(
      path.resolve(
        __dirname,
        '../../../../packages/civitai-db-schema/prisma/migrations/20261209120000_model_ownership/migration.sql'
      ),
      'utf8'
    )
  );
  // The content wipe asks it whether a post holds held text.
  await holder.db.exec(
    readFileSync(
      path.resolve(
        __dirname,
        '../../../../packages/civitai-db-schema/prisma/migrations/20270108093000_post_text/migration.sql'
      ),
      'utf8'
    )
  );
  await holder.db.exec(DELETED_ROW_COLUMNS_SQL);
});

beforeEach(async () => {
  vi.clearAllMocks();
  failGoneModels = false;
  notYetOnReplica = [];
  session.user = { id: 9, isModerator: true, bannedAt: null };
  await holder.db.exec(`
    TRUNCATE "CsamReport", "Image", "PostText", "BountyBenefactor", "Collection", "ModelVersion",
      "CommentV3", "CommentV3Report", "CommentV3Reaction", "CommentTopic",
      "ModActivity", "BountyUnpaidAward",
      ${[...SEEDED_TABLES, ...QA_DATA].map((t) => `"${t}"`).join(', ')} RESTART IDENTITY;
    ALTER SEQUENCE "Collection_id_seq" RESTART ${COLLECTION};
    ALTER SEQUENCE "Article_id_seq" RESTART ${ARTICLE};
    ALTER SEQUENCE "Model_id_seq" RESTART ${MODEL};
    ALTER SEQUENCE "Bounty_id_seq" RESTART ${BOUNTY};
    INSERT INTO "Collection" ("userId") VALUES (${CLEAN}), (${REPORTED}), (${OTHER}), (${BYSTANDER});
    INSERT INTO "CsamReport" ("userId") VALUES (${REPORTED});
    INSERT INTO "Image" (id, "userId", "postId") VALUES
      (${CLEAN * 100}, ${CLEAN}, 1), (${CLEAN * 100 + 1}, ${CLEAN}, 1),
      (${REPORTED * 100}, ${REPORTED}, NULL), (${OTHER * 100}, ${OTHER}, NULL),
      (${BYSTANDER * 100}, ${BYSTANDER}, NULL);
    ${[...SEEDED_TABLES, ...QA_DATA]
      .map(
        (t) =>
          `INSERT INTO "${t}" ("userId") VALUES (${CLEAN}), (${REPORTED}), (${OTHER}), (${BYSTANDER});`
      )
      .join('\n')}
  `);

  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (
    first: TemplateStringsArray | Prisma.Sql,
    ...values: unknown[]
  ) => {
    const sql = asSql(first, values);
    if (failGoneModels && sql.text.includes('FROM "Model" WHERE id = ANY'))
      throw new Error('connection reset');
    return (await run(sql)).rows;
  }) as never);
  vi.mocked(dbMock.dbWrite.$queryRawUnsafe).mockImplementation(
    (async (sql: string, ...params: unknown[]) =>
      (await holder.db.query(sql, params)).rows) as never
  );
  vi.mocked(dbMock.dbWrite.$executeRaw).mockImplementation((async (
    first: TemplateStringsArray | Prisma.Sql,
    ...values: unknown[]
  ) => {
    const sql = asSql(first, values);
    return (await run(sql)).affectedRows ?? 0;
  }) as never);
  const rowsOf = (table: string, columns: string, replica = false) =>
    (async (args: { where: { userId: number } }) =>
      (
        await holder.db.query(
          `SELECT ${columns} FROM "${table}" WHERE "userId" = $1 AND id <> ALL($2::int[])`,
          [args.where.userId, replica ? notYetOnReplica : []]
        )
      ).rows) as never;
  for (const [db, replica] of [
    [dbMock.dbRead, true],
    [dbMock.dbWrite, false],
  ] as const) {
    vi.mocked(db.image.findMany).mockImplementation(rowsOf('Image', 'id, "postId"', replica));
    vi.mocked(db.article.findMany).mockImplementation(rowsOf('Article', 'id', replica));
    vi.mocked(db.collection.findMany).mockImplementation(rowsOf('Collection', 'id', replica));
  }
  // Each model has one version, MODEL_VERSION(id). Only the selected fields come back, as from
  // Prisma, so a select that drops one is visible.
  const modelsOf = (replica: boolean) =>
    (async (args: { where: { userId: number }; select: Record<string, unknown> }) =>
      (
        await holder.db.query<{ id: number }>(
          `SELECT id FROM "Model" WHERE "userId" = $1 AND id <> ALL($2::int[]) ORDER BY id`,
          [args.where.userId, replica ? notYetOnReplica : []]
        )
      ).rows.map(({ id }) => {
        const row: Record<string, unknown> = {
          id,
          name: 'zzfixture',
          modelVersions: [{ id: MODEL_VERSION(id) }],
        };
        return Object.fromEntries(Object.entries(row).filter(([k]) => args.select?.[k]));
      })) as never;
  vi.mocked(dbMock.dbRead.model.findMany).mockImplementation(modelsOf(true));
  vi.mocked(dbMock.dbWrite.model.findMany).mockImplementation(modelsOf(false));
  vi.mocked(dbMock.dbWrite.collection.deleteMany).mockImplementation((async (args: {
    where: { userId: number };
  }) => ({
    count: (
      await holder.db.query(`DELETE FROM "Collection" WHERE "userId" = $1`, [args.where.userId])
    ).affectedRows,
  })) as never);
  // The account's bounties, less any kept.
  payout.settles = false;
  payout.claimed = [];
  vi.mocked(dbMock.dbWrite.bounty.findMany).mockImplementation((async (args: {
    where: { userId: number; id?: { notIn: number[] } };
  }) => {
    const kept = args.where.id?.notIn ?? [];
    return (
      await holder.db.query(
        `SELECT id FROM "Bounty" WHERE "userId" = $1 AND id <> ALL($2::int[])`,
        [args.where.userId, kept]
      )
    ).rows;
  }) as never);
});

/** The alertable lines for bids a wipe could not refund. */
const refundAlerts = () =>
  vi
    .mocked(loggingMock.logToAxiom)
    .mock.calls.map(([line]) => line as Record<string, unknown>)
    .filter((line) => line.name === 'bid-refund-failed');

/** The ids each search index was asked to drop. */
function dropped() {
  return Object.fromEntries(
    Object.entries(indexes).map(([name, index]) => [
      name,
      index.queueUpdate.mock.calls.flatMap(([rows]) =>
        rows.map((r) => (r.action === 'Delete' ? r.id : `${r.action} ${r.id}`))
      ),
    ])
  );
}
const NONE = {
  models: [],
  imagesMetrics: [],
  articles: [],
  collections: [],
  bounties: [],
  users: [],
};

/** Rows left per table for `userId`, images included. */
async function remaining(userId: number) {
  const counts: Record<string, number> = {};
  for (const t of [...SEEDED_TABLES, 'Image'])
    counts[t] = Number(
      (
        await holder.db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM "${t}" WHERE "userId" = $1`,
          [userId]
        )
      ).rows[0].n
    );
  return counts;
}
const all = (n: number) => Object.fromEntries([...SEEDED_TABLES, 'Image'].map((t) => [t, n]));
/** What the seed gives `userId`: one row per table, and two images for CLEAN. */
const seeded = (userId: number) => ({ ...all(1), Image: userId === CLEAN ? 2 : 1 });
/** CommentV3 rows of `userId`'s still there. */
const commentsOf = async (userId: number) =>
  (
    await holder.db.query<{ id: number }>(
      `SELECT id FROM "CommentV3" WHERE "userId" = $1 ORDER BY id`,
      [userId]
    )
  ).rows.map((r) => r.id);

describe('removeAllContent', () => {
  it('wipes the account, and no one else’s', async () => {
    expect(await removeAllContent({ id: CLEAN })).toEqual({ incomplete: [] });

    expect(await remaining(CLEAN)).toEqual(all(0));
    expect(await remaining(BYSTANDER)).toEqual(all(1));
    for (const t of QA_DATA) {
      const left = await holder.db.query(`SELECT 1 FROM "${t}" WHERE "userId" = ${CLEAN}`);
      expect(left.rows, t).toHaveLength(1);
    }
    expect(dropped()).toEqual({
      models: [MODEL],
      imagesMetrics: [CLEAN * 100, CLEAN * 100 + 1],
      articles: [ARTICLE],
      collections: [COLLECTION],
      bounties: [BOUNTY],
      users: [CLEAN],
    });
    expect(metrics.user.queueUpdate).toHaveBeenCalledWith(CLEAN);
    expect(metrics.article.queueUpdate).toHaveBeenCalledWith([ARTICLE]);
    // Rows, storage objects and caches: the listed images, then any uploaded since the list was
    // read (none here).
    expect(deleteImages).toHaveBeenCalledTimes(2);
    expect(deleteImages).toHaveBeenNthCalledWith(1, [CLEAN * 100, CLEAN * 100 + 1], {
      actor: { system: 'remove-all-content' },
      moderatorDelete: true,
    });
    expect(deleteImages).toHaveBeenNthCalledWith(2, [], {
      actor: { system: 'remove-all-content' },
      onlyWhere: expect.anything(),
      moderatorDelete: true,
    });
    expect(purgeUserAppStorageForAccountWipe).toHaveBeenCalledWith(
      expect.objectContaining({ targetUserId: CLEAN })
    );
  });

  // In-case images are kept by the delete's own case check, not by refusing the account.
  it('wipes an account named on a pending CSAM report', async () => {
    expect(await removeAllContent({ id: REPORTED })).toEqual({ incomplete: [] });

    expect(await remaining(REPORTED)).toEqual(all(0));
    expect(await remaining(BYSTANDER)).toEqual(all(1));
    expect(deleteImages).toHaveBeenNthCalledWith(1, [REPORTED * 100], expect.anything());
  });

  it('wipes an account banned with a note naming CSAM or NCMEC', async () => {
    await holder.db.query(
      `INSERT INTO "User" (id, meta, "bannedAt") VALUES ($1, $2, now() - interval '1 day')`,
      [CLEAN, JSON.stringify({ banDetails: { detailsExternal: 'Reported to NCMEC' } })]
    );
    try {
      await removeAllContent({ id: CLEAN });
      expect(await remaining(CLEAN)).toEqual(all(0));
    } finally {
      await holder.db.exec(`DELETE FROM "User"`);
    }
  });

  // A moderator's wipe deletes as that moderator, so no member ownership limit applies.
  it('deletes the images as the moderator who ordered the wipe', async () => {
    await removeAllContent({ id: CLEAN, actorUserId: 9 });

    expect(await remaining(CLEAN)).toEqual(all(0));
    const actors = vi.mocked(deleteImages).mock.calls.map(([, opts]) => opts.actor);
    expect(actors).toEqual([
      { id: 9, isModerator: true },
      { id: 9, isModerator: true },
    ]);
  });

  // Its content is every reporter's page captures; each one is acted on as an image instead.
  it('refuses the feedback capture account, deleting nothing', async () => {
    const CAPTURE = FEEDBACK_CAPTURE_OWNER_ID;
    await holder.db.exec(`INSERT INTO "Image" (id, "userId") VALUES (9703, ${CAPTURE})`);
    await expect(removeAllContent({ id: CAPTURE })).rejects.toThrow(/feedback page captures/);
    const left = await holder.db.query<{ id: number }>(
      `SELECT id FROM "Image" WHERE "userId" = ${CAPTURE} ORDER BY id`
    );
    expect(left.rows.map((r) => r.id)).toEqual([9703]);
  });

  // On someone else's content, so only the comment pass reaches them.
  describe('the account’s comments', () => {
    beforeEach(async () => {
      await holder.db.exec(`
        INSERT INTO "CommentTopic" ("entityType", "entityId") VALUES ('image', 1), ('model3dReview', 1);
        INSERT INTO "CommentV3" (id, "entityType", "entityId", "parentId", path, "userId", content) VALUES
          (91, 'image', 1, NULL, '91', ${CLEAN}, 'gone'),
          (92, 'image', 1, NULL, '92', ${CLEAN}, 'kept as a placeholder'),
          (93, 'image', 1, 92, '92.93', ${BYSTANDER}, 'a reply by someone else'),
          (94, 'model3dReview', 1, NULL, '94', ${CLEAN}, 'a 3D model review comment'),
          (95, 'image', 1, NULL, '95', ${CLEAN}, 'above a reported author''s reply'),
          (96, 'image', 1, 95, '95.96', ${REPORTED}, 'a reported author''s reply');
        INSERT INTO "CommentV3Reaction" ("commentId", "userId") VALUES (93, ${CLEAN}), (93, ${BYSTANDER});
      `);
    });
    const v3 = async () =>
      (
        await holder.db.query<{ id: number; content: string; deleted: boolean; tos: boolean }>(
          `SELECT id, content, "deletedAt" IS NOT NULL AS deleted, "tosViolation" AS tos
           FROM "CommentV3" ORDER BY id`
        )
      ).rows;

    it('are wiped on every surface, with a placeholder above a reply', async () => {
      await removeAllContent({ id: CLEAN });
      expect(await v3()).toEqual([
        { id: 92, content: '', deleted: true, tos: false },
        { id: 93, content: 'a reply by someone else', deleted: false, tos: false },
        { id: 95, content: '', deleted: true, tos: false },
        { id: 96, content: "a reported author's reply", deleted: false, tos: false },
      ]);
      // The account's reactions go too, and no one else's.
      const reactors = await holder.db.query<{ userId: number }>(
        `SELECT "userId" FROM "CommentV3Reaction" ORDER BY 1`
      );
      expect(reactors.rows).toEqual([{ userId: BYSTANDER }]);
    });

    it('deletes an article of the account and its comments, a reported author’s comment included', async () => {
      await holder.db.exec(`
        INSERT INTO "Article" (id, "userId") VALUES (777, ${CLEAN});
        INSERT INTO "CommentTopic" ("entityType", "entityId") VALUES ('article', 777);
        INSERT INTO "CommentV3" (id, "entityType", "entityId", "parentId", path, "userId", content) VALUES
          (97, 'article', 777, NULL, '97', ${REPORTED}, 'reported, on the account''s article');
      `);
      await removeAllContent({ id: CLEAN });
      expect(
        (await holder.db.query(`SELECT id FROM "Article" WHERE "userId" = ${CLEAN}`)).rows
      ).toEqual([]);
      expect(await commentsOf(REPORTED)).not.toContain(97);
    });
  });

  const bystanderCommentsOnItsReviews = () =>
    holder.db.exec(`
      INSERT INTO "CommentTopic" ("entityType", "entityId")
        SELECT 'review', id FROM "ResourceReview" WHERE "userId" = ${CLEAN};
      INSERT INTO "CommentV3" (id, "entityType", "entityId", path, "userId", content)
        SELECT 8000 + id, 'review', id, (8000 + id)::text::ltree, ${BYSTANDER}, 'on its review'
        FROM "ResourceReview" WHERE "userId" = ${CLEAN};
    `);

  it('takes the comments on its reviews with it', async () => {
    await bystanderCommentsOnItsReviews();
    await removeAllContent({ id: CLEAN });
    expect(await commentsOf(BYSTANDER)).toEqual([]);
  });

  // Not refund idempotency (that is the bid filter, in auction-refund-bids-for-versions.test.ts):
  // the second run finds no models, refunds nothing, and is not refused.
  it('runs a second time without refusing, and with no models left to refund', async () => {
    await removeAllContent({ id: CLEAN });
    vi.mocked(refundBidsForVersions).mockClear();
    expect(await removeAllContent({ id: CLEAN })).toEqual({ incomplete: [] });
    expect(refundBidsForVersions).not.toHaveBeenCalled();
  });

  it('names the bid refunds when a refund failed after its bid was cancelled', async () => {
    vi.mocked(refundBidsForVersions).mockResolvedValueOnce({
      bidsDeleted: [1],
      recurringBidsDeleted: [],
      refundFailed: ['tx-1'],
    });
    expect(await removeAllContent({ id: CLEAN, actorUserId: 9 })).toEqual({
      incomplete: ['bid-refunds'],
    });
    expect(refundAlerts()).toEqual([
      expect.objectContaining({
        userId: CLEAN,
        moderatorId: 9,
        versionIds: [MODEL_VERSION(MODEL)],
        transactionIds: ['tx-1'],
      }),
    ]);
  });

  it('raises no refund alert when every refund went through', async () => {
    await removeAllContent({ id: CLEAN, actorUserId: 9 });
    expect(refundAlerts()).toEqual([]);
  });

  it('names the bid refunds, and refunds nothing, when it cannot tell which models went', async () => {
    failGoneModels = true;
    expect(await removeAllContent({ id: CLEAN })).toEqual({
      incomplete: ['bid-refunds'],
    });
    expect(refundBidsForVersions).not.toHaveBeenCalled();
  });

  it('names the versions to check, and none to refund, when it cannot tell which models went', async () => {
    failGoneModels = true;
    await removeAllContent({ id: CLEAN, actorUserId: 9 });
    const alerts = refundAlerts();
    expect(alerts).toEqual([
      expect.objectContaining({ modelIds: [MODEL], candidateVersionIds: [MODEL_VERSION(MODEL)] }),
    ]);
    expect(alerts[0]).not.toHaveProperty('versionIds');
    expect(alerts[0].message).not.toMatch(/refund them/);
  });

  it('drops from storage and the indexes the rows the replica does not have yet', async () => {
    await holder.db.exec(`
      INSERT INTO "Image" (id, "userId", "postId") VALUES (${CLEAN * 100 + 2}, ${CLEAN}, 1);
      INSERT INTO "Article" (id, "userId") VALUES (${ARTICLE + 60}, ${CLEAN});
      INSERT INTO "Collection" (id, "userId") VALUES (${COLLECTION + 60}, ${CLEAN});
    `);
    notYetOnReplica = [CLEAN * 100 + 2, ARTICLE + 60, COLLECTION + 60];
    await removeAllContent({ id: CLEAN });
    expect(vi.mocked(deleteImages).mock.calls[0][0]).toContain(CLEAN * 100 + 2);
    expect(dropped().articles).toContain(ARTICLE + 60);
    expect(dropped().collections).toContain(COLLECTION + 60);
  });

  it('refunds the bids on a model the replica does not have yet', async () => {
    await holder.db.exec(`INSERT INTO "Model" (id, "userId") VALUES (${MODEL + 60}, ${CLEAN})`);
    notYetOnReplica = [MODEL + 60];
    await removeAllContent({ id: CLEAN });
    expect((await remaining(CLEAN)).Model).toBe(0);
    expect(refundBidsForVersions).toHaveBeenCalledWith(
      expect.objectContaining({ versionIds: [MODEL_VERSION(MODEL + 60)] })
    );
  });

  it('still refunds the next model when one model’s refund throws', async () => {
    await holder.db.exec(`INSERT INTO "Model" (id, "userId") VALUES (${MODEL + 50}, ${CLEAN})`);
    vi.mocked(refundBidsForVersions).mockRejectedValueOnce(new Error('auction read failed'));
    expect(await removeAllContent({ id: CLEAN })).toEqual({
      incomplete: ['bid-refunds'],
    });
    expect(refundBidsForVersions).toHaveBeenCalledTimes(2);
    expect(refundBidsForVersions).toHaveBeenLastCalledWith(
      expect.objectContaining({ versionIds: [MODEL_VERSION(MODEL + 50)] })
    );
  });

  it('refunds the bids on its models by version, after the models are gone', async () => {
    await removeAllContent({ id: CLEAN });
    expect(refundBidsForVersions).toHaveBeenCalledTimes(1);
    expect(refundBidsForVersions).toHaveBeenCalledWith({
      versionIds: [MODEL_VERSION(MODEL)],
      name: 'zzfixture',
      notificationKey: MODEL,
    });
    expect((await remaining(CLEAN)).Model).toBe(0);
    expect(dbMock.dbWrite.model.findFirst).not.toHaveBeenCalled();
  });

  it('runs every later step when the bid refunds fail, and names the failed one', async () => {
    vi.mocked(refundBidsForVersions).mockRejectedValueOnce(new Error('buzz down'));
    expect(await removeAllContent({ id: CLEAN })).toEqual({
      incomplete: ['bid-refunds'],
    });
    expect(purgeUserAppStorageForAccountWipe).toHaveBeenCalledTimes(1);
    expect(docStore.wipeAccount).toHaveBeenCalledWith(CLEAN);
  });

  it('still wipes the document store when the App Blocks purge fails, and names it', async () => {
    vi.mocked(purgeUserAppStorageForAccountWipe).mockRejectedValueOnce(new Error('apps db down'));
    expect(await removeAllContent({ id: CLEAN })).toEqual({
      incomplete: ['app-storage'],
    });
    expect(docStore.wipeAccount).toHaveBeenCalledWith(CLEAN);
  });

  it('runs the later index and metric steps when one index fails', async () => {
    indexes.models.queueUpdate.mockRejectedValueOnce(new Error('queue down'));
    expect(await removeAllContent({ id: CLEAN })).toEqual({
      incomplete: ['index-models'],
    });
    expect(dropped().users).toEqual([CLEAN]);
    expect(metrics.article.queueUpdate).toHaveBeenCalledWith([ARTICLE]);
    expect(refundBidsForVersions).toHaveBeenCalledTimes(1);
  });

  it('names a document store wipe that failed', async () => {
    docStore.wipeAccount.mockRejectedValueOnce(new Error('store down'));
    expect(await removeAllContent({ id: CLEAN })).toEqual({
      incomplete: ['doc-store'],
    });
  });

  it('refreshes the account’s content counts', async () => {
    await removeAllContent({ id: CLEAN });
    expect(contentCounts.refresh).toHaveBeenCalledWith(CLEAN);
  });

  it('keeps a bounty entry that won an award', async () => {
    await holder.db.exec(`
      INSERT INTO "BountyEntry" ("userId") VALUES (${CLEAN});
      INSERT INTO "BountyBenefactor" ("awardedToId") SELECT max(id) FROM "BountyEntry";
    `);
    await removeAllContent({ id: CLEAN });
    expect(await remaining(CLEAN)).toEqual({ ...all(0), BountyEntry: 1 });
  });

  it('refreshes the account’s cached profile picture after deleting its images', async () => {
    await removeAllContent({ id: CLEAN });
    expect(pictures.refresh).toHaveBeenCalledWith([CLEAN]);
  });
});

/**
 * The moderator app's real body reader and purge texts, loaded across the app boundary by path. It
 * matches the reason against those texts by equality, so a body-shape drift turns a refusal into a
 * generic failure.
 */
const moderator = {} as {
  restErrorReason: (body: unknown, status: number) => string | null;
  PURGE_ARCHIVE_REFUSAL: string;
  purgeWarning: (body: unknown) => string | undefined;
  PURGE_INCOMPLETE: string;
};
beforeAll(async () => {
  const lib = path.resolve(__dirname, '../../../..', 'apps/moderator/src/lib');
  const [reader, purge] = await Promise.all([
    import(/* @vite-ignore */ path.join(lib, 'server/rest-error-reason.ts')),
    import(/* @vite-ignore */ path.join(lib, 'purge-result.ts')),
  ]);
  Object.assign(moderator, {
    restErrorReason: reader.restErrorReason,
    PURGE_ARCHIVE_REFUSAL,
    purgeWarning: purge.purgeWarning,
    PURGE_INCOMPLETE: purge.PURGE_INCOMPLETE,
  });
  expect(typeof moderator.purgeWarning).toBe('function');
  expect(typeof moderator.restErrorReason).toBe('function');
  expect(moderator.restErrorReason({ nothingReadable: true }, 403)).toBeNull();
});
const moderatorReads = (res: { body: unknown; statusCode: number }) =>
  moderator.restErrorReason(res.body, res.statusCode);

/** A Next API response that records what the handler sent. */
function fakeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    setHeader: vi.fn(),
    status: (code: number) => {
      res.statusCode = code;
      return res;
    },
    json: (body: unknown) => {
      res.body = body;
      return res;
    },
  };
  return res;
}

// Comments go with the content they are on, whoever wrote them.
describe('removeAllContent and other people’s comments on its content', () => {
  const rows = async (sql: string) => (await holder.db.query<Record<string, unknown>>(sql)).rows;

  it('takes the comments on a deleted post with it, a reported author’s reply included', async () => {
    // BYSTANDER comments on CLEAN's post; REPORTED answers.
    await holder.db.exec(`
      INSERT INTO "CommentTopic" ("entityType", "entityId") VALUES ('post', 1);
      INSERT INTO "CommentV3" (id, "entityType", "entityId", "parentId", path, "userId", content) VALUES
        (5000, 'post', 1, NULL, '5000', ${BYSTANDER}, 'on its post'),
        (5001, 'post', 1, 5000, '5000.5001', ${REPORTED}, 'a reported author''s reply');
    `);

    await removeAllContent({ id: CLEAN });

    expect(await rows(`SELECT id FROM "CommentV3" WHERE id >= 5000`)).toEqual([]);
  });

  it('deletes a model a reported author commented on, with the comment', async () => {
    await holder.db.exec(`
      INSERT INTO "CommentTopic" ("entityType", "entityId") VALUES ('model', ${MODEL});
      INSERT INTO "CommentV3" (id, "entityType", "entityId", path, "userId", content) VALUES
        (5000, 'model', ${MODEL}, '5000', ${REPORTED}, 'reported, on its model');
    `);

    await removeAllContent({ id: CLEAN });

    expect(await rows(`SELECT id FROM "Model" WHERE id = ${MODEL}`)).toEqual([]);
    expect(await rows(`SELECT id FROM "CommentV3" WHERE id = 5000`)).toEqual([]);
  });
});

describe('/api/mod/remove-all-content', () => {
  const call = async (userId: number, extra: Record<string, string> = {}) => {
    const res = fakeRes();
    await removeAllContentWebhook(
      {
        method: 'POST',
        query: { token: 'test-webhook-token', userId: String(userId), ...extra },
        headers: {},
        cookies: {},
      } as never,
      res as never
    );
    return res;
  };

  it('wipes the account', async () => {
    const res = await call(CLEAN);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ userId: CLEAN, incomplete: [] });
    expect(moderatorReads(res)).toBeNull();
    expect(moderator.purgeWarning(res.body)).toBeUndefined();
    expect(await remaining(CLEAN)).toEqual(all(0));
  });

  it('answers 200, records the activity and names the step when a cleanup step fails', async () => {
    vi.mocked(refundBidsForVersions).mockRejectedValueOnce(new Error('buzz down'));
    const res = await call(CLEAN);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ userId: CLEAN, incomplete: ['bid-refunds'] });
    expect(tracked).toHaveBeenCalledWith({ type: 'RemoveContent', targetUserId: CLEAN });
    expect(moderator.purgeWarning(res.body)).toBe(moderator.PURGE_INCOMPLETE);
  });

  it('names the moderator the caller sent on a refund alert', async () => {
    vi.mocked(refundBidsForVersions).mockResolvedValueOnce({
      bidsDeleted: [1],
      recurringBidsDeleted: [],
      refundFailed: ['tx-3'],
    });
    await call(CLEAN, { moderatorId: '9' });
    expect(refundAlerts()).toEqual([expect.objectContaining({ moderatorId: 9 })]);
    // Unverified, so never written as the actor of a store's audit row.
    expect(purgeUserAppStorageForAccountWipe).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: null })
    );
  });
});

describe('/api/mod/delete-user-images', () => {
  const call = async (userId: number, extra: Record<string, string> = {}) => {
    const res = fakeRes();
    await deleteUserImages(
      {
        method: 'GET',
        query: { userId: String(userId), ...extra },
        headers: {},
        cookies: {},
      } as never,
      res as never
    );
    return res;
  };

  it('deletes the account’s images', async () => {
    const res = await call(CLEAN);
    expect(res.statusCode).toBe(200);
    expect((await remaining(CLEAN)).Image).toBe(0);
    // The post that held them goes with them.
    expect((await remaining(CLEAN)).Post).toBe(0);
    expect((await remaining(BYSTANDER)).Image).toBe(1);
    expect((await remaining(BYSTANDER)).Post).toBe(1);
  });

  it("takes a reported author's comment on the deleted post", async () => {
    await holder.db.exec(`
      INSERT INTO "CommentTopic" ("entityType", "entityId") VALUES ('post', 1);
      INSERT INTO "CommentV3" (id, "entityType", "entityId", path, "userId", content) VALUES
        (5000, 'post', 1, '5000', ${REPORTED}, 'reported, on its post');
    `);

    expect((await call(CLEAN)).statusCode).toBe(200);

    expect((await remaining(CLEAN)).Post).toBe(0);
    expect(await commentsOf(REPORTED)).toEqual([]);
  });

  it('refuses a batch size of zero, deleting nothing', async () => {
    const res = await call(CLEAN, { batchSize: '0' });
    expect(res.statusCode).not.toBe(200);
    expect(await remaining(CLEAN)).toEqual(seeded(CLEAN));
  });
});

describe('a bounty a content wipe kept for its unsettled payout', () => {
  const bounty = async (id = BOUNTY) =>
    (
      await holder.db.query<{ availability: string; meta: unknown }>(
        `SELECT availability, meta FROM "Bounty" WHERE id = $1`,
        [id]
      )
    ).rows[0];
  const RECORD = { removedWithOwner: true, availabilityBeforeRemoval: 'Public' };
  const settle = (complete = true) =>
    holder.db.exec(
      `UPDATE "Bounty" SET "payoutSettledAt" = now(), complete = ${complete} WHERE id = ${BOUNTY}`
    );
  const searchDeletes = () => [
    ...indexes.bounties.queueUpdate.mock.calls.flatMap(([rows]) => rows),
    ...searchQueue.mock.calls.flatMap(([{ items }]) => items),
  ];

  beforeEach(async () => {
    await holder.db.exec(
      `UPDATE "Bounty" SET "payoutRecordedAt" = now() - interval '1 hour' WHERE id = ${BOUNTY}`
    );
  });

  it('is hidden, with where it was recorded, and taken out of search', async () => {
    await removeAllContent({ id: CLEAN });

    expect(await bounty()).toEqual({ availability: 'Private', meta: RECORD });
    expect(searchDeletes()).toContainEqual({ id: BOUNTY, action: 'Delete' });
  });

  it('keeps the first record through a second wipe', async () => {
    await removeAllContent({ id: CLEAN });
    await removeAllContent({ id: CLEAN });

    expect(await bounty()).toEqual({ availability: 'Private', meta: RECORD });
  });

  it('is deleted by the wipe when its payout settles there (control)', async () => {
    payout.settles = true;
    await removeAllContent({ id: CLEAN });

    expect(await bounty()).toBeUndefined();
  });

  describe('and the payout retry after it', () => {
    beforeEach(async () => {
      await removeAllContent({ id: CLEAN });
      vi.clearAllMocks();
    });

    it('deletes it once its payout settles, with its files, and drops it from search', async () => {
      await holder.db.exec(`
        TRUNCATE "File";
        INSERT INTO "File" ("entityType", "entityId") VALUES
          ('Bounty', ${BOUNTY}), ('BountyEntry', ${BOUNTY}), ('Bounty', ${BOUNTY + 3});
      `);
      await settle();

      expect(await deleteSettledKeptBounties()).toBe(1);
      expect(await bounty()).toBeUndefined();
      expect(searchDeletes()).toEqual([{ id: BOUNTY, action: 'Delete' }]);
      expect(
        (await holder.db.query(`SELECT "entityType", "entityId" FROM "File" ORDER BY id`)).rows
      ).toEqual([
        { entityType: 'BountyEntry', entityId: BOUNTY },
        { entityType: 'Bounty', entityId: BOUNTY + 3 },
      ]);
    });

    it('leaves it hidden while it is open: a settled award does not settle its other supporters', async () => {
      await settle(false);

      expect(await deleteSettledKeptBounties()).toBe(0);
      expect(await bounty()).toEqual({ availability: 'Private', meta: RECORD });
    });

    it('leaves it hidden when a payout was recorded after the one that settled', async () => {
      await settle();
      await holder.db.exec(
        `UPDATE "Bounty" SET "payoutRecordedAt" = now() + interval '1 minute' WHERE id = ${BOUNTY}`
      );

      expect(await deleteSettledKeptBounties()).toBe(0);
      expect(await bounty()).toEqual({ availability: 'Private', meta: RECORD });
    });

    // The retry's own settle runs here, not the mock: a refund with no supporters left to pay,
    // reading and stamping the real row.
    it('retries a refund recorded after the payout that settled, then deletes it', async () => {
      await holder.db.exec(`UPDATE "Bounty" SET complete = true, refunded = true,
        "payoutSettledAt" = now() - interval '2 hours', "payoutRecordedAt" = now() - interval '1 hour'
        WHERE id = ${BOUNTY}`);
      vi.mocked(dbMock.dbWrite.bounty.findUnique).mockImplementationOnce(
        (async () =>
          (await holder.db.query(`SELECT * FROM "Bounty" WHERE id = ${BOUNTY}`)).rows[0]) as never
      );
      vi.mocked(dbMock.dbWrite.bounty.updateMany).mockImplementationOnce((async (args: {
        where: { id: number; payoutRecordedAt: Date };
        data: { payoutSettledAt: Date };
      }) => ({
        count: (
          await holder.db.query(
            `UPDATE "Bounty" SET "payoutSettledAt" = $1 WHERE id = $2 AND "payoutRecordedAt" = $3`,
            [args.data.payoutSettledAt, args.where.id, args.where.payoutRecordedAt]
          )
        ).affectedRows,
      })) as never);

      expect(await retryUnsettledBountyPayouts()).toEqual({ settled: 1 });
      expect(await deleteSettledKeptBounties()).toBe(1);
      expect(await bounty()).toBeUndefined();
    });

    it('leaves a payout recorded in the last ten minutes to the attempt still making it', async () => {
      await holder.db.exec(`UPDATE "Bounty" SET complete = true, refunded = true,
        "payoutSettledAt" = NULL, "payoutRecordedAt" = now() - interval '1 minute'
        WHERE id = ${BOUNTY}`);

      expect(await retryUnsettledBountyPayouts()).toEqual({ settled: 0 });
    });

    it('retries nothing settled at or after its last record (control)', async () => {
      await holder.db.exec(`UPDATE "Bounty" SET complete = true,
        "payoutRecordedAt" = now() - interval '1 hour', "payoutSettledAt" = now() - interval '1 hour'
        WHERE id = ${BOUNTY}`);

      expect(await retryUnsettledBountyPayouts()).toEqual({ settled: 0 });
    });

    it('leaves it hidden while its payout is still pending', async () => {
      expect(await deleteSettledKeptBounties()).toBe(0);
      expect(await bounty()).toEqual({ availability: 'Private', meta: RECORD });
    });

    it('leaves a settled bounty no wipe kept alone (control)', async () => {
      await holder.db.exec(`
        UPDATE "Bounty" SET "payoutSettledAt" = now(), complete = true WHERE "userId" = ${BYSTANDER};
      `);

      expect(await deleteSettledKeptBounties()).toBe(0);
      expect(
        (await holder.db.query(`SELECT id FROM "Bounty" WHERE "userId" = ${BYSTANDER}`)).rows
      ).toHaveLength(1);
    });
  });
});

describe('an open bounty with supporters, in a content wipe', () => {
  const bountyRow = async () =>
    (
      await holder.db.query<{ availability: string; meta: unknown }>(
        `SELECT availability, meta FROM "Bounty" WHERE id = ${BOUNTY}`
      )
    ).rows[0];

  beforeEach(async () => {
    await holder.db.exec(`INSERT INTO "BountyBenefactor" ("bountyId") VALUES (${BOUNTY})`);
  });

  it('refunds its supporters, then deletes it', async () => {
    payout.settles = true;
    await removeAllContent({ id: CLEAN });

    expect(payout.claimed).toEqual([BOUNTY]);
    expect(await bountyRow()).toBeUndefined();
  });

  it('keeps a bounty whose payout was recorded again after it settled, until that settles', async () => {
    await holder.db.exec(`UPDATE "Bounty" SET complete = true,
      "payoutSettledAt" = now() - interval '2 hours', "payoutRecordedAt" = now() - interval '1 hour'
      WHERE id = ${BOUNTY}`);
    await removeAllContent({ id: CLEAN });

    expect(payout.claimed).toEqual([]);
    expect((await bountyRow())?.availability).toBe('Private');
  });

  it('claims no bounty without supporters (control)', async () => {
    await holder.db.exec(`TRUNCATE "BountyBenefactor"`);
    await removeAllContent({ id: CLEAN });

    expect(payout.claimed).toEqual([]);
    expect(await bountyRow()).toBeUndefined();
  });

  it('keeps it, hidden, while an award on it is recorded for manual resolution', async () => {
    await holder.db.exec(`
      TRUNCATE "BountyBenefactor";
      INSERT INTO "BountyUnpaidAward" ("bountyId", "userId", "unitAmount", "recordedById")
        VALUES (${BOUNTY}, ${BYSTANDER}, 100, 1);`);
    await removeAllContent({ id: CLEAN });

    expect(await bountyRow()).toEqual({
      availability: 'Private',
      meta: { removedWithOwner: true, availabilityBeforeRemoval: 'Public' },
    });
  });

  it('keeps it, hidden, for an award recorded only before the table existed', async () => {
    await holder.db.exec(`
      TRUNCATE "BountyBenefactor";
      INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId")
        VALUES (${BYSTANDER}, 'bountyAwardUnpaid', 'bounty', ${BOUNTY});`);
    await removeAllContent({ id: CLEAN });

    expect((await bountyRow())?.availability).toBe('Private');
  });

  it('deletes it once that award is resolved', async () => {
    await holder.db.exec(`
      TRUNCATE "BountyBenefactor";
      INSERT INTO "BountyUnpaidAward" ("bountyId", "userId", "unitAmount", "recordedById",
        "resolvedAt") VALUES (${BOUNTY}, ${BYSTANDER}, 100, 1, now());`);
    await removeAllContent({ id: CLEAN });

    expect(await bountyRow()).toBeUndefined();
  });

  it('keeps it, hidden, when its refund throws, and finishes the wipe', async () => {
    payout.settles = 'throws';
    await removeAllContent({ id: CLEAN });

    expect(await bountyRow()).toEqual({
      availability: 'Private',
      meta: { removedWithOwner: true, availabilityBeforeRemoval: 'Public' },
    });
    expect((await remaining(CLEAN)).Image).toBe(0);
  });

  it('settles a refund a failed wipe claimed on the next wipe, without claiming it again', async () => {
    payout.settles = 'throws';
    await removeAllContent({ id: CLEAN });
    payout.settles = true;
    await removeAllContent({ id: CLEAN });

    expect(payout.claimed).toEqual([BOUNTY]);
    expect(await bountyRow()).toBeUndefined();
  });
});

// A wipe archives the profile and links of any account a CSAM report names, before
// deleting; a failed archive deletes nothing.
describe('removeAllContent and the profile archive', () => {
  const OLD_REPORT = 4; // named only on a report sent over a year ago and archived
  const PROFILE = { bio: 'zzbio', message: null };
  const LINKS = [{ id: 41, url: 'https://example.com/zz', type: 'Social' }];

  beforeEach(async () => {
    await holder.db.exec(`
      INSERT INTO "CsamReport" ("userId", "reportSentAt", "archivedAt")
        VALUES (${OLD_REPORT}, now() - interval '400 days', now());
      INSERT INTO "Image" (id, "userId", "postId") VALUES (${
        OLD_REPORT * 100
      }, ${OLD_REPORT}, NULL);
      ${SEEDED_TABLES.map((t) => `INSERT INTO "${t}" ("userId") VALUES (${OLD_REPORT});`).join(
        '\n'
      )}
    `);
    vi.mocked(dbMock.dbWrite.userProfile.findUnique).mockResolvedValue(PROFILE as never);
    vi.mocked(dbMock.dbWrite.userLink.findMany).mockResolvedValue(LINKS as never);
  });

  it('archives the profile and links of an account an old report names, before any delete', async () => {
    const archive = vi.fn(async () => undefined);

    await removeAllContent({ id: OLD_REPORT, actorUserId: 9, archive });

    expect(archive).toHaveBeenCalledTimes(1);
    expect(archive).toHaveBeenCalledWith(
      expect.objectContaining({ userId: OLD_REPORT, actorId: 9, profile: PROFILE, links: LINKS })
    );
    expect(await remaining(OLD_REPORT)).toEqual(all(0));
    const archivedAt = archive.mock.invocationCallOrder[0];
    // From the wipe's first read of what it deletes to its last delete.
    for (const del of [
      dbMock.dbWrite.model.findMany,
      deleteImages,
      dbMock.dbWrite.imageReaction.deleteMany,
      dbMock.dbWrite.userLink.deleteMany,
      dbMock.dbWrite.userProfile.deleteMany,
    ])
      expect(vi.mocked(del).mock.invocationCallOrder[0]).toBeGreaterThan(archivedAt);
  });

  // The wipe does not ban, so the owner can still add a link while the rest of it runs.
  it('never deletes a link the archive did not see, when one is added later in the wipe', async () => {
    const live = [...LINKS];
    const archived: number[] = [];
    const deletedUnarchived: number[] = [];
    vi.mocked(dbMock.dbWrite.userLink.findMany).mockImplementation((async () => [
      ...live,
    ]) as never);
    vi.mocked(dbMock.dbWrite.userLink.deleteMany).mockImplementation((async () => {
      deletedUnarchived.push(...live.map((l) => l.id).filter((l) => !archived.includes(l)));
      const count = live.length;
      live.length = 0;
      return { count };
    }) as never);
    const readModels = vi.mocked(dbMock.dbWrite.model.findMany).getMockImplementation() as (
      args: unknown
    ) => Promise<unknown>;
    vi.mocked(dbMock.dbWrite.model.findMany).mockImplementation((async (args: unknown) => {
      live.push({ id: 42, url: 'https://example.com/added', type: 'Social' });
      return readModels(args);
    }) as never);
    const archive = vi.fn(async (snapshot: { links: { id: number }[] }) => {
      archived.push(...snapshot.links.map((l) => l.id));
    });

    await removeAllContent({ id: OLD_REPORT, actorUserId: 9, archive });

    expect(archived).toEqual([41]);
    expect(deletedUnarchived).toEqual([]);
  });

  it('deletes nothing when the archive fails', async () => {
    const archive = vi.fn(async () => {
      throw new Error('bucket down');
    });

    await expect(
      removeAllContent({ id: OLD_REPORT, actorUserId: 9, archive })
    ).rejects.toBeInstanceOf(ProfileArchiveRefusedError);

    expect(await remaining(OLD_REPORT)).toEqual(all(1));
    expect(dbMock.dbWrite.imageReaction.deleteMany).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.userLink.deleteMany).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.userProfile.deleteMany).not.toHaveBeenCalled();
  });

  // The webhook takes the real archive, which fails here: the evidence bucket is not configured.
  it('the webhook refuses with the text the moderator app shows, when the archive fails', async () => {
    const res = fakeRes();
    await removeAllContentWebhook(
      {
        method: 'POST',
        query: { token: 'test-webhook-token', userId: String(OLD_REPORT) },
        headers: {},
        cookies: {},
      } as never,
      res as never
    );

    expect(res.statusCode).toBe(503);
    expect(moderatorReads(res)).toBe(moderator.PURGE_ARCHIVE_REFUSAL);
    expect(await remaining(OLD_REPORT)).toEqual(all(1));
  });

  it('wipes an account no report names without archiving it', async () => {
    const archive = vi.fn(async () => undefined);

    await removeAllContent({ id: CLEAN, archive });

    expect(archive).not.toHaveBeenCalled();
    expect(await remaining(CLEAN)).toEqual(all(0));
  });
});
