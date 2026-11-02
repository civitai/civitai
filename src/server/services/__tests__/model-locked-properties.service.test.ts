import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as ModeModule from '~/server/services/text-scan/mode';

// Unit tests for upsertModel's lockedProperties enforcement — locks are read from the
// stored row, never from the client payload. model.service.ts has a very large import
// graph, so most of its transitive service/db/search dependencies are stubbed out below.
// Mirrors the mock scaffold used in set-model-minor.service.test.ts.

const { mockEvaluateContent, mockThrowOnBlockedLinkDomain, mockGetHighestTierSubscription } =
  vi.hoisted(() => ({
    mockEvaluateContent: vi.fn(),
    mockThrowOnBlockedLinkDomain: vi.fn(),
    mockGetHighestTierSubscription: vi.fn(),
  }));

vi.mock('~/libs/profanity-simple', () => ({
  createProfanityFilter: () => ({ evaluateContent: mockEvaluateContent }),
}));

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
  dataForModelsCache: { refresh: vi.fn() },
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
vi.mock('~/server/services/buzz.service', () => ({
  getMultiAccountTransactionsByPrefix: vi.fn(),
  getUserBuzzAccountByAccountTypes: vi.fn(),
  refundMultiAccountTransaction: vi.fn(),
}));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTagsForModels: vi.fn(),
}));
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedLinkDomain: mockThrowOnBlockedLinkDomain,
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
vi.mock('~/server/services/subscriptions.service', () => ({
  getHighestTierSubscription: mockGetHighestTierSubscription,
}));
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
// Pinned per test: 'off' by default keeps the profanity tests about the path they were written for.
vi.mock('~/server/services/text-scan/mode', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeModule>()),
  getTextScanMode: vi.fn(),
}));

import {
  MINOR_LOCKED_PROPERTIES,
  privateModelFromTraining,
  upsertModel,
} from '~/server/services/model.service';
import type { ModelUpsertInput } from '~/server/schema/model.schema';
import { ModelStatus, ModelType, ModelUploadType } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { getTextScanMode } from '~/server/services/text-scan/mode';
import { trackModActivity } from '~/server/services/moderator.service';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import {
  allBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;

const OWNER_ID = 101;
const MODERATOR_ID = 7;
const MODEL_ID = 42;

const cleanEvaluation = {
  shouldMarkNSFW: false,
  reason: 'No profanity detected',
  suggestedLevel: 1,
  metrics: { matchCount: 0, uniqueWords: 0, totalWords: 2, density: 0 },
  matchedWords: [] as string[],
};

const profaneEvaluation = {
  shouldMarkNSFW: true,
  reason: 'Multiple profane words in short content (5 matches in 5 words)',
  suggestedLevel: 4,
  metrics: { matchCount: 5, uniqueWords: 5, totalWords: 5, density: 1 },
  matchedWords: ['badword'],
};

const storedModel = {
  name: 'Test Model',
  description: 'A description',
  poi: false,
  userId: OWNER_ID,
  minor: false,
  sfwOnly: false,
  nsfw: false,
  lockedProperties: [] as string[],
  gallerySettings: { level: 1, users: [] as number[], tags: [] as number[] },
  meta: null as Record<string, unknown> | null,
};

function mockStored(overrides: Partial<typeof storedModel> = {}) {
  mockDbWrite.model.findUnique.mockResolvedValue({ ...storedModel, ...overrides });
}

const baseInput = {
  name: 'Test Model',
  description: 'A description',
  type: ModelType.Checkpoint,
  uploadType: ModelUploadType.Created,
  status: ModelStatus.Draft,
} satisfies Partial<ModelUpsertInput>;

function upsert(input: Partial<ModelUpsertInput> & { userId: number; isModerator?: boolean }) {
  return upsertModel({ ...baseInput, ...input } as Parameters<typeof upsertModel>[0]);
}

function privateFromTraining(
  input: Partial<ModelUpsertInput> & { user: { id: number; isModerator: boolean } }
) {
  return privateModelFromTraining({
    ...baseInput,
    id: MODEL_ID,
    sfwOnly: true,
    ...input,
  } as Parameters<typeof privateModelFromTraining>[0]);
}

function updateData() {
  return mockDbWrite.model.update.mock.calls[0][0].data as Record<string, unknown>;
}

function createData() {
  return mockDbWrite.model.create.mock.calls[0][0].data as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getTextScanMode).mockResolvedValue('off');
  mockEvaluateContent.mockReturnValue(cleanEvaluation);
  mockStored();
  mockDbRead.model.count.mockResolvedValue(0);
  mockGetHighestTierSubscription.mockResolvedValue({ tier: 'gold' });
  mockDbWrite.modelVersion.findMany.mockResolvedValue([]);
  mockDbWrite.$queryRaw.mockResolvedValue([]);
  mockDbWrite.model.create.mockResolvedValue({
    id: MODEL_ID,
    nsfwLevel: 1,
    meta: null,
    availability: 'Public',
  });
  mockDbWrite.model.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({
      id: MODEL_ID,
      name: 'Test Model',
      description: 'A description',
      nsfwLevel: 1,
      poi: false,
      minor: false,
      sfwOnly: false,
      nsfw: false,
      gallerySettings: { level: 1, users: [], tags: [] },
      status: ModelStatus.Draft,
      meta: null,
      availability: 'Public',
      ...data,
      modelVersions: [],
    })
  );
});

