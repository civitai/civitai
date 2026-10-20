import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { ModelStatus, TrainingStatus } from '~/shared/utils/prisma/enums';

// `modelVersion.upsert` is reachable by every model owner, so a field only a moderator or a dedicated
// endpoint may change must be refused here too. The mock scaffold mirrors
// model-version.unpublish-refund.service.test.ts (large transitive import graph stubbed out).

const { mockTx } = vi.hoisted(() => ({
  // Separate from the write client on purpose: modelVersion.update is asserted as "inside the
  // transaction", which collapses if $transaction hands back dbWrite itself.
  mockTx: {
    modelVersion: { create: vi.fn(), update: vi.fn(), findUniqueOrThrow: vi.fn() },
    $executeRaw: vi.fn(),
    // The name/trained-words row lock; no stored row, so no conflict check.
    $queryRaw: vi.fn(async () => []),
  },
}));

const {
  mockGetMultiAccountTransactionsByPrefix,
  mockRefundMultiAccountTransaction,
  mockGetUserBuzzAccountByAccountTypes,
} = vi.hoisted(() => ({
  mockGetMultiAccountTransactionsByPrefix: vi.fn(),
  mockRefundMultiAccountTransaction: vi.fn(),
  mockGetUserBuzzAccountByAccountTypes: vi.fn(),
}));

vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, dbReadFallbackCounter: { inc: vi.fn() } };
});
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/redis/caches', () => ({
  modelVersionPublicDonationGoalsCache: { fetch: vi.fn(), bust: vi.fn() },
  dataForModelsCache: { refresh: vi.fn() },
  modelVersionAccessCache: { refresh: vi.fn() },
}));
vi.mock('~/server/redis/resource-data.redis', () => ({ resourceDataCache: { bust: vi.fn() } }));
vi.mock('~/server/search-index', () => ({
  modelsSearchIndex: { queueUpdate: vi.fn() },
  imagesSearchIndex: { queueUpdate: vi.fn() },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
}));
// Spread the real module rather than listing its exports: a hand-listed mock couples this file to
// model-version.service's whole import graph, and the next export it reaches for fails to LOAD here
// rather than failing an assertion. That is what happened when `bustPaidAccessCache` was added — only a
// full-suite run found it, hours later.
vi.mock('~/server/services/paid-access.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  materializePaidAccessEndsAt: vi.fn(),
  writePaidAccessForModelVersion: vi.fn(),
  getPaidAccess: vi.fn(),
  assertPaidAccessInput: vi.fn(),
  getFreshSalesForPermanentGate: vi.fn().mockResolvedValue([]),
  bustModelSaleCache: vi.fn(),
  bustPaidAccessCache: vi.fn(),
}));
vi.mock('~/server/services/auction.service', () => ({ deleteBidsForModelVersion: vi.fn() }));
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedLinkDomain: vi.fn(),
  throwOnBlockedUserContent: vi.fn(),
}));
vi.mock('~/server/services/buzz.service', () => ({
  createMultiAccountBuzzTransaction: vi.fn(),
  getMultiAccountTransactionsByPrefix: mockGetMultiAccountTransactionsByPrefix,
  getUserBuzzAccountByAccountTypes: mockGetUserBuzzAccountByAccountTypes,
  refundMultiAccountTransaction: mockRefundMultiAccountTransaction,
}));
vi.mock('~/server/services/common.service', () => ({ hasEntityAccess: vi.fn() }));
vi.mock('~/server/services/donation-goal.service', () => ({
  checkDonationGoalComplete: vi.fn(),
  ensureDonationGoal: vi.fn(),
  getDonationGoals: vi.fn(),
  getOwnerDonationGoals: vi.fn(),
}));
vi.mock('~/server/services/image.service', () => ({
  imagesForModelVersionsCache: { refresh: vi.fn() },
  uploadImageFromUrl: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/orchestrator/models', () => ({ bustOrchestratorModelCache: vi.fn() }));
vi.mock('~/server/services/post.service', () => ({ addPostImage: vi.fn(), createPost: vi.fn() }));
vi.mock('~/server/services/model.service', () => ({
  updateModelLastVersionAt: vi.fn(),
}));
vi.mock('~/server/services/model-file.service', () => ({
  deleteFilesForModelVersionCache: vi.fn(),
  findOfficialFileByHash: vi.fn(),
}));
vi.mock('~/server/services/monetization-rights.service', () => ({
  resolveRightsAffirmation: vi.fn(),
}));

import { upsertModelVersion } from '~/server/services/model-version.service';

const MODEL_ID = 42;
const OTHER_MODEL_ID = 43;
const OWNER_ID = 7;
const VERSION_ID = 100;

function seedExisting({
  status = ModelStatus.Draft,
  trainingStatus = null,
}: {
  status?: ModelStatus;
  trainingStatus?: TrainingStatus | null;
} = {}) {
  dbMock.dbWrite.model.findUniqueOrThrow.mockResolvedValue({
    nsfw: false,
    meta: null,
    userId: OWNER_ID,
    poi: false,
    availability: 'Public',
  });
  dbMock.dbWrite.modelVersion.findUniqueOrThrow.mockResolvedValue({
    id: VERSION_ID,
    status,
    trainingStatus,
    meta: null,
    model: { id: MODEL_ID, userId: OWNER_ID, meta: null, availability: 'Public' },
    monetization: null,
  });
  mockTx.modelVersion.update.mockResolvedValue({ id: VERSION_ID, modelId: MODEL_ID });
}

const edit = (input: Record<string, unknown>, isModerator = false) =>
  upsertModelVersion({ id: VERSION_ID, modelId: MODEL_ID, ...input, isModerator } as never);

const written = () => mockTx.modelVersion.update.mock.calls[0]?.[0]?.data;

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.$transaction.mockImplementation((fn: (tx: typeof mockTx) => unknown) =>
    fn(mockTx)
  );
});

describe('upsertModelVersion — Denied and Paused training status is moderator-only', () => {
  const refused = [
    [TrainingStatus.Denied, TrainingStatus.Approved],
    [TrainingStatus.Denied, TrainingStatus.Pending],
    [TrainingStatus.Paused, TrainingStatus.Approved],
    [TrainingStatus.Paused, TrainingStatus.Pending],
    [TrainingStatus.Denied, TrainingStatus.Submitted],
    [TrainingStatus.Paused, TrainingStatus.Processing],
    [TrainingStatus.Submitted, TrainingStatus.Denied],
    [TrainingStatus.Approved, TrainingStatus.Paused],
    [null, TrainingStatus.Denied],
  ] as const;

  it.each(refused)('refuses a non-moderator moving %s to %s', async (from, to) => {
    seedExisting({ trainingStatus: from });

    await expect(edit({ trainingStatus: to })).rejects.toThrowError(/training status/i);

    expect(mockTx.modelVersion.update).not.toHaveBeenCalled();
  });

  it.each([
    [TrainingStatus.InReview, TrainingStatus.Approved],
    [TrainingStatus.Failed, TrainingStatus.Approved],
    // A retry after a failed run; the basic-info step always sends Pending.
    [TrainingStatus.Failed, TrainingStatus.Pending],
    [TrainingStatus.Pending, TrainingStatus.Pending],
    [null, TrainingStatus.Pending],
    [TrainingStatus.Denied, TrainingStatus.Denied],
    [TrainingStatus.Paused, TrainingStatus.Paused],
    [TrainingStatus.Processing, TrainingStatus.Approved],
    [TrainingStatus.Submitted, TrainingStatus.Approved],
    [TrainingStatus.Expired, TrainingStatus.Pending],
    // A stale form re-sending InReview after the run moved to Approved.
    [TrainingStatus.Approved, TrainingStatus.InReview],
  ] as const)('lets an owner move %s to %s', async (from, to) => {
    seedExisting({ trainingStatus: from });

    await edit({ trainingStatus: to });

    expect(written().trainingStatus).toBe(to);
  });

  it('lets a save that omits trainingStatus through, whatever is stored', async () => {
    seedExisting({ trainingStatus: TrainingStatus.Denied });

    await edit({ name: 'renamed' });

    expect(mockTx.modelVersion.update).toHaveBeenCalled();
  });

  it('leaves a moderator free to change it', async () => {
    seedExisting({ trainingStatus: TrainingStatus.Denied });

    await edit({ trainingStatus: TrainingStatus.Approved }, true);

    expect(written().trainingStatus).toBe(TrainingStatus.Approved);
  });
});

describe('upsertModelVersion — an owner cannot reopen a started run for a new dataset', () => {
  const refused = [
    [TrainingStatus.InReview, TrainingStatus.Pending],
    [TrainingStatus.Approved, TrainingStatus.Pending],
    [TrainingStatus.Submitted, TrainingStatus.Pending],
    [TrainingStatus.Processing, TrainingStatus.Failed],
    [TrainingStatus.Approved, TrainingStatus.Expired],
    [TrainingStatus.InReview, null],
  ] as const;

  it.each(refused)('refuses a non-moderator moving %s to %s', async (from, to) => {
    seedExisting({ trainingStatus: from });

    await expect(edit({ trainingStatus: to })).rejects.toThrowError(/training status/i);

    expect(mockTx.modelVersion.update).not.toHaveBeenCalled();
  });

  it('leaves a moderator free to reopen it', async () => {
    seedExisting({ trainingStatus: TrainingStatus.InReview });

    await edit({ trainingStatus: TrainingStatus.Pending }, true);

    expect(written().trainingStatus).toBe(TrainingStatus.Pending);
  });

  it('judges the move against the locked row, not the earlier read', async () => {
    seedExisting({ trainingStatus: TrainingStatus.Pending });
    mockTx.$queryRaw.mockResolvedValueOnce([
      { name: 'v1', trainedWords: [], trainingStatus: TrainingStatus.Submitted },
    ] as never);

    await expect(edit({ trainingStatus: TrainingStatus.Pending })).rejects.toThrowError(
      /training status/i
    );

    expect(mockTx.modelVersion.update).not.toHaveBeenCalled();
  });

  it('saves when the locked row still allows the move', async () => {
    seedExisting({ trainingStatus: TrainingStatus.Pending });
    mockTx.$queryRaw.mockResolvedValueOnce([
      { name: 'v1', trainedWords: [], trainingStatus: TrainingStatus.Pending },
    ] as never);

    await edit({ trainingStatus: TrainingStatus.Pending });

    expect(written().trainingStatus).toBe(TrainingStatus.Pending);
  });
});

describe('upsertModelVersion — a version cannot be moved to another model', () => {
  it('refuses a non-moderator naming a different modelId on update', async () => {
    seedExisting();

    await expect(edit({ modelId: OTHER_MODEL_ID })).rejects.toThrowError(
      /cannot be moved to another model/i
    );

    expect(mockTx.modelVersion.update).not.toHaveBeenCalled();
  });

  it('lets a save naming the stored modelId through', async () => {
    seedExisting();

    await edit({ name: 'renamed' });

    expect(mockTx.modelVersion.update).toHaveBeenCalled();
  });

  it('lets a save that omits modelId through (review handlers replay without moving)', async () => {
    seedExisting();

    await upsertModelVersion({ id: VERSION_ID, name: 'renamed' } as never);

    expect(mockTx.modelVersion.update).toHaveBeenCalled();
  });

  it('leaves a moderator free to re-parent', async () => {
    seedExisting();

    await edit({ modelId: OTHER_MODEL_ID }, true);

    expect(written().modelId).toBe(OTHER_MODEL_ID);
  });
});
