import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ModelModerationAdapter from '~/server/services/model-moderation.adapter';
import type * as TextScanSubmit from '~/server/services/text-scan/submit';

// Drafts are not scanned, so a publish is the first text scan for the model and for the posts it
// dates. Same module-load scaffold as model-republish-last-version-at.service.test.ts.

const { mockTx } = vi.hoisted(() => ({
  mockTx: {
    model: { update: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: vi.fn() },
    modelVersion: { findFirst: vi.fn(), updateMany: vi.fn() },
    post: { updateMany: vi.fn() },
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
  },
}));

vi.mock('~/server/services/text-scan/submit', async (importOriginal) => ({
  ...(await importOriginal<typeof TextScanSubmit>()),
  scanEntitiesInBackground: vi.fn(),
  scanEntityInBackground: vi.fn(),
  checkModelRulesInBackground: vi.fn(),
}));
vi.mock('~/server/services/model-moderation.adapter', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelModerationAdapter>()),
  submitModelTextModeration: vi.fn(async () => undefined),
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

import { submitModelTextModeration } from '~/server/services/model-moderation.adapter';
import { publishModelById, publishPrivateModel } from '~/server/services/model.service';
import {
  scanEntitiesInBackground,
  scanEntityInBackground,
  checkModelRulesInBackground,
} from '~/server/services/text-scan/submit';

// Counts Model rules checks however they are queued.
const modelRulesScans = () =>
  vi.mocked(checkModelRulesInBackground).mock.calls.length +
  vi.mocked(scanEntityInBackground).mock.calls.filter(([args]) => args.entityType === 'ModelRules')
    .length;

const MODEL_ID = 42;
const OWNER_ID = 7;
const PUBLISHED = 100;
const DRAFT = 101;

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.$transaction.mockImplementation((fn: (tx: typeof mockTx) => unknown) =>
    fn(mockTx)
  );
  mockTx.model.update.mockResolvedValue({
    id: MODEL_ID,
    userId: OWNER_ID,
    name: 'LoRA',
    description: 'about',
    nsfw: false,
    modelVersions: [
      { id: PUBLISHED, baseModel: 'Illustrious' },
      { id: DRAFT, baseModel: 'Illustrious' },
    ],
    status: 'Published',
  });
  mockTx.modelVersion.findFirst.mockResolvedValue({ publishedAt: new Date('2026-01-01') });
  mockTx.$executeRaw.mockResolvedValue(0);
  // The requested versions are this model's own.
  dbMock.dbWrite.modelVersion.findMany.mockImplementation((async ({
    where,
  }: {
    where?: { id?: { in?: number[] }; modelId?: number };
  }) => (where?.modelId === MODEL_ID ? (where.id?.in ?? []).map((id) => ({ id })) : [])) as never);
  dbMock.dbWrite.post.findMany.mockResolvedValue([
    { id: 1, modelVersionId: PUBLISHED },
    { id: 2, modelVersionId: DRAFT },
  ]);
  dbMock.dbWrite.image.findMany.mockResolvedValue([]);
  dbMock.dbRead.image.findMany.mockResolvedValue([]);
  dbMock.dbWrite.$executeRaw.mockResolvedValue(0);
});

describe('publishModelById text scan', () => {
  it('scans the model and only the posts on the versions it publishes', async () => {
    await publishModelById({ id: MODEL_ID, versionIds: [PUBLISHED], republishing: false });

    expect(submitModelTextModeration).toHaveBeenCalledWith({
      id: MODEL_ID,
      name: 'LoRA',
      description: 'about',
      rules: false,
    });
    expect(scanEntitiesInBackground).toHaveBeenCalledWith('Post', [1]);
  });

  it('scans no post when it publishes no version', async () => {
    await publishModelById({ id: MODEL_ID, republishing: false });

    expect(submitModelTextModeration).toHaveBeenCalled();
    expect(scanEntitiesInBackground).not.toHaveBeenCalledWith('Post', expect.anything());
  });

  it('still publishes when the model scan fails', async () => {
    vi.mocked(submitModelTextModeration).mockRejectedValueOnce(new Error('down'));

    await expect(
      publishModelById({ id: MODEL_ID, versionIds: [PUBLISHED], republishing: false })
    ).resolves.toBeDefined();
  });
});

describe('publishPrivateModel text scan', () => {
  beforeEach(() => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue({
      id: MODEL_ID,
      userId: OWNER_ID,
      name: 'LoRA',
      description: 'about',
      availability: 'Private',
      status: 'Published',
      meta: {},
    });
    dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([{ id: PUBLISHED }]);
    // The in-transaction re-read: the version is still Published, the model is not taken down.
    mockTx.$queryRaw.mockImplementation((async (strings: string[]) =>
      strings.join('').includes('FROM "ModelVersion"') ? [{ id: PUBLISHED }] : []) as never);
  });

  it("scans the model and the owner's posts on its versions when it publishes them", async () => {
    dbMock.dbWrite.post.findMany
      .mockResolvedValueOnce([{ modelVersionId: PUBLISHED }])
      .mockResolvedValueOnce([{ id: 1 }]);

    await publishPrivateModel({ modelId: MODEL_ID, publishVersions: true });

    expect(submitModelTextModeration).toHaveBeenCalledWith({
      id: MODEL_ID,
      name: 'LoRA',
      description: 'about',
      rules: false,
    });
    expect(dbMock.dbWrite.post.findMany).toHaveBeenLastCalledWith({
      where: { modelVersionId: { in: [PUBLISHED] }, userId: OWNER_ID },
      select: { id: true },
    });
    expect(scanEntitiesInBackground).toHaveBeenCalledWith('Post', [1]);
  });

  it('scans nothing when it unpublishes the model instead', async () => {
    await publishPrivateModel({ modelId: MODEL_ID, publishVersions: false });

    expect(submitModelTextModeration).not.toHaveBeenCalled();
    expect(scanEntitiesInBackground).not.toHaveBeenCalled();
  });

  it.each([
    ['enforceModelRules off (a moderator publish)', true],
    ['enforceModelRules on (a non-moderator publish)', false],
  ])(
    'queues no Model rules check after %s: the literal check ran before the publish',
    async (_who, isModerator) => {
      dbMock.dbWrite.post.findMany
        .mockResolvedValueOnce([{ modelVersionId: PUBLISHED }])
        .mockResolvedValueOnce([{ id: 1 }]);

      await publishPrivateModel(
        { modelId: MODEL_ID, publishVersions: true, isModerator },
        { enforceModelRules: !isModerator }
      );

      expect(modelRulesScans()).toBe(0);
    }
  );
});