describe('upsertModel — non-moderator lock enforcement', () => {
  it('strips a DB-locked field even when the client claims no locks', async () => {
    mockStored({ minor: true, sfwOnly: true, lockedProperties: ['minor'] });

    await upsert({
      id: MODEL_ID,
      userId: OWNER_ID,
      name: 'Renamed Model',
      minor: false,
      lockedProperties: [],
    });

    const data = updateData();
    expect(data).not.toHaveProperty('minor');
    expect(data.name).toBe('Renamed Model');
  });

  it('strips every property the DB row locks, not only the ones the client admits to', async () => {
    mockStored({
      minor: true,
      sfwOnly: true,
      nsfw: false,
      lockedProperties: [...MINOR_LOCKED_PROPERTIES],
    });

    await upsert({
      id: MODEL_ID,
      userId: OWNER_ID,
      minor: false,
      sfwOnly: false,
      nsfw: true,
      lockedProperties: ['sfwOnly'],
    });

    const data = updateData();
    expect(data).not.toHaveProperty('minor');
    expect(data).not.toHaveProperty('sfwOnly');
    expect(data).not.toHaveProperty('nsfw');
  });

  it('ignores locks the client claims — only the stored row decides what is locked', async () => {
    mockStored({ lockedProperties: [] });

    await upsert({
      id: MODEL_ID,
      userId: OWNER_ID,
      poi: true,
      lockedProperties: ['poi'],
    });

    const data = updateData();
    expect(data.poi).toBe(true);
    expect(data).not.toHaveProperty('lockedProperties');
  });

  it('never persists a lock a non-moderator supplied', async () => {
    mockStored({ lockedProperties: [] });

    await upsert({
      id: MODEL_ID,
      userId: OWNER_ID,
      name: 'Renamed Model',
      lockedProperties: ['minor'],
    });

    expect(updateData()).not.toHaveProperty('lockedProperties');
  });

  it('leaves the stored locks untouched when the client posts an empty array', async () => {
    mockStored({ minor: true, lockedProperties: ['minor'] });

    await upsert({ id: MODEL_ID, userId: OWNER_ID, minor: false, lockedProperties: [] });

    expect(updateData()).not.toHaveProperty('lockedProperties');
  });

  it('drops lockedProperties from create input — there is no prior row to lock against', async () => {
    await upsert({ userId: OWNER_ID, minor: true, lockedProperties: ['minor'] });

    const data = createData();
    expect(data).not.toHaveProperty('lockedProperties');
    expect(mockDbWrite.model.findUnique).not.toHaveBeenCalled();
  });

  it('selects lockedProperties on the stored-row lookup — the field the whole fix depends on', async () => {
    await upsert({ id: MODEL_ID, userId: OWNER_ID, name: 'Renamed Model' });

    expect(mockDbWrite.model.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ lockedProperties: true }) })
    );
  });
});

describe('upsertModel — ownership guard', () => {
  it('returns null and writes nothing when the caller is neither owner nor moderator', async () => {
    mockStored({ userId: 999, lockedProperties: ['minor'] });

    const result = await upsert({ id: MODEL_ID, userId: OWNER_ID, minor: false });

    expect(result).toBeNull();
    expect(mockDbWrite.model.update).not.toHaveBeenCalled();
  });

  it('returns null and writes nothing when the model does not exist', async () => {
    mockDbWrite.model.findUnique.mockResolvedValue(null);

    const result = await upsert({ id: MODEL_ID, userId: OWNER_ID, minor: false });

    expect(result).toBeNull();
    expect(mockDbWrite.model.update).not.toHaveBeenCalled();
  });
});

describe('upsertModel — profanity lock', () => {
  it('marks the model nsfw and locks nsfw for a non-moderator', async () => {
    mockStored({ lockedProperties: [] });
    mockEvaluateContent.mockReturnValue(profaneEvaluation);

    await upsert({ id: MODEL_ID, userId: OWNER_ID, name: 'Renamed Model' });

    const data = updateData();
    expect(data.nsfw).toBe(true);
    expect(data.lockedProperties).toEqual(['nsfw']);
    expect(data.meta).toEqual(
      expect.objectContaining({
        profanityMatches: ['badword'],
        systemNsfwLock: { source: 'profanity-filter', at: expect.any(String) },
      })
    );
  });

  it('does not let a client-claimed nsfw lock suppress the profanity flag', async () => {
    mockStored({ lockedProperties: [] });
    mockEvaluateContent.mockReturnValue(profaneEvaluation);

    await upsert({
      id: MODEL_ID,
      userId: OWNER_ID,
      name: 'Renamed Model',
      lockedProperties: ['nsfw'],
    });

    const data = updateData();
    expect(data.nsfw).toBe(true);
    expect(data.lockedProperties).toEqual(['nsfw']);
  });

  it('keeps the stored locks when adding its nsfw lock', async () => {
    mockStored({ lockedProperties: ['minor', 'sfwOnly'] });
    mockEvaluateContent.mockReturnValue(profaneEvaluation);

    await upsert({
      id: MODEL_ID,
      userId: OWNER_ID,
      name: 'Renamed Model',
      lockedProperties: [],
    });

    expect(updateData().lockedProperties).toEqual(['minor', 'sfwOnly', 'nsfw']);
  });

  it('does not run for a moderator', async () => {
    mockStored({ lockedProperties: [] });
    mockEvaluateContent.mockReturnValue(profaneEvaluation);

    await upsert({ id: MODEL_ID, userId: MODERATOR_ID, isModerator: true, name: 'Renamed Model' });

    const data = updateData();
    expect(data.nsfw).toBeUndefined();
    expect(data).not.toHaveProperty('lockedProperties');
  });

  it('records the detection but does not override a DB-locked nsfw', async () => {
    mockStored({ minor: true, nsfw: false, lockedProperties: [...MINOR_LOCKED_PROPERTIES] });
    mockEvaluateContent.mockReturnValue(profaneEvaluation);

    await upsert({ id: MODEL_ID, userId: OWNER_ID, name: 'Renamed Model' });

    const data = updateData();
    expect(data.meta).toEqual(
      expect.objectContaining({
        profanityMatches: ['badword'],
        profanityEvaluation: expect.objectContaining({ reason: profaneEvaluation.reason }),
      })
    );
    expect(data).not.toHaveProperty('nsfw');
    expect(data).not.toHaveProperty('lockedProperties');
    expect(data.meta).not.toHaveProperty('systemNsfwLock');
  });
});

