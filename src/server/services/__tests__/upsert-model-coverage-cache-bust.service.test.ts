import { describe, it, expect, vi, beforeEach } from 'vitest';

// Same stub set as model-moderation.upsert-wiring.test.ts — upsertModel's transitive import graph
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
import { bustMvCache } from '~/server/services/model-version.service';
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
  mockDbRead.model.findUnique.mockResolvedValue(storedModel);
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

// The whole point of the fix: GenerationCoverage flips the moment allowCommercialUse gains
// RentCivit, but the orchestrator keeps serving its own cached record and 400s the generation with
// "not enabled for generation". Deleting the bust changes no other assertion in the suite.
describe('upsertModel — busts version caches when generation coverage can change', () => {
  it('busts for the whole model when the creator adds RentCivit', async () => {
    await upsert({ allowCommercialUse: [CommercialUse.Rent, CommercialUse.RentCivit] });

    expect(bustMvCache).toHaveBeenCalledTimes(1);
    expect(bustMvCache).toHaveBeenCalledWith(VERSION_IDS, MODEL_ID, OWNER_ID);
  });

  it('busts when availability changes', async () => {
    await upsert({ availability: Availability.Private });

    expect(bustMvCache).toHaveBeenCalledWith(VERSION_IDS, MODEL_ID, OWNER_ID);
  });

  it('does not bust on an edit that cannot move coverage', async () => {
    await upsert({ name: 'A renamed model' });

    expect(bustMvCache).not.toHaveBeenCalled();
  });

  // The form round-trips the permission array, and its order is not stable. Comparing raw values
  // would bust on every single save of every model, which is a bust per version per save against
  // the orchestrator.
  it('does not bust when allowCommercialUse is resubmitted in a different order', async () => {
    mockDbRead.model.findUnique.mockResolvedValue({
      ...storedModel,
      allowCommercialUse: [CommercialUse.Rent, CommercialUse.RentCivit],
    });

    await upsert({ allowCommercialUse: [CommercialUse.RentCivit, CommercialUse.Rent] });

    expect(bustMvCache).not.toHaveBeenCalled();
  });

  it('skips the bust when the model has no versions', async () => {
    mockDbWrite.modelVersion.findMany.mockResolvedValue([]);

    await upsert({ allowCommercialUse: [CommercialUse.RentCivit] });

    expect(bustMvCache).not.toHaveBeenCalled();
  });

  // The row is already committed by the time this runs, so a cache failure must not surface as a
  // failed save. bustMvCache itself rejects if resourceDataCache does.
  it('does not fail the save when the bust rejects', async () => {
    vi.mocked(bustMvCache).mockRejectedValueOnce(new Error('redis down'));

    await expect(upsert({ allowCommercialUse: [CommercialUse.RentCivit] })).resolves.toBeTruthy();
  });
});
