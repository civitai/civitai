import { PGlite } from '@electric-sql/pglite';
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import type * as ModelPoiMinor from '~/server/services/text-scan/actions/model-poi-minor';

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
const { mockStampRuling, mockSettleAppeals } = vi.hoisted(() => ({
  mockStampRuling: vi.fn(),
  mockSettleAppeals: vi.fn(),
}));
// Hand-listed: the real module loads every text-scan profile, whose graph this file stubs piecemeal.
vi.mock('~/server/services/text-scan/actions/appeal-text-hash', () => ({
  stampModeratorTextScanRuling: mockStampRuling,
  settleFlagAppealsAfterModeratorLift: mockSettleAppeals,
}));
const { mockReassertPoi } = vi.hoisted(() => ({ mockReassertPoi: vi.fn() }));
const { mockUpdateModelNsfwLevels } = vi.hoisted(() => ({ mockUpdateModelNsfwLevels: vi.fn() }));
vi.mock('~/server/services/nsfwLevels.service', () => ({
  updateModelNsfwLevels: mockUpdateModelNsfwLevels,
}));
const { mockBustGallerySettings } = vi.hoisted(() => ({ mockBustGallerySettings: vi.fn() }));
vi.mock('~/server/services/creator-gallery-hidden-users.service', () => ({
  bustModelGallerySettings: mockBustGallerySettings,
  getCreatorGalleryHiddenUserIds: vi.fn(),
}));
vi.mock('~/server/services/text-scan/actions/model-poi-minor', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelPoiMinor>()),
  reassertModelPoiRestrictions: mockReassertPoi,
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
import {
  MINOR_LOCKED_PROPERTIES,
  restoreOwnerFlagOverride,
  setModelMinor,
} from '~/server/services/model.service';
import { bustPublicModelResponseCache } from '~/server/services/model-version.service';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { rowChangesBeforeLock, sqlOf as sqlText } from './model-row-lock.fake';
import { Prisma } from '@prisma/client';
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

function mockBefore(overrides: Partial<typeof baseModelRow> & { meta?: unknown }) {
  mockDbWrite.model.findUnique.mockResolvedValue({ ...baseModelRow, ...overrides });
}

const sqlOf = (call: unknown[]) => (call[0] as TemplateStringsArray).join('?');
/** The fan-out's raw reads, without the row lock the setter takes first. */
const fanOutQueries = () =>
  mockDbWrite.$queryRaw.mock.calls.filter((call) => !sqlOf(call).includes('FOR NO KEY UPDATE'));

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
    expect(fanOutQueries()).toHaveLength(1);
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
    expect(fanOutQueries()).toHaveLength(1);
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

