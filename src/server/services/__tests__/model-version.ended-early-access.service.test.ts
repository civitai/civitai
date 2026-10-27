import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { ModelStatus } from '~/shared/utils/prisma/enums';
import { writePaidAccessForModelVersion } from '~/server/services/paid-access.service';
import { ensureDonationGoal } from '~/server/services/donation-goal.service';

// The edit form reloads a version's gate and sends it back with every save, including a timed window
// that has ended. That must save the rest of the version and leave the ended gate exactly as it was.
// Mock scaffold copied from model-version.owner-fields.service.test.ts.
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

import {
  isEndedTimedGateResubmitted,
  upsertModelVersion,
} from '~/server/services/model-version.service';

const MODEL_ID = 42;
const OWNER_ID = 7;
const VERSION_ID = 100;
const DAY = 86_400_000;
const terms = { download: { price: 500 } };

function seedPublished(gate: { timeframeDays: number | null; endsAt: Date | null }) {
  dbMock.dbWrite.model.findUniqueOrThrow.mockResolvedValue({
    nsfw: false,
    meta: null,
    userId: OWNER_ID,
    poi: false,
    availability: 'Public',
  });
  dbMock.dbWrite.modelVersion.findUniqueOrThrow.mockResolvedValue({
    id: VERSION_ID,
    status: ModelStatus.Published,
    trainingStatus: null,
    meta: null,
    model: { id: MODEL_ID, userId: OWNER_ID, meta: null, availability: 'Public' },
    monetization: null,
  });
  dbMock.dbWrite.paidAccess.findUnique.mockResolvedValue(gate);
  mockTx.modelVersion.update.mockResolvedValue({ id: VERSION_ID, modelId: MODEL_ID });
}

const save = (input: Record<string, unknown>) =>
  upsertModelVersion({
    id: VERSION_ID,
    modelId: MODEL_ID,
    usageControl: 'Download',
    isModerator: false,
    ...input,
  } as never);

const written = () => mockTx.modelVersion.update.mock.calls[0]?.[0]?.data;

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.$transaction.mockImplementation((fn: (tx: typeof mockTx) => unknown) =>
    fn(mockTx)
  );
});

describe('upsertModelVersion on a version whose timed Early Access has ended', () => {
  const ended = { timeframeDays: 7, endsAt: new Date(Date.now() - DAY) };

  it('saves a rename and a fee, and keeps the ended gate row', async () => {
    seedPublished(ended);

    await save({
      name: 'renamed',
      licensingFee: 5,
      paidAccess: { permanent: false, timeframeDays: 7, terms },
      donationGoal: { amount: 1000 },
    });

    expect(written()).toMatchObject({ name: 'renamed', licensingFee: 5 });
    expect(writePaidAccessForModelVersion).not.toHaveBeenCalled();
    expect(ensureDonationGoal).not.toHaveBeenCalled();
  });

  it('still writes a changed timeframe (assertUserEarlyAccessLimits refuses it before this)', async () => {
    seedPublished(ended);
    const paidAccess = { permanent: false, timeframeDays: 14, terms };

    await save({ name: 'renamed', paidAccess });

    expect(writePaidAccessForModelVersion).toHaveBeenCalledWith(VERSION_ID, paidAccess);
  });

  it('still writes a running window', async () => {
    seedPublished({ timeframeDays: 7, endsAt: new Date(Date.now() + DAY) });
    const paidAccess = { permanent: false, timeframeDays: 7, terms };

    await save({ name: 'renamed', paidAccess });

    expect(writePaidAccessForModelVersion).toHaveBeenCalledWith(VERSION_ID, paidAccess);
  });

  it('still clears the gate when the save sends none', async () => {
    seedPublished(ended);

    await save({ name: 'renamed', paidAccess: null });

    expect(writePaidAccessForModelVersion).toHaveBeenCalledWith(VERSION_ID, null);
  });

  it('still writes a permanent gate over an ended window', async () => {
    seedPublished(ended);
    const paidAccess = { permanent: true, terms };

    await save({ name: 'renamed', paidAccess });

    expect(writePaidAccessForModelVersion).toHaveBeenCalledWith(VERSION_ID, paidAccess);
  });
});

describe('isEndedTimedGateResubmitted', () => {
  const now = new Date('2026-06-01T00:00:00Z');
  const timed = { permanent: false, timeframeDays: 7 };

  it('counts a window ending exactly now as ended', () => {
    expect(isEndedTimedGateResubmitted({ timeframeDays: 7, endsAt: now }, timed, now)).toBe(true);
  });

  it('does not count a window ending a millisecond from now', () => {
    const endsAt = new Date(now.getTime() + 1);
    expect(isEndedTimedGateResubmitted({ timeframeDays: 7, endsAt }, timed, now)).toBe(false);
  });

  it('does not count a pending window or a permanent gate', () => {
    expect(isEndedTimedGateResubmitted({ timeframeDays: 7, endsAt: null }, timed, now)).toBe(false);
    expect(isEndedTimedGateResubmitted({ timeframeDays: null, endsAt: null }, timed, now)).toBe(
      false
    );
  });
});