describe('upsertModel — system nsfw lock marker', () => {
  const marker = { source: 'text-scan', at: '2026-09-05T00:00:00.000Z' };

  it("keeps the stored marker through the owner's clean edit", async () => {
    mockStored({ nsfw: true, lockedProperties: ['nsfw'], meta: { systemNsfwLock: marker } });

    await upsert({ id: MODEL_ID, userId: OWNER_ID, name: 'Cleaned', meta: {} } as never);

    expect(updateData().meta).toEqual(expect.objectContaining({ systemNsfwLock: marker }));
  });

  it('ignores a marker the client sends', async () => {
    mockStored({ nsfw: true, lockedProperties: ['nsfw'], meta: null });

    await upsert({
      id: MODEL_ID,
      userId: OWNER_ID,
      name: 'Cleaned',
      meta: { systemNsfwLock: marker },
    } as never);

    expect(updateData().meta ?? {}).not.toHaveProperty('systemNsfwLock');
  });
});

describe('upsertModel — profanity lock against a lock that landed after the read', () => {
  it("neither rewrites the lock nor marks it the system's", async () => {
    mockDbWrite.model.findUnique
      .mockResolvedValueOnce({ ...storedModel, lockedProperties: [] })
      .mockResolvedValue({ ...storedModel, nsfw: true, lockedProperties: ['nsfw', 'poi'] });
    mockEvaluateContent.mockReturnValue(profaneEvaluation);

    await upsert({ id: MODEL_ID, userId: OWNER_ID, name: 'Renamed Model' });

    const data = updateData();
    expect(data).not.toHaveProperty('lockedProperties');
    expect(data).not.toHaveProperty('nsfw');
    expect(data.meta).toEqual(expect.objectContaining({ profanityMatches: ['badword'] }));
    expect(data.meta).not.toHaveProperty('systemNsfwLock');
  });
});

// The first read is the one before the transaction; every later read is the row the transaction
// locked, after a lock landed in between.
function lockLandsMidSave(before: Partial<typeof storedModel>, after: Partial<typeof storedModel>) {
  mockDbWrite.model.findUnique
    .mockResolvedValueOnce({ ...storedModel, ...before })
    .mockResolvedValue({ ...storedModel, ...after });
}

describe('owner saves enforce locks against the row they lock', () => {
  it("refuses the owner's nsfw under an nsfw lock set after the first read", async () => {
    lockLandsMidSave({ lockedProperties: [] }, { nsfw: true, lockedProperties: ['nsfw'] });
    await upsert({ id: MODEL_ID, userId: OWNER_ID, nsfw: false });
    expect(updateData()).not.toHaveProperty('nsfw');
  });

  it("refuses the owner's minor under a minor lock set after the first read", async () => {
    lockLandsMidSave({ lockedProperties: [] }, { minor: true, lockedProperties: ['minor'] });
    await upsert({ id: MODEL_ID, userId: OWNER_ID, minor: false });
    expect(updateData()).not.toHaveProperty('minor');
  });

  it("refuses the owner's value in the private flow under a lock set after the first read", async () => {
    lockLandsMidSave({ lockedProperties: [] }, { lockedProperties: ['nsfw'] });
    await privateFromTraining({ user: { id: OWNER_ID, isModerator: false }, nsfw: true });
    expect(updateData()).not.toHaveProperty('nsfw');
  });

  it('keeps a poi lock set after the first read when the profanity lock is added', async () => {
    lockLandsMidSave({ lockedProperties: [] }, { lockedProperties: ['poi'] });
    mockEvaluateContent.mockReturnValue(profaneEvaluation);
    await upsert({ id: MODEL_ID, userId: OWNER_ID, name: 'Renamed Model' });
    const data = updateData();
    expect(data.nsfw).toBe(true);
    expect(data.lockedProperties).toEqual(['poi', 'nsfw']);
  });

  it('does not bring back a lock a moderator lifted after the first read', async () => {
    lockLandsMidSave({ lockedProperties: ['sfwOnly'] }, { lockedProperties: [] });
    mockEvaluateContent.mockReturnValue(profaneEvaluation);
    await upsert({ id: MODEL_ID, userId: OWNER_ID, name: 'Renamed Model' });
    expect(updateData().lockedProperties).toEqual(['nsfw']);
  });

  it('writes no locks when an nsfw lock and another lock both landed after the first read', async () => {
    lockLandsMidSave({ lockedProperties: [] }, { nsfw: true, lockedProperties: ['nsfw', 'poi'] });
    mockEvaluateContent.mockReturnValue(profaneEvaluation);
    await upsert({ id: MODEL_ID, userId: OWNER_ID, name: 'Renamed Model' });
    const data = updateData();
    expect(data).not.toHaveProperty('lockedProperties');
    expect(data).not.toHaveProperty('nsfw');
    expect(data.meta).toEqual(expect.objectContaining({ profanityMatches: ['badword'] }));
    expect(data.meta).not.toHaveProperty('systemNsfwLock');
  });

  it('builds the gallery settings from the locked row, keeping the SFW level a flag set', async () => {
    lockLandsMidSave(
      { lockedProperties: [], gallerySettings: { level: 31, users: [], tags: [] } },
      {
        minor: true,
        sfwOnly: true,
        lockedProperties: ['minor', 'nsfw', 'sfwOnly'],
        gallerySettings: { level: sfwBrowsingLevelsFlag, users: [], tags: [9] },
      }
    );
    await upsert({ id: MODEL_ID, userId: OWNER_ID, sfwOnly: false });
    const data = updateData();
    expect(data).not.toHaveProperty('sfwOnly');
    expect(data.gallerySettings).toEqual(
      expect.objectContaining({ level: sfwBrowsingLevelsFlag, tags: [9] })
    );
  });

  it('records the profanity lock against the locks the row had, not the first read', async () => {
    lockLandsMidSave({ lockedProperties: [] }, { lockedProperties: ['poi'] });
    mockEvaluateContent.mockReturnValue(profaneEvaluation);
    const entityChanges = vi.fn().mockResolvedValue(undefined);
    await upsert({
      id: MODEL_ID,
      userId: OWNER_ID,
      name: 'Renamed Model',
      tracker: { entityChanges } as never,
    });
    const rows = entityChanges.mock.calls[0][0] as { field: string }[];
    expect(rows.filter((r) => r.field === 'lockedProperties')).toEqual([
      expect.objectContaining({
        oldValue: JSON.stringify(['poi']),
        newValue: JSON.stringify(['nsfw', 'poi']),
        reason: 'profanity-filter',
      }),
    ]);
  });

  it('lets a moderator write under a lock set after the first read', async () => {
    lockLandsMidSave({ lockedProperties: [] }, { nsfw: true, lockedProperties: ['nsfw'] });
    await upsert({
      id: MODEL_ID,
      userId: MODERATOR_ID,
      isModerator: true,
      nsfw: false,
      lockedProperties: ['nsfw'],
    });
    expect(updateData()).toEqual(
      expect.objectContaining({ nsfw: false, lockedProperties: ['nsfw'] })
    );
  });
});

