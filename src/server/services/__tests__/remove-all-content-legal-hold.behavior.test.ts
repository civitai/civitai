import { readFileSync } from 'node:fs';
import { heldCopiesSchemaSql } from '~/server/services/__tests__/held-copies.fixture';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

/**
 * The two account-wide content wipes refuse a held account, and a hold that lands mid-wipe stops
 * every delete that destroys evidence. The hold query and the guarded deletes run as SQL against a
 * Postgres stand-in; `removeAllContent` and the delete-user-images endpoint are the real code.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { holder, indexes, metrics, session, pictures, tracked, docStore } = vi.hoisted(() => ({
  holder: {
    db: null as unknown as PGlite,
    /** Runs just before the first image delete: a hold landing mid-run. */
    beforeImages: null as (() => Promise<unknown>) | null,
  },
  indexes: Object.fromEntries(
    ['models', 'images', 'imagesMetrics', 'articles', 'collections', 'bounties', 'users'].map(
      (name) => [
        name,
        { queueUpdate: vi.fn<(rows: { id: number; action: string }[]) => Promise<undefined>>() },
      ]
    )
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
  imagesSearchIndex: indexes.images,
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
  deleteImages: vi.fn(
    async (ids: number[], _posts?: boolean, opts?: { onlyWhere?: Prisma.Sql }) => {
      if (!ids.length) return [];
      if (holder.beforeImages) {
        await holder.beforeImages();
        holder.beforeImages = null;
      }
      const where = opts?.onlyWhere ? Prisma.sql`AND (${opts.onlyWhere})` : Prisma.empty;
      const sql = Prisma.sql`DELETE FROM "Image" WHERE id = ANY(${ids}::int[]) ${where} RETURNING id`;
      return (await holder.db.query(sql.text, sql.values)).rows;
    }
  ),
}));
// The soft delete is model-removal-collection-reindex's; here, only which models get it, and how.
// It commits the Deleted status, as the real one does before its refunds and cache steps.
const { deleteModelById } = vi.hoisted(() => ({
  deleteModelById: vi.fn(async ({ id }: { id: number }) => {
    await holder.db.exec(`UPDATE "Model" SET status = 'Deleted' WHERE id = ${id}`);
    return null;
  }),
}));
vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  deleteModelById,
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

import {
  LEGAL_HOLD_STOPPED,
  LegalHoldError,
  LegalHoldStoppedError,
  LegalHoldUnconfirmedError,
} from '~/server/services/legal-hold.service';
import { removeAllContent } from '~/server/services/user.service';
import {
  deleteSettledKeptBounties,
  retryUnsettledBountyPayouts,
} from '~/server/services/bounty.service';
import { bulkClearCommentTosViolation } from '~/server/services/comment.service';
import { deleteImages } from '~/server/services/image.service';
import { refundBidsForVersions } from '~/server/services/auction.service';
import { KEPT_MODEL_STATUS } from '~/server/utils/legal-hold';
import { restoreModelRemovedWithOwner } from '~/server/services/model-removed-with-owner.service';
import { purgeUserAppStorageForAccountWipe } from '~/server/services/apps/user-storage-purge.service';
import deleteUserImages from '~/pages/api/mod/delete-user-images';
import removeAllContentWebhook from '~/pages/api/mod/remove-all-content';

const CLEAN = 1;
const HELD = 2; // named on a pending report
const MARKED = 3; // held by the marker view
const BYSTANDER = 9;
// CLEAN's rows, seeded first; each table's ids start apart so an id names one table.
const COLLECTION = 300;
const ARTICLE = 500;
const MODEL = 700;
const BOUNTY = 900;
const MODEL_VERSION = (modelId: number) => modelId * 10;
const GIVEN_BY_HELD = 7901;
const GIVEN_BY_BYSTANDER = 7902;
const SCHEDULED_GIVEN_BY_HELD = 7911;
const EVIDENCE = [
  'BountyEntry',
  'Bounty',
  'Answer',
  'Question',
  'ResourceReview',
  'CommentV2',
  'Comment',
  'Article',
  'Post',
  'Model',
  'ChatMessage',
  'ChatMember',
];

/** Runs just before the delete from `landsBefore`: a hold landing after the check. */
let beforeEvidence: (() => Promise<unknown>) | null = null;
/** The first guarded delete, unless a test lands the hold later. */
let landsBefore = EVIDENCE[0];
let failLookups = false;
/** Fails the wipe's read of which of its models are gone. */
let failGoneModels = false;
/** Rows the primary has and the replica does not yet: made inside replication lag. */
let notYetOnReplica: number[] = [];
/** Replaces what the wipe's re-check after its evidence deletes reads back. */
let afterHeld: unknown = undefined;

