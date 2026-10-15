import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as ModeModule from '~/server/services/text-scan/mode';
import type * as AppealTextHash from '~/server/services/text-scan/actions/appeal-text-hash';

// Unit tests for upsertModel's owner-writable fields: moderation-owned meta and availability.
// Scaffold mirrors model-locked-properties.service.test.ts.

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
const { mockSettleAppeals } = vi.hoisted(() => ({ mockSettleAppeals: vi.fn() }));
vi.mock('~/server/services/text-scan/actions/appeal-text-hash', async (importOriginal) => ({
  ...(await importOriginal<typeof AppealTextHash>()),
  settleFlagAppealsAfterModeratorLift: mockSettleAppeals,
}));
import { MODERATION_FLOW_META_KEYS } from '~/server/utils/minor-flag-meta';
import { ModelStatus, ModelType, ModelUploadType } from '~/shared/utils/prisma/enums';
import { Availability } from '~/shared/utils/prisma/enums';
import type { ModelUpsertInput } from '~/server/schema/model.schema';
import { upsertModel } from '~/server/services/model.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/redis.mock';
import { getTextScanMode } from '~/server/services/text-scan/mode';

const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;

const OWNER_ID = 101;
const MODERATOR_ID = 7;
const MODEL_ID = 42;

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
  availability: Availability.Public as Availability,
  status: ModelStatus.Published as ModelStatus,
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

function updateData() {
  return mockDbWrite.model.update.mock.calls[0][0].data as Record<string, unknown>;
}

function createData() {
  return mockDbWrite.model.create.mock.calls[0][0].data as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getTextScanMode).mockResolvedValue('off');
  mockEvaluateContent.mockReturnValue({
    shouldMarkNSFW: false,
    reason: 'No profanity detected',
    suggestedLevel: 1,
    metrics: { matchCount: 0, uniqueWords: 0, totalWords: 2, density: 0 },
    matchedWords: [],
  });
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
      status: ModelStatus.Published,
      meta: null,
      availability: 'Public',
      ...data,
      modelVersions: [],
    })
  );
});

const FLOW_KEYS = [
  'cannotPublish',
  'cannotPromote',
  'unpublishedReason',
  'unpublishedAt',
  'unpublishedBy',
  'customMessage',
  'needsReview',
  'declinedReason',
  'declinedAt',
  'takenDownAt',
  'takenDownBy',
  'archivedAt',
  'archivedBy',
] as const;

const FORGED = {
  cannotPublish: false,
  cannotPromote: false,
  unpublishedReason: 'forged',
  unpublishedAt: '2000-01-01T00:00:00.000Z',
  unpublishedBy: 999,
  customMessage: 'forged',
  needsReview: false,
  declinedReason: 'forged',
  declinedAt: '2000-01-01T00:00:00.000Z',
  takenDownAt: '2000-01-01T00:00:00.000Z',
  takenDownBy: 999,
  archivedAt: '2000-01-01T00:00:00.000Z',
  archivedBy: 999,
};

const STORED_FLOW_META = {
  cannotPublish: true,
  cannotPromote: true,
  unpublishedReason: 'violation',
  unpublishedAt: '2026-01-01T00:00:00.000Z',
  unpublishedBy: MODERATOR_ID,
  customMessage: 'stored',
  needsReview: true,
  declinedReason: 'stored',
  declinedAt: '2026-01-01T00:00:00.000Z',
  takenDownAt: '2026-01-01T00:00:00.000Z',
  takenDownBy: MODERATOR_ID,
  archivedAt: '2026-01-01T00:00:00.000Z',
  archivedBy: MODERATOR_ID,
};

describe('moderation-flow meta keys', () => {
  it('covers every key a moderation flow writes', () => {
    expect([...MODERATION_FLOW_META_KEYS].sort()).toEqual([...FLOW_KEYS].sort());
  });

  it('preserves stored values when a non-moderator update sends them back changed', async () => {
    mockStored({ meta: { ...STORED_FLOW_META, hideBuzz: false } });

    await upsert({
      id: MODEL_ID,
      userId: OWNER_ID,
      meta: { ...FORGED, hideBuzz: true } as ModelUpsertInput['meta'],
    });

    expect(updateData().meta).toEqual({ ...STORED_FLOW_META, hideBuzz: true });
  });

  it('does not let a non-moderator update add a flow key the model never had', async () => {
    mockStored({ meta: null });

    await upsert({
      id: MODEL_ID,
      userId: OWNER_ID,
      meta: { ...FORGED, hideBuzz: true } as ModelUpsertInput['meta'],
    });

    expect(updateData().meta).toEqual({ hideBuzz: true });
  });

  it('drops flow keys from a non-moderator create and keeps owner keys', async () => {
    await upsert({
      userId: OWNER_ID,
      meta: { ...FORGED, hideBuzz: true } as ModelUpsertInput['meta'],
    });

    expect(createData().meta).toEqual({ hideBuzz: true, bountyId: undefined });
  });

  it('lets a moderator write flow keys through upsert as before', async () => {
    mockStored({ meta: STORED_FLOW_META });

    await upsert({
      id: MODEL_ID,
      userId: MODERATOR_ID,
      isModerator: true,
      meta: { cannotPublish: false } as ModelUpsertInput['meta'],
    });

    expect(updateData().meta).toEqual({ ...STORED_FLOW_META, cannotPublish: false });
  });
});

