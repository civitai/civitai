import { describe, it, expect, vi, beforeEach } from 'vitest';

// model.service.ts has a very large import graph; scaffold mirrors
// model-locked-properties.service.test.ts.

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
import { bustMvCache } from '~/server/services/model-version.service';
import { preventModelVersionLagBatch } from '~/server/db/db-lag-helpers';
import type { ModelUpsertInput } from '~/server/schema/model.schema';
import { ModelStatus, ModelType, ModelUploadType } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;

const OWNER_ID = 101;
const MODEL_ID = 42;
const VERSION_ID = 3144879;
const OTHER_VERSION_ID = 3144880;
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

/**
 * The type the WRITER reports before the update. Read inside the transaction, so it is a separate
 * call from `dbRead.model.findUnique` and has to be declared separately.
 */
function storedTypeOnWriter(type: ModelType) {
  mockDbWrite.model.findUnique.mockResolvedValue({ type });
}

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
  rows: { id: number; baseModel: string; licensingSourceVersionId: number | null }[]
) {
  mockDbWrite.modelVersion.findMany.mockResolvedValue(rows);
}

function licensingRoots(
  rows: { modelVersionId: number; baseModel: string; modelType: ModelType }[]
) {
  mockDbWrite.licensingRoot.findMany.mockResolvedValue(rows);
}

const animaCheckpointRoot = {
  modelVersionId: ANIMA_ROOT_VERSION_ID,
  baseModel: 'Anima',
  modelType: ModelType.Checkpoint,
};

