import { describe, it, expect, vi, beforeEach } from 'vitest';

// upsertModel must re-check its versions' licensing lineage when the model's TYPE changes.
// A version inherits a per-image licence fee from a LicensingRoot, every root is a Checkpoint, and
// the type stays editable after the versions exist — so a version stamped while the model was a
// Checkpoint went on charging that checkpoint's fee once the model became a LoRA (CU 868kwf2fd).
// model.service.ts has a very large import graph, so its transitive dependencies are stubbed below;
// the scaffold mirrors model-locked-properties.service.test.ts.

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

import { upsertModel } from '~/server/services/model.service';
import type { ModelUpsertInput } from '~/server/schema/model.schema';
import { ModelStatus, ModelType, ModelUploadType } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;

const OWNER_ID = 101;
const MODEL_ID = 42;
const VERSION_ID = 3144879;
const ANIMA_ROOT_VERSION_ID = 2945208;

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
  type: ModelType.Checkpoint,
};

const entityChanges = vi.fn(() => Promise.resolve());

function upsert(input: Partial<ModelUpsertInput> & { userId: number }) {
  return upsertModel({
    name: 'Test Model',
    description: 'A description',
    uploadType: ModelUploadType.Created,
    status: ModelStatus.Draft,
    tracker: { entityChanges } as never,
    ...input,
  } as Parameters<typeof upsertModel>[0]);
}

function stampedVersions(
  rows: { id: number; baseModel: string; licensingSourceVersionId: number }[]
) {
  mockDbWrite.modelVersion.findMany.mockResolvedValue(rows);
}

function licensingRoots(
  rows: { modelVersionId: number; baseModel: string; modelType: ModelType }[]
) {
  mockDbWrite.licensingRoot.findMany.mockResolvedValue(rows);
}

/** Only the ModelVersion rows — the Model-level tracker call always fires, empty or not. */
function versionAuditRows() {
  return entityChanges.mock.calls
    .flatMap((call) => call[0] as Record<string, unknown>[])
    .filter((row) => row.entityType === 'ModelVersion');
}

function clearCall() {
  return mockDbWrite.modelVersion.updateMany.mock.calls[0]?.[0] as
    | { where: { id: { in: number[] } }; data: Record<string, unknown> }
    | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEvaluateContent.mockReturnValue({
    shouldMarkNSFW: false,
    reason: 'No profanity detected',
    suggestedLevel: 1,
    metrics: { matchCount: 0, uniqueWords: 0, totalWords: 2, density: 0 },
    matchedWords: [] as string[],
  });
  mockGetHighestTierSubscription.mockResolvedValue({ tier: 'gold' });
  mockDbRead.model.findUnique.mockResolvedValue(storedModel);
  mockDbRead.model.count.mockResolvedValue(0);
  mockDbWrite.$queryRaw.mockResolvedValue([]);
  stampedVersions([]);
  licensingRoots([]);
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

describe('upsertModel — licensing lineage on a model type change', () => {
  it('clears a checkpoint root off the versions when the model becomes a LoRA', async () => {
    stampedVersions([
      { id: VERSION_ID, baseModel: 'Anima', licensingSourceVersionId: ANIMA_ROOT_VERSION_ID },
    ]);
    licensingRoots([
      {
        modelVersionId: ANIMA_ROOT_VERSION_ID,
        baseModel: 'Anima',
        modelType: ModelType.Checkpoint,
      },
    ]);

    await upsert({ id: MODEL_ID, userId: OWNER_ID, type: ModelType.LORA });

    // Asserted on the ARGUMENT, not on a returned row. The db mock ignores `data` and echoes the
    // payload back, so a repair that wrote the wrong column — or wrote nothing — returns a result
    // indistinguishable from a correct one.
    expect(clearCall()).toEqual({
      where: { id: { in: [VERSION_ID] } },
      data: { licensingSourceVersionId: null },
    });
  });

  it('keeps a root the new type still supports', async () => {
    stampedVersions([
      { id: VERSION_ID, baseModel: 'Anima', licensingSourceVersionId: ANIMA_ROOT_VERSION_ID },
    ]);
    licensingRoots([
      {
        modelVersionId: ANIMA_ROOT_VERSION_ID,
        baseModel: 'Anima',
        modelType: ModelType.Checkpoint,
      },
    ]);

    await upsert({ id: MODEL_ID, userId: OWNER_ID, type: ModelType.Checkpoint });

    expect(mockDbWrite.modelVersion.updateMany).not.toHaveBeenCalled();
  });

  it('clears a root whose base model no longer matches the version', async () => {
    stampedVersions([
      { id: VERSION_ID, baseModel: 'Flux.1 D', licensingSourceVersionId: ANIMA_ROOT_VERSION_ID },
    ]);
    licensingRoots([
      {
        modelVersionId: ANIMA_ROOT_VERSION_ID,
        baseModel: 'Anima',
        modelType: ModelType.Checkpoint,
      },
    ]);

    await upsert({ id: MODEL_ID, userId: OWNER_ID, type: ModelType.Checkpoint });

    expect(clearCall()?.where).toEqual({ id: { in: [VERSION_ID] } });
  });

  it('clears a source that is not a registered root at all', async () => {
    stampedVersions([{ id: VERSION_ID, baseModel: 'Anima', licensingSourceVersionId: 999999 }]);
    licensingRoots([]);

    await upsert({ id: MODEL_ID, userId: OWNER_ID, type: ModelType.Checkpoint });

    expect(clearCall()?.where).toEqual({ id: { in: [VERSION_ID] } });
  });

  // The `where` filters these out, but a Prisma mock does not apply a `where` — and neither would a
  // future caller that hands this helper a wider row set. A version with no source has nothing to
  // repair, and counting one as repaired emits an audit row and a cache bust for a change that
  // never happened.
  it('ignores versions that carry no licensing source', async () => {
    mockDbWrite.modelVersion.findMany.mockResolvedValue([
      { id: 900, baseModel: 'Anima', licensingSourceVersionId: null },
      { id: 901, baseModel: 'Anima', licensingSourceVersionId: null },
    ]);
    licensingRoots([]);

    await upsert({ id: MODEL_ID, userId: OWNER_ID, type: ModelType.LORA });

    expect(mockDbWrite.modelVersion.updateMany).not.toHaveBeenCalled();
    expect(versionAuditRows()).toEqual([]);
  });

  // Named for the decision: the repair is attributed to the RULE, not to the creator, who changed a
  // type and never touched a fee. Drop the attribution and the first rows this audit trail ever
  // produces for the field are automated repairs wearing an owner's name.
  it('attributes the cleared source to the rule, not to the owner', async () => {
    stampedVersions([
      { id: VERSION_ID, baseModel: 'Anima', licensingSourceVersionId: ANIMA_ROOT_VERSION_ID },
    ]);
    licensingRoots([
      {
        modelVersionId: ANIMA_ROOT_VERSION_ID,
        baseModel: 'Anima',
        modelType: ModelType.Checkpoint,
      },
    ]);

    await upsert({ id: MODEL_ID, userId: OWNER_ID, type: ModelType.LORA });

    expect(versionAuditRows()).toEqual([
      expect.objectContaining({
        entityId: VERSION_ID,
        field: 'licensingSourceVersionId',
        oldValue: String(ANIMA_ROOT_VERSION_ID),
        newValue: 'null',
        actorRole: 'system',
        reason: 'model-type-changed',
      }),
    ]);
  });
});