describe('stored snapshot', () => {
  it('reads the stored row from the primary, never the replica', async () => {
    await upsert({ id: MODEL_ID, userId: OWNER_ID });

    expect(mockDbRead.model.findUnique).not.toHaveBeenCalled();
    expect(mockDbWrite.model.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: MODEL_ID } })
    );
  });
});

describe('cannotPromote on a private model', () => {
  const privateStored = (meta: Record<string, unknown>) =>
    mockStored({ availability: Availability.Private, meta });

  it('keeps cannotPromote forced on and records a moderator ban for publish', async () => {
    privateStored({ cannotPromote: true });

    await upsert({
      id: MODEL_ID,
      userId: MODERATOR_ID,
      isModerator: true,
      meta: { cannotPromote: true } as ModelUpsertInput['meta'],
    });

    expect(updateData().meta).toEqual({ cannotPromote: true, restoreCannotPromote: true });
  });

  it('keeps cannotPromote forced on and drops the marker on a moderator unban', async () => {
    privateStored({ cannotPromote: true, restoreCannotPromote: true });

    await upsert({
      id: MODEL_ID,
      userId: MODERATOR_ID,
      isModerator: true,
      meta: { cannotPromote: false } as ModelUpsertInput['meta'],
    });

    const meta = updateData().meta as Record<string, unknown>;
    expect(meta.cannotPromote).toBe(true);
    expect(meta).not.toHaveProperty('restoreCannotPromote');
  });

  it('leaves the marker alone when the moderator does not send cannotPromote', async () => {
    privateStored({ cannotPromote: true, restoreCannotPromote: true });

    await upsert({
      id: MODEL_ID,
      userId: MODERATOR_ID,
      isModerator: true,
      meta: { hideBuzz: true } as ModelUpsertInput['meta'],
    });

    expect(updateData().meta).toEqual({
      cannotPromote: true,
      restoreCannotPromote: true,
      hideBuzz: true,
    });
  });

  it('never lets the client author the marker', async () => {
    privateStored({ cannotPromote: true });

    await upsert({
      id: MODEL_ID,
      userId: OWNER_ID,
      meta: { restoreCannotPromote: true } as ModelUpsertInput['meta'],
    });

    expect(updateData().meta).toEqual({ cannotPromote: true });
  });
});

describe('availability', () => {
  it('refuses a non-moderator Private to Public change on a published model', async () => {
    mockStored({ availability: Availability.Private });

    await expect(
      upsert({ id: MODEL_ID, userId: OWNER_ID, availability: Availability.Public })
    ).rejects.toThrow(/publish/i);
    expect(mockDbWrite.model.update).not.toHaveBeenCalled();
  });

  it('refuses a non-moderator Public to Private change on a published model', async () => {
    mockStored({ availability: Availability.Public });

    await expect(
      upsert({ id: MODEL_ID, userId: OWNER_ID, availability: Availability.Private, sfwOnly: true })
    ).rejects.toThrow(/private/i);
    expect(mockDbWrite.model.update).not.toHaveBeenCalled();
  });

  it('accepts replaying the stored availability on a published model', async () => {
    mockStored({ availability: Availability.Private });

    await upsert({ id: MODEL_ID, userId: OWNER_ID, availability: Availability.Private });

    expect(mockDbWrite.model.update).toHaveBeenCalledTimes(1);
  });

  it('lets a moderator change availability on a published model', async () => {
    mockStored({ availability: Availability.Private });

    await upsert({
      id: MODEL_ID,
      userId: MODERATOR_ID,
      isModerator: true,
      availability: Availability.Public,
    });

    expect(updateData().availability).toBe(Availability.Public);
  });

  it('refuses a non-moderator availability change on a Draft model too', async () => {
    mockStored({ availability: Availability.Public, status: ModelStatus.Draft });

    await expect(
      upsert({ id: MODEL_ID, userId: OWNER_ID, availability: Availability.Private, sfwOnly: true })
    ).rejects.toThrow(/private/i);

    mockStored({ availability: Availability.Private, status: ModelStatus.Draft });

    await expect(
      upsert({ id: MODEL_ID, userId: OWNER_ID, availability: Availability.Public })
    ).rejects.toThrow(/private/i);
    expect(mockDbWrite.model.update).not.toHaveBeenCalled();
  });

  it('refuses a non-moderator Private create', async () => {
    await expect(
      upsert({ userId: OWNER_ID, availability: Availability.Private, sfwOnly: true })
    ).rejects.toThrow(/private/i);
    expect(mockDbWrite.model.create).not.toHaveBeenCalled();
  });

  it('lets a moderator create a Private model', async () => {
    mockGetHighestTierSubscription.mockResolvedValue(null);

    await upsert({
      userId: MODERATOR_ID,
      isModerator: true,
      availability: Availability.Private,
      sfwOnly: true,
    });

    expect(createData().availability).toBe(Availability.Private);
  });

  it('leaves a Public create alone', async () => {
    mockGetHighestTierSubscription.mockResolvedValue(null);

    await upsert({ userId: OWNER_ID, availability: Availability.Public });

    expect(createData().availability).toBe(Availability.Public);
  });
});

