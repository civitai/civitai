import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';

// unpublishModelById writes the model's meta. It must merge into the row it reads under its own lock,
// not write back a meta its caller read earlier: a moderator's flag set in between would be dropped.
// Mock scaffold copied from model-early-access-refund.service.test.ts.

// 🔴 `mockTx` stays a SEPARATE object from the write client. `mockTx.model.update` is asserted
// below and means "updated inside unpublishModelById's transaction"; the canonical `$transaction`
// default hands the callback `dbMock.dbWrite`, which would collapse that into the direct calls.
const { mockTx } = vi.hoisted(() => ({
  mockTx: {
    $queryRaw: vi.fn(),
    model: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    $executeRaw: vi.fn(),
  },
}));

// Both entry points read and write on dbWrite throughout — `modelVersion.findMany`
// (model.service:2806), `entityAccess.findMany` and
// `.deleteMany` (:2915), `model.findUniqueOrThrow` (:2877), `$transaction` (:2967),
// `post.findMany` (:3028), `image.findMany` (:3032) — so the old alias's split was never exercised.
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;

const {
  mockModelsQueueUpdate,
  mockQueueImageSearchIndexUpdate,
  mockDeleteBidsForModel,
  mockGetMultiAccountTransactionsByPrefix,
  mockGetUserBuzzAccountByAccountTypes,
  mockRefundMultiAccountTransaction,
} = vi.hoisted(() => ({
  mockModelsQueueUpdate: vi.fn(),
  mockQueueImageSearchIndexUpdate: vi.fn(),
  mockDeleteBidsForModel: vi.fn(),
  mockGetMultiAccountTransactionsByPrefix: vi.fn(),
  mockGetUserBuzzAccountByAccountTypes: vi.fn(),
  mockRefundMultiAccountTransaction: vi.fn(),
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
  modelsSearchIndex: { queueUpdate: mockModelsQueueUpdate },
}));
vi.mock('~/server/services/auction.service', () => ({
  deleteBidsForModel: mockDeleteBidsForModel,
  getLastAuctionReset: vi.fn(),
}));
vi.mock('~/server/services/buzz.service', () => ({
  getMultiAccountTransactionsByPrefix: mockGetMultiAccountTransactionsByPrefix,
  getUserBuzzAccountByAccountTypes: mockGetUserBuzzAccountByAccountTypes,
  refundMultiAccountTransaction: mockRefundMultiAccountTransaction,
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
  queueImageSearchIndexUpdate: mockQueueImageSearchIndexUpdate,
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

// The webhook auth wrapper is not what is under test; the handler runs as the token holder.
vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof EndpointHelpers>()),
  WebhookEndpoint: (handler: unknown) => handler,
}));

import unpublishAllModels from '~/pages/api/admin/unpublish-all-models';
import { unpublishModelById } from '~/server/services/model.service';
import { unpublishForModelRules } from '~/server/services/text-scan/actions/model-rules';
import { ModelStatus } from '~/shared/utils/prisma/enums';

const MODEL_ID = 42;
const OWNER_ID = 7;
const MOD_ID = 9;

// What a moderator set after the caller read the model: only the locked read sees it.
const MID_FLIGHT = { cannotPublish: true, minor: true };

/**
 * The model row. `locked` is what the transaction's FOR NO KEY UPDATE read returns; `stale` is the
 * status an unlocked read inside the transaction would see (the earlier read, before a moderator's
 * write committed).
 */
function setupModel({
  locked,
  stale = locked.status,
}: {
  locked: { status: string; meta: Record<string, unknown> | null };
  stale?: string;
}) {
  mockTx.$queryRaw.mockImplementation(async (strings: string[]) => {
    const sql = strings.join('');
    return sql.includes('FROM "Model"') && sql.includes('FOR NO KEY UPDATE') ? [locked] : [];
  });
  mockTx.model.findUniqueOrThrow.mockResolvedValue({ status: stale });
  mockTx.model.update.mockResolvedValue({ userId: OWNER_ID, modelVersions: [{ id: 100 }] });
  mockTx.$executeRaw.mockResolvedValue(1);
  mockDbWrite.modelVersion.findMany.mockResolvedValue([]);
  mockDbWrite.paidAccess.findMany.mockResolvedValue([]);
  mockDbWrite.entityAccess.findMany.mockResolvedValue([]);
  mockDbWrite.model.findUniqueOrThrow.mockResolvedValue({ name: 'Model', userId: OWNER_ID });
  mockDbWrite.post.findMany.mockResolvedValue([]);
  mockDbWrite.image.findMany.mockResolvedValue([]);
}

const written = () =>
  mockTx.model.update.mock.calls[0]?.[0].data as {
    status: string;
    meta: Record<string, unknown>;
  };

beforeEach(() => {
  vi.clearAllMocks();
  mockDbWrite.$transaction.mockImplementation((fn: (tx: typeof mockTx) => unknown) => fn(mockTx));
});

