import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

// A scheduled model's date, as publishModelById writes it: never after the model's first version.
// The transaction's raw SQL runs against an in-process Postgres; its ORM calls are stubs.

const { mockTx } = vi.hoisted(() => ({
  mockTx: {
    model: {
      update: vi.fn(),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findUnique: vi.fn(async () => ({ status: 'Scheduled', availability: 'Public', meta: null })),
    },
    modelVersion: { findFirst: vi.fn(async () => null), updateMany: vi.fn() },
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
  },
}));

vi.mock('~/server/db/db-lag-helpers', () => ({
  preventReplicationLag: vi.fn(),
  getDbWithoutLag: vi.fn(async () => dbMock.dbRead),
  preventModelVersionLagBatch: vi.fn(),
}));
const { syncReviewsOfMovedPosts } = vi.hoisted(() => ({ syncReviewsOfMovedPosts: vi.fn() }));
vi.mock('~/server/services/resourceReview.visibility', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  syncReviewsOfMovedPosts,
}));
vi.mock('~/server/db/pgDb', () => ({ pgDbRead: {}, pgDbWrite: {}, pgDbReadLong: {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null, Tracker: class {} }));
vi.mock('~/server/flipt/client', () => ({ isFlipt: vi.fn(() => false), FLIPT_FEATURE_FLAGS: {} }));
vi.mock('~/server/metrics', () => ({ modelMetrics: {} }));
vi.mock('~/server/redis/caches', () => ({
  dataForModelsCache: {},
  modelTagCache: { refresh: vi.fn() },
  modelVotableTagsCache: { bust: vi.fn() },
  userBasicCache: {},
  userModelCountCache: { refresh: vi.fn() },
}));
vi.mock('~/server/search-index', () => ({
  collectionsSearchIndex: { queueUpdate: vi.fn() },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
  imagesSearchIndex: { queueUpdate: vi.fn() },
  modelsSearchIndex: { queueUpdate: vi.fn() },
}));
vi.mock('~/server/services/auction.service', () => ({
  deleteBidsForModel: vi.fn(),
  getLastAuctionReset: vi.fn(),
}));
vi.mock('~/server/services/buzz.service', () => ({}));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTagsForModels: vi.fn(),
}));
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedLinkDomain: vi.fn(),
  throwOnBlockedUserContent: vi.fn(),
}));
vi.mock('~/server/services/collection.service', () => ({
  getAvailableCollectionItemsFilterForUser: vi.fn(),
  getUserCollectionPermissionsById: vi.fn(),
  saveItemInCollections: vi.fn(),
}));
vi.mock('~/server/services/cosmetic.service', () => ({ getCosmeticsForEntity: vi.fn() }));
vi.mock('~/server/services/creator-program.service', () => ({
  getValidCreatorMembershipMap: vi.fn(),
}));
vi.mock('~/server/services/generation/generation.service', () => ({
  getUnavailableResources: vi.fn(),
}));
vi.mock('~/server/services/image.service', () => ({
  getImagesForModelVersion: vi.fn(),
  getImagesForModelVersionCache: {},
  queueImageSearchIndexUpdate: vi.fn(),
}));
vi.mock('~/server/services/model-file.service', () => ({ getFilesForModelVersionCache: {} }));
vi.mock('~/server/services/model-version.service', () => ({
  bustMvCache: vi.fn(),
  bustPublicModelResponseCache: vi.fn(),
  createModelVersionPostFromTraining: vi.fn(),
  publishModelVersionsWithEarlyAccess: vi.fn(),
}));
vi.mock('~/server/services/moderator.service', () => ({ trackModActivity: vi.fn() }));
vi.mock('~/server/services/subscriptions.service', () => ({ getHighestTierSubscription: vi.fn() }));
vi.mock('~/server/services/system-cache', () => ({ getCategoryTags: vi.fn() }));
vi.mock('~/server/services/user.service', () => ({
  deleteBasicDataForUser: vi.fn(),
  getCosmeticsForUsers: vi.fn(),
  getProfilePicturesForUsers: vi.fn(),
}));
vi.mock('~/server/utils/cache-helpers', () => ({
  bustFetchThroughCache: vi.fn(),
  fetchThroughCache: vi.fn(),
}));
vi.mock('~/utils/s3-utils', () => ({ deleteModelFileObjects: vi.fn() }));
vi.mock('~/utils/storage-resolver', () => ({ deregisterFileLocationsBatch: vi.fn() }));

import { publishModelById } from '~/server/services/model.service';

const MODEL_ID = 42;
const OWNER_ID = 7;
const V1 = 100;
const V2 = 101;
const DAY = 24 * 60 * 60_000;
const TODAY = Math.floor(Date.now() / DAY) * DAY;
const at = (days: number) => new Date(TODAY + days * DAY);

const pg = { db: null as unknown as PGlite };

beforeAll(async () => {
  pg.db = new PGlite();
  await pg.db.exec(`
    CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int, "publishedAt" timestamp(3));
    CREATE TABLE "ModelVersion" (
      id int PRIMARY KEY, "modelId" int NOT NULL, status text NOT NULL, "publishedAt" timestamp(3)
    );
    CREATE TABLE "Post" (
      id int PRIMARY KEY, "userId" int, "modelVersionId" int, "publishedAt" timestamp(3),
      metadata jsonb NOT NULL DEFAULT '{}'
    );
  `);
  const raw = pgliteRaw(pg.db);
  mockTx.$executeRaw.mockImplementation(raw.executeRaw as never);
  mockTx.$queryRaw.mockImplementation(raw.queryRaw as never);
});

