import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit tests for applyModelFlagSideEffects — the post-update flag fan-out
// extracted from upsertModel (model tag/search-index refresh, gallery cache
// bust, ingestModel, and minor/poi propagation onto the model's images).
// model.service.ts has a very large import graph, so most of its transitive
// service/db/search dependencies are stubbed out below to keep this a real
// unit test rather than an integration test.

const { mockDbRead, mockDbWrite } = vi.hoisted(() => {
  const mk = () => ({
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  });
  return {
    mockDbRead: { model: mk(), modelVersion: mk(), $queryRaw: vi.fn() },
    mockDbWrite: {
      model: mk(),
      modelVersion: mk(),
      $queryRaw: vi.fn(),
      $executeRaw: vi.fn(),
    },
  };
});

const { mockModelTagRefresh, mockModelVotableBust, mockRedisDel, mockModelsQueueUpdate, mockImagesQueueUpdate } =
  vi.hoisted(() => ({
    mockModelTagRefresh: vi.fn(),
    mockModelVotableBust: vi.fn(),
    mockRedisDel: vi.fn(),
    mockModelsQueueUpdate: vi.fn(),
    mockImagesQueueUpdate: vi.fn(),
  }));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/db/db-lag-helpers', () => ({
  preventReplicationLag: vi.fn(),
  getDbWithoutLag: vi.fn(async () => mockDbRead),
  preventModelVersionLagBatch: vi.fn(),
}));
vi.mock('~/server/db/pgDb', () => ({ pgDbRead: {}, pgDbWrite: {}, pgDbReadLong: {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null, Tracker: class {} }));
vi.mock('~/server/flipt/client', () => ({ isFlipt: vi.fn(() => false), FLIPT_FEATURE_FLAGS: {} }));
vi.mock('~/server/metrics', () => ({ modelMetrics: {} }));
vi.mock('~/server/redis/caches', () => ({
  dataForModelsCache: {},
  modelTagCache: { refresh: mockModelTagRefresh },
  modelVotableTagsCache: { bust: mockModelVotableBust },
  userBasicCache: {},
  userModelCountCache: { refresh: vi.fn() },
}));
vi.mock('~/server/redis/client', () => ({
  redis: { del: mockRedisDel },
  REDIS_KEYS: { MODEL: { GALLERY_SETTINGS: 'model:gallery-settings' } },
}));
vi.mock('~/server/search-index', () => ({
  collectionsSearchIndex: { queueUpdate: vi.fn() },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
  imagesSearchIndex: { queueUpdate: mockImagesQueueUpdate },
  modelsSearchIndex: { queueUpdate: mockModelsQueueUpdate },
}));
vi.mock('~/server/services/auction.service', () => ({
  deleteBidsForModel: vi.fn(),
  getLastAuctionReset: vi.fn(),
}));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTagsForModels: vi.fn(),
}));
vi.mock('~/server/services/blocklist.service', () => ({ throwOnBlockedLinkDomain: vi.fn() }));
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

import { applyModelFlagSideEffects } from '~/server/services/model.service';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';

const baseBefore = {
  poi: false,
  minor: false,
  sfwOnly: false,
  nsfw: false,
  gallerySettings: { level: 1 },
};

const baseAfter = {
  id: 42,
  name: 'Test Model',
  description: 'A description',
  poi: false,
  nsfw: false,
  minor: false,
  sfwOnly: false,
  status: 'Published' as const,
  gallerySettings: { level: 1 },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDbWrite.modelVersion.findMany.mockResolvedValue([{ id: 100 }]);
  mockDbRead.$queryRaw.mockResolvedValue([{ id: 900 }]);
  mockDbWrite.model.update.mockResolvedValue({});
  mockDbWrite.$executeRaw.mockResolvedValue(undefined);
});

describe('applyModelFlagSideEffects — image propagation', () => {
  it('propagates minor/poi onto the model images and queues a search-index update when minor changes', async () => {
    await applyModelFlagSideEffects({
      before: baseBefore,
      after: { ...baseAfter, minor: true },
    });

    expect(mockDbWrite.modelVersion.findMany).toHaveBeenCalledWith({
      where: { modelId: 42 },
      select: { id: true },
    });
    expect(mockDbWrite.$executeRaw).toHaveBeenCalledTimes(1);
    expect(mockImagesQueueUpdate).toHaveBeenCalledWith([
      { id: 900, action: SearchIndexUpdateQueueAction.Update },
    ]);
  });

  it('skips image propagation entirely when neither minor nor poi changed', async () => {
    await applyModelFlagSideEffects({
      before: baseBefore,
      after: { ...baseAfter },
    });

    expect(mockDbWrite.modelVersion.findMany).not.toHaveBeenCalled();
    expect(mockDbWrite.$executeRaw).not.toHaveBeenCalled();
    expect(mockImagesQueueUpdate).not.toHaveBeenCalled();
  });

  it('does not touch images (no query, no update) when the model has no versions', async () => {
    mockDbWrite.modelVersion.findMany.mockResolvedValue([]);

    await applyModelFlagSideEffects({
      before: baseBefore,
      after: { ...baseAfter, poi: true },
    });

    expect(mockDbRead.$queryRaw).not.toHaveBeenCalled();
    expect(mockDbWrite.$executeRaw).not.toHaveBeenCalled();
    expect(mockImagesQueueUpdate).not.toHaveBeenCalled();
  });
});

