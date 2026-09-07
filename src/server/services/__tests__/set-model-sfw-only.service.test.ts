import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit tests for setModelSfwOnly — the moderator "Set as SFW" quick action.
// model.service.ts has a very large import graph, so most of its transitive
// service/db/search dependencies are stubbed out below to keep this a real
// unit test rather than an integration test. Mirrors the mock scaffold used
// for applyModelFlagSideEffects in model-flag-side-effects.service.test.ts.

const {
  mockModelTagRefresh,
  mockModelVotableBust,
  mockModelsQueueUpdate,
  mockQueueImageSearchIndexUpdate,
  mockTrackModActivity,
  mockPreventReplicationLag,
} = vi.hoisted(() => ({
  mockModelTagRefresh: vi.fn(),
  mockModelVotableBust: vi.fn(),
  mockModelsQueueUpdate: vi.fn(),
  mockQueueImageSearchIndexUpdate: vi.fn(),
  mockTrackModActivity: vi.fn(),
  mockPreventReplicationLag: vi.fn(),
}));

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

vi.mock('~/server/search-index', () => ({
  collectionsSearchIndex: { queueUpdate: vi.fn() },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
  imagesSearchIndex: { queueUpdate: vi.fn() },
  modelsSearchIndex: { queueUpdate: mockModelsQueueUpdate },
}));
vi.mock('~/server/services/auction.service', () => ({
  deleteBidsForModel: vi.fn(),
  getLastAuctionReset: vi.fn(),
}));
vi.mock('~/server/services/buzz.service', () => ({
  getMultiAccountTransactionsByPrefix: vi.fn(),
  getUserBuzzAccountByAccountTypes: vi.fn(),
  refundMultiAccountTransaction: vi.fn(),
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
  queueImageSearchIndexUpdate: mockQueueImageSearchIndexUpdate,
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

import type { Tracker } from '~/server/clickhouse/client';
import { SFW_ONLY_LOCKED_PROPERTIES, setModelSfwOnly } from '~/server/services/model.service';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { Availability } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;
const mockLogToAxiom = loggingMock.logToAxiom;

const MODERATOR_ID = 7;
const MODEL_ID = 42;
const OWNER_ID = 555;

const baseModelRow = {
  userId: OWNER_ID,
  poi: false,
  minor: false,
  sfwOnly: false,
  nsfw: true,
  availability: Availability.Public,
  gallerySettings: { level: 1, users: [] as number[], tags: [] as number[] },
  lockedProperties: [] as string[],
};

function mockBefore(overrides: Partial<typeof baseModelRow>) {
  mockDbRead.model.findUnique.mockResolvedValue({ ...baseModelRow, ...overrides });
}

function mockTracker() {
  return { entityChanges: vi.fn().mockResolvedValue(undefined) };
}

function changeRowsFrom(tracker: ReturnType<typeof mockTracker>) {
  // Assert here so a stopped emit fails as 0-calls, not a TypeError on the line below.
  expect(tracker.entityChanges).toHaveBeenCalledTimes(1);
  return tracker.entityChanges.mock.calls[0][0] as {
    entityType: string;
    entityId: number;
    ownerId: number;
    field: string;
    oldValue: string;
    newValue: string;
    actorRole: string;
    reason: string;
  }[];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDbWrite.modelVersion.findMany.mockResolvedValue([]);
  mockDbWrite.$queryRaw.mockResolvedValue([]);
  mockDbWrite.$executeRaw.mockResolvedValue(undefined);
  mockTrackModActivity.mockResolvedValue(undefined);
  // Callers chain .catch() on the result, so the mock must return a promise.
  mockLogToAxiom.mockResolvedValue(undefined);
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
    })
  );
});

