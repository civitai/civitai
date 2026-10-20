import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { ModelStatus } from '~/shared/utils/prisma/enums';

// A version's name and trained words are scanned only where they differ from the stored row,
// because the review handlers replay the stored row through `upsertModelVersion`. The mock
// scaffold mirrors model-version.owner-fields.service.test.ts.

const { mockTx, throwOnBlockedUserContent } = vi.hoisted(() => ({
  mockTx: {
    modelVersion: { create: vi.fn(), update: vi.fn(), findUniqueOrThrow: vi.fn() },
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
  },
  // Stands in for the blocklist: refuses any string containing BLOCKED.
  throwOnBlockedUserContent: vi.fn(async (value: unknown) => {
    const values = Array.isArray(value) ? value : [value];
    if (values.some((v) => typeof v === 'string' && v.includes('BLOCKED')))
      throw new Error('blocked');
  }),
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
  throwOnBlockedUserContent,
}));
vi.mock('~/server/services/buzz.service', () => ({
  createMultiAccountBuzzTransaction: vi.fn(),
  getMultiAccountTransactionsByPrefix: vi.fn(),
  getUserBuzzAccountByAccountTypes: vi.fn(),
  refundMultiAccountTransaction: vi.fn(),
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
vi.mock('~/server/services/model.service', () => ({ updateModelLastVersionAt: vi.fn() }));
vi.mock('~/server/services/model-file.service', () => ({
  deleteFilesForModelVersionCache: vi.fn(),
  findOfficialFileByHash: vi.fn(),
}));
vi.mock('~/server/services/monetization-rights.service', () => ({
  resolveRightsAffirmation: vi.fn(),
}));

import { upsertModelVersion } from '~/server/services/model-version.service';

const MODEL_ID = 42;
const OWNER_ID = 7;
const VERSION_ID = 100;
const STORED = { name: 'v1 BLOCKED', trainedWords: ['alpha', 'BLOCKED word'] };

function seed(locked = STORED) {
  dbMock.dbWrite.model.findUniqueOrThrow.mockResolvedValue({
    nsfw: false,
    meta: null,
    userId: OWNER_ID,
    poi: false,
    availability: 'Public',
  });
  dbMock.dbWrite.modelVersion.findUnique.mockResolvedValue(STORED);
  dbMock.dbWrite.modelVersion.findUniqueOrThrow.mockResolvedValue({
    id: VERSION_ID,
    status: ModelStatus.UnpublishedViolation,
    trainingStatus: null,
    meta: null,
    model: { id: MODEL_ID, userId: OWNER_ID, meta: null, availability: 'Public' },
    monetization: null,
  });
  mockTx.$queryRaw.mockResolvedValue([locked]);
  mockTx.modelVersion.update.mockResolvedValue({ id: VERSION_ID, modelId: MODEL_ID });
}

// The argument shape `requestReviewHandler` and `declineReviewHandler` pass: the stored row,
// replayed with a new `meta` and no moderator flag.
const replay = (meta: Record<string, unknown>) =>
  upsertModelVersion({
    id: VERSION_ID,
    modelId: MODEL_ID,
    status: ModelStatus.UnpublishedViolation,
    baseModel: 'SDXL 1.0',
    ...STORED,
    meta,
  } as never);

const edit = (input: Record<string, unknown>) =>
  upsertModelVersion({
    id: VERSION_ID,
    modelId: MODEL_ID,
    status: ModelStatus.UnpublishedViolation,
    ...STORED,
    ...input,
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.$transaction.mockImplementation((fn: (tx: typeof mockTx) => unknown) =>
    fn(mockTx)
  );
  seed();
});

describe('upsertModelVersion — the review replay of a stored name', () => {
  it('lets a version whose stored name and words trip the list request a review', async () => {
    await expect(replay({ needsReview: true })).resolves.toBeDefined();
    expect(mockTx.modelVersion.update).toHaveBeenCalledTimes(1);
  });

  it('lets a moderator decline that review', async () => {
    await expect(replay({ needsReview: false, declinedReason: 'x' })).resolves.toBeDefined();
    expect(mockTx.modelVersion.update).toHaveBeenCalledTimes(1);
  });
});

describe('upsertModelVersion — a user edit of the name or trained words', () => {
  it('scans a changed name', async () => {
    await expect(edit({ name: 'new BLOCKED name' })).rejects.toThrow('blocked');
    expect(mockTx.modelVersion.update).not.toHaveBeenCalled();
  });

  it('scans an added trained word, not the stored ones beside it', async () => {
    await expect(edit({ trainedWords: [...STORED.trainedWords, 'BLOCKED new'] })).rejects.toThrow(
      'blocked'
    );
    await expect(edit({ trainedWords: [...STORED.trainedWords, 'beta'] })).resolves.toBeDefined();
  });

  it('scans the whole name and every word of a version not yet stored', async () => {
    await expect(
      upsertModelVersion({
        modelId: MODEL_ID,
        name: 'BLOCKED',
        trainedWords: [],
      } as never)
    ).rejects.toThrow('blocked');
  });
});

describe('upsertModelVersion — a concurrent edit of the scanned fields', () => {
  it('refuses when the locked row no longer matches the one the diff was taken against', async () => {
    seed({ name: 'renamed meanwhile', trainedWords: STORED.trainedWords });

    await expect(edit({ name: STORED.name })).rejects.toThrow('changed while you were saving');
    expect(mockTx.modelVersion.update).not.toHaveBeenCalled();
  });
});