describe('unpublishModelById merges into the meta it reads under its lock', () => {
  it("keeps a moderator's flag set after the caller read the model, on an owner unpublish", async () => {
    setupModel({ locked: { status: ModelStatus.Published, meta: { ...MID_FLIGHT } } });

    await unpublishModelById({ id: MODEL_ID, userId: OWNER_ID });

    expect(written().status).toBe(ModelStatus.Unpublished);
    expect(written().meta).toEqual({
      ...MID_FLIGHT,
      unpublishedAt: expect.any(String),
      unpublishedBy: OWNER_ID,
    });
  });

  it('keeps it on a moderator unpublish with a reason', async () => {
    setupModel({ locked: { status: ModelStatus.Published, meta: { ...MID_FLIGHT } } });

    await unpublishModelById({
      id: MODEL_ID,
      userId: MOD_ID,
      isModerator: true,
      reason: 'other',
      customMessage: 'why',
    });

    expect(written().status).toBe(ModelStatus.UnpublishedViolation);
    expect(written().meta).toEqual({
      ...MID_FLIGHT,
      unpublishedReason: 'other',
      customMessage: 'why',
      unpublishedAt: expect.any(String),
      unpublishedBy: MOD_ID,
    });
  });

  it("keeps it, and the moderator's record, when the take-down is preserved", async () => {
    const record = { unpublishedReason: 'other', customMessage: 'mod', unpublishedBy: MOD_ID };
    setupModel({
      locked: { status: ModelStatus.UnpublishedViolation, meta: { ...record, ...MID_FLIGHT } },
    });

    await unpublishModelById({ id: MODEL_ID, userId: OWNER_ID });

    expect(written()).toMatchObject({
      status: ModelStatus.UnpublishedViolation,
      meta: { ...record, ...MID_FLIGHT },
    });
  });

  // A take-down landing between an unlocked status read and the write must still be preserved.
  it('decides to preserve a take-down from the locked row', async () => {
    setupModel({
      locked: { status: ModelStatus.UnpublishedViolation, meta: {} },
      stale: ModelStatus.Published,
    });

    await unpublishModelById({ id: MODEL_ID, userId: OWNER_ID });

    expect(written().status).toBe(ModelStatus.UnpublishedViolation);
    expect(written().meta).not.toHaveProperty('unpublishedBy');
  });

  it('sets the patch keys and removes the unset keys, keeping the rest', async () => {
    setupModel({
      locked: { status: ModelStatus.Published, meta: { ...MID_FLIGHT, needsReview: true } },
    });

    await unpublishModelById({
      id: MODEL_ID,
      userId: MOD_ID,
      isModerator: true,
      reason: 'other',
      metaPatch: { showcaseCollectionId: 3 },
      metaUnset: ['needsReview'],
    });

    expect(written().meta).toMatchObject({ ...MID_FLIGHT, showcaseCollectionId: 3 });
    expect(written().meta).not.toHaveProperty('needsReview');
  });

  it('locks the model row as the first statement of its transaction', async () => {
    setupModel({ locked: { status: ModelStatus.Published, meta: {} } });

    await unpublishModelById({ id: MODEL_ID, userId: OWNER_ID });

    const [strings, ...values] = mockTx.$queryRaw.mock.calls[0] as [string[], ...unknown[]];
    const first = Prisma.sql(strings, ...values);
    expect(first.text.replace(/\s+/g, ' ').trim()).toBe(
      'SELECT status, meta FROM "Model" WHERE id = $1 FOR NO KEY UPDATE'
    );
    expect(first.values).toEqual([MODEL_ID]);
    const lockOrder = mockTx.$queryRaw.mock.invocationCallOrder[0];
    for (const write of [mockTx.model.update, mockTx.$executeRaw])
      expect(lockOrder).toBeLessThan(write.mock.invocationCallOrder[0]);
  });

  it.each([
    ['empty', null],
    ['not an object', ['legacy']],
  ])('unpublishes a model whose stored meta is %s', async (_label, meta) => {
    setupModel({ locked: { status: ModelStatus.Published, meta: meta as never } });

    await unpublishModelById({ id: MODEL_ID, userId: OWNER_ID });

    expect(written().meta).toEqual({ unpublishedAt: expect.any(String), unpublishedBy: OWNER_ID });
  });
});

// Every model-rules route (a literal hold before publish, a live take-down on edit or version add,
// a moderator's keep-down ruling) unpublishes through this one function.
describe('unpublishForModelRules', () => {
  const modelRules = {
    ruleIds: [3],
    workflowId: 'literal:h1:3',
    textHash: 'h1',
    at: '2026-10-27T00:00:00.000Z',
  };

  it.each([
    ['a detection', true],
    ["a moderator's ruling", false],
  ])("keeps a moderator's flag through %s", async (_label, needsReview) => {
    setupModel({
      locked: {
        status: ModelStatus.Published,
        meta: { ...MID_FLIGHT, ...(needsReview ? {} : { needsReview: true }) },
      },
    });

    await unpublishForModelRules({ entityId: MODEL_ID, modelRules, needsReview });

    expect(written().meta).toMatchObject({ ...MID_FLIGHT, modelRules });
    if (needsReview) expect(written().meta.needsReview).toBe(true);
    else expect(written().meta).not.toHaveProperty('needsReview');
  });
});

describe('unpublish-all-models', () => {
  it("keeps each model's stored meta", async () => {
    setupModel({ locked: { status: ModelStatus.Published, meta: { ...MID_FLIGHT } } });
    mockDbWrite.model.findMany.mockResolvedValue([{ id: MODEL_ID, name: 'Model' }]);
    const res = { status: vi.fn(() => res), json: vi.fn(() => res) };

    await (unpublishAllModels as unknown as (req: unknown, r: unknown) => Promise<unknown>)(
      { query: { userId: String(OWNER_ID) } },
      res
    );

    expect(written()).toMatchObject({ status: ModelStatus.UnpublishedViolation, meta: MID_FLIGHT });
  });
});
