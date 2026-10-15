import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const { mockTx, checkModelRulesLiteralHold, holdModelForLiteralRules } = vi.hoisted(() => ({
  checkModelRulesLiteralHold: vi.fn(),
  holdModelForLiteralRules: vi.fn(),
  mockTx: {
    model: { update: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: vi.fn() },
    modelVersion: { findFirst: vi.fn(), updateMany: vi.fn() },
    post: { updateMany: vi.fn() },
    $executeRaw: vi.fn(),
  },
}));

vi.mock('~/server/db/db-lag-helpers', () => ({
  preventReplicationLag: vi.fn(),
  getDbWithoutLag: vi.fn(async () => dbMock.dbRead),
  preventModelVersionLagBatch: vi.fn(),
}));
vi.mock('~/server/db/pgDb', () => ({ pgDbRead: {}, pgDbWrite: {}, pgDbReadLong: {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null, Tracker: class {} }));
vi.mock('~/server/flipt/client', () => ({ isFlipt: vi.fn(() => false), FLIPT_FEATURE_FLAGS: {} }));
vi.mock('~/server/metrics', () => ({ modelMetrics: {} }));
vi.mock('~/server/redis/caches', () => ({
  dataForModelsCache: {},
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
vi.mock('~/server/services/buzz.service', () => ({}));
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

vi.mock('~/server/services/text-scan/model-rules-hold', () => ({ checkModelRulesLiteralHold }));
vi.mock('~/server/services/text-scan/actions/model-rules', () => ({ holdModelForLiteralRules }));

const logToAxiom = loggingMock.logToAxiom;
import { publishModelById, publishPrivateModel } from '~/server/services/model.service';

const MODEL_ID = 42;
const HOLD = { ruleIds: [3], textHash: 'h1' };

beforeEach(() => {
  vi.clearAllMocks();
  checkModelRulesLiteralHold.mockResolvedValue(null);
  holdModelForLiteralRules.mockResolvedValue(undefined);
  dbMock.dbWrite.$transaction.mockImplementation((fn: (tx: typeof mockTx) => unknown) =>
    fn(mockTx)
  );
  mockTx.model.update.mockResolvedValue({
    id: MODEL_ID,
    userId: 7,
    nsfw: false,
    modelVersions: [{ id: 100, baseModel: 'Illustrious' }],
    status: 'Published',
  });
  mockTx.$executeRaw.mockResolvedValue(0);
  // The requested versions are this model's own.
  dbMock.dbWrite.modelVersion.findMany.mockImplementation((async ({
    where,
  }: {
    where?: { id?: { in?: number[] }; modelId?: number };
  }) => (where?.modelId === MODEL_ID ? (where.id?.in ?? []).map((id) => ({ id })) : [])) as never);
  dbMock.dbWrite.model.findUniqueOrThrow.mockResolvedValue({
    id: MODEL_ID,
    status: 'UnpublishedViolation',
  });
  dbMock.dbWrite.model.findUnique.mockResolvedValue({ status: 'Draft' });
  dbMock.dbWrite.post.findMany.mockResolvedValue([]);
  dbMock.dbWrite.image.findMany.mockResolvedValue([]);
  dbMock.dbWrite.$executeRaw.mockResolvedValue(0);
});

describe('publishModelById — Model rules literal hold', () => {
  const publish = (over: Record<string, unknown> = {}) =>
    publishModelById({ id: MODEL_ID, versionIds: [100], meta: { foo: 1 } as never, ...over });

  it('holds a literal hit for review and never writes a published state', async () => {
    checkModelRulesLiteralHold.mockResolvedValue(HOLD);

    const result = await publish({ enforceModelRules: true });

    expect(checkModelRulesLiteralHold).toHaveBeenCalledWith({
      modelId: MODEL_ID,
      versionIds: [100],
      meta: { foo: 1 },
    });
    expect(holdModelForLiteralRules).toHaveBeenCalledWith({
      modelId: MODEL_ID,
      ...HOLD,
      meta: { foo: 1 },
    });
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: MODEL_ID });
  });

  it('publishes and logs when the hold action throws', async () => {
    checkModelRulesLiteralHold.mockResolvedValue(HOLD);
    holdModelForLiteralRules.mockRejectedValue(new Error('boom'));

    const result = await publish({ enforceModelRules: true });

    expect(result).toMatchObject({ status: 'Published' });
    expect(dbMock.dbWrite.$transaction).toHaveBeenCalledTimes(1);
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'text-scan', type: 'error', entityId: MODEL_ID })
    );
  });

  it('reports the hold when the hold action throws after writing the held status', async () => {
    checkModelRulesLiteralHold.mockResolvedValue(HOLD);
    holdModelForLiteralRules.mockRejectedValue(new Error('notice failed'));
    dbMock.dbWrite.model.findUnique.mockResolvedValue({ status: 'UnpublishedViolation' });

    const result = await publish({ enforceModelRules: true });

    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'UnpublishedViolation' });
  });

  it('publishes when there is no hit', async () => {
    const result = await publish({ enforceModelRules: true });
    expect(holdModelForLiteralRules).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'Published' });
  });

  it('checks the already-public versions only when no versions are passed', async () => {
    await publish({ enforceModelRules: true, versionIds: undefined });
    expect(checkModelRulesLiteralHold).toHaveBeenCalledWith(
      expect.objectContaining({ versionIds: [] })
    );
  });

  it('refuses to overwrite a hold that landed after the caller checked', async () => {
    mockTx.model.update.mockRejectedValue(Object.assign(new Error('none'), { code: 'P2025' }));

    await expect(publish({ enforceModelRules: true })).rejects.toThrow(/not authorized/);

    expect(mockTx.model.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: MODEL_ID, status: { notIn: ['UnpublishedViolation', 'Deleted'] } },
      })
    );
  });

  it('lets a moderator or internal caller republish a held model', async () => {
    await publish();
    expect(mockTx.model.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: MODEL_ID } })
    );
  });

  it('does not check at all unless the caller asks (moderators, internal callers)', async () => {
    checkModelRulesLiteralHold.mockResolvedValue(HOLD);
    await publish();
    expect(checkModelRulesLiteralHold).not.toHaveBeenCalled();
    expect(holdModelForLiteralRules).not.toHaveBeenCalled();
  });
});