describe('setModelMinor — a lift restores the nsfw ruling the flag replaced', () => {
  const AT = '2026-10-01T00:00:00.000Z';
  const ownerFlagOverride = {
    at: AT,
    flags: ['minor'],
    prevNsfw: true,
    prevSfwOnly: false,
    prevLockedProperties: ['nsfw', 'name'],
  };
  const flagged = {
    minor: true,
    nsfw: false,
    sfwOnly: true,
    lockedProperties: ['nsfw', 'name', 'minor', 'sfwOnly'],
  };
  const writtenData = () => mockDbWrite.model.update.mock.calls[0][0].data;
  const overrideWrites = () =>
    mockDbWrite.$executeRaw.mock.calls
      .map((call) => JSON.stringify(call.slice(1)))
      .filter((values) => values.includes('ownerFlagOverride'));

  // The same call an appeal overturn makes for a flag that is not automated.
  it('after an owner override, puts back the rating, the SFW-only setting and the locks it replaced', async () => {
    mockBefore({ ...flagged, meta: { ownerFlagOverride } });

    await setModelMinor({ id: MODEL_ID, minor: false, userId: MODERATOR_ID });

    const data = writtenData();
    expect(data).toMatchObject({ minor: false, nsfw: true, sfwOnly: false });
    expect([...data.lockedProperties].sort()).toEqual(['name', 'nsfw']);
    expect(data).not.toHaveProperty('gallerySettings');
    expect(overrideWrites()).toHaveLength(1);
    expect(overrideWrites()[0]).not.toContain('flags');
  });

  it("after a moderator's nsfw lock, puts back the rating, its lock and the gallery level from the flag snapshot", async () => {
    mockBefore({
      ...flagged,
      lockedProperties: [...MINOR_LOCKED_PROPERTIES],
      gallerySettings: { level: sfwBrowsingLevelsFlag, users: [3], tags: [] },
      meta: {
        minorFlagSnapshot: {
          at: AT,
          source: 'manual',
          prevNsfw: true,
          prevSfwOnly: false,
          prevGalleryLevel: 31,
          prevLockedProperties: ['nsfw'],
        },
      },
    });

    await setModelMinor({ id: MODEL_ID, minor: false, userId: MODERATOR_ID });

    expect(writtenData()).toEqual({
      minor: false,
      nsfw: true,
      sfwOnly: false,
      lockedProperties: ['nsfw'],
      gallerySettings: { level: 31, users: [3], tags: [] },
    });
  });

  // A flagged model is never nsfw, so an override always predates a snapshot of the same flag.
  it('takes the rating and gallery level from the older owner override', async () => {
    mockBefore({
      ...flagged,
      gallerySettings: { level: sfwBrowsingLevelsFlag, users: [], tags: [] },
      meta: {
        ownerFlagOverride: { ...ownerFlagOverride, prevGalleryLevel: 31 },
        minorFlagSnapshot: {
          at: '2026-10-02T00:00:00.000Z',
          source: 'auto',
          prevNsfw: false,
          prevSfwOnly: true,
          prevGalleryLevel: sfwBrowsingLevelsFlag,
          prevLockedProperties: ['nsfw', 'minor', 'sfwOnly'],
        },
      },
    });

    await setModelMinor({ id: MODEL_ID, minor: false, userId: MODERATOR_ID });

    expect(writtenData()).toMatchObject({
      nsfw: true,
      sfwOnly: false,
      gallerySettings: { level: 31 },
    });
    expect([...writtenData().lockedProperties].sort()).toEqual(['name', 'nsfw']);
  });

  it('leaves the rating alone when the flag replaced no locked ruling', async () => {
    mockBefore({
      ...flagged,
      lockedProperties: [...MINOR_LOCKED_PROPERTIES],
      meta: {
        minorFlagSnapshot: {
          at: AT,
          source: 'manual',
          prevNsfw: true,
          prevSfwOnly: false,
          prevLockedProperties: [],
        },
      },
    });

    await setModelMinor({ id: MODEL_ID, minor: false, userId: MODERATOR_ID });

    expect(writtenData()).toEqual({ minor: false, lockedProperties: [] });
  });

  it('leaves the rating to a moderator who changed it while the flag was on, and drops the override', async () => {
    mockBefore({ ...flagged, sfwOnly: false, meta: { ownerFlagOverride } });

    await setModelMinor({ id: MODEL_ID, minor: false, userId: MODERATOR_ID });

    expect(writtenData()).toEqual({ minor: false, lockedProperties: ['name'] });
    expect(overrideWrites()).toHaveLength(1);
    expect(overrideWrites()[0]).not.toContain('flags');
  });

  it('ignores a flag snapshot that an earlier lift already ended', async () => {
    mockBefore({
      ...flagged,
      lockedProperties: [...MINOR_LOCKED_PROPERTIES],
      meta: {
        minorFlagSnapshot: {
          at: AT,
          source: 'manual',
          prevNsfw: true,
          prevSfwOnly: false,
          prevLockedProperties: ['nsfw'],
        },
      },
    });
    mockDbWrite.$queryRaw.mockImplementation(((strings: TemplateStringsArray) =>
      Promise.resolve(strings.join('?').includes('ModActivity') ? [{ found: 1 }] : [])) as never);

    await setModelMinor({ id: MODEL_ID, minor: false, userId: MODERATOR_ID });

    expect(writtenData()).toEqual({ minor: false, lockedProperties: [] });
    const [strings, ...values] = mockDbWrite.$queryRaw.mock.calls.find((call) =>
      Array.from(call[0] as TemplateStringsArray)
        .join('?')
        .includes('ModActivity')
    ) as [TemplateStringsArray, ...unknown[]];
    expect(strings.join('?')).toMatch(/"createdAt" > \?::timestamptz/);
    expect(values).toContainEqual(MODEL_ID);
    expect(values).toContainEqual(AT);
    expect(values).toContainEqual([
      'unsetMinor',
      'rollbackMinorAutoHash',
      'setSfwOnly',
      'unsetSfwOnly',
      'lockProperty:nsfw',
      'unlockProperty:nsfw',
    ]);
  });

  it('ignores a flag snapshot stamped as superseded, without asking the activity log', async () => {
    mockBefore({
      ...flagged,
      lockedProperties: [...MINOR_LOCKED_PROPERTIES],
      meta: {
        minorFlagSnapshot: {
          at: AT,
          supersededAt: '2026-10-03T00:00:00.000Z',
          source: 'manual',
          prevNsfw: true,
          prevSfwOnly: false,
          prevLockedProperties: ['nsfw'],
        },
      },
    });

    await setModelMinor({ id: MODEL_ID, minor: false, userId: MODERATOR_ID });

    expect(writtenData()).toEqual({ minor: false, lockedProperties: [] });
    const askedLog = mockDbWrite.$queryRaw.mock.calls.some((call) =>
      Array.from(call[0] as TemplateStringsArray)
        .join('?')
        .includes('ModActivity')
    );
    expect(askedLog).toBe(false);
  });

  it("ignores an override older than a moderator's later ruling on the rating", async () => {
    mockBefore({ ...flagged, meta: { ownerFlagOverride } });
    mockDbWrite.$queryRaw.mockImplementation(((strings: TemplateStringsArray) =>
      Promise.resolve(strings.join('?').includes('ModActivity') ? [{ found: 1 }] : [])) as never);

    await setModelMinor({ id: MODEL_ID, minor: false, userId: MODERATOR_ID });

    expect(writtenData()).toEqual({ minor: false, lockedProperties: ['name'] });
    const [, ...values] = mockDbWrite.$queryRaw.mock.calls.find((call) =>
      Array.from(call[0] as TemplateStringsArray)
        .join('?')
        .includes('ModActivity')
    ) as [TemplateStringsArray, ...unknown[]];
    expect(values).toContainEqual(AT);
    expect(values).toContainEqual([
      'setSfwOnly',
      'unsetSfwOnly',
      'lockProperty:nsfw',
      'unlockProperty:nsfw',
    ]);
  });

  it('leaves a private model SFW-only', async () => {
    mockBefore({ ...flagged, availability: 'Private', meta: { ownerFlagOverride } } as never);

    await setModelMinor({ id: MODEL_ID, minor: false, userId: MODERATOR_ID });

    expect(writtenData()).toEqual({ minor: false, lockedProperties: ['name'] });
  });

  it('restores nothing from a record that was both mature and SFW-only', async () => {
    mockBefore({
      ...flagged,
      meta: { ownerFlagOverride: { ...ownerFlagOverride, prevSfwOnly: true } },
    });

    await setModelMinor({ id: MODEL_ID, minor: false, userId: MODERATOR_ID });

    expect(writtenData()).toEqual({ minor: false, lockedProperties: ['name'] });
  });

  it('removes the gallery level when the snapshot recorded none', async () => {
    mockBefore({
      ...flagged,
      lockedProperties: [...MINOR_LOCKED_PROPERTIES],
      gallerySettings: { level: sfwBrowsingLevelsFlag, users: [3], tags: [] },
      meta: {
        minorFlagSnapshot: {
          at: AT,
          source: 'manual',
          prevNsfw: true,
          prevSfwOnly: false,
          prevGalleryLevel: null,
          prevLockedProperties: ['nsfw'],
        },
      },
    });

    await setModelMinor({ id: MODEL_ID, minor: false, userId: MODERATOR_ID });

    expect(writtenData().gallerySettings).toEqual({ users: [3], tags: [] });
  });

  it("recomputes the model's nsfw level after restoring a mature rating, and only then", async () => {
    mockBefore({ ...flagged, meta: { ownerFlagOverride } });
    await setModelMinor({ id: MODEL_ID, minor: false, userId: MODERATOR_ID });
    expect(mockUpdateModelNsfwLevels).toHaveBeenCalledWith([MODEL_ID]);
    expect(vi.mocked(bustPublicModelResponseCache)).toHaveBeenCalledWith(MODEL_ID);

    mockUpdateModelNsfwLevels.mockClear();
    mockBefore({ ...flagged, meta: {} });
    await setModelMinor({ id: MODEL_ID, minor: false, userId: MODERATOR_ID });
    expect(mockUpdateModelNsfwLevels).not.toHaveBeenCalled();
  });

  it('keeps the restrictions while the real-person flag stays on, and the override for it', async () => {
    mockBefore({
      ...flagged,
      poi: true,
      lockedProperties: ['nsfw', 'minor', 'sfwOnly', 'poi'],
      meta: { ownerFlagOverride: { ...ownerFlagOverride, flags: ['minor', 'poi'] } },
    });
    mockUpdateReturns({ poi: true });

    await setModelMinor({ id: MODEL_ID, minor: false, userId: MODERATOR_ID });

    expect(writtenData()).not.toHaveProperty('nsfw');
    expect(overrideWrites()).toHaveLength(1);
    expect(overrideWrites()[0]).toContain('\\"flags\\":[\\"poi\\"]');
  });

  it('restores once the second of two overridden flags is lifted', async () => {
    // What the first lift (real-person) left: minor still on, the override narrowed to it.
    mockBefore({
      ...flagged,
      lockedProperties: ['name', 'minor', 'nsfw', 'sfwOnly'],
      meta: { ownerFlagOverride: { ...ownerFlagOverride, flags: ['minor'] } },
    });

    await setModelMinor({ id: MODEL_ID, minor: false, userId: MODERATOR_ID });

    expect(writtenData()).toMatchObject({ nsfw: true, sfwOnly: false });
    expect([...writtenData().lockedProperties].sort()).toEqual(['name', 'nsfw']);
  });

  it('restores nothing on a rollback, which puts back its own snapshot', async () => {
    mockBefore({ ...flagged, meta: { ownerFlagOverride } });

    await setModelMinor({
      id: MODEL_ID,
      minor: false,
      userId: MODERATOR_ID,
      activity: 'rollbackMinorAutoHash',
    });

    expect(writtenData()).not.toHaveProperty('nsfw');
    expect(overrideWrites()).toHaveLength(0);
  });
});