describe('upsertModel — profanity auto-NSFW yields to an active text scan', () => {
  it('does not run once Model text scan is active for this model', async () => {
    vi.mocked(getTextScanMode).mockResolvedValue('active');
    mockStored({ lockedProperties: [] });
    mockEvaluateContent.mockReturnValue(profaneEvaluation);

    await upsert({ id: MODEL_ID, userId: OWNER_ID, name: 'Renamed Model' });

    const data = updateData();
    expect(data.nsfw).toBeUndefined();
    expect(data).not.toHaveProperty('lockedProperties');
    expect(data.meta ?? {}).not.toHaveProperty('profanityMatches');
    expect(getTextScanMode).toHaveBeenCalledWith('Model', MODEL_ID);
  });

  it.each(['off', 'shadow'] as const)('still runs in %s', async (mode) => {
    vi.mocked(getTextScanMode).mockResolvedValue(mode);
    mockStored({ lockedProperties: [] });
    mockEvaluateContent.mockReturnValue(profaneEvaluation);

    await upsert({ id: MODEL_ID, userId: OWNER_ID, name: 'Renamed Model' });

    expect(updateData().nsfw).toBe(true);
  });
});

describe('privateModelFromTraining — lock enforcement', () => {
  const owner = { id: OWNER_ID, isModerator: false };
  const moderator = { id: MODERATOR_ID, isModerator: true };

  it('strips a DB-locked field even when the client claims no locks', async () => {
    mockStored({ minor: true, sfwOnly: true, lockedProperties: ['minor'] });

    await privateFromTraining({ user: owner, minor: false, lockedProperties: [] });

    expect(updateData()).not.toHaveProperty('minor');
  });

  it('never lets a non-moderator write lockedProperties — the stored locks must survive', async () => {
    // The worse half of the bug: passing the client array through to the write would
    // replace the stored locks with [], permanently unlocking the model.
    mockStored({ minor: true, sfwOnly: true, lockedProperties: [...MINOR_LOCKED_PROPERTIES] });

    await privateFromTraining({
      user: owner,
      minor: false,
      nsfw: true,
      lockedProperties: [],
    });

    const data = updateData();
    expect(data).not.toHaveProperty('lockedProperties');
    expect(data).not.toHaveProperty('minor');
    expect(data).not.toHaveProperty('nsfw');
  });

  it('reads the stored locks from the DB row', async () => {
    await privateFromTraining({ user: owner, lockedProperties: [] });

    expect(mockDbWrite.model.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ lockedProperties: true }) })
    );
  });

  it('ignores locks the client claims — only the stored row decides what is locked', async () => {
    mockStored({ lockedProperties: [] });

    await privateFromTraining({ user: owner, poi: true, lockedProperties: ['poi'] });

    const data = updateData();
    expect(data.poi).toBe(true);
    expect(data).not.toHaveProperty('lockedProperties');
  });

  it('lets a moderator write lockedProperties and the locked values themselves', async () => {
    mockStored({ lockedProperties: [] });

    await privateFromTraining({
      user: moderator,
      minor: true,
      lockedProperties: [...MINOR_LOCKED_PROPERTIES],
    });

    const data = updateData();
    expect(data.minor).toBe(true);
    expect(data.lockedProperties).toEqual(MINOR_LOCKED_PROPERTIES);
  });

  it('returns null and writes nothing when the caller is neither owner nor moderator', async () => {
    mockStored({ userId: 999, lockedProperties: ['minor'] });

    const result = await privateFromTraining({ user: owner, minor: false });

    expect(result).toBeNull();
    expect(mockDbWrite.model.update).not.toHaveBeenCalled();
  });
});

const systemMarker = { source: 'text-scan', at: '2026-09-05T00:00:00.000Z' };