describe('applyModelFlagSideEffects — model search-index / tag cache', () => {
  it('refreshes the tag cache and queues the model search-index update when poi changes', async () => {
    await applyModelFlagSideEffects({
      before: baseBefore,
      after: { ...baseAfter, poi: true },
    });

    expect(mockModelTagRefresh).toHaveBeenCalledWith(42);
    expect(mockModelsQueueUpdate).toHaveBeenCalledWith([
      { id: 42, action: SearchIndexUpdateQueueAction.Update },
    ]);
  });

  it('refreshes the tag cache and queues the model search-index update when minor changes', async () => {
    await applyModelFlagSideEffects({
      before: baseBefore,
      after: { ...baseAfter, minor: true },
    });

    expect(mockModelTagRefresh).toHaveBeenCalledWith(42);
    expect(mockModelsQueueUpdate).toHaveBeenCalledWith([
      { id: 42, action: SearchIndexUpdateQueueAction.Update },
    ]);
  });

  it('does not bust the votable-tags cache unless tagsChanged is set, even when poi changes', async () => {
    await applyModelFlagSideEffects({
      before: baseBefore,
      after: { ...baseAfter, poi: true },
      tagsChanged: false,
    });

    expect(mockModelTagRefresh).toHaveBeenCalledWith(42);
    expect(mockModelVotableBust).not.toHaveBeenCalled();
  });

  it('refreshes the tag cache and busts the votable-tags cache when only tagsChanged is set', async () => {
    await applyModelFlagSideEffects({
      before: baseBefore,
      after: { ...baseAfter },
      tagsChanged: true,
    });

    expect(mockModelTagRefresh).toHaveBeenCalledWith(42);
    expect(mockModelVotableBust).toHaveBeenCalledWith(42);
    expect(mockModelsQueueUpdate).toHaveBeenCalledWith([
      { id: 42, action: SearchIndexUpdateQueueAction.Update },
    ]);
  });

  it('does nothing to the search index when nothing relevant changed', async () => {
    await applyModelFlagSideEffects({ before: baseBefore, after: { ...baseAfter } });

    expect(mockModelTagRefresh).not.toHaveBeenCalled();
    expect(mockModelVotableBust).not.toHaveBeenCalled();
    expect(mockModelsQueueUpdate).not.toHaveBeenCalled();
  });
});

describe('applyModelFlagSideEffects — gallery browsing-level cache bust', () => {
  it('deletes the gallery settings cache key when the browsing level changed', async () => {
    await applyModelFlagSideEffects({
      before: baseBefore,
      after: { ...baseAfter, gallerySettings: { level: 4 } },
    });

    expect(mockRedisDel).toHaveBeenCalledWith('model:gallery-settings:42');
  });

  it('does not touch the gallery cache when the browsing level is unchanged', async () => {
    await applyModelFlagSideEffects({ before: baseBefore, after: { ...baseAfter } });

    expect(mockRedisDel).not.toHaveBeenCalled();
  });
});

describe('applyModelFlagSideEffects — ingestModel gating', () => {
  // ingestModel is a same-module function (not separately mockable); with
  // CONTENT_SCAN_ENDPOINT unset (the test-env default) it short-circuits to
  // stamping scannedAt via dbWrite.model.update — the observable proof it ran.
  const ranIngest = () =>
    mockDbWrite.model.update.mock.calls.some(
      (call) => call[0]?.where?.id === 42 && 'scannedAt' in (call[0]?.data ?? {})
    );

  it('fires for a Published model when a flag changed', async () => {
    await applyModelFlagSideEffects({
      before: baseBefore,
      after: { ...baseAfter, status: 'Published', minor: true },
    });

    expect(ranIngest()).toBe(true);
  });

  it('fires for a Scheduled model when a flag changed', async () => {
    await applyModelFlagSideEffects({
      before: baseBefore,
      after: { ...baseAfter, status: 'Scheduled', poi: true },
    });

    expect(ranIngest()).toBe(true);
  });

  it('does not fire for a Draft model even when a flag changed', async () => {
    await applyModelFlagSideEffects({
      before: baseBefore,
      after: { ...baseAfter, status: 'Draft', minor: true },
    });

    expect(ranIngest()).toBe(false);
  });

  it('does not fire for a Published model when nothing relevant changed', async () => {
    await applyModelFlagSideEffects({
      before: baseBefore,
      after: { ...baseAfter, status: 'Published' },
    });

    expect(ranIngest()).toBe(false);
  });

  it('fires for a Published model on a name-only change', async () => {
    await applyModelFlagSideEffects({
      before: baseBefore,
      after: { ...baseAfter, status: 'Published' },
      nameChanged: true,
    });

    expect(ranIngest()).toBe(true);
  });

  it('fires for a Published model on a description-only change', async () => {
    await applyModelFlagSideEffects({
      before: baseBefore,
      after: { ...baseAfter, status: 'Published' },
      descriptionChanged: true,
    });

    expect(ranIngest()).toBe(true);
  });
});