describe('restoreOwnerFlagOverride — after a revert put back its own snapshot', () => {
  const reverted = {
    minor: false,
    nsfw: false,
    sfwOnly: true,
    lockedProperties: ['minor', 'nsfw', 'sfwOnly'],
  };

  it('puts back the ruling the override replaced, since it is the older record', async () => {
    mockBefore({
      ...reverted,
      meta: {
        ownerFlagOverride: {
          at: '2026-10-01T00:00:00.000Z',
          flags: ['minor'],
          prevNsfw: true,
          prevSfwOnly: false,
          prevLockedProperties: ['nsfw'],
        },
      },
    });

    const written = await restoreOwnerFlagOverride(MODEL_ID, { revertedFlag: 'poi' });

    const expected = { nsfw: true, sfwOnly: false, lockedProperties: ['nsfw'] };
    expect(mockDbWrite.model.update).toHaveBeenCalledWith({
      where: { id: MODEL_ID },
      data: expected,
    });
    expect(written).toEqual(expected);
    const dropped = mockDbWrite.$executeRaw.mock.calls.filter((call) =>
      JSON.stringify(call.slice(1)).includes('ownerFlagOverride')
    );
    expect(dropped).toHaveLength(1);
    expect(JSON.stringify(dropped[0])).not.toContain('flags');
    expect(mockUpdateModelNsfwLevels).toHaveBeenCalledWith([MODEL_ID]);
    expect(vi.mocked(bustPublicModelResponseCache)).toHaveBeenCalledWith(MODEL_ID);
  });

  // The revert undoes the automated flag; the owner's own declaration of it stands.
  // Kept, it would be restored by the later lift or revert of the flag still set.
  it('drops the override outright when the owner declared the reverted flag and another stays set', async () => {
    mockBefore({
      ...reverted,
      poi: true,
      lockedProperties: ['poi', 'nsfw', 'sfwOnly'],
      meta: {
        ownerFlagOverride: {
          at: '2026-10-01T00:00:00.000Z',
          flags: ['minor'],
          prevNsfw: true,
          prevSfwOnly: false,
          prevLockedProperties: ['nsfw'],
        },
      },
    });

    expect(await restoreOwnerFlagOverride(MODEL_ID, { revertedFlag: 'minor' })).toBeUndefined();
    const writes = mockDbWrite.$executeRaw.mock.calls.filter((call) =>
      JSON.stringify(call.slice(1)).includes('ownerFlagOverride')
    );
    expect(writes).toHaveLength(1);
    expect(JSON.stringify(writes[0])).not.toContain('flags');
  });

  it('restores nothing, and drops the override, when the owner declared the reverted flag', async () => {
    mockBefore({
      ...reverted,
      meta: {
        ownerFlagOverride: {
          at: '2026-10-01T00:00:00.000Z',
          flags: ['minor'],
          prevNsfw: true,
          prevSfwOnly: false,
          prevLockedProperties: ['nsfw'],
        },
      },
    });

    expect(await restoreOwnerFlagOverride(MODEL_ID, { revertedFlag: 'minor' })).toBeUndefined();
    expect(mockDbWrite.model.update).not.toHaveBeenCalled();
    // A later revert of the other flag would otherwise restore from it.
    const dropped = mockDbWrite.$executeRaw.mock.calls.filter((call) =>
      JSON.stringify(call.slice(1)).includes('ownerFlagOverride')
    );
    expect(dropped).toHaveLength(1);
    expect(JSON.stringify(dropped[0])).not.toContain('flags');
  });

  it('drops the override and restores nothing when a moderator changed the rating since', async () => {
    mockBefore({
      ...reverted,
      sfwOnly: false,
      meta: {
        ownerFlagOverride: {
          at: '2026-10-01T00:00:00.000Z',
          flags: ['minor'],
          prevNsfw: true,
          prevSfwOnly: false,
          prevLockedProperties: ['nsfw'],
        },
      },
    });

    expect(await restoreOwnerFlagOverride(MODEL_ID, { revertedFlag: 'poi' })).toBeUndefined();
    expect(mockDbWrite.model.update).not.toHaveBeenCalled();
    expect(mockUpdateModelNsfwLevels).not.toHaveBeenCalled();
    const dropped = mockDbWrite.$executeRaw.mock.calls.filter((call) =>
      JSON.stringify(call.slice(1)).includes('ownerFlagOverride')
    );
    expect(dropped).toHaveLength(1);
    expect(JSON.stringify(dropped[0])).not.toContain('flags');
  });

  // Only a minor lift reads the snapshot; a revert put back its own already.
  it('falls back to no flag snapshot when the override has been ruled on since', async () => {
    const OVERRIDE_AT = '2026-10-01T00:00:00.000Z';
    mockBefore({
      ...reverted,
      meta: {
        ownerFlagOverride: {
          at: OVERRIDE_AT,
          flags: ['minor'],
          prevNsfw: true,
          prevSfwOnly: false,
          prevLockedProperties: ['nsfw'],
        },
        minorFlagSnapshot: {
          at: '2026-10-02T00:00:00.000Z',
          source: 'manual',
          prevNsfw: true,
          prevSfwOnly: false,
          prevLockedProperties: ['nsfw'],
        },
      },
    });
    mockDbWrite.$queryRaw.mockImplementation(((
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) =>
      Promise.resolve(
        strings.join('?').includes('ModActivity') && values.includes(OVERRIDE_AT)
          ? [{ found: 1 }]
          : []
      )) as never);

    expect(await restoreOwnerFlagOverride(MODEL_ID, { revertedFlag: 'poi' })).toBeUndefined();
    expect(mockDbWrite.model.update).not.toHaveBeenCalled();
  });

  it('writes nothing without an override, even over a flag snapshot that holds a ruling', async () => {
    mockBefore({
      ...reverted,
      meta: {
        minorFlagSnapshot: {
          at: '2026-10-01T00:00:00.000Z',
          source: 'manual',
          prevNsfw: true,
          prevSfwOnly: false,
          prevLockedProperties: ['nsfw'],
        },
      },
    });

    expect(await restoreOwnerFlagOverride(MODEL_ID, { revertedFlag: 'poi' })).toBeUndefined();
    expect(mockDbWrite.model.update).not.toHaveBeenCalled();
  });
});