describe('publishPrivateModel — Model rules literal hold', () => {
  beforeEach(() => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue({
      id: MODEL_ID,
      userId: 7,
      availability: 'Private',
      status: 'Published',
      meta: { foo: 1 },
    });
    dbMock.dbRead.modelVersion.findMany.mockResolvedValue([{ id: 100 }, { id: 101 }]);
    dbMock.dbWrite.post.findMany.mockResolvedValue([
      { modelVersionId: 100 },
      { modelVersionId: 101 },
    ]);
  });
  const input = { modelId: MODEL_ID, publishVersions: true };

  it('holds a literal hit instead of making the model public', async () => {
    checkModelRulesLiteralHold.mockResolvedValue(HOLD);

    await expect(publishPrivateModel(input, { enforceModelRules: true })).resolves.toEqual({
      versionIds: [100, 101],
      held: true,
    });

    expect(checkModelRulesLiteralHold).toHaveBeenCalledWith({
      modelId: MODEL_ID,
      versionIds: [100, 101],
      meta: { foo: 1 },
    });
    expect(holdModelForLiteralRules).toHaveBeenCalledWith({
      modelId: MODEL_ID,
      ...HOLD,
      meta: { foo: 1 },
    });
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
  });

  it('makes the model public and logs when the hold action throws', async () => {
    checkModelRulesLiteralHold.mockResolvedValue(HOLD);
    holdModelForLiteralRules.mockRejectedValue(new Error('boom'));

    await expect(publishPrivateModel(input, { enforceModelRules: true })).resolves.toEqual({
      versionIds: [100, 101],
      held: false,
    });

    expect(dbMock.dbWrite.$transaction).toHaveBeenCalledTimes(1);
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'text-scan', type: 'error', entityId: MODEL_ID })
    );
  });

  it('makes the model public when nothing matches, or for a moderator', async () => {
    await expect(publishPrivateModel(input, { enforceModelRules: true })).resolves.toMatchObject({
      held: false,
    });
    expect(holdModelForLiteralRules).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$transaction).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    checkModelRulesLiteralHold.mockResolvedValue(HOLD);
    await publishPrivateModel(input);
    expect(checkModelRulesLiteralHold).not.toHaveBeenCalled();
  });

  it('does not check when the model stays private (publishVersions false)', async () => {
    checkModelRulesLiteralHold.mockResolvedValue(HOLD);
    await publishPrivateModel({ ...input, publishVersions: false }, { enforceModelRules: true });
    expect(checkModelRulesLiteralHold).not.toHaveBeenCalled();
  });
});
