import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit tests for setModelMinor — the moderator "Set as Minor" quick action.
// model.service.ts has a very large import graph, so most of its transitive
// service/db/search dependencies are stubbed out below to keep this a real
// unit test rather than an integration test. Mirrors the mock scaffold used
// for applyModelFlagSideEffects in model-flag-side-effects.service.test.ts.

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

const {
  mockModelTagRefresh,
  mockModelVotableBust,
  mockRedisDel,
  mockModelsQueueUpdate,
  mockImagesQueueUpdate,
  mockTrackModActivity,
  mockPreventReplicationLag,
  mockLogToAxiom,
} = vi.hoisted(() => ({
  mockModelTagRefresh: vi.fn(),
  mockModelVotableBust: vi.fn(),
  mockRedisDel: vi.fn(),
  mockModelsQueueUpdate: vi.fn(),
  mockImagesQueueUpdate: vi.fn(),
  mockTrackModActivity: vi.fn(),
  mockPreventReplicationLag: vi.fn(),
  mockLogToAxiom: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/db/db-lag-helpers', () => ({
  preventReplicationLag: mockPreventReplicationLag,
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
vi.mock('~/server/services/moderator.service', () => ({
  trackModActivity: mockTrackModActivity,
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom: mockLogToAxiom }));
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

import { MINOR_LOCKED_PROPERTIES, setModelMinor } from '~/server/services/model.service';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

const MODERATOR_ID = 7;
const MODEL_ID = 42;

const baseModelRow = {
  poi: false,
  minor: false,
  sfwOnly: false,
  nsfw: false,
  gallerySettings: { level: 1, users: [] as number[], tags: [] as number[] },
  lockedProperties: [] as string[],
};

function mockBefore(overrides: Partial<typeof baseModelRow>) {
  mockDbRead.model.findUnique.mockResolvedValue({ ...baseModelRow, ...overrides });
}

function mockUpdateReturns(overrides: Record<string, unknown> = {}) {
  mockDbWrite.model.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({
      id: MODEL_ID,
      name: 'Test Model',
      description: 'A description',
      status: 'Published',
      poi: false,
      nsfw: false,
      minor: false,
      sfwOnly: false,
      gallerySettings: { level: 1, users: [], tags: [] },
      ...data,
      ...overrides,
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDbWrite.modelVersion.findMany.mockResolvedValue([]);
  mockDbWrite.$queryRaw.mockResolvedValue([]);
  mockTrackModActivity.mockResolvedValue(undefined);
  mockUpdateReturns();
});

describe('setModelMinor — set', () => {
  it('writes minor/nsfw/sfwOnly/gallerySettings.level and unions locks without dropping an existing poi lock', async () => {
    mockBefore({ lockedProperties: ['poi'] });

    await setModelMinor({ id: MODEL_ID, minor: true, userId: MODERATOR_ID });

    expect(mockDbWrite.model.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: MODEL_ID },
        data: expect.objectContaining({
          minor: true,
          nsfw: false,
          sfwOnly: true,
          gallerySettings: expect.objectContaining({ level: sfwBrowsingLevelsFlag }),
        }),
      })
    );

    const { data } = mockDbWrite.model.update.mock.calls[0][0];
    expect(data.lockedProperties).toEqual(
      expect.arrayContaining(['poi', 'minor', 'nsfw', 'sfwOnly'])
    );
    expect(data.lockedProperties).toHaveLength(4);
  });

  it('is idempotent — re-running on an already-minor model does not duplicate lock entries', async () => {
    mockBefore({
      minor: true,
      nsfw: false,
      sfwOnly: true,
      lockedProperties: [...MINOR_LOCKED_PROPERTIES, 'poi'],
    });

    await setModelMinor({ id: MODEL_ID, minor: true, userId: MODERATOR_ID });

    const { data } = mockDbWrite.model.update.mock.calls[0][0];
    expect(data.lockedProperties).toEqual(
      expect.arrayContaining(['poi', 'minor', 'nsfw', 'sfwOnly'])
    );
    expect(data.lockedProperties).toHaveLength(4);
  });

  it('merges into the existing gallerySettings object instead of replacing it', async () => {
    mockBefore({ gallerySettings: { level: 1, users: [123], tags: [456] } });

    await setModelMinor({ id: MODEL_ID, minor: true, userId: MODERATOR_ID });

    const { data } = mockDbWrite.model.update.mock.calls[0][0];
    expect(data.gallerySettings).toEqual({
      level: sfwBrowsingLevelsFlag,
      users: [123],
      tags: [456],
    });
  });

  it('triggers the side-effect fan-out (applyModelFlagSideEffects) when a previously-SFW-only-false minor model is (re-)set', async () => {
    // Pins the sfwOnly-only branch of applyModelFlagSideEffects' minorChanged check:
    // minor is already true, but sfwOnly is false, so `minor` itself doesn't change
    // on this write — only sfwOnly does. The fan-out must still fire.
    mockBefore({ minor: true, sfwOnly: false, lockedProperties: [] });
    mockDbWrite.modelVersion.findMany.mockResolvedValue([{ id: 100 }]);
    mockDbWrite.$queryRaw.mockResolvedValue([{ id: 900 }]);

    await setModelMinor({ id: MODEL_ID, minor: true, userId: MODERATOR_ID });

    expect(mockModelTagRefresh).toHaveBeenCalledWith(MODEL_ID);
    expect(mockModelsQueueUpdate).toHaveBeenCalled();
    expect(mockDbWrite.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mockImagesQueueUpdate).toHaveBeenCalled();
  });

  it('tracks mod activity as setMinor', async () => {
    mockBefore({});

    await setModelMinor({ id: MODEL_ID, minor: true, userId: MODERATOR_ID });

    expect(mockTrackModActivity).toHaveBeenCalledWith(MODERATOR_ID, {
      entityType: 'model',
      entityId: MODEL_ID,
      activity: 'setMinor',
    });
  });
});

describe('setModelMinor — audit ordering', () => {
  it('records the mod activity before running the fan-out', async () => {
    mockBefore({});
    mockDbWrite.modelVersion.findMany.mockResolvedValue([{ id: 100 }]);

    await setModelMinor({ id: MODEL_ID, minor: true, userId: MODERATOR_ID });

    expect(mockTrackModActivity.mock.invocationCallOrder[0]).toBeLessThan(
      mockModelTagRefresh.mock.invocationCallOrder[0]
    );
  });

  it('keeps the audit record when the fan-out throws — the flag write already committed', async () => {
    mockBefore({});
    mockDbWrite.modelVersion.findMany.mockRejectedValue(new Error('too many bind parameters'));

    await expect(
      setModelMinor({ id: MODEL_ID, minor: true, userId: MODERATOR_ID })
    ).rejects.toThrow();

    expect(mockTrackModActivity).toHaveBeenCalledWith(MODERATOR_ID, {
      entityType: 'model',
      entityId: MODEL_ID,
      activity: 'setMinor',
    });
  });

  it('still completes and runs the fan-out when trackModActivity rejects', async () => {
    mockBefore({});
    mockTrackModActivity.mockRejectedValue(new Error('audit db down'));
    mockDbWrite.modelVersion.findMany.mockResolvedValue([{ id: 100 }]);
    mockDbWrite.$queryRaw.mockResolvedValue([{ id: 900 }]);

    await expect(
      setModelMinor({ id: MODEL_ID, minor: true, userId: MODERATOR_ID })
    ).resolves.toEqual(expect.objectContaining({ id: MODEL_ID }));

    expect(mockModelTagRefresh).toHaveBeenCalledWith(MODEL_ID);
    expect(mockModelsQueueUpdate).toHaveBeenCalled();
    expect(mockImagesQueueUpdate).toHaveBeenCalled();
    expect(mockLogToAxiom).toHaveBeenCalled();
  });
});

describe('setModelMinor — unset', () => {
  it('writes minor: false, removes only the three minor-related locks, and leaves an unrelated poi lock', async () => {
    mockBefore({
      minor: true,
      nsfw: false,
      sfwOnly: true,
      lockedProperties: [...MINOR_LOCKED_PROPERTIES, 'poi'],
    });

    await setModelMinor({ id: MODEL_ID, minor: false, userId: MODERATOR_ID });

    const { data } = mockDbWrite.model.update.mock.calls[0][0];
    expect(data).toEqual({ minor: false, lockedProperties: ['poi'] });
  });

  it('does not write sfwOnly, nsfw, or gallerySettings', async () => {
    mockBefore({ minor: true, sfwOnly: true, lockedProperties: [...MINOR_LOCKED_PROPERTIES] });

    await setModelMinor({ id: MODEL_ID, minor: false, userId: MODERATOR_ID });

    const { data } = mockDbWrite.model.update.mock.calls[0][0];
    expect(data).not.toHaveProperty('sfwOnly');
    expect(data).not.toHaveProperty('nsfw');
    expect(data).not.toHaveProperty('gallerySettings');
  });

  it('triggers the side-effect fan-out (applyModelFlagSideEffects)', async () => {
    mockBefore({ minor: true, sfwOnly: true, lockedProperties: [...MINOR_LOCKED_PROPERTIES] });
    mockDbWrite.modelVersion.findMany.mockResolvedValue([{ id: 100 }]);
    mockDbWrite.$queryRaw.mockResolvedValue([{ id: 900 }]);

    await setModelMinor({ id: MODEL_ID, minor: false, userId: MODERATOR_ID });

    expect(mockModelTagRefresh).toHaveBeenCalledWith(MODEL_ID);
    expect(mockModelsQueueUpdate).toHaveBeenCalled();
    expect(mockDbWrite.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mockImagesQueueUpdate).toHaveBeenCalled();
  });

  it('tracks mod activity as unsetMinor', async () => {
    mockBefore({ minor: true, lockedProperties: [...MINOR_LOCKED_PROPERTIES] });

    await setModelMinor({ id: MODEL_ID, minor: false, userId: MODERATOR_ID });

    expect(mockTrackModActivity).toHaveBeenCalledWith(MODERATOR_ID, {
      entityType: 'model',
      entityId: MODEL_ID,
      activity: 'unsetMinor',
    });
  });
});

describe('setModelMinor — not found', () => {
  it('throws a not-found error when the model does not exist', async () => {
    mockDbRead.model.findUnique.mockResolvedValue(null);

    await expect(
      setModelMinor({ id: MODEL_ID, minor: true, userId: MODERATOR_ID })
    ).rejects.toThrow();

    expect(mockDbWrite.model.update).not.toHaveBeenCalled();
  });
});