afterAll(async () => {
  await pg.db?.close();
});

beforeEach(async () => {
  await pg.db.exec(`TRUNCATE "Model", "ModelVersion", "Post"`);
  dbMock.dbWrite.$transaction.mockImplementation((fn: (tx: typeof mockTx) => unknown) =>
    fn(mockTx)
  );
  dbMock.dbWrite.modelVersion.findMany.mockImplementation((async ({
    where,
  }: {
    where: { id: { in: number[] } };
  }) => where.id.in.map((id) => ({ id }))) as never);
  mockTx.modelVersion.updateMany.mockImplementation((async ({
    where,
    data,
  }: {
    where: { id: { in: number[] }; status?: { not: string } };
    data: { status: string };
  }) =>
    pg.db.query(
      `UPDATE "ModelVersion" SET status = $1
       WHERE id = ANY($2) AND ($3::text IS NULL OR status <> $3)`,
      [data.status, where.id.in, where.status?.not ?? null]
    )) as never);
  mockTx.model.update.mockResolvedValue({
    id: MODEL_ID,
    userId: OWNER_ID,
    nsfw: false,
    modelVersions: [],
    status: 'Scheduled',
  });
  dbMock.dbWrite.post.findMany.mockResolvedValue([]);
  dbMock.dbWrite.image.findMany.mockResolvedValue([]);
  dbMock.dbWrite.$executeRaw.mockResolvedValue(0);
});

async function seed(model: Date | null, versions: [id: number, status: string, at: Date | null][]) {
  await pg.db.query(`INSERT INTO "Model" VALUES ($1, $2, $3)`, [MODEL_ID, OWNER_ID, model]);
  for (const [id, status, publishedAt] of versions)
    await pg.db.query(`INSERT INTO "ModelVersion" VALUES ($1, $2, $3, $4)`, [
      id,
      MODEL_ID,
      status,
      publishedAt,
    ]);
}
const modelDate = async () =>
  (
    await pg.db.query<{ publishedAt: Date }>(`SELECT "publishedAt" FROM "Model" WHERE id = $1`, [
      MODEL_ID,
    ])
  ).rows[0].publishedAt;

describe('publishModelById :: the date of a scheduled model', () => {
  it('keeps the first version’s date when a later second version is scheduled', async () => {
    await seed(at(1), [
      [V1, 'Scheduled', at(1)],
      [V2, 'Draft', null],
    ]);
    await publishModelById({ id: MODEL_ID, versionIds: [V2], publishedAt: at(3) });
    expect(await modelDate()).toEqual(at(1));
  });

  // A live version may have been published at once, ahead of the model's date.
  it('takes the owner’s new date when a live version is the only earlier one', async () => {
    await seed(at(3), [
      [V1, 'Published', at(-1)],
      [V2, 'Scheduled', at(3)],
    ]);
    await publishModelById({ id: MODEL_ID, versionIds: [V2], publishedAt: at(5) });
    expect(await modelDate()).toEqual(at(5));
  });

  it('keeps a live version live when the model is rescheduled with it', async () => {
    await seed(at(3), [
      [V1, 'Published', at(-1)],
      [V2, 'Scheduled', at(3)],
    ]);
    await publishModelById({ id: MODEL_ID, versionIds: [V1, V2], publishedAt: at(5) });
    const [v1] = (
      await pg.db.query<{ status: string; publishedAt: Date }>(
        `SELECT status, "publishedAt" FROM "ModelVersion" WHERE id = $1`,
        [V1]
      )
    ).rows;
    expect(v1).toEqual({ status: 'Published', publishedAt: at(-1) });
    expect(await modelDate()).toEqual(at(5));
  });

  it('leaves the date of a model already public', async () => {
    await seed(at(-2), [[V1, 'Scheduled', at(1)]]);
    await publishModelById({ id: MODEL_ID, versionIds: [V2], publishedAt: at(3) });
    expect(await modelDate()).toEqual(at(-2));
  });

  // Unpublished after going live, then rescheduled: it keeps the date it went live on.
  it('ignores a rescheduled version still carrying a past date', async () => {
    await seed(at(3), [[V1, 'Unpublished', at(-1)]]);
    await publishModelById({ id: MODEL_ID, versionIds: [V1], publishedAt: at(5) });
    expect(await modelDate()).toEqual(at(5));
  });

  it('dates a Draft model at its first scheduled version', async () => {
    await seed(null, [[V1, 'Draft', null]]);
    await publishModelById({ id: MODEL_ID, versionIds: [V1], publishedAt: at(2) });
    expect(await modelDate()).toEqual(at(2));
  });

  it('ignores a version that is neither live nor scheduled', async () => {
    await seed(at(1), [
      [V1, 'Unpublished', at(-5)],
      [V2, 'Draft', null],
    ]);
    await publishModelById({ id: MODEL_ID, versionIds: [V2], publishedAt: at(3) });
    expect(await modelDate()).toEqual(at(3));
  });

  it('follows a lone version rescheduled later', async () => {
    await seed(at(1), [[V1, 'Scheduled', at(1)]]);
    await publishModelById({ id: MODEL_ID, versionIds: [V1], publishedAt: at(4) });
    expect(await modelDate()).toEqual(at(4));
  });
});
