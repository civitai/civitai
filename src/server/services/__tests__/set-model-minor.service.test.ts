import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit tests for setModelMinor — the moderator "Set as Minor" quick action.
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
import { MINOR_LOCKED_PROPERTIES, setModelMinor } from '~/server/services/model.service';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;
const mockRedisDel = redisMock.redis.del;
const mockLogToAxiom = loggingMock.logToAxiom;

const MODERATOR_ID = 7;
const MODEL_ID = 42;
const OWNER_ID = 555;

const baseModelRow = {
  userId: OWNER_ID,
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
  mockDbWrite.$executeRaw.mockResolvedValue(undefined);
  mockTrackModActivity.mockResolvedValue(undefined);
  // Callers chain .catch() on the result, so the mock must return a promise.
  mockLogToAxiom.mockResolvedValue(undefined);
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
    expect(mockQueueImageSearchIndexUpdate).toHaveBeenCalled();
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
    expect(mockQueueImageSearchIndexUpdate).toHaveBeenCalled();
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
    expect(mockQueueImageSearchIndexUpdate).toHaveBeenCalled();
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

// The snapshot is what makes any minor flag reversible — without it nsfw/sfwOnly/
// gallery level are overwritten with no record of the prior values.
describe('setModelMinor — pre-state snapshot', () => {
  const snapshotCall = () =>
    mockDbWrite.$executeRaw.mock.calls.find((call) =>
      Array.from(call[0] as TemplateStringsArray)
        .join('?')
        .includes('minorFlagSnapshot')
    ) ??
    mockDbWrite.$executeRaw.mock.calls.find((call) => call.slice(1).includes('minorFlagSnapshot'));

  it('snapshots before the update so it records pre-flag state', async () => {
    mockBefore({});

    await setModelMinor({ id: MODEL_ID, minor: true, userId: MODERATOR_ID });

    expect(mockDbWrite.$executeRaw).toHaveBeenCalled();
    expect(mockDbWrite.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mockDbWrite.model.update.mock.invocationCallOrder[0]
    );
  });

  it('marks a moderator flag as manual so a bulk rollback leaves it alone', async () => {
    mockBefore({});

    await setModelMinor({ id: MODEL_ID, minor: true, userId: MODERATOR_ID });

    const [, ...values] = snapshotCall()!;
    expect(values).toContain('manual');
    expect(values).not.toContain('auto');
  });

  it('marks an auto-hash flag as auto', async () => {
    mockBefore({});

    await setModelMinor({
      id: MODEL_ID,
      minor: true,
      userId: -1,
      activity: 'setMinorAutoHash',
    });

    const [, ...values] = snapshotCall()!;
    expect(values).toContain('auto');
  });

  it('guards against overwriting an existing snapshot', async () => {
    mockBefore({});

    await setModelMinor({ id: MODEL_ID, minor: true, userId: MODERATOR_ID });

    const text = Array.from(snapshotCall()![0] as TemplateStringsArray).join('?');
    expect(text).toContain(`NOT (COALESCE(m.meta, '{}'::jsonb) ?`);
    expect(text).toContain('"ModelVersion" mv');
    expect(text).toContain('i.minor');
  });

  it('does not snapshot when unsetting minor', async () => {
    mockBefore({ minor: true, lockedProperties: [...MINOR_LOCKED_PROPERTIES] });

    await setModelMinor({ id: MODEL_ID, minor: false, userId: MODERATOR_ID });

    expect(snapshotCall()).toBeUndefined();
  });

  it('still flags when the snapshot write fails — losing it must not block the flag', async () => {
    mockBefore({});
    mockDbWrite.$executeRaw.mockRejectedValueOnce(new Error('db exploded'));

    await expect(
      setModelMinor({ id: MODEL_ID, minor: true, userId: MODERATOR_ID })
    ).resolves.toEqual(expect.objectContaining({ id: MODEL_ID }));
    expect(mockDbWrite.model.update).toHaveBeenCalled();
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'minor-flag-snapshot', modelId: MODEL_ID })
    );
  });
});

describe('setModelMinor — activity override', () => {
  it('records the supplied activity instead of setMinor', async () => {
    mockBefore({});
    mockUpdateReturns({ minor: true });

    await setModelMinor({
      id: MODEL_ID,
      minor: true,
      userId: -1,
      activity: 'setMinorAutoHash',
    });

    expect(mockTrackModActivity).toHaveBeenCalledWith(-1, {
      entityType: 'model',
      entityId: MODEL_ID,
      activity: 'setMinorAutoHash',
    });
  });

  it('defaults to setMinor when no activity is supplied', async () => {
    mockBefore({});
    mockUpdateReturns({ minor: true });

    await setModelMinor({ id: MODEL_ID, minor: true, userId: MODERATOR_ID });

    expect(mockTrackModActivity).toHaveBeenCalledWith(MODERATOR_ID, {
      entityType: 'model',
      entityId: MODEL_ID,
      activity: 'setMinor',
    });
  });
});