describe('system nsfw lock marker on a moderator save', () => {
  const locked = { nsfw: true, lockedProperties: ['nsfw'], meta: { systemNsfwLock: systemMarker } };

  it('drops the marker when a moderator removes the nsfw lock', async () => {
    mockStored(locked);
    await upsert({ id: MODEL_ID, userId: MODERATOR_ID, isModerator: true, lockedProperties: [] });
    expect(updateData().meta).not.toHaveProperty('systemNsfwLock');
  });

  it('drops the marker when a moderator adds the nsfw lock over a stale one', async () => {
    mockStored({ ...locked, lockedProperties: [] });
    await upsert({
      id: MODEL_ID,
      userId: MODERATOR_ID,
      isModerator: true,
      lockedProperties: ['nsfw'],
    });
    expect(updateData().meta).not.toHaveProperty('systemNsfwLock');
  });

  it('keeps the marker on a moderator save that leaves the nsfw lock alone', async () => {
    mockStored(locked);
    await upsert({
      id: MODEL_ID,
      userId: MODERATOR_ID,
      isModerator: true,
      lockedProperties: ['nsfw', 'poi'],
    });
    expect(updateData().meta).toEqual(expect.objectContaining({ systemNsfwLock: systemMarker }));
  });

  it('drops the marker when a moderator changes nsfw under the same lock', async () => {
    mockStored(locked);
    await upsert({
      id: MODEL_ID,
      userId: MODERATOR_ID,
      isModerator: true,
      nsfw: false,
      lockedProperties: ['nsfw'],
    });
    expect(updateData().meta).not.toHaveProperty('systemNsfwLock');
  });

  it('drops the marker and logs the unlock when a moderator unlocks nsfw in the private flow', async () => {
    mockStored({ ...locked, sfwOnly: true });
    await privateFromTraining({
      user: { id: MODERATOR_ID, isModerator: true },
      lockedProperties: [],
    });
    expect(updateData().meta).not.toHaveProperty('systemNsfwLock');
    expect(trackModActivity).toHaveBeenCalledWith(
      MODERATOR_ID,
      { entityType: 'model', entityId: MODEL_ID, activity: 'unlockProperty:nsfw' },
      expect.anything()
    );
  });

  it("keeps the marker and logs nothing on an owner's private-flow publish", async () => {
    mockStored({ ...locked, nsfw: false });
    await privateFromTraining({ user: { id: OWNER_ID, isModerator: false }, lockedProperties: [] });
    expect(updateData().meta).toEqual(expect.objectContaining({ systemNsfwLock: systemMarker }));
    expect(trackModActivity).not.toHaveBeenCalled();
  });
});

