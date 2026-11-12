import { describe, it, expect, vi, beforeEach } from 'vitest';

// Same stub set as upsert-model-coverage-cache-bust.service.test.ts — upsertModel's transitive import graph
// reaches db, search, redis and the orchestrator client, none of which this suite exercises.
vi.mock('~/libs/profanity-simple', () => ({
  createProfanityFilter: () => ({ evaluateContent: () => cleanEvaluation }),
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
  queueImageSearchIndexUpdate: vi.fn(),
}));
vi.mock('~/server/services/model-file.service', () => ({ getFilesForModelVersionCache: {} }));
// Wholesale for the same reason model-moderation.upsert-wiring.test.ts documents: the real module
// reaches text-moderation.service -> orchestrator.service, which builds an SDK client at import.
vi.mock('~/server/services/model-moderation.adapter', () => ({
  submitModelTextModeration: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/services/model-version.service', () => ({
  bustMvCache: vi.fn().mockResolvedValue(undefined),
  bustPublicModelResponseCache: vi.fn(),
  createModelVersionPostFromTraining: vi.fn(),
  publishModelVersionsWithEarlyAccess: vi.fn(),
}));
vi.mock('~/server/services/moderator.service', () => ({ trackModActivity: vi.fn() }));
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

import { upsertModel } from '~/server/services/model.service';
import type { ModelUpsertInput } from '~/server/schema/model.schema';
import {
  Availability,
  CommercialUse,
  ModelStatus,
  ModelType,
  ModelUploadType,
} from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';

const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;

const OWNER_ID = 101;
const MODEL_ID = 42;
const VERSION_IDS = [900, 901];

const cleanEvaluation = {
  shouldMarkNSFW: false,
  reason: 'No profanity detected',
  suggestedLevel: 1,
  metrics: { matchCount: 0, uniqueWords: 0, totalWords: 2, density: 0 },
  matchedWords: [] as string[],
};

const storedModel = {
  name: 'A Model',
  description: 'A description',
  poi: false,
  userId: OWNER_ID,
  minor: false,
  sfwOnly: false,
  nsfw: false,
  lockedProperties: [] as string[],
  gallerySettings: { level: 1, users: [] as number[], tags: [] as number[] },
  meta: null as Record<string, unknown> | null,
  availability: Availability.Public,
  mode: null,
  allowNoCredit: true,
  allowCommercialUse: [CommercialUse.Sell],
  allowDerivatives: true,
  allowDifferentLicense: true,
  type: ModelType.LORA,
  uploadType: ModelUploadType.Created,
  createdAt: new Date('2025-01-01T00:00:00Z'),
};

const baseInput = {
  id: MODEL_ID,
  userId: OWNER_ID,
  name: storedModel.name,
  description: storedModel.description,
  type: storedModel.type,
  uploadType: storedModel.uploadType,
  status: ModelStatus.Published,
  availability: storedModel.availability,
  allowCommercialUse: storedModel.allowCommercialUse,
} satisfies Partial<ModelUpsertInput> & { userId: number };

function upsert(input: Partial<ModelUpsertInput> = {}) {
  return upsertModel({ ...baseInput, ...input } as Parameters<typeof upsertModel>[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDbWrite.model.findUnique.mockResolvedValue(storedModel);
  mockDbWrite.modelVersion.findMany.mockResolvedValue(VERSION_IDS.map((id) => ({ id })));
  mockDbWrite.$queryRaw.mockResolvedValue([]);
  mockDbWrite.model.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({
      id: MODEL_ID,
      nsfwLevel: 1,
      poi: false,
      minor: false,
      sfwOnly: false,
      nsfw: false,
      gallerySettings: storedModel.gallerySettings,
      status: ModelStatus.Published,
      meta: null,
      availability: Availability.Public,
      ...data,
      name: storedModel.name,
      description: storedModel.description,
    })
  );
});

const MATURE_REFUSAL = 'Models marked as mature content cannot use this base model.';
const liveGatedVersion = (found: boolean) =>
  mockDbWrite.modelVersion.findFirst.mockImplementation((async ({
    where,
  }: {
    where: { status?: { in?: string[] }; baseModel?: { in?: string[] } };
  }) =>
    found &&
    where.status?.in?.includes(ModelStatus.Published) &&
    where.baseModel?.in?.includes('Fibo 2.0')
      ? { id: VERSION_IDS[0] }
      : null) as never);

// The gate judged a live version of a review-required base model as not mature.
describe('upsertModel — the mature flag on a model with a live gated version', () => {
  it('refuses an owner marking it mature', async () => {
    liveGatedVersion(true);
    await expect(upsert({ nsfw: true })).rejects.toThrow(MATURE_REFUSAL);
    expect(mockDbWrite.model.update).not.toHaveBeenCalled();
  });

  it('lets a moderator mark it mature', async () => {
    liveGatedVersion(true);
    await upsert({ nsfw: true, isModerator: true } as Partial<ModelUpsertInput>);
    expect(mockDbWrite.model.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ nsfw: true }) })
    );
  });

  it('lets an owner mark a model with no live gated version mature (control)', async () => {
    liveGatedVersion(false);
    await upsert({ nsfw: true });
    expect(mockDbWrite.model.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ nsfw: true }) })
    );
  });

  it('lets an owner save an already-mature model (control)', async () => {
    liveGatedVersion(true);
    mockDbWrite.model.findUnique.mockResolvedValue({ ...storedModel, nsfw: true });
    await expect(upsert({ nsfw: true })).resolves.toBeTruthy();
  });
});