const run = (sql: Prisma.Sql) => holder.db.query(sql.text, sql.values);
const asSql = (first: TemplateStringsArray | Prisma.Sql, values: unknown[]) =>
  Array.isArray(first)
    ? Prisma.sql(first as TemplateStringsArray, ...(values as never[]))
    : (first as Prisma.Sql);

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "CsamReport" (
      id serial PRIMARY KEY, "userId" int, "reportSentAt" timestamp(3), "archivedAt" timestamp(3),
      details jsonb NOT NULL DEFAULT '{}', images jsonb NOT NULL DEFAULT '[]'
    );
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL, "postId" int, "needsReview" text, "blockedFor" text
    );
    ${EVIDENCE.map(
      (t) => `CREATE TABLE "${t}" (id serial PRIMARY KEY, "userId" int NOT NULL);`
    ).join('\n')}
    CREATE TABLE "BountyBenefactor" ("awardedToId" int REFERENCES "BountyEntry"(id) ON DELETE SET NULL);
    ALTER TABLE "BountyBenefactor" ADD COLUMN "bountyId" int REFERENCES "Bounty"(id) ON DELETE CASCADE;
    ALTER TABLE "BountyEntry" ADD COLUMN "bountyId" int REFERENCES "Bounty"(id) ON DELETE CASCADE;
    ALTER TABLE "Answer" ADD COLUMN "questionId" int REFERENCES "Question"(id) ON DELETE CASCADE;
    ALTER TABLE "ResourceReview" ADD COLUMN "modelId" int REFERENCES "Model"(id) ON DELETE CASCADE;
    ALTER TABLE "Model" ADD COLUMN "deletedAt" timestamp(3), ADD COLUMN "updatedAt" timestamp(3);
    CREATE DOMAIN "Availability" AS text;
    ALTER TABLE "Bounty" ADD COLUMN availability "Availability" NOT NULL DEFAULT 'Public',
      ADD COLUMN meta jsonb, ADD COLUMN "payoutSettledAt" timestamp(3),
      ADD COLUMN "payoutRecordedAt" timestamp(3),
      ADD COLUMN complete boolean NOT NULL DEFAULT false,
      ADD COLUMN refunded boolean NOT NULL DEFAULT false;
    CREATE TABLE "File" (id serial PRIMARY KEY, "entityType" text, "entityId" int);
    ALTER TABLE "Comment" ADD COLUMN "modelId" int REFERENCES "Model"(id) ON DELETE CASCADE,
      ADD COLUMN "parentId" int REFERENCES "Comment"(id) ON DELETE CASCADE,
      ADD COLUMN "tosViolation" boolean NOT NULL DEFAULT false, ADD COLUMN "updatedAt" timestamp(3),
      ADD COLUMN "removedByAuthor" boolean NOT NULL DEFAULT false;
    -- What a ToS restore reopens; no reports here, so only the flag moves.
    CREATE DOMAIN "ReportStatus" AS text;
    CREATE DOMAIN "ReportReason" AS text;
    CREATE TABLE "Report" (id int PRIMARY KEY, status text, reason text);
    CREATE TABLE "CommentReport" ("reportId" int, "commentId" int);
    -- A parent's comment thread, and the comments on it, go with the parent; reply threads with
    -- their root.
    CREATE TABLE "Thread" (
      id serial PRIMARY KEY,
      "reviewId" int REFERENCES "ResourceReview"(id) ON DELETE CASCADE,
      "postId" int REFERENCES "Post"(id) ON DELETE CASCADE,
      "modelId" int REFERENCES "Model"(id) ON DELETE CASCADE,
      "imageId" int REFERENCES "Image"(id) ON DELETE CASCADE,
      "articleId" int REFERENCES "Article"(id) ON DELETE CASCADE,
      "bountyId" int REFERENCES "Bounty"(id) ON DELETE CASCADE,
      "bountyEntryId" int REFERENCES "BountyEntry"(id) ON DELETE CASCADE,
      "questionId" int REFERENCES "Question"(id) ON DELETE CASCADE,
      "answerId" int REFERENCES "Answer"(id) ON DELETE CASCADE,
      "parentThreadId" int REFERENCES "Thread"(id) ON DELETE CASCADE,
      "rootThreadId" int REFERENCES "Thread"(id) ON DELETE CASCADE,
      "commentId" int,
      metadata jsonb NOT NULL DEFAULT '{}'
    );
    ALTER TABLE "CommentV2" ADD COLUMN "threadId" int REFERENCES "Thread"(id) ON DELETE CASCADE;
    CREATE TABLE "Collection" (id serial PRIMARY KEY, "userId" int NOT NULL);
    CREATE TYPE "ModelStatus" AS ENUM (
      'Draft', 'Training', 'Published', 'Scheduled', 'Unpublished', 'UnpublishedViolation',
      'GatherInterest', 'Deleted'
    );
    ALTER TABLE "Model" ADD COLUMN status text NOT NULL DEFAULT 'Published', ADD COLUMN meta jsonb;
    CREATE TABLE "ModelVersion" (
      id serial PRIMARY KEY, "modelId" int NOT NULL, status text NOT NULL DEFAULT 'Published'
    );
  `);
  await holder.db.exec(
    readFileSync(
      path.resolve(
        __dirname,
        '../../../../packages/civitai-db-schema/prisma/migrations/20261209120000_model_ownership/migration.sql'
      ),
      'utf8'
    )
  );
  await holder.db.exec(heldCopiesSchemaSql());
  // Append-only, so set once: two models CLEAN was given, one by a held owner.
  await holder.db.exec(`
    INSERT INTO "ModelOwnership" ("modelId", "userId", reason) VALUES
      (${GIVEN_BY_HELD}, ${HELD}, 'create'), (${GIVEN_BY_HELD}, ${CLEAN}, 'transfer'),
      (${GIVEN_BY_BYSTANDER}, ${BYSTANDER}, 'create'), (${GIVEN_BY_BYSTANDER}, ${CLEAN}, 'transfer');
  `);
});

beforeEach(async () => {
  vi.clearAllMocks();
  beforeEvidence = null;
  landsBefore = EVIDENCE[0];
  holder.beforeImages = null;
  failLookups = false;
  failGoneModels = false;
  notYetOnReplica = [];
  afterHeld = undefined;
  session.user = { id: 9, isModerator: true, bannedAt: null };
  await holder.db.exec(`
    DROP VIEW IF EXISTS "EvidenceHeldUser";
    DROP TABLE IF EXISTS "EvidenceHold";
    TRUNCATE "CsamReport", "Image", "BountyBenefactor", "Thread", "Collection", "ModelVersion",
      "HeldResourceReview", "HeldAnswer", ${EVIDENCE.map((t) => `"${t}"`).join(
        ', '
      )} RESTART IDENTITY;
    ALTER SEQUENCE "Collection_id_seq" RESTART ${COLLECTION};
    ALTER SEQUENCE "Article_id_seq" RESTART ${ARTICLE};
    ALTER SEQUENCE "Model_id_seq" RESTART ${MODEL};
    ALTER SEQUENCE "Bounty_id_seq" RESTART ${BOUNTY};
    INSERT INTO "Collection" ("userId") VALUES (${CLEAN}), (${HELD}), (${MARKED}), (${BYSTANDER});
    INSERT INTO "CsamReport" ("userId") VALUES (${HELD});
    INSERT INTO "Image" (id, "userId", "postId") VALUES
      (${CLEAN * 100}, ${CLEAN}, 1), (${CLEAN * 100 + 1}, ${CLEAN}, 1),
      (${HELD * 100}, ${HELD}, NULL), (${MARKED * 100}, ${MARKED}, NULL),
      (${BYSTANDER * 100}, ${BYSTANDER}, NULL);
    ${EVIDENCE.map(
      (t) =>
        `INSERT INTO "${t}" ("userId") VALUES (${CLEAN}), (${HELD}), (${MARKED}), (${BYSTANDER});`
    ).join('\n')}
  `);

  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (
    first: TemplateStringsArray | Prisma.Sql,
    ...values: unknown[]
  ) => {
    if (failLookups) throw new Error('connection reset');
    const sql = asSql(first, values);
    if (failGoneModels && sql.text.includes('FROM "Model" WHERE id = ANY'))
      throw new Error('connection reset');
    if (afterHeld !== undefined && sql.text.trimEnd().endsWith('AS held'))
      return [{ held: afterHeld }];
    return (await run(sql)).rows;
  }) as never);
  vi.mocked(dbMock.dbWrite.$executeRaw).mockImplementation((async (
    first: TemplateStringsArray | Prisma.Sql,
    ...values: unknown[]
  ) => {
    const sql = asSql(first, values);
    if (beforeEvidence && sql.text.includes(`DELETE FROM "${landsBefore}"`)) {
      await beforeEvidence();
      beforeEvidence = null;
    }
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
  images: [],
  imagesMetrics: [],
  articles: [],
  collections: [],
  bounties: [],
  users: [],
};

async function createMarkerView() {
  await holder.db.exec(`
    CREATE TABLE "EvidenceHold" ("userId" int NOT NULL, "releasedAt" timestamp(3));
    CREATE VIEW "EvidenceHeldUser" AS
      SELECT "userId" FROM "EvidenceHold" WHERE "releasedAt" IS NULL GROUP BY "userId";
    INSERT INTO "EvidenceHold" VALUES (${MARKED}, NULL);
  `);
}

/** Rows left per table for `userId`, images included. */
async function remaining(userId: number) {
  const counts: Record<string, number> = {};
  for (const t of [...EVIDENCE, 'Image'])
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
const all = (n: number) => Object.fromEntries([...EVIDENCE, 'Image'].map((t) => [t, n]));
/** What the seed gives `userId`: one row per table, and two images for CLEAN. */
const seeded = (userId: number) => ({ ...all(1), Image: userId === CLEAN ? 2 : 1 });

describe('removeAllContent', () => {
  it('wipes an account no hold covers, and no one else’s', async () => {
    expect(await removeAllContent({ id: CLEAN })).toEqual({ incomplete: [], keptModelIds: [] });

    expect(await remaining(CLEAN)).toEqual(all(0));
    expect(await remaining(BYSTANDER)).toEqual(all(1));
    expect(dropped()).toEqual({
      models: [MODEL],
      images: [CLEAN * 100, CLEAN * 100 + 1],
      imagesMetrics: [CLEAN * 100, CLEAN * 100 + 1],
      articles: [ARTICLE],
      collections: [COLLECTION],
      bounties: [BOUNTY],
      users: [CLEAN],
    });
    expect(metrics.user.queueUpdate).toHaveBeenCalledWith(CLEAN);
    expect(metrics.article.queueUpdate).toHaveBeenCalledWith([ARTICLE]);
    // Rows, storage objects and caches, once, held to the hold.
    expect(deleteImages).toHaveBeenCalledTimes(1);
    expect(deleteImages).toHaveBeenCalledWith([CLEAN * 100, CLEAN * 100 + 1], true, {
      onlyWhere: expect.anything(),
    });
    expect(purgeUserAppStorageForAccountWipe).toHaveBeenCalledWith(
      expect.objectContaining({ targetUserId: CLEAN })
    );
  });

  it.each([
    ['named on a report', HELD, async () => undefined],
    ['held by the marker', MARKED, createMarkerView],
  ])('refuses an account %s before deleting anything', async (_, userId, setup) => {
    await setup();
    const before = await remaining(userId);

    const refused = await removeAllContent({ id: userId }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(LegalHoldError);
    expect(refused).not.toBeInstanceOf(LegalHoldStoppedError);
    expect(refused).not.toBeInstanceOf(LegalHoldUnconfirmedError);

    expect(await remaining(userId)).toEqual(before);
    expect(dbMock.dbWrite.imageReaction.deleteMany).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('refuses when the hold cannot be checked', async () => {
    failLookups = true;
    const refused = await removeAllContent({ id: CLEAN }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(LegalHoldUnconfirmedError);
    expect(refused).not.toBeInstanceOf(LegalHoldStoppedError);
    expect(await remaining(CLEAN)).toEqual(seeded(CLEAN));
    expect(dbMock.dbWrite.imageReaction.deleteMany).not.toHaveBeenCalled();
  });

  // PGlite has one connection, so this lands the hold strictly between the check and the deletes; it
  // shows each delete re-reads the hold, not how they behave under true concurrency.
  it('keeps every piece of evidence when a hold lands mid-wipe, and says so', async () => {
    await holder.db.exec(
      `INSERT INTO "ModelVersion" ("modelId") SELECT id FROM "Model" WHERE "userId" = ${CLEAN}`
    );
    beforeEvidence = () => holder.db.exec(`INSERT INTO "CsamReport" ("userId") VALUES (${CLEAN})`);

    await expect(removeAllContent({ id: CLEAN })).rejects.toBeInstanceOf(LegalHoldStoppedError);

    expect(await remaining(CLEAN)).toEqual(seeded(CLEAN));
    // Not even hidden: a wipe stopped before the hide leaves its models as they were.
    const statuses = await holder.db.query<{ status: string }>(
      `SELECT DISTINCT status FROM "Model" WHERE "userId" = ${CLEAN}
       UNION ALL
       SELECT DISTINCT mv.status FROM "ModelVersion" mv JOIN "Model" m ON m.id = mv."modelId"
       WHERE m."userId" = ${CLEAN}`
    );
    expect(statuses.rows).toEqual([{ status: 'Published' }, { status: 'Published' }]);
    // The low-impact rows before the evidence go, and only those leave the index; nothing is purged
    // elsewhere.
    expect(dbMock.dbWrite.imageReaction.deleteMany).toHaveBeenCalled();
    expect(dropped()).toEqual({ ...NONE, collections: [COLLECTION] });
    expect(metrics.user.queueUpdate).not.toHaveBeenCalled();
    expect(metrics.article.queueUpdate).not.toHaveBeenCalled();
    expect(purgeUserAppStorageForAccountWipe).not.toHaveBeenCalled();
  });

  it('keeps evidence when the marker appears mid-wipe after a check that found none', async () => {
    beforeEvidence = () => holder.db.exec(`CREATE TABLE "EvidenceHold" ("userId" int NOT NULL)`);
    await expect(removeAllContent({ id: CLEAN })).rejects.toBeInstanceOf(LegalHoldStoppedError);
    expect(await remaining(CLEAN)).toEqual(seeded(CLEAN));
  });

  it('wipes an unheld account while the marker view exists', async () => {
    await createMarkerView();
    await removeAllContent({ id: CLEAN });
    expect(await remaining(CLEAN)).toEqual(all(0));
  });

  it('keeps evidence when a marker lands mid-wipe', async () => {
    await createMarkerView();
    beforeEvidence = () => holder.db.exec(`INSERT INTO "EvidenceHold" VALUES (${CLEAN}, NULL)`);
    await expect(removeAllContent({ id: CLEAN })).rejects.toBeInstanceOf(LegalHoldStoppedError);
    expect(await remaining(CLEAN)).toEqual(seeded(CLEAN));
  });

  it.each([
    [
      'an image put to review',
      `UPDATE "Image" SET "needsReview" = 'csam' WHERE id = ${CLEAN * 100}`,
    ],
    [
      'an image blocked with no sent report',
      `UPDATE "Image" SET "blockedFor" = 'CSAM' WHERE id = ${CLEAN * 100}`,
    ],
    [
      'an image listed on a pending report',
      `INSERT INTO "CsamReport" (images) VALUES ('[{"id": ${CLEAN * 100}}]')`,
    ],
  ])('keeps evidence when %s lands mid-wipe', async (_, landing) => {
    beforeEvidence = () => holder.db.exec(landing);
    await expect(removeAllContent({ id: CLEAN })).rejects.toBeInstanceOf(LegalHoldStoppedError);
    expect(await remaining(CLEAN)).toEqual(seeded(CLEAN));
  });

  it('reports a hold when its re-check cannot be read', async () => {
    afterHeld = null;
    await expect(removeAllContent({ id: CLEAN })).rejects.toBeInstanceOf(LegalHoldStoppedError);
    // Everything went, so all of it leaves the index; the account itself stays in it.
    expect(dropped()).toEqual({
      ...NONE,
      models: [MODEL],
      articles: [ARTICLE],
      collections: [COLLECTION],
      bounties: [BOUNTY],
    });
  });

  it('keeps another user’s comment on a review of theirs when a hold lands mid-wipe', async () => {
    await holder.db.exec(`
      INSERT INTO "Thread" ("reviewId")
        SELECT id FROM "ResourceReview" WHERE "userId" = ${CLEAN};
      INSERT INTO "CommentV2" ("userId", "threadId") SELECT ${BYSTANDER}, id FROM "Thread";
    `);
    beforeEvidence = () => holder.db.exec(`INSERT INTO "CsamReport" ("userId") VALUES (${CLEAN})`);

    await expect(removeAllContent({ id: CLEAN })).rejects.toBeInstanceOf(LegalHoldStoppedError);

    expect((await remaining(BYSTANDER)).CommentV2).toBe(2);
  });

  it('takes the comments on its reviews with it when no hold lands (control for the above)', async () => {
    await holder.db.exec(`
      INSERT INTO "Thread" ("reviewId")
        SELECT id FROM "ResourceReview" WHERE "userId" = ${CLEAN};
      INSERT INTO "CommentV2" ("userId", "threadId") SELECT ${BYSTANDER}, id FROM "Thread";
    `);
    await removeAllContent({ id: CLEAN });
    expect((await remaining(BYSTANDER)).CommentV2).toBe(1);
  });

  describe('a held author’s rows under the wiped account’s own', () => {
    const rows = async (sql: string) => (await holder.db.query(sql)).rows;

    it('copies a held author’s review of its model, and not a bystander’s', async () => {
      await holder.db.exec(`
        INSERT INTO "ResourceReview" ("userId", "modelId", "modelVersionId", details) VALUES
          (${HELD}, ${MODEL}, ${MODEL_VERSION(MODEL)}, 'held'),
          (${BYSTANDER}, ${MODEL}, ${MODEL_VERSION(MODEL)}, 'bystander');
      `);

      expect(await removeAllContent({ id: CLEAN })).toEqual({ incomplete: [], keptModelIds: [] });

      expect(await rows(`SELECT id FROM "ResourceReview" WHERE "modelId" = ${MODEL}`)).toEqual([]);
      expect(
        await rows(`SELECT "userId", "modelId", details, "holdReasons" FROM "HeldResourceReview"`)
      ).toEqual([{ userId: HELD, modelId: MODEL, details: 'held', holdReasons: ['report'] }]);
    });

    it('copies a held author’s answer to its question, and not a bystander’s', async () => {
      const [{ id: question }] = (await rows(
        `SELECT id FROM "Question" WHERE "userId" = ${CLEAN}`
      )) as { id: number }[];
      await holder.db.exec(`
        INSERT INTO "Answer" ("userId", "questionId", content) VALUES
          (${HELD}, ${question}, 'held'), (${BYSTANDER}, ${question}, 'bystander');
      `);

      await removeAllContent({ id: CLEAN });

      expect(await rows(`SELECT id FROM "Answer" WHERE "questionId" = ${question}`)).toEqual([]);
      expect(
        await rows(`SELECT "userId", "questionId", content, "holdReasons" FROM "HeldAnswer"`)
      ).toEqual([{ userId: HELD, questionId: question, content: 'held', holdReasons: ['report'] }]);
    });

    it('keeps, hidden, a bounty a held author entered, and deletes one only a bystander entered', async () => {
      const [{ id: bystanders }] = (await rows(
        `INSERT INTO "Bounty" ("userId") VALUES (${CLEAN}) RETURNING id`
      )) as { id: number }[];
      await holder.db.exec(`
        INSERT INTO "BountyEntry" ("userId", "bountyId") VALUES
          (${HELD}, ${BOUNTY}), (${BYSTANDER}, ${bystanders});
      `);

      await removeAllContent({ id: CLEAN });

      expect(
        await rows(`SELECT id, availability, meta->>'removedWithOwner' AS removed FROM "Bounty"
          WHERE id IN (${BOUNTY}, ${bystanders})`)
      ).toEqual([{ id: BOUNTY, availability: 'Private', removed: 'true' }]);
      expect(await rows(`SELECT "userId" FROM "BountyEntry" WHERE "bountyId" IS NOT NULL`)).toEqual(
        [{ userId: HELD }]
      );
      expect(dropped().bounties).toEqual(expect.arrayContaining([BOUNTY, bystanders]));
    });

    it('deletes the kept bounty once the entrant’s hold ends, and not before', async () => {
      await holder.db.exec(
        `INSERT INTO "BountyEntry" ("userId", "bountyId") VALUES (${HELD}, ${BOUNTY})`
      );
      await removeAllContent({ id: CLEAN });
      await createMarkerView();

      expect(await deleteSettledKeptBounties()).toBe(0);
      expect(await rows(`SELECT id FROM "Bounty" WHERE id = ${BOUNTY}`)).toEqual([{ id: BOUNTY }]);

      await holder.db.exec(`DELETE FROM "CsamReport" WHERE "userId" = ${HELD}`);
      expect(await deleteSettledKeptBounties()).toBe(1);
      expect(await rows(`SELECT id FROM "Bounty" WHERE id = ${BOUNTY}`)).toEqual([]);
    });
  });

  it('stops before the App Blocks stores when a hold lands after the deletes', async () => {
    vi.mocked(refundBidsForVersions).mockImplementationOnce(async () => {
      await holder.db.exec(`INSERT INTO "CsamReport" ("userId") VALUES (${CLEAN})`);
      return { bidsDeleted: [], recurringBidsDeleted: [], refundFailed: [] };
    });
    await expect(removeAllContent({ id: CLEAN })).rejects.toBeInstanceOf(LegalHoldStoppedError);
    expect(refundBidsForVersions).toHaveBeenCalledTimes(1);
    expect(purgeUserAppStorageForAccountWipe).not.toHaveBeenCalled();
    expect(docStore.wipeAccount).not.toHaveBeenCalled();
  });

  it('stops before the App Blocks stores when the hold cannot be checked after the deletes', async () => {
    vi.mocked(refundBidsForVersions).mockImplementationOnce(async () => {
      failLookups = true;
      return { bidsDeleted: [], recurringBidsDeleted: [], refundFailed: [] };
    });
    await expect(removeAllContent({ id: CLEAN })).rejects.toBeInstanceOf(LegalHoldStoppedError);
    expect(refundBidsForVersions).toHaveBeenCalledTimes(1);
    expect(purgeUserAppStorageForAccountWipe).not.toHaveBeenCalled();
    expect(docStore.wipeAccount).not.toHaveBeenCalled();
  });

  // Not refund idempotency (that is the bid filter, in auction-refund-bids-for-versions.test.ts):
  // the second run finds no models, refunds nothing, and is not refused.
  it('runs a second time without refusing, and with no models left to refund', async () => {
    await removeAllContent({ id: CLEAN });
    vi.mocked(refundBidsForVersions).mockClear();
    expect(await removeAllContent({ id: CLEAN })).toEqual({ incomplete: [], keptModelIds: [] });
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
      keptModelIds: [],
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

  it('raises a refund alert from a stopped wipe too', async () => {
    landsBefore = 'ChatMessage';
    beforeEvidence = () => holder.db.exec(`INSERT INTO "CsamReport" ("userId") VALUES (${CLEAN})`);
    vi.mocked(refundBidsForVersions).mockResolvedValueOnce({
      bidsDeleted: [1],
      recurringBidsDeleted: [],
      refundFailed: ['tx-2'],
    });
    await expect(removeAllContent({ id: CLEAN, actorUserId: 9 })).rejects.toBeInstanceOf(
      LegalHoldStoppedError
    );
    expect(refundAlerts()).toEqual([
      expect.objectContaining({ moderatorId: 9, transactionIds: ['tx-2'] }),
    ]);
  });

  it('raises no refund alert when every refund went through', async () => {
    await removeAllContent({ id: CLEAN, actorUserId: 9 });
    expect(refundAlerts()).toEqual([]);
  });

  it('names the model index and the bid refunds, and refunds nothing, when it cannot tell which models went', async () => {
    failGoneModels = true;
    expect(await removeAllContent({ id: CLEAN })).toEqual({
      incomplete: ['index-models', 'bid-refunds'],
      keptModelIds: [],
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
    // A model a hold kept may be among them, and its bids still stand.
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

  it('still reports a stopped wipe when its bid refunds fail', async () => {
    landsBefore = 'ChatMessage';
    beforeEvidence = () => holder.db.exec(`INSERT INTO "CsamReport" ("userId") VALUES (${CLEAN})`);
    vi.mocked(refundBidsForVersions).mockRejectedValueOnce(new Error('buzz down'));
    await expect(removeAllContent({ id: CLEAN })).rejects.toBeInstanceOf(LegalHoldStoppedError);
    expect(refundBidsForVersions).toHaveBeenCalledTimes(1);
  });

  it('still refunds the next model when one model’s refund throws', async () => {
    await holder.db.exec(`INSERT INTO "Model" (id, "userId") VALUES (${MODEL + 50}, ${CLEAN})`);
    vi.mocked(refundBidsForVersions).mockRejectedValueOnce(new Error('auction read failed'));
    expect(await removeAllContent({ id: CLEAN })).toEqual({
      incomplete: ['bid-refunds'],
      keptModelIds: [],
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
      keptModelIds: [],
    });
    expect(purgeUserAppStorageForAccountWipe).toHaveBeenCalledTimes(1);
    expect(docStore.wipeAccount).toHaveBeenCalledWith(CLEAN);
  });

  it('still wipes the document store when the App Blocks purge fails, and names it', async () => {
    vi.mocked(purgeUserAppStorageForAccountWipe).mockRejectedValueOnce(new Error('apps db down'));
    expect(await removeAllContent({ id: CLEAN })).toEqual({
      incomplete: ['app-storage'],
      keptModelIds: [],
    });
    expect(docStore.wipeAccount).toHaveBeenCalledWith(CLEAN);
  });

  it('runs the later index and metric steps when one index fails', async () => {
    indexes.models.queueUpdate.mockRejectedValueOnce(new Error('queue down'));
    expect(await removeAllContent({ id: CLEAN })).toEqual({
      incomplete: ['index-models'],
      keptModelIds: [],
    });
    expect(dropped().users).toEqual([CLEAN]);
    expect(metrics.article.queueUpdate).toHaveBeenCalledWith([ARTICLE]);
    expect(refundBidsForVersions).toHaveBeenCalledTimes(1);
  });

  it('names a document store wipe that failed', async () => {
    docStore.wipeAccount.mockRejectedValueOnce(new Error('store down'));
    expect(await removeAllContent({ id: CLEAN })).toEqual({
      incomplete: ['doc-store'],
      keptModelIds: [],
    });
  });

  it('keeps a model an earlier owner of which is held, and deletes one only unheld owners had', async () => {
    await holder.db.exec(`
      INSERT INTO "Model" (id, "userId") VALUES (${GIVEN_BY_HELD}, ${CLEAN}), (${GIVEN_BY_BYSTANDER}, ${CLEAN})
    `);

    const result = await removeAllContent({ id: CLEAN });

    const left = await holder.db.query<{ id: number }>(`SELECT id FROM "Model" ORDER BY id`);
    expect(left.rows.map((r) => r.id)).toContain(GIVEN_BY_HELD);
    expect(result.keptModelIds).toEqual([GIVEN_BY_HELD]);
    expect(dropped().models).toContain(GIVEN_BY_BYSTANDER);
    expect(left.rows.map((r) => r.id)).not.toContain(GIVEN_BY_BYSTANDER);
    expect(left.rows.map((r) => r.id)).not.toContain(MODEL);
  });

  it('takes a kept model off the site and out of search, keeping its record', async () => {
    await holder.db.exec(`
      INSERT INTO "Model" (id, "userId", meta) VALUES
        (${GIVEN_BY_HELD}, ${CLEAN}, '{"note": 1}'), (${GIVEN_BY_BYSTANDER}, ${CLEAN}, NULL);
      INSERT INTO "ModelVersion" ("modelId", status) VALUES
        (${GIVEN_BY_HELD}, 'Published'), (${GIVEN_BY_HELD}, 'Draft');
    `);

    await removeAllContent({ id: CLEAN });

    const versions = await holder.db.query<{ id: number; status: string }>(
      `SELECT id, status FROM "ModelVersion" WHERE "modelId" = ${GIVEN_BY_HELD} ORDER BY id`
    );
    expect(versions.rows.map((r) => r.status)).toEqual(['Unpublished', 'Draft']);
    // What a moderator's restore needs: the prior status, and only the versions the wipe took down.
    const kept = await holder.db.query<{ status: string; meta: Record<string, unknown> }>(
      `SELECT status, meta FROM "Model" WHERE id = ${GIVEN_BY_HELD}`
    );
    expect(kept.rows).toEqual([
      {
        status: KEPT_MODEL_STATUS,
        meta: {
          note: 1,
          removedWithOwner: true,
          statusBeforeRemoval: 'Published',
          versionsUnpublishedByRemoval: [{ id: versions.rows[0].id, status: 'Published' }],
        },
      },
    ]);
    expect(dropped().models).toContain(GIVEN_BY_HELD);
    // Control: a model only unheld owners had is deleted, as before.
    const gone = await holder.db.query(`SELECT 1 FROM "Model" WHERE id = ${GIVEN_BY_BYSTANDER}`);
    expect(gone.rows).toEqual([]);
  });

  describe('a moderator restore of a model the wipe kept', () => {
    const wipeThenRestore = async (status: string, versions: string[]) => {
      await holder.db.exec(`
        INSERT INTO "Model" (id, "userId", status, meta)
          VALUES (${GIVEN_BY_HELD}, ${CLEAN}, '${status}', '{"note": 1}');
        INSERT INTO "ModelVersion" ("modelId", status)
          SELECT ${GIVEN_BY_HELD}, s FROM unnest(ARRAY[${versions
        .map((v) => `'${v}'`)
        .join(',')}]) s;
      `);
      await removeAllContent({ id: CLEAN });
      const restored = await restoreModelRemovedWithOwner(GIVEN_BY_HELD);
      const model = await holder.db.query<{ status: string; meta: unknown }>(
        `SELECT status, meta FROM "Model" WHERE id = ${GIVEN_BY_HELD}`
      );
      const after = await holder.db.query<{ status: string }>(
        `SELECT status FROM "ModelVersion" WHERE "modelId" = ${GIVEN_BY_HELD} ORDER BY id`
      );
      return { restored, model: model.rows[0], versions: after.rows.map((r) => r.status) };
    };

    it('puts back a published model and only the versions the wipe took down', async () => {
      const { restored, model, versions } = await wipeThenRestore('Published', [
        'Published',
        'Unpublished',
        'Scheduled',
        'Draft',
      ]);
      expect(model).toEqual({ status: 'Published', meta: { note: 1 } });
      // The version unpublished before the wipe, and the draft, stay as they were.
      expect(versions).toEqual(['Published', 'Unpublished', 'Scheduled', 'Draft']);
      expect(restored).toMatchObject({ status: 'Published', userId: CLEAN });
    });

    it('puts a model its owner had unpublished back to unpublished', async () => {
      const { model, versions } = await wipeThenRestore('Unpublished', ['Unpublished']);
      expect(model).toEqual({ status: 'Unpublished', meta: { note: 1 } });
      expect(versions).toEqual(['Unpublished']);
    });

    it('clears the record on a draft it kept in place, so its owner may publish it again', async () => {
      const { restored, model, versions } = await wipeThenRestore('Draft', ['Draft']);
      expect(model).toEqual({ status: 'Draft', meta: { note: 1 } });
      expect(versions).toEqual(['Draft']);
      expect(restored).toMatchObject({ status: 'Draft', userId: CLEAN, versionIds: [] });
    });

    // Only a status the wipe keeps a model in where it found it counts as kept in place.
    it('restores nothing on a recorded model back at a status the wipe moves', async () => {
      await holder.db.exec(`
        INSERT INTO "Model" (id, "userId", status, meta) VALUES (${GIVEN_BY_HELD}, ${CLEAN}, 'Published',
          '{"removedWithOwner": true, "statusBeforeRemoval": "Published", "versionsUnpublishedByRemoval": []}')
      `);
      expect(await restoreModelRemovedWithOwner(GIVEN_BY_HELD)).toBeNull();
    });

    it('restores nothing on a recorded model that has moved since the wipe', async () => {
      await holder.db.exec(`
        INSERT INTO "Model" (id, "userId", status, meta) VALUES (${GIVEN_BY_HELD}, ${CLEAN}, 'Unpublished',
          '{"removedWithOwner": true, "statusBeforeRemoval": "Published", "versionsUnpublishedByRemoval": []}')
      `);
      expect(await restoreModelRemovedWithOwner(GIVEN_BY_HELD)).toBeNull();
    });

    it('leaves a version a moderator took down while the model was hidden', async () => {
      await holder.db.exec(`
        INSERT INTO "Model" (id, "userId", status) VALUES (${GIVEN_BY_HELD}, ${CLEAN}, 'Published');
        INSERT INTO "ModelVersion" ("modelId", status) VALUES (${GIVEN_BY_HELD}, 'Published');
      `);
      await removeAllContent({ id: CLEAN });
      await holder.db.exec(
        `UPDATE "ModelVersion" SET status = 'UnpublishedViolation' WHERE "modelId" = ${GIVEN_BY_HELD}`
      );

      await restoreModelRemovedWithOwner(GIVEN_BY_HELD);

      const after = await holder.db.query<{ status: string }>(
        `SELECT status FROM "ModelVersion" WHERE "modelId" = ${GIVEN_BY_HELD}`
      );
      expect(after.rows).toEqual([{ status: 'UnpublishedViolation' }]);
    });

    it('restores nothing on a record with no prior status', async () => {
      await holder.db.exec(`
        INSERT INTO "Model" (id, "userId", status, meta) VALUES
          (${GIVEN_BY_HELD}, ${CLEAN}, 'UnpublishedViolation', '{"removedWithOwner": true}')
      `);
      expect(await restoreModelRemovedWithOwner(GIVEN_BY_HELD)).toBeNull();
    });

    it('restores nothing on a model the wipe did not hide', async () => {
      await holder.db.exec(
        `INSERT INTO "Model" (id, "userId", status) VALUES (${GIVEN_BY_HELD}, ${HELD}, 'UnpublishedViolation')`
      );
      expect(await restoreModelRemovedWithOwner(GIVEN_BY_HELD)).toBeNull();
    });
  });

  it('hides a kept model its owner had unpublished, and records a kept draft without moving it', async () => {
    const DRAFT_GIVEN_BY_HELD = SCHEDULED_GIVEN_BY_HELD + 1;
    await holder.db.exec(`
      INSERT INTO "ModelOwnership" ("modelId", "userId", reason)
        SELECT ${DRAFT_GIVEN_BY_HELD}, ${HELD}, 'create'
        WHERE NOT EXISTS (SELECT 1 FROM "ModelOwnership" WHERE "modelId" = ${DRAFT_GIVEN_BY_HELD});
      INSERT INTO "Model" (id, "userId", status) VALUES
        (${GIVEN_BY_HELD}, ${CLEAN}, 'Unpublished'), (${DRAFT_GIVEN_BY_HELD}, ${CLEAN}, 'Draft');
      INSERT INTO "ModelVersion" ("modelId", status) VALUES (${GIVEN_BY_HELD}, 'Unpublished');
    `);

    await removeAllContent({ id: CLEAN });

    const kept = await holder.db.query<{ id: number; status: string; meta: unknown }>(
      `SELECT id, status, meta FROM "Model" WHERE id IN (${GIVEN_BY_HELD}, ${DRAFT_GIVEN_BY_HELD}) ORDER BY id`
    );
    expect(kept.rows).toEqual([
      {
        id: GIVEN_BY_HELD,
        status: KEPT_MODEL_STATUS,
        meta: {
          removedWithOwner: true,
          statusBeforeRemoval: 'Unpublished',
          versionsUnpublishedByRemoval: [],
        },
      },
      // Its status stays; the record is what stops its owner publishing it.
      {
        id: DRAFT_GIVEN_BY_HELD,
        status: 'Draft',
        meta: {
          removedWithOwner: true,
          statusBeforeRemoval: 'Draft',
          versionsUnpublishedByRemoval: [],
        },
      },
    ]);
  });

  it('hides only the wiped account’s models, scheduled ones included, and drops their caches', async () => {
    await holder.db.exec(`
      INSERT INTO "ModelOwnership" ("modelId", "userId", reason)
        SELECT ${SCHEDULED_GIVEN_BY_HELD}, ${HELD}, 'create'
        WHERE NOT EXISTS (SELECT 1 FROM "ModelOwnership" WHERE "modelId" = ${SCHEDULED_GIVEN_BY_HELD});
      INSERT INTO "Model" (id, "userId", status) VALUES
        (${GIVEN_BY_HELD}, ${CLEAN}, 'Published'), (${SCHEDULED_GIVEN_BY_HELD}, ${CLEAN}, 'Scheduled');
      INSERT INTO "ModelVersion" ("modelId", status) VALUES
        (${GIVEN_BY_HELD}, 'Published'), (${SCHEDULED_GIVEN_BY_HELD}, 'Scheduled');
      INSERT INTO "ModelVersion" ("modelId", status)
        SELECT id, 'Published' FROM "Model" WHERE "userId" = ${HELD};
    `);

    const result = await removeAllContent({ id: CLEAN });

    const status = async (where: string) =>
      (
        await holder.db.query<{ status: string }>(
          `SELECT DISTINCT status FROM ${where} ORDER BY status`
        )
      ).rows.map((r) => r.status);
    expect(
      await status(`"Model" WHERE id IN (${GIVEN_BY_HELD}, ${SCHEDULED_GIVEN_BY_HELD})`)
    ).toEqual([KEPT_MODEL_STATUS]);
    expect(
      await status(
        `"ModelVersion" WHERE "modelId" IN (${GIVEN_BY_HELD}, ${SCHEDULED_GIVEN_BY_HELD})`
      )
    ).toEqual(['Unpublished']);
    // Another account's model and version are untouched.
    expect(await status(`"Model" WHERE "userId" = ${HELD}`)).toEqual(['Published']);
    expect(
      await status(
        `"ModelVersion" WHERE "modelId" IN (SELECT id FROM "Model" WHERE "userId" = ${HELD})`
      )
    ).toEqual(['Published']);

    expect(result.keptModelIds).toEqual([GIVEN_BY_HELD, SCHEDULED_GIVEN_BY_HELD]);
    const keptVersions = await holder.db.query<{ id: number }>(
      `SELECT id FROM "ModelVersion" WHERE "modelId" IN (${GIVEN_BY_HELD}, ${SCHEDULED_GIVEN_BY_HELD}) ORDER BY id`
    );
    expect(bustMvCache).toHaveBeenCalledWith(
      keptVersions.rows.map((r) => r.id),
      [GIVEN_BY_HELD, SCHEDULED_GIVEN_BY_HELD],
      CLEAN
    );
    expect(contentCounts.refresh).toHaveBeenCalledWith(CLEAN);
  });

  it('refunds the bids on a model it keeps and hides', async () => {
    await holder.db.exec(`INSERT INTO "Model" (id, "userId") VALUES (${GIVEN_BY_HELD}, ${CLEAN})`);

    await removeAllContent({ id: CLEAN });

    expect(refundBidsForVersions).toHaveBeenCalledWith({
      versionIds: [MODEL_VERSION(GIVEN_BY_HELD)],
      name: 'zzfixture',
      notificationKey: GIVEN_BY_HELD,
    });
  });

  it('hides a kept model and alerts when its bid refund fails', async () => {
    await holder.db.exec(`INSERT INTO "Model" (id, "userId") VALUES (${GIVEN_BY_HELD}, ${CLEAN})`);
    const refund = vi.mocked(refundBidsForVersions);
    const usual = refund.getMockImplementation();
    refund.mockImplementation(async (args) => {
      if (args.versionIds.includes(MODEL_VERSION(GIVEN_BY_HELD))) throw new Error('buzz down');
      return usual!(args);
    });
    let result: Awaited<ReturnType<typeof removeAllContent>>;
    try {
      result = await removeAllContent({ id: CLEAN, actorUserId: 9 });
    } finally {
      refund.mockImplementation(usual!);
    }

    expect(result.incomplete).toEqual(['bid-refunds']);
    const kept = await holder.db.query<{ status: string }>(
      `SELECT status FROM "Model" WHERE id = ${GIVEN_BY_HELD}`
    );
    expect(kept.rows).toEqual([{ status: KEPT_MODEL_STATUS }]);
    expect(refundAlerts()).toEqual([
      expect.objectContaining({
        versionIds: [MODEL_VERSION(GIVEN_BY_HELD)],
        error: 'buzz down',
      }),
    ]);
  });

  it('drops a hidden model from search when a hold stops the wipe after the hide', async () => {
    await holder.db.exec(`INSERT INTO "Model" (id, "userId") VALUES (${GIVEN_BY_HELD}, ${CLEAN})`);
    landsBefore = 'ChatMessage';
    beforeEvidence = () => holder.db.exec(`INSERT INTO "CsamReport" ("userId") VALUES (${CLEAN})`);

    await expect(removeAllContent({ id: CLEAN })).rejects.toBeInstanceOf(LegalHoldStoppedError);

    const kept = await holder.db.query<{ status: string }>(
      `SELECT status FROM "Model" WHERE id = ${GIVEN_BY_HELD}`
    );
    expect(kept.rows).toEqual([{ status: KEPT_MODEL_STATUS }]);
    expect(dropped().models).toContain(GIVEN_BY_HELD);
    // Its bids and caches go with it, as on a completed wipe.
    expect(refundBidsForVersions).toHaveBeenCalledWith(
      expect.objectContaining({ versionIds: [MODEL_VERSION(GIVEN_BY_HELD)] })
    );
    expect(bustMvCache).toHaveBeenCalledWith(expect.any(Array), [GIVEN_BY_HELD], CLEAN);
  });

  it('leaves the bids on a kept model a moderator had already taken down', async () => {
    await holder.db.exec(`
      INSERT INTO "Model" (id, "userId", status, meta)
        VALUES (${GIVEN_BY_HELD}, ${CLEAN}, 'UnpublishedViolation', '{"unpublishedReason": "other"}')
    `);

    await removeAllContent({ id: CLEAN });

    expect(refundBidsForVersions).not.toHaveBeenCalledWith(
      expect.objectContaining({ versionIds: [MODEL_VERSION(GIVEN_BY_HELD)] })
    );
  });

  it('refreshes the account’s content counts when it keeps no model', async () => {
    expect(await removeAllContent({ id: CLEAN })).toMatchObject({ keptModelIds: [] });
    expect(contentCounts.refresh).toHaveBeenCalledWith(CLEAN);
  });

  it('leaves the bids on a model an earlier wipe hid and a moderator republished', async () => {
    await holder.db.exec(`
      INSERT INTO "Model" (id, "userId", meta) VALUES
        (${GIVEN_BY_HELD}, ${CLEAN}, '{"removedWithOwner": true}')
    `);
    beforeEvidence = () => holder.db.exec(`INSERT INTO "CsamReport" ("userId") VALUES (${CLEAN})`);

    await expect(removeAllContent({ id: CLEAN })).rejects.toBeInstanceOf(LegalHoldStoppedError);

    expect(refundBidsForVersions).not.toHaveBeenCalledWith(
      expect.objectContaining({ versionIds: [MODEL_VERSION(GIVEN_BY_HELD)] })
    );
    expect(bustMvCache).not.toHaveBeenCalled();
  });

  it('leaves the bids on a model a hold kept', async () => {
    landsBefore = 'Model';
    beforeEvidence = () => holder.db.exec(`INSERT INTO "CsamReport" ("userId") VALUES (${CLEAN})`);
    await expect(removeAllContent({ id: CLEAN })).rejects.toBeInstanceOf(LegalHoldStoppedError);
    expect((await remaining(CLEAN)).Model).toBe(1);
    expect(refundBidsForVersions).not.toHaveBeenCalled();
  });

  it('refunds the bids on a model that went before a hold stopped the wipe', async () => {
    landsBefore = 'ChatMessage';
    beforeEvidence = () => holder.db.exec(`INSERT INTO "CsamReport" ("userId") VALUES (${CLEAN})`);
    await expect(removeAllContent({ id: CLEAN })).rejects.toBeInstanceOf(LegalHoldStoppedError);
    expect((await remaining(CLEAN)).Model).toBe(0);
    expect(refundBidsForVersions).toHaveBeenCalledWith(
      expect.objectContaining({ versionIds: [MODEL_VERSION(MODEL)] })
    );
  });

  it('stops, keeping the evidence, when the marker view is dropped mid-wipe', async () => {
    await createMarkerView();
    beforeEvidence = () => holder.db.exec(`DROP VIEW "EvidenceHeldUser"`);

    await expect(removeAllContent({ id: CLEAN })).rejects.toBeInstanceOf(LegalHoldStoppedError);

    expect(await remaining(CLEAN)).toEqual(seeded(CLEAN));
    expect(metrics.user.queueUpdate).not.toHaveBeenCalled();
  });

  it('drops from the search index only what a stopped wipe really deleted', async () => {
    landsBefore = 'Model';
    beforeEvidence = () => holder.db.exec(`INSERT INTO "CsamReport" ("userId") VALUES (${CLEAN})`);

    await expect(removeAllContent({ id: CLEAN })).rejects.toBeInstanceOf(LegalHoldStoppedError);

    // The article went before the hold landed; the model did not.
    expect((await remaining(CLEAN)).Model).toBe(1);
    expect(dropped()).toEqual({
      ...NONE,
      articles: [ARTICLE],
      collections: [COLLECTION],
      bounties: [BOUNTY],
    });
  });

  it('keeps in the index a bounty a stopped wipe did not delete', async () => {
    landsBefore = 'Bounty';
    beforeEvidence = () => holder.db.exec(`INSERT INTO "CsamReport" ("userId") VALUES (${CLEAN})`);

    await expect(removeAllContent({ id: CLEAN })).rejects.toBeInstanceOf(LegalHoldStoppedError);

    expect((await remaining(CLEAN)).Bounty).toBe(1);
    expect(dropped()).toEqual({ ...NONE, collections: [COLLECTION] });
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
 * The moderator app's real body reader and refusal texts, loaded across the app boundary by path (both
 * modules are import-free for this). It matches the reason against its own constants by equality, so
 * a reworded constant on either side, or a body-shape drift, turns a refusal into a generic failure.
 */
const moderator = {} as {
  restErrorReason: (body: unknown, status: number) => string | null;
  LEGAL_HOLD_REFUSAL: string;
  LEGAL_HOLD_STOPPED: string;
  LEGAL_HOLD_STOPPED_REFUNDS_INCOMPLETE: string;
  HOLD_UNKNOWN_REFUSAL: string;
  purgeWarning: (body: unknown) => string | undefined;
  PURGE_INCOMPLETE: string;
};
beforeAll(async () => {
  const lib = path.resolve(__dirname, '../../../..', 'apps/moderator/src/lib');
  const [reader, texts, purge] = await Promise.all([
    import(/* @vite-ignore */ path.join(lib, 'server/rest-error-reason.ts')),
    import(/* @vite-ignore */ path.join(lib, 'legal-hold.ts')),
    import(/* @vite-ignore */ path.join(lib, 'purge-result.ts')),
  ]);
  Object.assign(moderator, {
    restErrorReason: reader.restErrorReason,
    LEGAL_HOLD_REFUSAL: texts.LEGAL_HOLD_REFUSAL,
    LEGAL_HOLD_STOPPED: texts.LEGAL_HOLD_STOPPED,
    LEGAL_HOLD_STOPPED_REFUNDS_INCOMPLETE: texts.LEGAL_HOLD_STOPPED_REFUNDS_INCOMPLETE,
    HOLD_UNKNOWN_REFUSAL: texts.HOLD_UNKNOWN_REFUSAL,
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

describe('removeAllContent keeps other people’s comments a held author is part of', () => {
  const rows = async (sql: string) => (await holder.db.query<Record<string, unknown>>(sql)).rows;
  const commentIds = async () =>
    (await rows(`SELECT id FROM "CommentV2" WHERE id >= 5000 ORDER BY id`)).map((r) => r.id);

  /**
   * A thread on CLEAN's post: BYSTANDER comments, and `replier` answers in a reply thread. The reply
   * thread hangs off the root thread (both cascade edges) and off BYSTANDER's comment.
   */
  async function seedPostThread(replier: number) {
    await holder.db.exec(`
      INSERT INTO "Thread" (id, "postId") VALUES (5000, 1);
      INSERT INTO "CommentV2" (id, "userId", "threadId") VALUES (5000, ${BYSTANDER}, 5000);
      INSERT INTO "Thread" (id, "rootThreadId", "parentThreadId", "commentId")
        VALUES (5001, 5000, 5000, 5000);
      INSERT INTO "CommentV2" (id, "userId", "threadId") VALUES (5001, ${replier}, 5001);
    `);
  }

  it('keeps the thread, and the unheld reply above the held one, off the deleted post', async () => {
    await seedPostThread(HELD);

    await removeAllContent({ id: CLEAN });

    expect(await rows(`SELECT id FROM "Post" WHERE "userId" = ${CLEAN}`)).toEqual([]);
    expect(await commentIds()).toEqual([5000, 5001]);
    expect(await rows(`SELECT "postId", metadata FROM "Thread" WHERE id = 5000`)).toEqual([
      { postId: null, metadata: expect.objectContaining({ detachedFrom: { postId: 1 } }) },
    ]);
  });

  it('takes the whole thread with the post when no held author is in it (control)', async () => {
    await seedPostThread(BYSTANDER);

    await removeAllContent({ id: CLEAN });

    expect(await commentIds()).toEqual([]);
  });

  it('keeps a held comment on another user’s review of the deleted model', async () => {
    await holder.db.exec(`
      UPDATE "ResourceReview" SET "modelId" = ${MODEL} WHERE "userId" = ${BYSTANDER};
      INSERT INTO "Thread" (id, "reviewId")
        SELECT 5000, id FROM "ResourceReview" WHERE "userId" = ${BYSTANDER};
      INSERT INTO "CommentV2" (id, "userId", "threadId") VALUES (5000, ${HELD}, 5000);
    `);

    await removeAllContent({ id: CLEAN });

    expect(await rows(`SELECT id FROM "Model" WHERE id = ${MODEL}`)).toEqual([]);
    expect(await commentIds()).toEqual([5000]);
  });

  it('keeps a held comment on another user’s entry to the deleted bounty', async () => {
    await holder.db.exec(`
      UPDATE "BountyEntry" SET "bountyId" = ${BOUNTY} WHERE "userId" = ${BYSTANDER};
      INSERT INTO "Thread" (id, "bountyEntryId")
        SELECT 5000, id FROM "BountyEntry" WHERE "userId" = ${BYSTANDER};
      INSERT INTO "CommentV2" (id, "userId", "threadId") VALUES (5000, ${HELD}, 5000);
    `);

    await removeAllContent({ id: CLEAN });

    expect(await rows(`SELECT id FROM "Bounty" WHERE id = ${BOUNTY}`)).toEqual([]);
    expect(await commentIds()).toEqual([5000]);
  });

  it('takes a model a held author left a legacy comment on off the site instead of deleting it', async () => {
    await holder.db.exec(`
      INSERT INTO "Comment" (id, "userId", "modelId") VALUES (5000, ${HELD}, ${MODEL});
    `);

    await removeAllContent({ id: CLEAN, actorUserId: 77 });

    expect(deleteModelById).toHaveBeenCalledTimes(1);
    expect(deleteModelById).toHaveBeenCalledWith(
      expect.objectContaining({ id: MODEL, userId: 77, isModerator: true })
    );
    // The legacy comment cascades with the model, so a hard delete would take it. Not hidden as
    // well: the end-of-wipe refund would then refund its bids a second time.
    expect(
      await rows(`SELECT id, status, meta ->> 'removedWithOwner' AS removed
        FROM "Model" WHERE id = ${MODEL}`)
    ).toEqual([{ id: MODEL, status: 'Deleted', removed: null }]);
    expect(await rows(`SELECT id FROM "Comment" WHERE id = 5000`)).toEqual([{ id: 5000 }]);
  });

  it('hides, with its record, a model with a held legacy comment that an earlier owner’s hold keeps', async () => {
    await holder.db.exec(`
      INSERT INTO "Model" (id, "userId", status) VALUES (${GIVEN_BY_HELD}, ${CLEAN}, 'Published');
      INSERT INTO "Comment" (id, "userId", "modelId") VALUES (5000, ${HELD}, ${GIVEN_BY_HELD});
    `);

    await removeAllContent({ id: CLEAN, actorUserId: 77 });

    expect(deleteModelById).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: GIVEN_BY_HELD })
    );
    expect(
      await rows(`SELECT status, meta ->> 'removedWithOwner' AS removed
        FROM "Model" WHERE id = ${GIVEN_BY_HELD}`)
    ).toEqual([{ status: KEPT_MODEL_STATUS, removed: 'true' }]);
    expect(await rows(`SELECT id FROM "Comment" WHERE id = 5000`)).toEqual([{ id: 5000 }]);
  });

  // The same alerted line as a hard-deleted model's failed refund, which the bids need by hand.
  it('alerts on a bid refund that fails for the model it soft-deletes', async () => {
    await holder.db.exec(`
      INSERT INTO "Comment" (id, "userId", "modelId") VALUES (5000, ${HELD}, ${MODEL});
    `);
    deleteModelById.mockImplementationOnce((async (args: {
      onBidRefundFailed?: (f: { versionIds: number[]; transactionIds: string[] }) => void;
    }) => {
      args.onBidRefundFailed?.({ versionIds: [41], transactionIds: ['tx-1'] });
      return null;
    }) as never);

    const result = await removeAllContent({ id: CLEAN, actorUserId: 77 });

    expect(result).toMatchObject({ incomplete: expect.arrayContaining(['bid-refunds']) });
    expect(refundAlerts()).toContainEqual(
      expect.objectContaining({
        source: 'remove-all-content',
        userId: CLEAN,
        moderatorId: 77,
        versionIds: [41],
        transactionIds: ['tx-1'],
      })
    );
  });

  it('names the soft-deleted model’s failed refund when a hold stops the wipe', async () => {
    await holder.db.exec(`
      INSERT INTO "Comment" (id, "userId", "modelId") VALUES (5000, ${HELD}, ${MODEL});
    `);
    deleteModelById.mockImplementationOnce((async (args: {
      onBidRefundFailed?: (f: { versionIds: number[]; transactionIds: string[] }) => void;
    }) => {
      args.onBidRefundFailed?.({ versionIds: [41], transactionIds: ['tx-1'] });
      return null;
    }) as never);
    landsBefore = 'ChatMessage';
    beforeEvidence = () => holder.db.exec(`INSERT INTO "CsamReport" ("userId") VALUES (${CLEAN})`);

    const stopped = await removeAllContent({ id: CLEAN, actorUserId: 77 }).catch((e) => e);

    expect(stopped).toBeInstanceOf(LegalHoldStoppedError);
    expect((stopped as LegalHoldStoppedError).incomplete).toContain('bid-refunds');
  });

  it('still finishes the wipe when that soft delete fails, and names it incomplete', async () => {
    await holder.db.exec(`
      INSERT INTO "Comment" (id, "userId", "modelId") VALUES (5000, ${HELD}, ${MODEL});
    `);
    deleteModelById.mockRejectedValueOnce(new Error('cache down'));

    const result = await removeAllContent({ id: CLEAN });

    // No moderator named: the wipe is no one's delete, so none is recorded as the deleter.
    expect(deleteModelById).toHaveBeenCalledWith(
      expect.objectContaining({ id: MODEL, userId: null, isModerator: true })
    );
    expect(result).toMatchObject({ incomplete: expect.arrayContaining(['model-soft-delete']) });
    expect(await rows(`SELECT id FROM "Comment" WHERE id = 5000`)).toEqual([{ id: 5000 }]);
  });

  it('deletes a model whose legacy comments no held author wrote (control)', async () => {
    await holder.db.exec(`
      INSERT INTO "Comment" (id, "userId", "modelId") VALUES (5000, ${BYSTANDER}, ${MODEL});
    `);

    await removeAllContent({ id: CLEAN });

    expect(deleteModelById).not.toHaveBeenCalled();
    expect(await rows(`SELECT id FROM "Model" WHERE id = ${MODEL}`)).toEqual([]);
    expect(await rows(`SELECT id FROM "Comment" WHERE id = 5000`)).toEqual([]);
  });

  it('keeps, hidden, its own legacy comment a held author replied to', async () => {
    await holder.db.exec(`
      INSERT INTO "Comment" (id, "userId", "modelId", "parentId") VALUES
        (5000, ${CLEAN}, NULL, NULL), (5001, ${HELD}, NULL, 5000), (5002, ${CLEAN}, NULL, NULL);
    `);

    await removeAllContent({ id: CLEAN });

    expect(
      await rows(`SELECT id, "tosViolation" FROM "Comment" WHERE id >= 5000 ORDER BY id`)
    ).toEqual([
      { id: 5000, tosViolation: true },
      { id: 5001, tosViolation: false },
    ]);
  });

  it("leaves the legacy comment it kept hidden through a moderator's ToS restore", async () => {
    // Prisma's update, as one UPDATE whose WHERE carries every field the call names.
    vi.mocked(dbMock.dbWrite.comment.update).mockImplementation((async (args: {
      where: { id: number; removedByAuthor?: boolean };
      data: { tosViolation: boolean };
    }) => {
      const { rows: updated } = await holder.db.query(
        `UPDATE "Comment" SET "tosViolation" = $2 WHERE id = $1
           AND ($3::boolean IS NULL OR "removedByAuthor" = $3) RETURNING id`,
        [args.where.id, args.data.tosViolation, args.where.removedByAuthor ?? null]
      );
      if (!updated.length) throw Object.assign(new Error('not found'), { code: 'P2025' });
      return updated[0];
    }) as never);
    // 5003 is a bystander's comment a moderator hid: the control a restore brings back.
    await holder.db.exec(`
      INSERT INTO "Comment" (id, "userId", "modelId", "parentId") VALUES
        (5000, ${CLEAN}, NULL, NULL), (5001, ${HELD}, NULL, 5000);
      INSERT INTO "Comment" (id, "userId", "tosViolation") VALUES (5003, ${BYSTANDER}, true);
    `);

    await removeAllContent({ id: CLEAN });
    await expect(bulkClearCommentTosViolation({ ids: [5000, 5003] })).resolves.toMatchObject({
      count: 1,
    });

    expect(
      await rows(`SELECT id, "tosViolation" FROM "Comment" WHERE id IN (5000, 5003) ORDER BY id`)
    ).toEqual([
      { id: 5000, tosViolation: true },
      { id: 5003, tosViolation: false },
    ]);
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

  it('wipes an unheld account', async () => {
    const res = await call(CLEAN);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ userId: CLEAN, incomplete: [], keptModelIds: [] });
    expect(moderatorReads(res)).toBeNull();
    expect(moderator.purgeWarning(res.body)).toBeUndefined();
    expect(await remaining(CLEAN)).toEqual(all(0));
  });

  it('answers 200, records the activity and names the step when a cleanup step fails', async () => {
    vi.mocked(refundBidsForVersions).mockRejectedValueOnce(new Error('buzz down'));
    const res = await call(CLEAN);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ userId: CLEAN, incomplete: ['bid-refunds'], keptModelIds: [] });
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

  it('answers 403 with the hold refusal for a held account, deleting nothing', async () => {
    const res = await call(HELD);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ message: 'Account under legal hold; contact Legal.' });
    expect(moderatorReads(res)).toBe(moderator.LEGAL_HOLD_REFUSAL);
    expect(await remaining(HELD)).toEqual(seeded(HELD));
    expect(tracked).not.toHaveBeenCalled();
  });

  it('answers 403 saying the hold could not be checked, deleting nothing', async () => {
    failLookups = true;
    const res = await call(CLEAN);
    failLookups = false;
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ message: "Couldn't check legal hold status; try again." });
    expect(moderatorReads(res)).toBe(moderator.HOLD_UNKNOWN_REFUSAL);
    expect(await remaining(CLEAN)).toEqual(seeded(CLEAN));
    expect(tracked).not.toHaveBeenCalled();
  });

  it('answers 409 and records the activity when a hold stops the wipe part-way', async () => {
    beforeEvidence = () => holder.db.exec(`INSERT INTO "CsamReport" ("userId") VALUES (${CLEAN})`);
    const res = await call(CLEAN);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ message: LEGAL_HOLD_STOPPED });
    expect(moderatorReads(res)).toBe(moderator.LEGAL_HOLD_STOPPED);
    expect(tracked).toHaveBeenCalledWith({ type: 'RemoveContent', targetUserId: CLEAN });
  });

  it('says a stopped wipe left bids unrefunded, when one of its refunds failed', async () => {
    landsBefore = 'ChatMessage';
    beforeEvidence = () => holder.db.exec(`INSERT INTO "CsamReport" ("userId") VALUES (${CLEAN})`);
    vi.mocked(refundBidsForVersions).mockResolvedValueOnce({
      bidsDeleted: [1],
      recurringBidsDeleted: [],
      refundFailed: ['tx-3'],
    });
    const res = await call(CLEAN);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      message: moderator.LEGAL_HOLD_STOPPED_REFUNDS_INCOMPLETE,
      incomplete: ['bid-refunds'],
    });
    expect(moderatorReads(res)).toBe(moderator.LEGAL_HOLD_STOPPED_REFUNDS_INCOMPLETE);
  });

  it('says bids were left unrefunded when the hold lands after the refunds, before the App Blocks stores', async () => {
    vi.mocked(refundBidsForVersions).mockImplementationOnce(async () => {
      await holder.db.exec(`INSERT INTO "CsamReport" ("userId") VALUES (${CLEAN})`);
      return { bidsDeleted: [1], recurringBidsDeleted: [], refundFailed: ['tx-4'] };
    });
    const res = await call(CLEAN);
    expect(purgeUserAppStorageForAccountWipe).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      message: moderator.LEGAL_HOLD_STOPPED_REFUNDS_INCOMPLETE,
      incomplete: ['bid-refunds'],
    });
  });

  it('says only that it stopped when every refund of a stopped wipe went through', async () => {
    landsBefore = 'ChatMessage';
    beforeEvidence = () => holder.db.exec(`INSERT INTO "CsamReport" ("userId") VALUES (${CLEAN})`);
    const res = await call(CLEAN);
    expect(refundBidsForVersions).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ message: LEGAL_HOLD_STOPPED });
  });

  it('names a failed step other than the refunds without saying bids were left unrefunded', async () => {
    indexes.models.queueUpdate.mockRejectedValueOnce(new Error('queue down'));
    vi.mocked(refundBidsForVersions).mockImplementationOnce(async () => {
      await holder.db.exec(`INSERT INTO "CsamReport" ("userId") VALUES (${CLEAN})`);
      return { bidsDeleted: [1], recurringBidsDeleted: [], refundFailed: [] };
    });
    const res = await call(CLEAN);
    expect(purgeUserAppStorageForAccountWipe).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ message: LEGAL_HOLD_STOPPED, incomplete: ['index-models'] });
    expect(moderatorReads(res)).toBe(moderator.LEGAL_HOLD_STOPPED);
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

  it('deletes an unheld account’s images', async () => {
    const res = await call(CLEAN);
    expect(res.statusCode).toBe(200);
    expect((await remaining(CLEAN)).Image).toBe(0);
    // The post that held them goes with them.
    expect((await remaining(CLEAN)).Post).toBe(0);
    expect((await remaining(BYSTANDER)).Image).toBe(1);
    expect((await remaining(BYSTANDER)).Post).toBe(1);
  });

  it.each([
    ['keeps', HELD, [5000]],
    ['takes, as a control,', BYSTANDER, []],
  ])("%s a comment on the deleted post's thread by an author", async (_, author, left) => {
    await holder.db.exec(`
      INSERT INTO "Thread" (id, "postId") VALUES (5000, 1);
      INSERT INTO "CommentV2" (id, "userId", "threadId") VALUES (5000, ${author}, 5000);
    `);

    expect((await call(CLEAN)).statusCode).toBe(200);

    expect((await remaining(CLEAN)).Post).toBe(0);
    const { rows } = await holder.db.query<{ id: number }>(
      `SELECT id FROM "CommentV2" WHERE id >= 5000`
    );
    expect(rows.map((r) => r.id)).toEqual(left);
  });

  it('deletes an unheld account’s images while the marker view exists', async () => {
    await createMarkerView();
    expect((await call(CLEAN)).statusCode).toBe(200);
    expect((await remaining(CLEAN)).Image).toBe(0);
  });

  it('refuses a held account with the hold refusal, deleting nothing', async () => {
    const res = await call(HELD);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ message: 'Account under legal hold; contact Legal.' });
    expect(moderatorReads(res)).toBe(moderator.LEGAL_HOLD_REFUSAL);
    expect((await remaining(HELD)).Image).toBe(1);
  });

  it('refuses, saying the hold could not be checked, deleting nothing', async () => {
    failLookups = true;
    const res = await call(CLEAN);
    failLookups = false;
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ message: "Couldn't check legal hold status; try again." });
    expect(moderatorReads(res)).toBe(moderator.HOLD_UNKNOWN_REFUSAL);
    expect((await remaining(CLEAN)).Image).toBe(2);
  });

  it('keeps the images and posts when a hold lands mid-run, and says it stopped', async () => {
    holder.beforeImages = () =>
      holder.db.exec(`INSERT INTO "CsamReport" ("userId") VALUES (${CLEAN})`);
    const res = await call(CLEAN);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ message: LEGAL_HOLD_STOPPED });
    expect(moderatorReads(res)).toBe(moderator.LEGAL_HOLD_STOPPED);
    expect((await remaining(CLEAN)).Image).toBe(2);
    expect((await remaining(CLEAN)).Post).toBe(1);
  });

  it('says it stopped, naming nothing, when the marker view is dropped mid-run', async () => {
    await createMarkerView();
    holder.beforeImages = () => holder.db.exec(`DROP VIEW "EvidenceHeldUser"`);
    const res = await call(CLEAN);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ message: LEGAL_HOLD_STOPPED });
    expect(moderatorReads(res)).toBe(moderator.LEGAL_HOLD_STOPPED);
    expect((await remaining(CLEAN)).Image).toBe(2);
  });

  it('says it stopped when its re-check cannot be read', async () => {
    afterHeld = null;
    const res = await call(CLEAN);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ message: LEGAL_HOLD_STOPPED });
    expect(moderatorReads(res)).toBe(moderator.LEGAL_HOLD_STOPPED);
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

  it.each([
    ['after it was hidden, leaves it hidden and out of search', 'Answer', RECORD, 'Private'],
    ['before it was hidden, leaves it as it was', 'Bounty', null, 'Public'],
  ])('a hold landing mid-wipe %s', async (_, before, meta, availability) => {
    landsBefore = before;
    beforeEvidence = () => holder.db.exec(`INSERT INTO "CsamReport" ("userId") VALUES (${CLEAN})`);

    await expect(removeAllContent({ id: CLEAN })).rejects.toBeInstanceOf(LegalHoldStoppedError);
    expect(await bounty()).toEqual({ availability, meta });
    expect(searchDeletes().some((r) => (r as { id: number }).id === BOUNTY)).toBe(!!meta);
  });

  it('is deleted by the wipe when its payout settles there (control)', async () => {
    payout.settles = true;
    await removeAllContent({ id: CLEAN });

    expect(await bounty()).toBeUndefined();
  });

  describe('and the payout retry after it', () => {
    beforeEach(async () => {
      await removeAllContent({ id: CLEAN });
      await createMarkerView();
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

    it('leaves it hidden while its owner is held, and deletes it once the hold ends', async () => {
      await settle();
      await holder.db.exec(`INSERT INTO "EvidenceHold" VALUES (${CLEAN}, NULL)`);

      expect(await deleteSettledKeptBounties()).toBe(0);
      expect(await bounty()).toEqual({ availability: 'Private', meta: RECORD });

      await holder.db.exec(
        `UPDATE "EvidenceHold" SET "releasedAt" = now() WHERE "userId" = ${CLEAN}`
      );
      expect(await deleteSettledKeptBounties()).toBe(1);
    });

    it('keeps a held author’s comment on it', async () => {
      await settle();
      await holder.db.exec(`
        INSERT INTO "Thread" (id, "bountyId") VALUES (5000, ${BOUNTY});
        INSERT INTO "CommentV2" (id, "userId", "threadId") VALUES (5000, ${HELD}, 5000);
      `);

      expect(await deleteSettledKeptBounties()).toBe(1);
      expect(
        (await holder.db.query(`SELECT id FROM "CommentV2" WHERE id = 5000`)).rows
      ).toHaveLength(1);
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

  it.each([
    ['refund settles', true],
    ['refund throws', 'throws'],
  ] as const)('is kept for a hold landing mid-wipe after its %s', async (_, settles) => {
    payout.settles = settles;
    landsBefore = 'Bounty';
    beforeEvidence = () => holder.db.exec(`INSERT INTO "CsamReport" ("userId") VALUES (${CLEAN})`);

    await expect(removeAllContent({ id: CLEAN })).rejects.toBeInstanceOf(LegalHoldStoppedError);
    expect(payout.claimed).toEqual([BOUNTY]);
    expect((await remaining(CLEAN)).Bounty).toBe(1);
  });
});