describe('flag appeals settled by a moderator save', () => {
  it('settles the poi appeal when a moderator turns poi off', async () => {
    mockStored({ poi: true });

    await upsert({ id: MODEL_ID, userId: MODERATOR_ID, isModerator: true, poi: false });

    expect(mockSettleAppeals).toHaveBeenCalledWith({
      modelId: MODEL_ID,
      userId: MODERATOR_ID,
      liftedLabels: ['poi'],
    });
    expect(mockSettleAppeals.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockDbWrite.model.update.mock.invocationCallOrder[0]
    );
  });

  it('names every label the save lifted', async () => {
    mockStored({ poi: true, minor: true });

    await upsert({
      id: MODEL_ID,
      userId: MODERATOR_ID,
      isModerator: true,
      poi: false,
      minor: false,
    });

    expect(mockSettleAppeals).toHaveBeenCalledWith(
      expect.objectContaining({ liftedLabels: ['minor', 'poi'] })
    );
  });

  it('settles nothing when no flag went from set to unset', async () => {
    mockStored({ poi: true });
    await upsert({ id: MODEL_ID, userId: MODERATOR_ID, isModerator: true, poi: true });
    mockStored({ poi: false });
    await upsert({ id: MODEL_ID, userId: MODERATOR_ID, isModerator: true, poi: false });

    expect(mockSettleAppeals).not.toHaveBeenCalled();
  });

  it('settles nothing for a flag the moderator did not set, even if another path cleared it', async () => {
    mockStored({ poi: true });

    await upsert({ id: MODEL_ID, userId: MODERATOR_ID, isModerator: true });

    expect(mockSettleAppeals).not.toHaveBeenCalled();
  });

  it('never settles for the owner, whose locks keep the flag in force', async () => {
    mockStored({ poi: true, lockedProperties: ['poi'] });

    await upsert({ id: MODEL_ID, userId: OWNER_ID, poi: false });

    expect(mockSettleAppeals).not.toHaveBeenCalled();
  });
});

describe('merge permissions on save', () => {
  it('stores "different permissions" off when the owner saves with merges off', async () => {
    mockStored({ allowDerivatives: true, allowDifferentLicense: true } as Partial<
      typeof storedModel
    >);

    await upsert({
      id: MODEL_ID,
      userId: OWNER_ID,
      allowDerivatives: false,
      allowDifferentLicense: true,
    });

    expect(updateData()).toMatchObject({ allowDerivatives: false, allowDifferentLicense: false });
  });

  it('does the same on create', async () => {
    await upsert({ userId: OWNER_ID, allowDerivatives: false, allowDifferentLicense: true });

    expect(createData()).toMatchObject({ allowDerivatives: false, allowDifferentLicense: false });
  });

  it('control: keeps it on while merges are allowed', async () => {
    mockStored({ allowDerivatives: false, allowDifferentLicense: false } as Partial<
      typeof storedModel
    >);

    await upsert({
      id: MODEL_ID,
      userId: OWNER_ID,
      allowDerivatives: true,
      allowDifferentLicense: true,
    });

    expect(updateData()).toMatchObject({ allowDerivatives: true, allowDifferentLicense: true });
  });
});