describe('upsertModel — content flags the row ends up with', () => {
  // What the API passes on after parsing: a left-out minor/sfwOnly arrives as false.
  const moderatorRequest = {
    id: MODEL_ID,
    userId: MODERATOR_ID,
    isModerator: true,
    minor: false,
    sfwOnly: false,
  };

  it.each([
    ['minor', 'Mature content depicting minors is not permitted.'],
    ['poi', 'Mature content depicting actual people is not permitted.'],
    ['sfwOnly', 'Mature content on a model marked as SFW is not permitted.'],
  ] as const)(
    'refuses an owner marking nsfw alone on a model with %s locked on',
    async (flag, message) => {
      mockStored({ [flag]: true, lockedProperties: [flag] });

      await expect(upsert({ id: MODEL_ID, userId: OWNER_ID, nsfw: true })).rejects.toThrow(message);
      expect(mockDbWrite.model.update).not.toHaveBeenCalled();
    }
  );

  const flaggedRow = {
    minor: true,
    nsfw: true,
    sfwOnly: true,
    lockedProperties: [...MINOR_LOCKED_PROPERTIES],
  };

  it('lets an owner edit only the description of a row already holding nsfw with minor', async () => {
    mockStored(flaggedRow);

    await upsert({ id: MODEL_ID, userId: OWNER_ID, description: 'New description' });

    expect(updateData().description).toBe('New description');
  });

  it('lets a moderator save the description with the row’s flags unchanged', async () => {
    mockStored(flaggedRow);

    await upsert({
      id: MODEL_ID,
      userId: MODERATOR_ID,
      isModerator: true,
      description: 'New description',
      nsfw: true,
      minor: true,
      sfwOnly: true,
      poi: false,
    });

    expect(updateData().description).toBe('New description');
  });

  it('lets a moderator clear nsfw on that row', async () => {
    mockStored(flaggedRow);

    await upsert({ id: MODEL_ID, userId: MODERATOR_ID, isModerator: true, nsfw: false });

    expect(updateData().nsfw).toBe(false);
  });

  it.each(['minor', 'poi', 'sfwOnly'] as const)(
    'lets a moderator mark nsfw in the same save that clears %s',
    async (flag) => {
      mockStored({ [flag]: true, lockedProperties: [flag] });

      await upsert({
        ...moderatorRequest,
        nsfw: true,
        [flag]: false,
      });

      expect(updateData()).toEqual(expect.objectContaining({ nsfw: true, [flag]: false }));
    }
  );

  it('lets a moderator mark minor in the same save that clears nsfw', async () => {
    mockStored({ nsfw: true });

    await upsert({ ...moderatorRequest, nsfw: false, minor: true });

    expect(updateData()).toEqual(expect.objectContaining({ nsfw: false, minor: true }));
  });

  it('refuses a moderator marking minor on an nsfw model', async () => {
    mockStored({ nsfw: true });

    await expect(upsert({ ...moderatorRequest, nsfw: true, minor: true })).rejects.toThrow(
      'Mature content depicting minors is not permitted.'
    );
    expect(mockDbWrite.model.update).not.toHaveBeenCalled();
  });

  it('saves profane text on a poi model without marking it nsfw, keeping the matches', async () => {
    mockStored({ poi: true });
    mockEvaluateContent.mockReturnValue(profaneEvaluation);

    await upsert({ id: MODEL_ID, userId: OWNER_ID, name: 'Renamed Model' });

    expect(updateData()).not.toHaveProperty('nsfw');
    expect(updateData()).not.toHaveProperty('lockedProperties');
    expect(updateData().meta).toEqual(expect.objectContaining({ profanityMatches: ['badword'] }));
    expect(updateData().meta).not.toHaveProperty('systemNsfwLock');
  });

  it('saves an unrelated edit to a profane-named SFW-only model', async () => {
    mockStored({ sfwOnly: true });
    mockEvaluateContent.mockReturnValue(profaneEvaluation);

    await upsert({
      id: MODEL_ID,
      userId: OWNER_ID,
      description: 'New description',
      minor: false,
      sfwOnly: true,
    });

    expect(updateData().description).toBe('New description');
    expect(updateData()).not.toHaveProperty('nsfw');
  });

  it('creates a poi model SFW, without the profanity nsfw, when the text is profane', async () => {
    mockEvaluateContent.mockReturnValue(profaneEvaluation);

    await upsert({ userId: OWNER_ID, poi: true, minor: false, sfwOnly: false });

    expect(createData()).toEqual(
      expect.objectContaining({ poi: true, sfwOnly: true, nsfw: false })
    );
    expect(createData()).not.toHaveProperty('lockedProperties');
  });

  it('refuses a moderator create holding nsfw with poi', async () => {
    await expect(
      upsert({ userId: MODERATOR_ID, isModerator: true, poi: true, nsfw: true })
    ).rejects.toThrow('Mature content depicting actual people is not permitted.');
    expect(mockDbWrite.model.create).not.toHaveBeenCalled();
  });

  it('creates a poi model with clean text', async () => {
    await upsert({ userId: OWNER_ID, poi: true });

    expect(createData().poi).toBe(true);
  });

  it('refuses the private flow on a model whose nsfw is locked on', async () => {
    mockStored({ nsfw: true, lockedProperties: ['nsfw'] });

    // sfwOnly left out: the flow writes it regardless, so the check must count it.
    await expect(
      privateFromTraining({
        user: { id: OWNER_ID, isModerator: false },
        nsfw: false,
        sfwOnly: undefined,
      })
    ).rejects.toThrow('Mature content on a model marked as SFW is not permitted.');
    expect(mockDbWrite.model.update).not.toHaveBeenCalled();
    // A refusal is not a failed publish: the live model is not rolled back to Draft.
    expect(mockDbWrite.model.updateMany).not.toHaveBeenCalled();
    expect(mockDbWrite.modelVersion.updateMany).not.toHaveBeenCalled();
  });

  const minorRow = { minor: true, sfwOnly: true, lockedProperties: [...MINOR_LOCKED_PROPERTIES] };

  it('refuses a moderator marking nsfw on a minor model', async () => {
    mockStored(minorRow);

    await expect(
      upsert({ ...moderatorRequest, nsfw: true, minor: true, sfwOnly: true })
    ).rejects.toThrow('Mature content depicting minors is not permitted.');
    expect(mockDbWrite.model.update).not.toHaveBeenCalled();
  });

  // The schema fills a left-out minor/sfwOnly with false, so this request also clears them.
  it('clears minor when a moderator marks nsfw with minor left out', async () => {
    mockStored(minorRow);

    await upsert({ ...moderatorRequest, nsfw: true });

    expect(updateData()).toEqual(
      expect.objectContaining({ nsfw: true, minor: false, sfwOnly: false })
    );
  });

  it('makes an owner save that marks minor SFW, over a locked nsfw, and locks minor', async () => {
    mockStored({ nsfw: true, lockedProperties: ['nsfw'] });

    await upsert({ id: MODEL_ID, userId: OWNER_ID, minor: true, sfwOnly: false, nsfw: false });

    expect(updateData()).toEqual(
      expect.objectContaining({
        minor: true,
        nsfw: false,
        sfwOnly: true,
        lockedProperties: ['nsfw', 'minor', 'sfwOnly'],
      })
    );
    expect(updateData().meta).toEqual(
      expect.objectContaining({
        ownerFlagOverride: {
          at: expect.any(String),
          flags: ['minor'],
          prevNsfw: true,
          prevSfwOnly: false,
          prevLockedProperties: ['nsfw'],
          prevGalleryLevel: 1,
        },
      })
    );
  });

  it('makes an owner save that marks poi SFW over a locked nsfw, and takes the poi locks', async () => {
    mockStored({ nsfw: true, lockedProperties: ['nsfw'] });

    await upsert({ id: MODEL_ID, userId: OWNER_ID, poi: true, minor: false, sfwOnly: false });

    expect(updateData()).toEqual(
      expect.objectContaining({
        poi: true,
        nsfw: false,
        sfwOnly: true,
        lockedProperties: ['nsfw', 'poi', 'sfwOnly'],
      })
    );
    expect(updateData().meta).toEqual(
      expect.objectContaining({ ownerFlagOverride: expect.objectContaining({ flags: ['poi'] }) })
    );
  });

  // An automated revert of the later flag must know the owner declared it too.
  it('adds a flag the owner declares later to the override already on the row', async () => {
    const ownerFlagOverride = {
      at: '2026-01-01T00:00:00.000Z',
      flags: ['poi'],
      prevNsfw: true,
      prevSfwOnly: false,
      prevLockedProperties: ['nsfw'],
      prevGalleryLevel: 31,
    };
    mockStored({
      poi: true,
      sfwOnly: true,
      lockedProperties: ['nsfw', 'poi', 'sfwOnly'],
      meta: { ownerFlagOverride },
    });

    await upsert({ id: MODEL_ID, userId: OWNER_ID, minor: true });

    expect(updateData().meta.ownerFlagOverride).toEqual({
      ...ownerFlagOverride,
      flags: ['poi', 'minor'],
    });
  });

  it('takes both lock sets when an owner marks minor and poi over a locked nsfw', async () => {
    mockStored({ nsfw: true, lockedProperties: ['nsfw'] });

    await upsert({ id: MODEL_ID, userId: OWNER_ID, minor: true, poi: true, sfwOnly: false });

    expect(updateData().lockedProperties).toEqual(['nsfw', 'minor', 'sfwOnly', 'poi']);
    expect(updateData().meta).toEqual(
      expect.objectContaining({
        ownerFlagOverride: expect.objectContaining({ flags: ['minor', 'poi'] }),
      })
    );
  });

  it('creates an owner model marking minor with nsfw sent SFW', async () => {
    await upsert({ userId: OWNER_ID, minor: true, nsfw: true, sfwOnly: false });

    expect(createData()).toEqual(
      expect.objectContaining({ minor: true, nsfw: false, sfwOnly: true })
    );
  });

  it('refuses a moderator private flow on an nsfw model, leaving it published', async () => {
    mockStored({ nsfw: true });

    await expect(
      privateFromTraining({ user: { id: MODERATOR_ID, isModerator: true }, sfwOnly: undefined })
    ).rejects.toThrow('Mature content on a model marked as SFW is not permitted.');
    expect(mockDbWrite.model.updateMany).not.toHaveBeenCalled();
  });

  // Otherwise a later flag's lift would restore a ruling this save already replaced.
  it("drops the owner-flag override when a moderator's save leaves neither flag", async () => {
    const ownerFlagOverride = {
      at: '2026-01-01T00:00:00.000Z',
      flags: ['minor'],
      prevNsfw: true,
      prevSfwOnly: false,
      prevLockedProperties: ['nsfw'],
    };
    mockStored({
      minor: true,
      sfwOnly: true,
      lockedProperties: ['nsfw', 'minor', 'sfwOnly'],
      meta: { ownerFlagOverride, cannotPromote: true },
    });

    await upsert({ id: MODEL_ID, userId: MODERATOR_ID, isModerator: true, minor: false });

    expect(updateData().meta).not.toHaveProperty('ownerFlagOverride');
    expect(updateData().meta).toHaveProperty('cannotPromote', true);
  });

  it("drops the owner-flag override when a moderator's save rules on the rating", async () => {
    mockStored({
      minor: true,
      sfwOnly: true,
      lockedProperties: ['nsfw', 'minor', 'sfwOnly'],
      meta: {
        ownerFlagOverride: {
          at: '2026-01-01T00:00:00.000Z',
          flags: ['minor'],
          prevNsfw: true,
          prevSfwOnly: false,
          prevLockedProperties: ['nsfw'],
        },
      },
    });

    await upsert({
      id: MODEL_ID,
      userId: MODERATOR_ID,
      isModerator: true,
      lockedProperties: ['minor', 'sfwOnly'],
    });

    expect(updateData().meta).not.toHaveProperty('ownerFlagOverride');
  });

  it('marks the minor flag snapshot as superseded when a save turns minor off', async () => {
    mockStored({
      minor: true,
      sfwOnly: true,
      lockedProperties: [],
      meta: { minorFlagSnapshot: { at: '2026-01-01T00:00:00.000Z', source: 'manual' } },
    });

    await upsert({ id: MODEL_ID, userId: MODERATOR_ID, isModerator: true, minor: false });

    expect(updateData().meta.minorFlagSnapshot).toEqual({
      at: '2026-01-01T00:00:00.000Z',
      source: 'manual',
      supersededAt: expect.any(String),
    });
  });

  it('keeps the owner-flag override while a save leaves a flag on', async () => {
    const ownerFlagOverride = {
      at: '2026-01-01T00:00:00.000Z',
      flags: ['minor'],
      prevNsfw: true,
      prevSfwOnly: false,
      prevLockedProperties: ['nsfw'],
    };
    mockStored({
      minor: true,
      sfwOnly: true,
      lockedProperties: ['nsfw', 'minor', 'sfwOnly'],
      meta: { ownerFlagOverride },
    });

    await upsert({ id: MODEL_ID, userId: MODERATOR_ID, isModerator: true, name: 'Renamed Model' });

    expect(updateData().meta).toHaveProperty('ownerFlagOverride', ownerFlagOverride);
  });

  it('never takes an owner-flag override record from the client', async () => {
    const forged = {
      at: '2026-01-01T00:00:00.000Z',
      flags: ['minor'],
      prevNsfw: true,
      prevSfwOnly: false,
      prevLockedProperties: [],
    };

    await upsert({ id: MODEL_ID, userId: OWNER_ID, meta: { ownerFlagOverride: forged } as never });

    expect(updateData().meta).not.toHaveProperty('ownerFlagOverride');
  });

  it('writes sfwOnly over a moderator sfwOnly lock when an owner marks minor', async () => {
    mockStored({ lockedProperties: ['sfwOnly'] });

    await upsert({ id: MODEL_ID, userId: OWNER_ID, minor: true, sfwOnly: false });

    expect(updateData()).toEqual(expect.objectContaining({ minor: true, sfwOnly: true }));
  });

  it('holds the gallery at SFW on an owner create that marks poi', async () => {
    await upsert({ userId: OWNER_ID, poi: true, minor: false, sfwOnly: false });

    expect((createData().gallerySettings as { level: number }).level).toBe(sfwBrowsingLevelsFlag);
  });

  it('adds no lock when an owner marks poi under an nsfw lock already holding nsfw off', async () => {
    mockStored({ lockedProperties: ['nsfw'] });

    await upsert({ id: MODEL_ID, userId: OWNER_ID, poi: true, minor: false, sfwOnly: false });

    expect(updateData()).toEqual(expect.objectContaining({ poi: true, sfwOnly: true }));
    expect(updateData()).not.toHaveProperty('lockedProperties');
  });

  it('keeps minor and nsfw where an owner who marked minor over a locked nsfw left them', async () => {
    mockStored({ minor: true, sfwOnly: true, lockedProperties: ['nsfw', 'minor', 'sfwOnly'] });

    await upsert({ id: MODEL_ID, userId: OWNER_ID, minor: false, nsfw: true, sfwOnly: false });

    expect(updateData()).not.toHaveProperty('minor');
    expect(updateData()).not.toHaveProperty('nsfw');
    expect(updateData()).not.toHaveProperty('sfwOnly');
  });

  it('makes an owner save that marks poi SFW without adding a lock when nsfw is unlocked', async () => {
    mockStored({ nsfw: true });

    await upsert({ id: MODEL_ID, userId: OWNER_ID, poi: true, minor: false, sfwOnly: false });

    expect(updateData()).toEqual(
      expect.objectContaining({ poi: true, nsfw: false, sfwOnly: true })
    );
    expect(updateData()).not.toHaveProperty('lockedProperties');
  });

  it('drops the profanity nsfw when minor was cleared after the first read and the save marks it', async () => {
    lockLandsMidSave({ minor: true, sfwOnly: true }, { minor: false });
    mockEvaluateContent.mockReturnValue(profaneEvaluation);

    await upsert({ id: MODEL_ID, userId: OWNER_ID, minor: true, sfwOnly: true });

    expect(updateData()).toEqual(expect.objectContaining({ minor: true, nsfw: false }));
    expect(updateData()).not.toHaveProperty('lockedProperties');
    expect(updateData().meta).not.toHaveProperty('systemNsfwLock');
  });

  it('drops the profanity nsfw when the row turned SFW-only after the first read', async () => {
    lockLandsMidSave({}, { sfwOnly: true });
    mockEvaluateContent.mockReturnValue(profaneEvaluation);

    await upsert({ id: MODEL_ID, userId: OWNER_ID, name: 'Renamed Model' });

    expect(updateData().nsfw).toBeUndefined();
    expect(updateData()).not.toHaveProperty('lockedProperties');
    expect(updateData().meta).not.toHaveProperty('systemNsfwLock');
  });

  it('changes nothing on an unchanged save of a legacy nsfw poi row under an nsfw lock', async () => {
    mockStored({ nsfw: true, poi: true, lockedProperties: ['nsfw'] });

    await upsert({ id: MODEL_ID, userId: OWNER_ID, poi: true });

    expect(updateData()).not.toHaveProperty('sfwOnly');
    expect(updateData()).not.toHaveProperty('lockedProperties');
    expect(updateData().meta).not.toHaveProperty('ownerFlagOverride');
  });

  it('leaves nsfw off an owner save that marks minor with profane text', async () => {
    mockEvaluateContent.mockReturnValue(profaneEvaluation);

    await upsert({ id: MODEL_ID, userId: OWNER_ID, minor: true, sfwOnly: false });

    expect(updateData()).toEqual(
      expect.objectContaining({ minor: true, nsfw: false, sfwOnly: true })
    );
    expect(updateData()).not.toHaveProperty('lockedProperties');
    expect(updateData().meta).not.toHaveProperty('systemNsfwLock');
  });

  it('holds the gallery at SFW for a minor row the save does not send minor for', async () => {
    mockStored({
      minor: true,
      lockedProperties: ['minor'],
      gallerySettings: { level: allBrowsingLevelsFlag, users: [], tags: [] },
    });

    await upsert({ id: MODEL_ID, userId: OWNER_ID, description: 'New description' });

    expect((updateData().gallerySettings as { level: number }).level).toBe(sfwBrowsingLevelsFlag);
  });
});