describe('setModelSfwOnly — set', () => {
  it('writes sfwOnly/nsfw/gallerySettings.level and unions locks without dropping an existing poi lock', async () => {
    mockBefore({ lockedProperties: ['poi'] });

    await setModelSfwOnly({ id: MODEL_ID, sfwOnly: true, userId: MODERATOR_ID });

    expect(mockDbWrite.model.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: MODEL_ID },
        data: expect.objectContaining({
          sfwOnly: true,
          nsfw: false,
          gallerySettings: expect.objectContaining({ level: sfwBrowsingLevelsFlag }),
        }),
      })
    );

    const { data } = mockDbWrite.model.update.mock.calls[0][0];
    expect(data.lockedProperties).toEqual(expect.arrayContaining(['poi', 'nsfw', 'sfwOnly']));
    expect(data.lockedProperties).toHaveLength(3);
  });

  it('leaves minor alone — the two flags are independent quick actions', async () => {
    mockBefore({});

    await setModelSfwOnly({ id: MODEL_ID, sfwOnly: true, userId: MODERATOR_ID });

    const { data } = mockDbWrite.model.update.mock.calls[0][0];
    expect(data).not.toHaveProperty('minor');
  });

  it('is idempotent — re-running on an already-SFW model does not duplicate lock entries', async () => {
    mockBefore({
      sfwOnly: true,
      nsfw: false,
      lockedProperties: [...SFW_ONLY_LOCKED_PROPERTIES, 'poi'],
    });

    await setModelSfwOnly({ id: MODEL_ID, sfwOnly: true, userId: MODERATOR_ID });

    const { data } = mockDbWrite.model.update.mock.calls[0][0];
    expect(data.lockedProperties).toEqual(expect.arrayContaining(['poi', 'nsfw', 'sfwOnly']));
    expect(data.lockedProperties).toHaveLength(3);
  });

  it('merges into the existing gallerySettings object instead of replacing it', async () => {
    mockBefore({ gallerySettings: { level: 1, users: [123], tags: [456] } });

    await setModelSfwOnly({ id: MODEL_ID, sfwOnly: true, userId: MODERATOR_ID });

    const { data } = mockDbWrite.model.update.mock.calls[0][0];
    expect(data.gallerySettings).toEqual({
      level: sfwBrowsingLevelsFlag,
      users: [123],
      tags: [456],
    });
  });

  it('runs the side-effect fan-out so the listing and image rows follow the flag', async () => {
    mockBefore({});
    mockDbWrite.modelVersion.findMany.mockResolvedValue([{ id: 100 }]);
    mockDbWrite.$queryRaw.mockResolvedValue([{ id: 900 }]);

    await setModelSfwOnly({ id: MODEL_ID, sfwOnly: true, userId: MODERATOR_ID });

    expect(mockModelTagRefresh).toHaveBeenCalledWith(MODEL_ID);
    expect(mockModelsQueueUpdate).toHaveBeenCalled();
    expect(mockQueueImageSearchIndexUpdate).toHaveBeenCalled();
  });

  it('tracks mod activity as setSfwOnly, before the fan-out', async () => {
    mockBefore({});
    mockDbWrite.modelVersion.findMany.mockResolvedValue([{ id: 100 }]);

    await setModelSfwOnly({ id: MODEL_ID, sfwOnly: true, userId: MODERATOR_ID });

    expect(mockTrackModActivity).toHaveBeenCalledWith(MODERATOR_ID, {
      entityType: 'model',
      entityId: MODEL_ID,
      activity: 'setSfwOnly',
    });
    expect(mockTrackModActivity.mock.invocationCallOrder[0]).toBeLessThan(
      mockModelTagRefresh.mock.invocationCallOrder[0]
    );
  });
});

describe('setModelSfwOnly — unset', () => {
  it('clears sfwOnly and drops only its own locks, leaving nsfw untouched', async () => {
    mockBefore({
      sfwOnly: true,
      nsfw: false,
      lockedProperties: ['poi', 'minor', 'nsfw', 'sfwOnly'],
    });

    await setModelSfwOnly({ id: MODEL_ID, sfwOnly: false, userId: MODERATOR_ID });

    const { data } = mockDbWrite.model.update.mock.calls[0][0];
    expect(data.sfwOnly).toBe(false);
    expect(data).not.toHaveProperty('nsfw');
    expect(data).not.toHaveProperty('gallerySettings');
    expect(data.lockedProperties).toEqual(['poi', 'minor']);
  });

  it('tracks mod activity as unsetSfwOnly', async () => {
    mockBefore({ sfwOnly: true, nsfw: false });

    await setModelSfwOnly({ id: MODEL_ID, sfwOnly: false, userId: MODERATOR_ID });

    expect(mockTrackModActivity).toHaveBeenCalledWith(MODERATOR_ID, {
      entityType: 'model',
      entityId: MODEL_ID,
      activity: 'unsetSfwOnly',
    });
  });

  it('refuses on a minor model — ModelUpsertForm forbids minor && !sfwOnly', async () => {
    mockBefore({ minor: true, sfwOnly: true, nsfw: false });

    await expect(
      setModelSfwOnly({ id: MODEL_ID, sfwOnly: false, userId: MODERATOR_ID })
    ).rejects.toThrow(/Unset as Minor/);

    expect(mockDbWrite.model.update).not.toHaveBeenCalled();
  });

  it('refuses on a private model — ModelUpsertForm forbids private && !sfwOnly', async () => {
    mockBefore({ sfwOnly: true, nsfw: false, availability: Availability.Private });

    await expect(
      setModelSfwOnly({ id: MODEL_ID, sfwOnly: false, userId: MODERATOR_ID })
    ).rejects.toThrow(/Private models/);

    expect(mockDbWrite.model.update).not.toHaveBeenCalled();
  });

  it('still allows SETTING sfwOnly on a minor or private model', async () => {
    mockBefore({ minor: true, sfwOnly: false, availability: Availability.Private });

    await setModelSfwOnly({ id: MODEL_ID, sfwOnly: true, userId: MODERATOR_ID });

    expect(mockDbWrite.model.update).toHaveBeenCalled();
  });
});

