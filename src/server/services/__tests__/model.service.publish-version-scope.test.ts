import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// Publishing a model only touches that model's own versions: a version id that belongs to a
// different model is dropped before anything is written, and every version write is also scoped by
// modelId.

const { mockTx } = vi.hoisted(() => ({
  mockTx: {
    model: {
      update: vi.fn(),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findUnique: vi.fn(async () => ({ status: 'Draft', availability: 'Public', meta: null })),
    },
    modelVersion: { findFirst: vi.fn(), updateMany: vi.fn() },
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(async () => []),
  },
}));

vi.mock('~/server/db/db-lag-helpers', () => ({
  preventReplicationLag: vi.fn(),
  getDbWithoutLag: vi.fn(async () => dbMock.dbRead),
  preventModelVersionLagBatch: vi.fn(),
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

import { publishModelVersionsWithEarlyAccess } from '~/server/services/model-version.service';
import { publishModelById } from '~/server/services/model.service';

const MODEL_ID = 42;
const OWNER_ID = 7;
const OWN_VERSION_ID = 100;
const OTHER_MODEL_ID = 43;
const OTHER_MODEL_VERSION_ID = 200;

type VersionRow = { id: number; modelId: number; status: string };
let versions: VersionRow[] = [];

type VersionWhere = { id?: { in?: number[] }; modelId?: number };
const matches = (row: VersionRow, where: VersionWhere) =>
  (where.id?.in === undefined || where.id.in.includes(row.id)) &&
  (where.modelId === undefined || row.modelId === where.modelId);

const rawSql = () =>
  mockTx.$executeRaw.mock.calls.map(([strings]) => (strings as string[]).join('?'));

beforeEach(() => {
  vi.clearAllMocks();
  versions = [
    { id: OWN_VERSION_ID, modelId: MODEL_ID, status: 'Draft' },
    { id: OTHER_MODEL_VERSION_ID, modelId: OTHER_MODEL_ID, status: 'Draft' },
  ];
  dbMock.dbWrite.$transaction.mockImplementation((fn: (tx: typeof mockTx) => unknown) =>
    fn(mockTx)
  );
  dbMock.dbWrite.modelVersion.findMany.mockImplementation((async ({
    where,
  }: {
    where: VersionWhere;
  }) => versions.filter((row) => matches(row, where)).map(({ id }) => ({ id }))) as never);
  mockTx.modelVersion.updateMany.mockImplementation(
    async ({ where, data }: { where: VersionWhere; data: { status: string } }) => {
      const hit = versions.filter((row) => matches(row, where));
      hit.forEach((row) => (row.status = data.status));
      return { count: hit.length };
    }
  );
  mockTx.model.update.mockResolvedValue({
    id: MODEL_ID,
    userId: OWNER_ID,
    nsfw: false,
    modelVersions: [{ id: OWN_VERSION_ID, baseModel: 'Illustrious' }],
    status: 'Published',
  });
  mockTx.model.updateMany.mockResolvedValue({ count: 0 });
  mockTx.modelVersion.findFirst.mockResolvedValue(null);
  mockTx.$executeRaw.mockResolvedValue(0);
  dbMock.dbWrite.post.findMany.mockResolvedValue([]);
  dbMock.dbWrite.image.findMany.mockResolvedValue([]);
  dbMock.dbWrite.$executeRaw.mockResolvedValue(0);
});

describe('publishModelById only touches the model’s own versions', () => {
  it('publishes the model’s version and drops a version id from another model', async () => {
    await publishModelById({
      id: MODEL_ID,
      versionIds: [OWN_VERSION_ID, OTHER_MODEL_VERSION_ID],
    });

    expect(publishModelVersionsWithEarlyAccess).toHaveBeenCalledTimes(1);
    expect(publishModelVersionsWithEarlyAccess).toHaveBeenCalledWith(
      expect.objectContaining({ modelVersionIds: [OWN_VERSION_ID], modelId: MODEL_ID })
    );
  });

  it('publishes no version when every id belongs to another model', async () => {
    await publishModelById({ id: MODEL_ID, versionIds: [OTHER_MODEL_VERSION_ID] });

    expect(publishModelVersionsWithEarlyAccess).not.toHaveBeenCalled();
  });

  it('a scheduled publish leaves another model’s version as it was', async () => {
    await publishModelById({
      id: MODEL_ID,
      versionIds: [OWN_VERSION_ID, OTHER_MODEL_VERSION_ID],
      publishedAt: new Date(Date.now() + 86_400_000),
    });

    expect(versions).toEqual([
      { id: OWN_VERSION_ID, modelId: MODEL_ID, status: 'Scheduled' },
      { id: OTHER_MODEL_VERSION_ID, modelId: OTHER_MODEL_ID, status: 'Draft' },
    ]);
  });

  it('scopes every version write to the model, not only the id list', async () => {
    await publishModelById({
      id: MODEL_ID,
      versionIds: [OWN_VERSION_ID],
      publishedAt: new Date(Date.now() + 86_400_000),
    });

    expect(mockTx.modelVersion.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [OWN_VERSION_ID] }, modelId: MODEL_ID },
      data: { status: 'Scheduled' },
    });
    const versionPublishedAt = rawSql().find((sql) => sql.includes('UPDATE "ModelVersion"'));
    expect(versionPublishedAt).toMatch(/WHERE id IN \(\?\)\s+AND "modelId" = \?\s+AND/);
    const postRestore = rawSql().find((sql) => sql.includes('UPDATE "Post" p'));
    expect(postRestore).toMatch(/WHERE mv\.id = p\."modelVersionId"\s+AND mv\."modelId" = \?\s/);
  });
});

describe('publishModelById meta', () => {
  // JSON `null` here is what the `COALESCE(meta, '{}') || x` writers turned into `[null, x]`, which
  // prepare-leaderboard's jsonb_set then threw on (2026-10-18). `{}` is the column's own default.
  it('stores an empty object, not JSON null, when published without meta', async () => {
    await publishModelById({ id: MODEL_ID, versionIds: [OWN_VERSION_ID] });

    // toStrictEqual: Prisma.JsonNull is a class instance with no own keys, so plain equality takes it for {}.
    expect(mockTx.model.update.mock.calls[0][0].data.meta).toStrictEqual({});
  });

  it('stores the meta it is given', async () => {
    await publishModelById({
      id: MODEL_ID,
      versionIds: [OWN_VERSION_ID],
      meta: { showcaseCollectionId: 3 },
    });

    expect(mockTx.model.update.mock.calls[0][0].data.meta).toStrictEqual({
      showcaseCollectionId: 3,
    });
  });
});
