import { describe, it, expect, vi, beforeEach } from 'vitest';

// The non-commercial monetization guard at the model.service paths that publish versions. Scaffold
// copied from model.base-model-attestation.service.test.ts.

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

import { publishModelById, publishPrivateModel } from '~/server/services/model.service';
import { ModelStatus, ModelType } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;

const OWNER_ID = 7;
const MODEL_ID = 42;
const FREE_9B = 100;
const CHARGED_9B = 101;
const CHARGED_4B = 102;
const NON_COMMERCIAL = /non-commercial/;

const versions = [
  { id: FREE_9B, baseModel: 'Flux.2 Klein 9B' },
  { id: CHARGED_9B, baseModel: 'Flux.2 Klein 9B-base' },
  { id: CHARGED_4B, baseModel: 'Flux.2 Klein 4B' },
].map((v) => ({
  ...v,
  publishedAt: null,
  status: ModelStatus.Published,
  meta: {},
  licensingSourceVersionId: null,
  model: { type: ModelType.LORA, userId: OWNER_ID },
}));

// One findMany serves both the publish's own version read and the guard's fee read; the fee read is
// told apart by its licensingFee filter and answers with the charged versions among the ids it asked
// about, so a guard that asks about the wrong versions reads nothing.
const seedVersions = (ids: number[], charged: number[]) => {
  mockDbWrite.modelVersion.findMany.mockImplementation((async (args: {
    where?: { id?: { in?: number[] }; licensingFee?: unknown };
  }) => {
    const asked = args?.where?.id?.in ?? ids;
    if (args?.where?.licensingFee)
      return charged.filter((id) => asked.includes(id)).map((id) => ({ id }));
    return versions.filter((v) => ids.includes(v.id));
  }) as never);
  mockDbWrite.paidAccess.findMany.mockResolvedValue([]);
};

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

describe('publishModelById — stored charges on a non-commercial base model', () => {
  const publish = (versionIds: number[]) => publishModelById({ id: MODEL_ID, versionIds });

  it('refuses when one 9B version in the batch stores a fee', async () => {
    seedVersions([FREE_9B, CHARGED_9B, CHARGED_4B], [CHARGED_9B, CHARGED_4B]);

    await expect(publish([FREE_9B, CHARGED_9B, CHARGED_4B])).rejects.toThrowError(
      /Flux.2 Klein 9B-base.*non-commercial/
    );
    expect(mockDbWrite.$transaction).not.toHaveBeenCalled();
  });

  it('publishes a free 9B version alongside a charged 4B one (control)', async () => {
    seedVersions([FREE_9B, CHARGED_4B], [CHARGED_4B]);

    await expect(publish([FREE_9B, CHARGED_4B])).rejects.toThrowError('reached the transaction');
  });
});

describe('publishPrivateModel — stored charges on a non-commercial base model', () => {
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
    // The showcase-post check is the next step after the guard.
    mockDbWrite.post.findMany.mockRejectedValue(new Error('reached the post check'));
  });
  const goPublic = () => publishPrivateModel({ modelId: MODEL_ID, publishVersions: true });

  it('refuses a private model going public with a charged 9B version', async () => {
    seedVersions([CHARGED_9B, CHARGED_4B], [CHARGED_9B, CHARGED_4B]);

    await expect(goPublic()).rejects.toThrowError(NON_COMMERCIAL);
    expect(mockDbWrite.post.findMany).not.toHaveBeenCalled();
  });

  it('lets a charged 4B model go public (control)', async () => {
    seedVersions([CHARGED_4B], [CHARGED_4B]);

    await expect(goPublic()).rejects.toThrowError('reached the post check');
  });
});
