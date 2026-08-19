import { describe, it, expect, vi, beforeEach } from 'vitest';

// upsertModel has a very large import graph; stub its transitive service/db/search
// dependencies the same way model-locked-properties.service.test.ts does.
//
// This suite's job is narrower than that file's: prove the create AND update branches
// of the real upsertModel actually call `submitModelTextModeration` with the right
// arguments. model-moderation.submit.test.ts exercises that function in isolation and
// never touches upsertModel, so deleting either call site changed zero assertions
// anywhere in the suite — this file is what makes a revert fail loudly.

const { mockEvaluateContent } = vi.hoisted(() => ({ mockEvaluateContent: vi.fn() }));

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
// Wholesale, not spread via importOriginal: the real module pulls in nsfwLevels.service
// and text-moderation.service -> orchestrator.service, the latter of which constructs an
// orchestrator SDK client at module scope. Same accepted exception CLAUDE.md documents for
// nsfwLevels.service in model-moderation.submit.test.ts. Not in no-wholesale-module-mock's
// configured module set (only ~/utils/trpc), so this doesn't trip that guard either.
vi.mock('~/server/services/model-moderation.adapter', () => ({
  // Resolved, not a bare vi.fn(): the real function is async, and upsertModel calls
  // `.catch()` on its return value — an unresolved mock throws at that call site.
  submitModelTextModeration: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/services/model-version.service', () => ({
  bustMvCache: vi.fn(),
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
import { submitModelTextModeration } from '~/server/services/model-moderation.adapter';
import type { ModelUpsertInput } from '~/server/schema/model.schema';
import { ModelStatus, ModelType, ModelUploadType } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';

const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;

const OWNER_ID = 101;
const MODEL_ID = 42;

const cleanEvaluation = {
  shouldMarkNSFW: false,
  reason: 'No profanity detected',
  suggestedLevel: 1,
  metrics: { matchCount: 0, uniqueWords: 0, totalWords: 2, density: 0 },
  matchedWords: [] as string[],
};

const storedModel = {
  name: 'Old Name',
  description: 'Old description',
  poi: false,
  userId: OWNER_ID,
  minor: false,
  sfwOnly: false,
  nsfw: false,
  lockedProperties: [] as string[],
  gallerySettings: { level: 1, users: [] as number[], tags: [] as number[] },
  meta: null as Record<string, unknown> | null,
};

const baseInput = {
  type: ModelType.Checkpoint,
  uploadType: ModelUploadType.Created,
  // Draft keeps applyModelFlagSideEffects's ingest/search-index side effects out of the
  // update path so this scaffold's mocked collaborators stay untouched.
  status: ModelStatus.Draft,
} satisfies Partial<ModelUpsertInput>;

function upsert(input: Partial<ModelUpsertInput> & { userId: number; isModerator?: boolean }) {
  return upsertModel({ ...baseInput, ...input } as Parameters<typeof upsertModel>[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEvaluateContent.mockReturnValue(cleanEvaluation);
  mockDbRead.model.findUnique.mockResolvedValue(storedModel);
  mockDbWrite.modelVersion.findMany.mockResolvedValue([]);
  mockDbWrite.$queryRaw.mockResolvedValue([]);
});

describe('upsertModel — wires into submitModelTextModeration', () => {
  it('create branch: submits the persisted id with the create input name/description', async () => {
    mockDbWrite.model.create.mockResolvedValue({
      id: 555,
      nsfwLevel: 1,
      meta: null,
      availability: 'Public',
    });

    await upsert({ userId: OWNER_ID, name: 'New Model', description: 'A fresh description' });

    expect(submitModelTextModeration).toHaveBeenCalledTimes(1);
    expect(submitModelTextModeration).toHaveBeenCalledWith({
      id: 555,
      name: 'New Model',
      description: 'A fresh description',
    });
  });

  it('update branch: submits the POST-update name/description, not the stored pre-update ones', async () => {
    mockDbWrite.model.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({
        id: MODEL_ID,
        name: 'New Name',
        description: 'New description',
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

    await upsert({
      id: MODEL_ID,
      userId: OWNER_ID,
      name: 'New Name',
      description: 'New description',
    });

    expect(submitModelTextModeration).toHaveBeenCalledTimes(1);
    expect(submitModelTextModeration).toHaveBeenCalledWith({
      id: MODEL_ID,
      name: 'New Name',
      description: 'New description',
    });
    expect(submitModelTextModeration).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Old Name' })
    );
  });

  // IMPORTANT 1 — upsertModel already destructures `isModerator` out of `input` for
  // enforceLockedProperties and the profanity branch; this proves it also reaches the
  // submit call rather than staying only on those two older paths.
  it('update branch: threads isModerator through to submitModelTextModeration', async () => {
    mockDbWrite.model.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({
        id: MODEL_ID,
        name: 'New Name',
        description: 'New description',
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

    await upsert({
      id: MODEL_ID,
      userId: OWNER_ID,
      isModerator: true,
      name: 'New Name',
      description: 'New description',
    });

    expect(submitModelTextModeration).toHaveBeenCalledWith(
      expect.objectContaining({ isModerator: true })
    );
  });
});