describe('upsertModel — moderator', () => {
  it('can set lockedProperties and the locked values themselves', async () => {
    mockStored({ lockedProperties: [] });

    await upsert({
      id: MODEL_ID,
      userId: MODERATOR_ID,
      isModerator: true,
      minor: true,
      sfwOnly: true,
      lockedProperties: [...MINOR_LOCKED_PROPERTIES],
    });

    const data = updateData();
    expect(data.minor).toBe(true);
    expect(data.sfwOnly).toBe(true);
    expect(data.lockedProperties).toEqual(MINOR_LOCKED_PROPERTIES);
  });

  it('can clear lockedProperties and edit a previously locked value', async () => {
    mockStored({ minor: true, sfwOnly: true, lockedProperties: [...MINOR_LOCKED_PROPERTIES] });

    await upsert({
      id: MODEL_ID,
      userId: MODERATOR_ID,
      isModerator: true,
      minor: false,
      lockedProperties: [],
    });

    const data = updateData();
    expect(data.minor).toBe(false);
    expect(data.lockedProperties).toEqual([]);
  });
});

// Publishing runs through model.publish; a create that kept the client's status would skip every
// check that endpoint enforces.
describe('upsertModel — status on create', () => {
  it.each(Object.values(ModelStatus).filter((status) => status !== ModelStatus.Draft))(
    'stores Draft when a non-moderator creates with %s',
    async (status) => {
      await upsert({ userId: OWNER_ID, status });

      expect(createData().status).toBe(ModelStatus.Draft);
    }
  );

  it('stores Draft for a templated create too', async () => {
    await upsert({ id: MODEL_ID, templateId: MODEL_ID, userId: OWNER_ID, status: 'Published' });

    expect(createData().status).toBe(ModelStatus.Draft);
  });

  it('keeps a moderator-supplied status', async () => {
    await upsert({ userId: MODERATOR_ID, isModerator: true, status: ModelStatus.Published });

    expect(createData().status).toBe(ModelStatus.Published);
  });
});