// Unset strips the nsfw/sfwOnly locks the poi restriction also depends on.
describe('setModelMinor — unset on a model that stays poi', () => {
  it.each([
    ['poi flagged after minor', [...MINOR_LOCKED_PROPERTIES, 'poi']],
    ['poi flagged before minor', ['poi', 'nsfw', 'sfwOnly', 'minor']],
  ])('reasserts the poi restrictions after the unset write (%s)', async (_label, locks) => {
    mockBefore({ minor: true, poi: true, sfwOnly: true, lockedProperties: locks });
    mockUpdateReturns({ poi: true });

    await setModelMinor({ id: MODEL_ID, minor: false, userId: MODERATOR_ID });

    expect(mockReassertPoi).toHaveBeenCalledWith(MODEL_ID);
    expect(mockDbWrite.model.update).toHaveBeenCalled();
    expect(mockDbWrite.model.update.mock.invocationCallOrder[0]).toBeLessThan(
      mockReassertPoi.mock.invocationCallOrder[0]
    );
  });

  it('does not reassert for a model that is not poi, or on a set', async () => {
    mockBefore({ minor: true, lockedProperties: [...MINOR_LOCKED_PROPERTIES] });
    await setModelMinor({ id: MODEL_ID, minor: false, userId: MODERATOR_ID });

    mockBefore({ poi: true, lockedProperties: ['poi'] });
    mockUpdateReturns({ poi: true });
    await setModelMinor({ id: MODEL_ID, minor: true, userId: MODERATOR_ID });

    expect(mockReassertPoi).not.toHaveBeenCalled();
  });
});

