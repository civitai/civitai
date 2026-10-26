import { describe, it, expect, vi, beforeEach } from 'vitest';

// The attestation gate at the model.service paths that publish versions or change a model's type.
// Scaffold copied from model-licensing-source-on-type-change.test.ts.

const {
  mockEvaluateContent,
  mockThrowOnBlockedLinkDomain,
  mockThrowOnBlockedUserContent,
  mockGetHighestTierSubscription,
} = vi.hoisted(() => ({
  mockEvaluateContent: vi.fn(),
  mockThrowOnBlockedLinkDomain: vi.fn(),
  mockThrowOnBlockedUserContent: vi.fn(),
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
  throwOnBlockedUserContent: mockThrowOnBlockedUserContent,
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
  bustMvCache: vi.fn(() => Promise.resolve()),
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
  publishModelById,
  publishPrivateModel,
  upsertModel,
} from '~/server/services/model.service';
import { buildBaseModelAttestation } from '~/shared/constants/base-model-attestation.constants';
import { ModelStatus, ModelType, ModelUploadType } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;

const H3 = 'MiniMax H3';
const OWNER_ID = 7;
const MODEL_ID = 42;
const VERSION_ID = 100;
const attestedMeta = () => ({ baseModelAttestation: buildBaseModelAttestation(OWNER_ID, H3) });

const versionRow = (overrides: Record<string, unknown> = {}) => ({
  id: VERSION_ID,
  baseModel: H3,
  publishedAt: null as Date | null,
  status: ModelStatus.Draft,
  meta: {} as unknown,
  licensingSourceVersionId: null,
  model: { type: ModelType.LORA, userId: OWNER_ID },
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGetHighestTierSubscription.mockResolvedValue({ tier: 'gold' });
  mockEvaluateContent.mockReturnValue({
    shouldMarkNSFW: false,
    reason: 'No profanity detected',
    suggestedLevel: 1,
    metrics: { matchCount: 0, uniqueWords: 0, totalWords: 2, density: 0 },
    matchedWords: [] as string[],
  });
  mockDbWrite.$transaction.mockRejectedValue(new Error('reached the transaction'));
});

describe('publishModelById — H3 attestation', () => {
  const publish = () => publishModelById({ id: MODEL_ID, versionIds: [VERSION_ID] });

  it('refuses an unattested H3 LoRA before the transaction', async () => {
    mockDbWrite.modelVersion.findMany.mockResolvedValue([versionRow()]);

    await expect(publish()).rejects.toThrowError(/right to train and share/);
    expect(mockDbWrite.$transaction).not.toHaveBeenCalled();
  });

  it('lets an attested one through', async () => {
    mockDbWrite.modelVersion.findMany.mockResolvedValue([versionRow({ meta: attestedMeta() })]);

    await expect(publish()).rejects.toThrowError('reached the transaction');
  });

  it('lets a non-H3 LoRA through without one (control)', async () => {
    mockDbWrite.modelVersion.findMany.mockResolvedValue([versionRow({ baseModel: 'SDXL 1.0' })]);

    await expect(publish()).rejects.toThrowError('reached the transaction');
  });

  it('grandfathers a version that was public before (a republish)', async () => {
    mockDbWrite.modelVersion.findMany.mockResolvedValue([
      versionRow({ publishedAt: new Date('2026-09-01') }),
    ]);

    await expect(publish()).rejects.toThrowError('reached the transaction');
  });
});

describe('publishPrivateModel — H3 attestation', () => {
  beforeEach(() => {
    mockDbWrite.model.findUnique.mockResolvedValue({
      id: MODEL_ID,
      userId: OWNER_ID,
      name: 'model',
      description: '',
      availability: 'Private',
      status: ModelStatus.Published,
      meta: {},
      type: ModelType.LORA,
    });
    // The showcase-post check is the next step after the gate.
    mockDbWrite.post.findMany.mockRejectedValue(new Error('reached the post check'));
  });
  const goPublic = () => publishPrivateModel({ modelId: MODEL_ID, publishVersions: true });

  it('refuses an unattested H3 LoRA going public, though its private publish set publishedAt', async () => {
    mockDbWrite.modelVersion.findMany.mockResolvedValue([
      versionRow({ status: ModelStatus.Published, publishedAt: new Date('2026-09-01') }),
    ]);

    await expect(goPublic()).rejects.toThrowError(/right to train and share/);
    expect(mockDbWrite.post.findMany).not.toHaveBeenCalled();
  });

  it('lets an attested one through', async () => {
    mockDbWrite.modelVersion.findMany.mockResolvedValue([
      versionRow({ status: ModelStatus.Published, meta: attestedMeta() }),
    ]);

    await expect(goPublic()).rejects.toThrowError('reached the post check');
  });

  it('lets a non-H3 model through (control)', async () => {
    mockDbWrite.modelVersion.findMany.mockResolvedValue([
      versionRow({ status: ModelStatus.Published, baseModel: 'SDXL 1.0' }),
    ]);

    await expect(goPublic()).rejects.toThrowError('reached the post check');
  });
});

describe('upsertModel — a type change into scope', () => {
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
    meta: null,
    availability: 'Public',
    status: ModelStatus.Published,
    type: ModelType.Workflows,
  };
  const changeType = (type: ModelType) =>
    upsertModel({
      id: MODEL_ID,
      userId: OWNER_ID,
      name: 'Test Model',
      description: 'A description',
      uploadType: ModelUploadType.Created,
      status: ModelStatus.Published,
      type,
    } as Parameters<typeof upsertModel>[0]);

  beforeEach(() => {
    mockDbWrite.model.findUnique.mockResolvedValue(storedModel);
    mockDbRead.model.count.mockResolvedValue(0);
    mockDbWrite.$queryRaw.mockResolvedValue([]);
    mockDbWrite.licensingRoot.findMany.mockResolvedValue([]);
  });

  it('refuses turning a model with a published H3 version into a LoRA without the attestation', async () => {
    mockDbWrite.modelVersion.findMany.mockResolvedValue([
      versionRow({ status: ModelStatus.Published, publishedAt: new Date('2026-09-01') }),
    ]);

    await expect(changeType(ModelType.LORA)).rejects.toThrowError(/right to train and share/);
    expect(mockDbWrite.model.update).not.toHaveBeenCalled();
  });

  it('lets an attested version through', async () => {
    mockDbWrite.modelVersion.findMany.mockResolvedValue([
      versionRow({
        status: ModelStatus.Published,
        publishedAt: new Date('2026-09-01'),
        meta: attestedMeta(),
      }),
    ]);

    await expect(changeType(ModelType.LORA)).rejects.not.toThrowError(/right to train and share/);
  });

  it('lets a type change that stays out of scope through (control)', async () => {
    mockDbWrite.modelVersion.findMany.mockResolvedValue([
      versionRow({ status: ModelStatus.Published, publishedAt: new Date('2026-09-01') }),
    ]);

    await expect(changeType(ModelType.Other)).rejects.not.toThrowError(/right to train and share/);
  });
});
