import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

// Unit tests for setModelPoi — the moderator app's POI toggle. Same mock scaffold as
// set-model-sfw-only.service.test.ts (model.service.ts has a very large import graph).

const {
  mockModelTagRefresh,
  mockModelVotableBust,
  mockModelsQueueUpdate,
  mockQueueImageSearchIndexUpdate,
  mockTrackModActivity,
  mockPreventReplicationLag,
  mockStampRuling,
  mockSettleAppeals,
} = vi.hoisted(() => ({
  mockModelTagRefresh: vi.fn(),
  mockModelVotableBust: vi.fn(),
  mockModelsQueueUpdate: vi.fn(),
  mockQueueImageSearchIndexUpdate: vi.fn(),
  mockTrackModActivity: vi.fn(),
  mockPreventReplicationLag: vi.fn(),
  mockStampRuling: vi.fn(),
  mockSettleAppeals: vi.fn(),
}));

vi.mock('~/server/services/text-scan/actions/appeal-text-hash', () => ({
  stampModeratorTextScanRuling: mockStampRuling,
  settleFlagAppealsAfterModeratorLift: mockSettleAppeals,
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

import { MINOR_LOCKED_PROPERTIES, setModelPoi } from '~/server/services/model.service';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;
const mockLogToAxiom = loggingMock.logToAxiom;

const MODERATOR_ID = 7;
const MODEL_ID = 42;

const baseModelRow = {
  userId: 555,
  poi: false,
  minor: false,
  sfwOnly: false,
  nsfw: true,
  gallerySettings: { level: 31, users: [] as number[], tags: [] as number[] },
  lockedProperties: [] as string[],
};
const mockBefore = (overrides: Partial<typeof baseModelRow>) =>
  mockDbRead.model.findUnique.mockResolvedValue({ ...baseModelRow, ...overrides });
const written = () => mockDbWrite.model.update.mock.calls[0][0].data;

beforeEach(() => {
  vi.clearAllMocks();
  mockDbWrite.modelVersion.findMany.mockResolvedValue([{ id: 1 }]);
  mockDbWrite.$queryRaw.mockResolvedValue([]);
  mockTrackModActivity.mockResolvedValue(undefined);
  mockLogToAxiom.mockResolvedValue(undefined);
  mockStampRuling.mockResolvedValue(true);
  mockSettleAppeals.mockResolvedValue(undefined);
  mockDbWrite.model.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({
      id: MODEL_ID,
      name: 'Test Model',
      description: null,
      status: 'Published',
      ...baseModelRow,
      ...data,
    })
  );
});

describe('setModelPoi — set', () => {
  it('applies the restrictions a POI model carries and locks them', async () => {
    mockBefore({ lockedProperties: ['minor'] });
    await setModelPoi({ id: MODEL_ID, poi: true, userId: MODERATOR_ID });

    expect(written()).toMatchObject({
      poi: true,
      nsfw: false,
      sfwOnly: true,
      gallerySettings: { level: sfwBrowsingLevelsFlag },
    });
    expect([...written().lockedProperties].sort()).toEqual(['minor', 'nsfw', 'poi', 'sfwOnly']);
  });

  it("carries poi to the model's images — what flags images made with it", async () => {
    mockBefore({});
    await setModelPoi({ id: MODEL_ID, poi: true, userId: MODERATOR_ID });
    expect(mockDbWrite.$queryRaw).toHaveBeenCalled();
    expect(mockModelsQueueUpdate).toHaveBeenCalled();
  });

  it('records the activity and touches no appeal', async () => {
    mockBefore({});
    await setModelPoi({ id: MODEL_ID, poi: true, userId: MODERATOR_ID });
    expect(mockTrackModActivity).toHaveBeenCalledWith(MODERATOR_ID, {
      entityType: 'model',
      entityId: MODEL_ID,
      activity: 'setPoi',
    });
    expect(mockStampRuling).not.toHaveBeenCalled();
    expect(mockSettleAppeals).not.toHaveBeenCalled();
  });
});

describe('setModelPoi — lift', () => {
  it('clears poi and its locks, and leaves sfwOnly/nsfw as they are', async () => {
    mockBefore({
      poi: true,
      nsfw: false,
      sfwOnly: true,
      lockedProperties: ['poi', 'nsfw', 'sfwOnly'],
    });
    await setModelPoi({ id: MODEL_ID, poi: false, userId: MODERATOR_ID });
    expect(written()).toEqual({ poi: false, lockedProperties: [] });
  });

  it('keeps the locks a minor flag still holds', async () => {
    mockBefore({ poi: true, minor: true, lockedProperties: ['poi', 'minor', 'nsfw', 'sfwOnly'] });
    await setModelPoi({ id: MODEL_ID, poi: false, userId: MODERATOR_ID });
    expect([...written().lockedProperties].sort()).toEqual([...MINOR_LOCKED_PROPERTIES].sort());
  });

  it('stamps the ruling BEFORE the write, then settles the appeal without stamping again', async () => {
    mockBefore({ poi: true });
    await setModelPoi({ id: MODEL_ID, poi: false, userId: MODERATOR_ID });

    expect(mockStampRuling).toHaveBeenCalledWith({
      modelId: MODEL_ID,
      userId: MODERATOR_ID,
      label: 'poi',
    });
    expect(mockStampRuling.mock.invocationCallOrder[0]).toBeLessThan(
      mockDbWrite.model.update.mock.invocationCallOrder[0]
    );
    expect(mockSettleAppeals).toHaveBeenCalledWith({
      modelId: MODEL_ID,
      userId: MODERATOR_ID,
      liftedLabels: ['poi'],
      recordRulings: false,
    });
  });

  it('records no ruling when the model was not POI to begin with', async () => {
    mockBefore({ poi: false });
    await setModelPoi({ id: MODEL_ID, poi: false, userId: MODERATOR_ID });
    expect(mockStampRuling).not.toHaveBeenCalled();
    expect(mockSettleAppeals).not.toHaveBeenCalled();
  });
});

/** The values of every raw write, so a meta key the write sets or removes can be named. */
const rawWriteValues = () =>
  mockDbWrite.$executeRaw.mock.calls.map(
    ([strings, ...values]) =>
      Prisma.sql(strings as TemplateStringsArray, ...(values as never[])).values
  );
const wroteKey = (key: string) => rawWriteValues().some((values) => values.includes(key));

describe('setModelPoi — the real-person hash match', () => {
  it('snapshots the pre-flag state before an automated flag', async () => {
    mockBefore({});
    mockDbWrite.$executeRaw.mockResolvedValue(1);
    await setModelPoi({ id: MODEL_ID, poi: true, userId: 1, activity: 'setPoiAutoHash' });

    expect(wroteKey('poiFlagSnapshot')).toBe(true);
    expect(mockDbWrite.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mockDbWrite.model.update.mock.invocationCallOrder[0]
    );
    expect(mockTrackModActivity).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ activity: 'setPoiAutoHash' })
    );
  });

  // Without a snapshot the flag could neither be reverted nor appealed.
  it('applies no automated flag when the snapshot was not recorded', async () => {
    mockBefore({});
    mockDbWrite.$executeRaw.mockResolvedValue(0);
    await expect(
      setModelPoi({ id: MODEL_ID, poi: true, userId: 1, activity: 'setPoiAutoHash' })
    ).rejects.toThrow();
    expect(mockDbWrite.model.update).not.toHaveBeenCalled();
  });

  it('a moderator set takes no snapshot', async () => {
    mockBefore({});
    await setModelPoi({ id: MODEL_ID, poi: true, userId: MODERATOR_ID });
    expect(wroteKey('poiFlagSnapshot')).toBe(false);
  });

  it('a lift stamps the model cleared, so the hash match does not put the flag back', async () => {
    mockBefore({ poi: true });
    await setModelPoi({ id: MODEL_ID, poi: false, userId: MODERATOR_ID });
    expect(wroteKey('poiHashCleared')).toBe(true);
  });

  it('a lift for an appeal leaves the ruling and the appeal to the resolver', async () => {
    mockBefore({ poi: true });
    await setModelPoi({ id: MODEL_ID, poi: false, userId: MODERATOR_ID, fromAppeal: true });
    expect(mockStampRuling).not.toHaveBeenCalled();
    expect(mockSettleAppeals).not.toHaveBeenCalled();
    expect(wroteKey('poiHashCleared')).toBe(true);
  });
});

it('refuses an unknown model', async () => {
  mockDbRead.model.findUnique.mockResolvedValue(null);
  await expect(setModelPoi({ id: MODEL_ID, poi: true, userId: MODERATOR_ID })).rejects.toThrow();
  expect(mockDbWrite.model.update).not.toHaveBeenCalled();
});