describe('setModelSfwOnly — missing model', () => {
  it('throws before writing anything', async () => {
    mockDbRead.model.findUnique.mockResolvedValue(null);

    await expect(
      setModelSfwOnly({ id: MODEL_ID, sfwOnly: true, userId: MODERATOR_ID })
    ).rejects.toThrow(/No model with id/);

    expect(mockDbWrite.model.update).not.toHaveBeenCalled();
  });
});

describe('setModelSfwOnly — change history', () => {
  it('emits a field-level change row per watched field the flag moved', async () => {
    mockBefore({ lockedProperties: ['poi'] });
    const tracker = mockTracker();

    await setModelSfwOnly({
      id: MODEL_ID,
      sfwOnly: true,
      userId: MODERATOR_ID,
      isModerator: true,
      tracker: tracker as unknown as Tracker,
    });

    const rows = changeRowsFrom(tracker);
    expect(rows.map((r) => r.field).sort()).toEqual(['lockedProperties', 'nsfw', 'sfwOnly']);
    expect(rows.every((r) => r.entityType === 'Model' && r.entityId === MODEL_ID)).toBe(true);
    expect(rows.every((r) => r.ownerId === OWNER_ID)).toBe(true);
    expect(rows.every((r) => r.actorRole === 'moderator')).toBe(true);
    expect(rows.every((r) => r.reason === 'setSfwOnly')).toBe(true);

    expect(rows.find((r) => r.field === 'sfwOnly')).toMatchObject({
      oldValue: 'false',
      newValue: 'true',
    });
  });

  it('does not claim nsfw changed on unset', async () => {
    mockBefore({ sfwOnly: true, nsfw: false, lockedProperties: [...SFW_ONLY_LOCKED_PROPERTIES] });
    const tracker = mockTracker();

    await setModelSfwOnly({
      id: MODEL_ID,
      sfwOnly: false,
      userId: MODERATOR_ID,
      isModerator: true,
      tracker: tracker as unknown as Tracker,
    });

    const rows = changeRowsFrom(tracker);
    expect(rows.map((r) => r.field).sort()).toEqual(['lockedProperties', 'sfwOnly']);
    expect(rows.every((r) => r.reason === 'unsetSfwOnly')).toBe(true);
  });

  it('attributes the change to the owner when a moderator flags their own model', async () => {
    mockBefore({ userId: MODERATOR_ID });
    const tracker = mockTracker();

    await setModelSfwOnly({
      id: MODEL_ID,
      sfwOnly: true,
      userId: MODERATOR_ID,
      isModerator: true,
      tracker: tracker as unknown as Tracker,
    });

    expect(changeRowsFrom(tracker).every((r) => r.actorRole === 'owner')).toBe(true);
  });

  it('emits nothing and does not throw when the rejected invariants block the write', async () => {
    mockBefore({ sfwOnly: true, minor: true });
    const tracker = mockTracker();

    await expect(
      setModelSfwOnly({
        id: MODEL_ID,
        sfwOnly: false,
        userId: MODERATOR_ID,
        isModerator: true,
        tracker: tracker as unknown as Tracker,
      })
    ).rejects.toThrow(/Minor models/);

    expect(tracker.entityChanges).not.toHaveBeenCalled();
  });

  it('flags without a tracker', async () => {
    mockBefore({});

    await expect(
      setModelSfwOnly({ id: MODEL_ID, sfwOnly: true, userId: MODERATOR_ID })
    ).resolves.toBeDefined();
    expect(mockDbWrite.model.update).toHaveBeenCalled();
  });

  it('runs the fan-out even when the change-history write rejects', async () => {
    mockBefore({});
    mockDbWrite.modelVersion.findMany.mockResolvedValue([{ id: 100 }]);
    const tracker = { entityChanges: vi.fn().mockRejectedValue(new Error('clickhouse down')) };

    await setModelSfwOnly({
      id: MODEL_ID,
      sfwOnly: true,
      userId: MODERATOR_ID,
      isModerator: true,
      tracker: tracker as unknown as Tracker,
    });

    expect(mockModelTagRefresh).toHaveBeenCalledWith(MODEL_ID);
  });
});