describe('setModelMinor — not found', () => {
  it('throws a not-found error when the model does not exist', async () => {
    mockDbWrite.model.findUnique.mockResolvedValue(null);

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

    const at = mockDbWrite.$executeRaw.mock.calls.indexOf(snapshotCall()!);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(mockDbWrite.$executeRaw.mock.invocationCallOrder[at]).toBeLessThan(
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

  it('marks a text-scan flag as text-scan, not manual — it is not a human decision', async () => {
    mockBefore({});

    await setModelMinor({
      id: MODEL_ID,
      minor: true,
      userId: -1,
      activity: 'setMinorTextScan',
    });

    const [, ...values] = snapshotCall()!;
    expect(values).toContain('text-scan');
    expect(values).not.toContain('manual');
    expect(values).not.toContain('auto');
  });

  // An unset leaves the snapshot behind. Keeping it on the next flag would record the new flag
  // under the old one's source and roll it back to a pre-state from the earlier flag.
  it('keeps the original snapshot only while the model is still minor', async () => {
    mockBefore({});

    await setModelMinor({ id: MODEL_ID, minor: true, userId: MODERATOR_ID });

    const text = Array.from(snapshotCall()![0] as TemplateStringsArray).join('?');
    expect(text).toContain(`NOT (COALESCE(m.meta, '{}'::jsonb) ?`);
    expect(text).toContain('OR NOT m.minor');
    expect(text).toContain('"ModelVersion" mv');
    expect(text).toContain('i.minor');
  });

  it('takes no snapshot when unsetting minor, and marks the existing one as ended', async () => {
    mockBefore({ minor: true, lockedProperties: [...MINOR_LOCKED_PROPERTIES] });

    await setModelMinor({ id: MODEL_ID, minor: false, userId: MODERATOR_ID });

    const sql = mockDbWrite.$executeRaw.mock.calls.map((call) =>
      Array.from(call[0] as TemplateStringsArray).join('?')
    );
    expect(sql.some((text) => text.includes('prevNsfw'))).toBe(false);
    expect(sql.some((text) => text.includes("'supersededAt'"))).toBe(true);
  });

  it('still flags when the snapshot write fails — losing it must not block the flag', async () => {
    mockBefore({});
    mockDbWrite.$executeRaw.mockImplementation((...call: unknown[]) =>
      sqlOf(call).includes('UPDATE "Model"')
        ? Promise.reject(new Error('db exploded'))
        : Promise.resolve(0)
    );

    await expect(
      setModelMinor({ id: MODEL_ID, minor: true, userId: MODERATOR_ID })
    ).resolves.toEqual(expect.objectContaining({ id: MODEL_ID }));
    expect(mockDbWrite.model.update).toHaveBeenCalled();
    // In Postgres a failed statement aborts the transaction; only the savepoint lets the flag land.
    expect(mockDbWrite.$executeRaw.mock.calls.map(sqlOf)).toContainEqual(
      expect.stringContaining('ROLLBACK TO SAVEPOINT minor_flag_snapshot')
    );
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
    expect(rows.map((r) => r.field).sort()).toEqual(['lockedProperties', 'minor', 'sfwOnly']);
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

// Review Focus 7.
describe('setModelMinor — moderator ruling on unset', () => {
  it('a moderator unset records a ruling on the current text, before the unset write', async () => {
    mockBefore({ minor: true, lockedProperties: [...MINOR_LOCKED_PROPERTIES] });
    mockStampRuling.mockResolvedValue(true);

    await setModelMinor({
      id: MODEL_ID,
      minor: false,
      userId: MODERATOR_ID,
      recordTextScanRuling: true,
    });

    expect(mockStampRuling).toHaveBeenCalledWith({
      modelId: MODEL_ID,
      userId: MODERATOR_ID,
      label: 'minor',
    });
    expect(mockStampRuling.mock.invocationCallOrder[0]).toBeLessThan(
      mockDbWrite.model.update.mock.invocationCallOrder[0]
    );
  });

  it('forwards the moderator reason, note and the ruled text hash to the ruling', async () => {
    mockBefore({ minor: true, lockedProperties: [...MINOR_LOCKED_PROPERTIES] });
    mockStampRuling.mockResolvedValue(true);

    await setModelMinor({
      id: MODEL_ID,
      minor: false,
      userId: MODERATOR_ID,
      recordTextScanRuling: true,
      reason: 'Adult character',
      note: 'checked the sheet',
      textHash: 'h-ruled',
    });

    expect(mockStampRuling).toHaveBeenCalledWith({
      modelId: MODEL_ID,
      userId: MODERATOR_ID,
      label: 'minor',
      reason: 'Adult character',
      note: 'checked the sheet',
      textHash: 'h-ruled',
    });
  });

  it('records no ruling for a rollback-style unset or for a set', async () => {
    mockBefore({ minor: true, lockedProperties: [...MINOR_LOCKED_PROPERTIES] });
    await setModelMinor({
      id: MODEL_ID,
      minor: false,
      userId: -1,
      activity: 'rollbackMinorAutoHash',
    });
    mockBefore({});
    await setModelMinor({
      id: MODEL_ID,
      minor: true,
      userId: MODERATOR_ID,
      recordTextScanRuling: true,
    });
    expect(mockStampRuling).not.toHaveBeenCalled();
  });

  it("settles the model's pending appeal after the unset, ruling already recorded", async () => {
    mockBefore({ minor: true, lockedProperties: [...MINOR_LOCKED_PROPERTIES] });
    mockStampRuling.mockResolvedValue(true);

    await setModelMinor({
      id: MODEL_ID,
      minor: false,
      userId: MODERATOR_ID,
      recordTextScanRuling: true,
    });

    expect(mockSettleAppeals).toHaveBeenCalledWith({
      modelId: MODEL_ID,
      userId: MODERATOR_ID,
      liftedLabels: ['minor'],
      recordRulings: false,
    });
    expect(mockSettleAppeals.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockDbWrite.model.update.mock.invocationCallOrder[0]
    );
  });

  it('settles no appeal for a rollback-style unset, a set, or a model that was not minor', async () => {
    mockBefore({ minor: true, lockedProperties: [...MINOR_LOCKED_PROPERTIES] });
    await setModelMinor({
      id: MODEL_ID,
      minor: false,
      userId: -1,
      activity: 'rollbackMinorAutoHash',
    });
    mockBefore({});
    await setModelMinor({
      id: MODEL_ID,
      minor: true,
      userId: MODERATOR_ID,
      recordTextScanRuling: true,
    });
    await setModelMinor({
      id: MODEL_ID,
      minor: false,
      userId: MODERATOR_ID,
      recordTextScanRuling: true,
    });
    expect(mockSettleAppeals).not.toHaveBeenCalled();
  });

  it('still unsets when the text cannot be read, and logs the miss', async () => {
    mockBefore({ minor: true, lockedProperties: [...MINOR_LOCKED_PROPERTIES] });
    mockStampRuling.mockResolvedValue(false);

    await setModelMinor({
      id: MODEL_ID,
      minor: false,
      userId: MODERATOR_ID,
      recordTextScanRuling: true,
    });

    expect(mockDbWrite.model.update).toHaveBeenCalled();
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'text-scan', modelId: MODEL_ID })
    );
  });
});

// A keep whose first attempt set the flag and died before propagating it is retried with
// `reapplySideEffects`: the row already reads as flagged, so the fan-out is diffed against the
// pre-flag state the flag snapshot recorded.
describe('setModelMinor — reapplying side effects', () => {
  const flaggedBefore = {
    minor: true,
    sfwOnly: true,
    gallerySettings: { level: sfwBrowsingLevelsFlag, users: [], tags: [] },
  };

  it('busts the gallery settings from the snapshot level, which a minor-only diff would skip', async () => {
    mockBefore(flaggedBefore);
    // The first read is the locked row; the one after the write is the snapshot.
    mockDbWrite.model.findUnique
      .mockResolvedValueOnce({ ...baseModelRow, ...flaggedBefore })
      .mockResolvedValue({
        meta: { minorFlagSnapshot: { prevGalleryLevel: 31, prevSfwOnly: false, prevNsfw: true } },
      });

    await setModelMinor({
      id: MODEL_ID,
      minor: true,
      userId: MODERATOR_ID,
      reapplySideEffects: true,
    });

    expect(mockBustGallerySettings).toHaveBeenCalledWith([MODEL_ID]);
    expect(mockModelsQueueUpdate).toHaveBeenCalled();
  });

  it('leaves the gallery alone on an ordinary repeat of the flag', async () => {
    mockBefore(flaggedBefore);

    await setModelMinor({ id: MODEL_ID, minor: true, userId: MODERATOR_ID });

    expect(mockBustGallerySettings).not.toHaveBeenCalled();
  });

  // The gallery serves a held level while the model is minor, so the flag the fan-out never carried
  // drops the cached settings even with the stored level unchanged.
  it('still flips minor, and drops the cached gallery settings, when no snapshot survived', async () => {
    mockBefore(flaggedBefore);
    mockDbWrite.model.findUnique
      .mockResolvedValueOnce({ ...baseModelRow, ...flaggedBefore })
      .mockResolvedValue({ meta: {} });

    await setModelMinor({
      id: MODEL_ID,
      minor: true,
      userId: MODERATOR_ID,
      reapplySideEffects: true,
    });

    expect(mockModelsQueueUpdate).toHaveBeenCalled();
    expect(mockBustGallerySettings).toHaveBeenCalledWith([MODEL_ID]);
  });
});

// A flag or lock another moderator or a job sets after an earlier read of the model is in the row
// the setter locks, and the write is built from that row.
describe('setModelMinor — decides from the row it locks', () => {
  it('keeps a poi lock set since an earlier read when the minor flag is lifted', async () => {
    const { written } = rowChangesBeforeLock(
      { ...baseModelRow, minor: true, lockedProperties: [...MINOR_LOCKED_PROPERTIES] },
      {
        ...baseModelRow,
        minor: true,
        poi: true,
        lockedProperties: [...MINOR_LOCKED_PROPERTIES, 'poi'],
      }
    );

    await setModelMinor({ id: MODEL_ID, minor: false, userId: MODERATOR_ID });

    expect(written().lockedProperties).toEqual(['poi']);
  });

  it('keeps the locks and gallery settings written since an earlier read when flagging', async () => {
    const { written } = rowChangesBeforeLock(baseModelRow, {
      ...baseModelRow,
      gallerySettings: { level: 1, users: [9], tags: [] },
      lockedProperties: ['poi'],
    });

    await setModelMinor({ id: MODEL_ID, minor: true, userId: MODERATOR_ID });

    expect([...written().lockedProperties].sort()).toEqual(['minor', 'nsfw', 'poi', 'sfwOnly']);
    expect(written().gallerySettings).toEqual({
      level: sfwBrowsingLevelsFlag,
      users: [9],
      tags: [],
    });
  });

  it('records the change against the row it locked', async () => {
    rowChangesBeforeLock(baseModelRow, { ...baseModelRow, sfwOnly: true, nsfw: false });
    const tracker = mockTracker();

    await setModelMinor({
      id: MODEL_ID,
      minor: true,
      userId: MODERATOR_ID,
      tracker: tracker as unknown as Tracker,
    });

    const fields = changeRowsFrom(tracker).map(({ field }) => field);
    expect(fields).toContain('minor');
    expect(fields).not.toContain('sfwOnly');
  });

  // On its own connection the snapshot would wait on the row lock the flag's transaction holds.
  it('takes the snapshot on the transaction that holds the row lock', async () => {
    const { tx, written } = rowChangesBeforeLock(baseModelRow, baseModelRow);

    await setModelMinor({ id: MODEL_ID, minor: true, userId: MODERATOR_ID });

    // The savepoint brackets the snapshot, so a failed capture can be undone alone.
    expect(
      tx.$executeRaw.mock.calls.map(([strings]) => sqlText(strings).trim().split(/\s+/)[0])
    ).toEqual(['SAVEPOINT', 'UPDATE', 'RELEASE']);
    expect(mockLogToAxiom).not.toHaveBeenCalled();
    expect(written()).toMatchObject({ minor: true });
  });

  it('still flags, and logs after commit, when the snapshot fails inside the transaction', async () => {
    const { tx, written } = rowChangesBeforeLock(baseModelRow, baseModelRow);
    tx.$executeRaw.mockImplementation(async (strings) => {
      if (sqlText(strings).includes('UPDATE "Model"')) throw new Error('db exploded');
      return 0;
    });

    await setModelMinor({ id: MODEL_ID, minor: true, userId: MODERATOR_ID });

    expect(
      tx.$executeRaw.mock.calls.map(([strings]) => sqlText(strings).trim().split(/\s+/)[0])
    ).toEqual(['SAVEPOINT', 'UPDATE', 'ROLLBACK']);
    expect(written()).toMatchObject({ minor: true });
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'minor-flag-snapshot', modelId: MODEL_ID })
    );
    expect(mockLogToAxiom.mock.invocationCallOrder[0]).toBeGreaterThan(
      tx.model.update.mock.invocationCallOrder[0]
    );
  });

  it('does all of its follow-up work after the write commits', async () => {
    rowChangesBeforeLock(baseModelRow, baseModelRow);
    let committed = false;
    const transaction = mockDbWrite.$transaction.getMockImplementation()!;
    mockDbWrite.$transaction.mockImplementation((async (callback: never) => {
      const result = await transaction(callback);
      committed = true;
      return result;
    }) as never);
    const commitSeen: boolean[] = [];
    for (const fn of [mockTrackModActivity, mockPreventReplicationLag, mockModelsQueueUpdate])
      fn.mockImplementation(async () => void commitSeen.push(committed));

    await setModelMinor({ id: MODEL_ID, minor: true, userId: MODERATOR_ID });

    expect(commitSeen).toHaveLength(3);
    expect(commitSeen.every(Boolean)).toBe(true);
  });
});

describe('setModelMinor — lift restore on a real row', () => {
  const JSONB = ['meta', 'gallerySettings'];
  let pg: PGlite;
  const row = async () =>
    (await pg.query<Record<string, unknown>>(`SELECT * FROM "Model" WHERE id = $1`, [MODEL_ID]))
      .rows[0];

  const TEXT_OID = 25;
  const TEXT_ARRAY_OID = 1009;
  // The transaction's raw SQL with its parameters typed as Prisma sends them (a bare string is text),
  // and its ORM calls as the single-row reads and writes Prisma would send.
  const client = (db: Pick<PGlite, 'query'>) => {
    const raw = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = Prisma.sql(strings, ...values);
      const paramTypes = sql.values.map((v) =>
        typeof v === 'string' ? TEXT_OID : Array.isArray(v) ? TEXT_ARRAY_OID : 0
      );
      return db.query(sql.text, sql.values, { paramTypes });
    };
    const select = async (id: number, keys: string[]) =>
      (
        await db.query<Record<string, unknown>>(
          `SELECT ${keys.map((k) => `"${k}"`).join(', ')} FROM "Model" WHERE id = $1`,
          [id]
        )
      ).rows[0] ?? null;
    return {
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) =>
        (await raw(strings, ...values)).affectedRows ?? 0,
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) =>
        (await raw(strings, ...values)).rows,
      model: {
        findUnique: ({ where, select: keys }: { where: { id: number }; select: object }) =>
          select(where.id, Object.keys(keys)),
        update: async ({
          where,
          data,
          select: keys,
        }: {
          where: { id: number };
          data: Record<string, unknown>;
          select: object;
        }) => {
          // Prisma leaves an undefined key out of the write.
          const entries = Object.entries(data).filter(([, v]) => v !== undefined);
          await db.query(
            `UPDATE "Model" SET ${entries
              .map(([k], i) => `"${k}" = $${i + 2}`)
              .join(', ')} WHERE id = $1`,
            [where.id, ...entries.map(([k, v]) => (JSONB.includes(k) ? JSON.stringify(v) : v))]
          );
          return select(where.id, Object.keys(keys));
        },
      },
    };
  };

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(`
      CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int, name text, description text,
        status text NOT NULL DEFAULT 'Published', availability text NOT NULL DEFAULT 'Public',
        mode text, meta jsonb, "lockedProperties" text[] NOT NULL DEFAULT '{}',
        nsfw bool NOT NULL DEFAULT false, minor bool NOT NULL DEFAULT false,
        "sfwOnly" bool NOT NULL DEFAULT false, poi bool NOT NULL DEFAULT false,
        "gallerySettings" jsonb);
      CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int);
      CREATE TABLE "Post" (id int PRIMARY KEY, "modelVersionId" int);
      CREATE TABLE "Image" (id int PRIMARY KEY, "postId" int, minor bool NOT NULL DEFAULT false);
      CREATE TABLE "ModActivity" (id serial, "userId" int, activity text, "entityType" text,
        "entityId" int, "createdAt" timestamp(3) NOT NULL DEFAULT now());
    `);
  }, 60_000);
  afterAll(() => pg.close());

  let transaction: ReturnType<typeof mockDbWrite.$transaction.getMockImplementation>;
  let trackModActivity: ReturnType<typeof mockTrackModActivity.getMockImplementation>;
  beforeEach(async () => {
    await pg.exec(`TRUNCATE "Model", "ModActivity"`);
    // A moderator's mature ruling with its nsfw lock, before any flag.
    await pg.query(
      `INSERT INTO "Model" (id, "userId", nsfw, "sfwOnly", "lockedProperties", "gallerySettings")
       VALUES ($1, $2, true, false, '{nsfw}', '{"level": 31, "users": [9], "tags": [4]}')`,
      [MODEL_ID, OWNER_ID]
    );
    transaction = mockDbWrite.$transaction.getMockImplementation();
    trackModActivity = mockTrackModActivity.getMockImplementation();
    mockDbWrite.$transaction.mockImplementation((async (fn: (tx: unknown) => unknown) =>
      pg.transaction((tx) => fn(client(tx)))) as never);
    // Backdated: createdAt rounds to the millisecond, which could otherwise put an audit row after
    // the snapshot a flag takes right behind it.
    mockTrackModActivity.mockImplementation(
      async (userId: number, { activity, entityType, entityId }: Record<string, unknown>) => {
        await pg.query(
          `INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId", "createdAt")
           VALUES ($1, $2, $3, $4, now() - interval '1 second')`,
          [userId, activity, entityType, entityId]
        );
      }
    );
  });
  afterEach(() => {
    mockDbWrite.$transaction.mockImplementation(transaction as never);
    mockTrackModActivity.mockReset().mockImplementation(trackModActivity as never);
  });

  const flag = () => setModelMinor({ id: MODEL_ID, minor: true, userId: MODERATOR_ID });
  const lift = () => setModelMinor({ id: MODEL_ID, minor: false, userId: MODERATOR_ID });
  const restored = {
    minor: false,
    nsfw: true,
    sfwOnly: false,
    lockedProperties: ['nsfw'],
    gallerySettings: { level: 31, users: [9], tags: [4] },
  };
  const notRestored = {
    minor: false,
    nsfw: false,
    sfwOnly: true,
    lockedProperties: [],
    gallerySettings: { level: sfwBrowsingLevelsFlag, users: [9], tags: [4] },
  };

  it('a lift puts back the rating, SFW-only, nsfw lock and gallery level the flag replaced', async () => {
    await flag();
    expect(await row()).toMatchObject({
      minor: true,
      nsfw: false,
      sfwOnly: true,
      gallerySettings: { level: sfwBrowsingLevelsFlag },
    });

    await lift();

    expect(await row()).toMatchObject(restored);
  });

  it.each([
    'setSfwOnly',
    'unsetSfwOnly',
    'lockProperty:nsfw',
    'unlockProperty:nsfw',
    'unsetMinor',
    'rollbackMinorAutoHash',
  ])('a lift after a logged %s does not restore', async (activity) => {
    await flag();
    await pg.query(
      `INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId", "createdAt")
       VALUES ($1, $2, 'model', $3, now() + interval '1 second')`,
      [MODERATOR_ID, activity, MODEL_ID]
    );

    await lift();

    expect(await row()).toMatchObject(notRestored);
  });

  it.each([
    ['on another model', 'model', MODEL_ID + 1, '+ 1 second'],
    ['on another entity type', 'image', MODEL_ID, '+ 1 second'],
    ['before the flag', 'model', MODEL_ID, '- 1 hour'],
  ])(
    'a rating ruling logged %s does not stop the restore',
    async (_, entityType, entityId, offset) => {
      await flag();
      await pg.query(
        `INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId", "createdAt")
       VALUES ($1, 'setSfwOnly', $2, $3, now() ${offset[0]} interval '${offset.slice(2)}')`,
        [MODERATOR_ID, entityType, entityId]
      );

      await lift();

      expect(await row()).toMatchObject(restored);
    }
  );

  it('a second lift does not restore the snapshot the first lift used up', async () => {
    await flag();
    // The first lift's audit row is lost, so only the snapshot's own mark records the lift.
    mockTrackModActivity.mockRejectedValueOnce(new Error('audit write failed'));
    await lift();
    expect(await row()).toMatchObject(restored);
    expect((await pg.query(`SELECT activity FROM "ModActivity"`)).rows).toEqual([
      { activity: 'setMinor' },
    ]);
    // A save raises the flag again without a snapshot of its own.
    await pg.query(
      `UPDATE "Model" SET minor = true, nsfw = false, "sfwOnly" = true,
         "lockedProperties" = '{minor,nsfw,sfwOnly}',
         "gallerySettings" = jsonb_set("gallerySettings", '{level}', to_jsonb($2::int))
       WHERE id = $1`,
      [MODEL_ID, sfwBrowsingLevelsFlag]
    );

    await lift();

    expect(await row()).toMatchObject(notRestored);
  });

  it('a flag after a lift takes a fresh snapshot, which the next lift restores', async () => {
    await flag();
    await lift();
    await flag();

    await lift();

    expect(await row()).toMatchObject(restored);
  });
});