/** Only the ModelVersion rows — the Model-level tracker call always fires, empty or not. */
function versionAuditRows() {
  return entityChanges.mock.calls
    .flatMap((call) => call[0] as unknown as Record<string, unknown>[])
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
  storedTypeOnWriter(ModelType.Checkpoint);
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
    licensingRoots([animaCheckpointRoot]);

    await upsert({ id: MODEL_ID, userId: OWNER_ID, type: ModelType.LORA });

    // Assert the ARGUMENT: the db mock echoes the payload back, so a repair that wrote the wrong
    // column, or nothing, returns a result indistinguishable from a correct one.
    expect(clearCall()).toEqual({
      where: { id: { in: [VERSION_ID] } },
      data: { licensingSourceVersionId: null },
    });
  });

  it('keeps a root the new type supports', async () => {
    storedTypeOnWriter(ModelType.LORA);
    stampedVersions([
      { id: VERSION_ID, baseModel: 'Anima', licensingSourceVersionId: ANIMA_ROOT_VERSION_ID },
    ]);
    licensingRoots([animaCheckpointRoot]);

    await upsert({ id: MODEL_ID, userId: OWNER_ID, type: ModelType.Checkpoint });

    expect(mockDbWrite.modelVersion.updateMany).not.toHaveBeenCalled();
  });

  // Multi-version on purpose: clearing the whole stamped set instead of the failing subset passes
  // every single-version fixture while taking a fee off a version whose root is still valid.
  it('clears only the failing version, not every stamped version on the model', async () => {
    storedTypeOnWriter(ModelType.LORA);
    stampedVersions([
      { id: VERSION_ID, baseModel: 'Anima', licensingSourceVersionId: ANIMA_ROOT_VERSION_ID },
      {
        id: OTHER_VERSION_ID,
        baseModel: 'Krea 2',
        licensingSourceVersionId: ANIMA_ROOT_VERSION_ID,
      },
    ]);
    licensingRoots([animaCheckpointRoot]);

    await upsert({ id: MODEL_ID, userId: OWNER_ID, type: ModelType.Checkpoint });

    expect(clearCall()?.where).toEqual({ id: { in: [OTHER_VERSION_ID] } });
    expect(versionAuditRows()).toHaveLength(1);
  });

  // A rename must not clear anything — see the gate comment in upsertModel.
  it('does not touch lineage on a save that leaves the type alone', async () => {
    storedTypeOnWriter(ModelType.LORA);
    stampedVersions([
      { id: VERSION_ID, baseModel: 'Anima', licensingSourceVersionId: ANIMA_ROOT_VERSION_ID },
    ]);
    licensingRoots([animaCheckpointRoot]);

    await upsert({ id: MODEL_ID, userId: OWNER_ID, type: ModelType.LORA, name: 'Renamed' });

    expect(mockDbWrite.modelVersion.updateMany).not.toHaveBeenCalled();
    expect(versionAuditRows()).toEqual([]);
  });

  it('clears a root whose base model no longer matches the version', async () => {
    stampedVersions([
      { id: VERSION_ID, baseModel: 'Flux.1 D', licensingSourceVersionId: ANIMA_ROOT_VERSION_ID },
    ]);
    licensingRoots([animaCheckpointRoot]);

    await upsert({ id: MODEL_ID, userId: OWNER_ID, type: ModelType.LORA });

    expect(clearCall()?.where).toEqual({ id: { in: [VERSION_ID] } });
  });

  it('clears a source that is not a registered root at all', async () => {
    stampedVersions([{ id: VERSION_ID, baseModel: 'Anima', licensingSourceVersionId: 999999 }]);
    licensingRoots([]);

    await upsert({ id: MODEL_ID, userId: OWNER_ID, type: ModelType.LORA });

    expect(clearCall()?.where).toEqual({ id: { in: [VERSION_ID] } });
  });

  // A Prisma mock does not apply the `where`, and a future caller could hand this a wider set.
  it('ignores versions that carry no licensing source', async () => {
    stampedVersions([
      { id: 900, baseModel: 'Anima', licensingSourceVersionId: null },
      { id: 901, baseModel: 'Anima', licensingSourceVersionId: null },
    ]);
    licensingRoots([]);

    await upsert({ id: MODEL_ID, userId: OWNER_ID, type: ModelType.LORA });

    expect(mockDbWrite.modelVersion.updateMany).not.toHaveBeenCalled();
    expect(versionAuditRows()).toEqual([]);
  });

  // The clear is attributed to the rule, not the owner.
  it('attributes the cleared source to the rule, not to the owner', async () => {
    stampedVersions([
      { id: VERSION_ID, baseModel: 'Anima', licensingSourceVersionId: ANIMA_ROOT_VERSION_ID },
    ]);
    licensingRoots([animaCheckpointRoot]);

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

  // Mixed on purpose: `type` is in `coverageModelFields`, so a type change already busts every
  // version id below. Only the cleared SUBSET distinguishes that call from this one.
  it('busts the version caches for the versions it cleared', async () => {
    storedTypeOnWriter(ModelType.LORA);
    stampedVersions([
      { id: VERSION_ID, baseModel: 'Anima', licensingSourceVersionId: ANIMA_ROOT_VERSION_ID },
      {
        id: OTHER_VERSION_ID,
        baseModel: 'Krea 2',
        licensingSourceVersionId: ANIMA_ROOT_VERSION_ID,
      },
    ]);
    licensingRoots([animaCheckpointRoot]);

    await upsert({ id: MODEL_ID, userId: OWNER_ID, type: ModelType.Checkpoint });

    expect(bustMvCache).toHaveBeenCalledWith([OTHER_VERSION_ID], MODEL_ID, OWNER_ID);
    // Order, not just presence: bust first and the replica refills the same caches pre-clear.
    expect(preventModelVersionLagBatch).toHaveBeenCalledWith(MODEL_ID, [OTHER_VERSION_ID]);
    expect(
      (preventModelVersionLagBatch as unknown as { mock: { invocationCallOrder: number[] } }).mock
        .invocationCallOrder[0]
    ).toBeLessThan(
      (bustMvCache as unknown as { mock: { invocationCallOrder: number[] } }).mock
        .invocationCallOrder[0]
    );
  });

  // 🔴 The only assertion pinning the repair to the TRANSACTION. The shared db mock returns the
  // same client as `tx`, so lifting the block out of the callback is invisible to every other test
  // here. This one passes its own tx object and fails if the write lands on `dbWrite`.
  it('does the clearing inside the model-update transaction', async () => {
    stampedVersions([
      { id: VERSION_ID, baseModel: 'Anima', licensingSourceVersionId: ANIMA_ROOT_VERSION_ID },
    ]);
    licensingRoots([animaCheckpointRoot]);

    const calledOnTx: string[] = [];
    mockDbWrite.$transaction.mockImplementation(async (arg: unknown) => {
      if (typeof arg !== 'function') return undefined;
      const tx: unknown = new Proxy(
        {},
        {
          get(_t, model: string) {
            return new Proxy(
              {},
              {
                get(_m, method: string) {
                  return (...args: unknown[]) => {
                    calledOnTx.push(`${model}.${method}`);
                    return (
                      mockDbWrite as unknown as Record<
                        string,
                        Record<string, (...a: unknown[]) => unknown>
                      >
                    )[model][method](...args);
                  };
                },
              }
            );
          },
        }
      );
      return (arg as (tx: unknown) => unknown)(tx);
    });

    await upsert({ id: MODEL_ID, userId: OWNER_ID, type: ModelType.LORA });

    expect(clearCall()?.where).toEqual({ id: { in: [VERSION_ID] } });
    expect(calledOnTx).toContain('modelVersion.updateMany');
  });
});