describe('setModelMinor — change history', () => {
  it('emits a field-level change row per watched field the flag moved', async () => {
    mockBefore({ lockedProperties: ['poi'] });
    const tracker = mockTracker();

    await setModelMinor({
      id: MODEL_ID,
      minor: true,
      userId: MODERATOR_ID,
      isModerator: true,
      tracker: tracker as unknown as Tracker,
    });

    const rows = changeRowsFrom(tracker);
    expect(rows.map((r) => r.field).sort()).toEqual([
      'lockedProperties',
      'minor',
      'sfwOnly',
    ]);
    expect(rows.every((r) => r.entityType === 'Model' && r.entityId === MODEL_ID)).toBe(true);
    expect(rows.every((r) => r.ownerId === OWNER_ID)).toBe(true);
    expect(rows.every((r) => r.actorRole === 'moderator')).toBe(true);
    expect(rows.every((r) => r.reason === 'setMinor')).toBe(true);

    const minorRow = rows.find((r) => r.field === 'minor');
    expect(minorRow).toMatchObject({ oldValue: 'false', newValue: 'true' });
  });

  it('emits an nsfw row when the flag actually turns nsfw off', async () => {
    mockBefore({ nsfw: true });
    const tracker = mockTracker();

    await setModelMinor({
      id: MODEL_ID,
      minor: true,
      userId: MODERATOR_ID,
      isModerator: true,
      tracker: tracker as unknown as Tracker,
    });

    expect(changeRowsFrom(tracker).find((r) => r.field === 'nsfw')).toMatchObject({
      oldValue: 'true',
      newValue: 'false',
    });
  });

  it('does not claim nsfw/sfwOnly changed on unset', async () => {
    mockBefore({ minor: true, sfwOnly: true, lockedProperties: [...MINOR_LOCKED_PROPERTIES] });
    const tracker = mockTracker();

    await setModelMinor({
      id: MODEL_ID,
      minor: false,
      userId: MODERATOR_ID,
      isModerator: true,
      tracker: tracker as unknown as Tracker,
    });

    const rows = changeRowsFrom(tracker);
    expect(rows.map((r) => r.field).sort()).toEqual(['lockedProperties', 'minor']);
    expect(rows.every((r) => r.reason === 'unsetMinor')).toBe(true);
  });

  it('attributes the change to the owner when a moderator flags their own model', async () => {
    mockBefore({ userId: MODERATOR_ID });
    const tracker = mockTracker();

    await setModelMinor({
      id: MODEL_ID,
      minor: true,
      userId: MODERATOR_ID,
      isModerator: true,
      tracker: tracker as unknown as Tracker,
    });

    expect(changeRowsFrom(tracker).every((r) => r.actorRole === 'owner')).toBe(true);
  });

  it('carries the supplied activity through as the row reason', async () => {
    mockBefore({});
    const tracker = mockTracker();

    await setModelMinor({
      id: MODEL_ID,
      minor: true,
      userId: -1,
      activity: 'setMinorAutoHash',
      tracker: tracker as unknown as Tracker,
    });

    expect(changeRowsFrom(tracker).every((r) => r.reason === 'setMinorAutoHash')).toBe(true);
  });

  // minor-hash.service and /api/mod/minor-flag/set-minor call this with no tracker.
  it('flags without a tracker', async () => {
    mockBefore({});

    await expect(setModelMinor({ id: MODEL_ID, minor: true, userId: -1 })).resolves.toBeDefined();
    expect(mockDbWrite.model.update).toHaveBeenCalled();
  });

  it('runs the fan-out even when the change-history write rejects', async () => {
    mockBefore({});
    mockDbWrite.modelVersion.findMany.mockResolvedValue([{ id: 100 }]);
    const tracker = { entityChanges: vi.fn().mockRejectedValue(new Error('clickhouse down')) };

    await setModelMinor({
      id: MODEL_ID,
      minor: true,
      userId: MODERATOR_ID,
      isModerator: true,
      tracker: tracker as unknown as Tracker,
    });

    expect(mockModelTagRefresh).toHaveBeenCalledWith(MODEL_ID);
    expect(mockModelsQueueUpdate).toHaveBeenCalled();
  });
});