// privateModelFromTraining replaces meta wholesale, so it must carry the stored server-owned keys over
// and ignore any the client sends — the publish paths read them.
describe('privateModelFromTraining — server-owned meta keys', () => {
  it.each([false, true])(
    'keeps the stored training keys when client meta (isModerator=%s) omits or rewrites them',
    async (isModerator) => {
      mockStored({
        meta: { trainingStudioWorkflowId: 'wf-real', trainingStudioModerationApproved: true },
      });

      await privateFromTraining({
        user: { id: isModerator ? MODERATOR_ID : OWNER_ID, isModerator },
        meta: {
          trainingStudioWorkflowId: 'wf-other',
          commentsLocked: true,
        } as unknown as ModelUpsertInput['meta'],
      });

      expect(updateData().meta).toEqual({
        commentsLocked: true,
        trainingStudioWorkflowId: 'wf-real',
        trainingStudioModerationApproved: true,
        cannotPromote: true,
      });
    }
  );

  it('does not let client meta add training keys a model never had', async () => {
    mockStored({ meta: null });

    await privateFromTraining({
      user: { id: OWNER_ID, isModerator: false },
      meta: {
        trainingStudioWorkflowId: 'wf-client',
        trainingStudioModerationApproved: true,
        commentsLocked: true,
      } as unknown as ModelUpsertInput['meta'],
    });

    expect(updateData().meta).toEqual({ commentsLocked: true, cannotPromote: true });
  });
});
