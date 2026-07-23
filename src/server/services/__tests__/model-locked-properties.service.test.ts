import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit tests for upsertModel's lockedProperties enforcement — locks are read from the
// stored row, never from the client payload. model.service.ts has a very large import
// graph, so most of its transitive service/db/search dependencies are stubbed out below.
// Mirrors the mock scaffold used in set-model-minor.service.test.ts.

const { mockDbRead, mockDbWrite } = vi.hoisted(() => {
  const mk = () => ({
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(),
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

const { mockEvaluateContent, mockThrowOnBlockedLinkDomain, mockGetHighestTierSubscription } =
  vi.hoisted(() => ({
    mockEvaluateContent: vi.fn(),
    mockThrowOnBlockedLinkDomain: vi.fn(),
    mockGetHighestTierSubscription: vi.fn(),
  }));

vi.mock('~/libs/profanity-simple', () => ({
  createProfanityFilter: () => ({ evaluateContent: mockEvaluateContent }),
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
  dataForModelsCache: { refresh: vi.fn() },
  modelTagCache: { refresh: vi.fn() },
  modelVotableTagsCache: { bust: vi.fn() },
  userBasicCache: {},
  userModelCountCache: { refresh: vi.fn() },
}));
vi.mock('~/server/redis/client', () => ({
  redis: { del: vi.fn() },
  REDIS_KEYS: { MODEL: { GALLERY_SETTINGS: 'model:gallery-settings' } },
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
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTagsForModels: vi.fn(),
}));
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedLinkDomain: mockThrowOnBlockedLinkDomain,
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

import {
  MINOR_LOCKED_PROPERTIES,
  privateModelFromTraining,
  upsertModel,
} from '~/server/services/model.service';
import type { ModelUpsertInput } from '~/server/schema/model.schema';
import { ModelStatus, ModelType, ModelUploadType } from '~/shared/utils/prisma/enums';

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
  mockDbRead.model.findUnique.mockResolvedValue({ ...storedModel, ...overrides });
}

const baseInput = {
  name: 'Test Model',
  description: 'A description',
  type: ModelType.Checkpoint,
  uploadType: ModelUploadType.Created,
  // Draft keeps applyModelFlagSideEffects out of the ingest path so the only
  // dbWrite.model.update call in a test is the upsert itself.
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

  it('still honors locks the client claims on top of the DB row', async () => {
    mockStored({ lockedProperties: [] });

    await upsert({
      id: MODEL_ID,
      userId: OWNER_ID,
      poi: true,
      lockedProperties: ['poi'],
    });

    expect(updateData()).not.toHaveProperty('poi');
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
    expect(mockDbRead.model.findUnique).not.toHaveBeenCalled();
  });

  it('selects lockedProperties on the stored-row lookup — the field the whole fix depends on', async () => {
    await upsert({ id: MODEL_ID, userId: OWNER_ID, name: 'Renamed Model' });

    expect(mockDbRead.model.findUnique).toHaveBeenCalledWith(
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
    mockDbRead.model.findUnique.mockResolvedValue(null);

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
    expect(data.meta).toEqual(expect.objectContaining({ profanityMatches: ['badword'] }));
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
    mockStored({ minor: true, sfwOnly: true, lockedProperties: ['minor', 'sfwOnly'] });
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

    expect(mockDbRead.model.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ lockedProperties: true }) })
    );
  });

  it('still honors locks the client claims on top of the DB row', async () => {
    mockStored({ lockedProperties: [] });

    await privateFromTraining({ user: owner, poi: true, lockedProperties: ['poi'] });

    expect(updateData()).not.toHaveProperty('poi');
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
