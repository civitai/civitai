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
  updateModelVersionPaidAccess,
  upsertModelVersion,
} from '~/server/services/model-version.service';
import { writePaidAccessForModelVersion } from '~/server/services/paid-access.service';

const MODEL_ID = 42;
const OTHER_MODEL_ID = 43;
const OWNER_ID = 7;
const VERSION_ID = 100;

type StoredGate = {
  timeframeDays: number | null;
  terms: Record<string, unknown>;
  endsAt?: Date | null;
} | null;

function seedExisting({
  status = ModelStatus.Draft,
  trainingStatus = null,
  gate = null,
  initialPublishedAt = null,
}: {
  initialPublishedAt?: Date | null;
  status?: ModelStatus;
  trainingStatus?: TrainingStatus | null;
  gate?: StoredGate;
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
    initialPublishedAt,
    trainingStatus,
    meta: null,
    model: { id: MODEL_ID, userId: OWNER_ID, meta: null, availability: 'Public' },
    monetization: null,
  });
  dbMock.dbWrite.paidAccess.findUnique.mockResolvedValue(gate && { endsAt: null, ...gate });
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

describe('upsertModelVersion — trainingStatus is not owner-changeable', () => {
  const refused = [
    [TrainingStatus.Denied, TrainingStatus.Approved],
    [TrainingStatus.Denied, TrainingStatus.Pending],
    [TrainingStatus.Paused, TrainingStatus.Approved],
    [TrainingStatus.Paused, TrainingStatus.Pending],
    [TrainingStatus.Submitted, TrainingStatus.Pending],
    [TrainingStatus.Processing, TrainingStatus.Approved],
    [TrainingStatus.Approved, TrainingStatus.Pending],
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
    [TrainingStatus.Expired, TrainingStatus.Pending],
  ] as const)('lets the wizard move %s to %s', async (from, to) => {
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

describe('upsertModelVersion — early access cannot grow after publish', () => {
  const timed = (timeframeDays: number, download = 500) => ({
    timeframeDays,
    terms: { download: { price: download } },
  });
  const input = (timeframeDays: number, download = 500, extra: Record<string, unknown> = {}) => ({
    usageControl: 'Download',
    paidAccess: { timeframeDays, terms: { download: { price: download } }, ...extra },
  });

  it('refuses a longer window', async () => {
    seedExisting({ status: ModelStatus.Published, gate: timed(7) });

    await expect(edit(input(14))).rejects.toThrowError(/increase.*timeframe/i);

    expect(mockTx.modelVersion.update).not.toHaveBeenCalled();
  });

  it('refuses turning a timed window into a permanent gate', async () => {
    seedExisting({ status: ModelStatus.Published, gate: timed(7) });

    await expect(edit(input(0, 500, { permanent: true }))).rejects.toThrowError(
      /increase.*timeframe/i
    );
  });

  it('refuses a higher download price', async () => {
    seedExisting({ status: ModelStatus.Published, gate: timed(7, 500) });

    await expect(edit(input(7, 900))).rejects.toThrowError(/increase.*price/i);
  });

  it('refuses a higher generation price', async () => {
    seedExisting({
      status: ModelStatus.Published,
      gate: { timeframeDays: 7, terms: { download: { price: 500 }, generation: { price: 100 } } },
    });

    await expect(
      edit({
        usageControl: 'Download',
        paidAccess: {
          timeframeDays: 7,
          terms: { download: { price: 500 }, generation: { price: 200 } },
        },
      })
    ).rejects.toThrowError(/increase.*price/i);
  });

  it('refuses adding a price tier the stored gate did not have', async () => {
    seedExisting({
      status: ModelStatus.Published,
      gate: { timeframeDays: 7, terms: { generation: { free: true } } },
    });

    await expect(edit(input(7, 500))).rejects.toThrowError(/increase.*price/i);
  });

  it.each([
    ['the same gate replayed', input(7, 500)],
    ['a shorter window', input(3, 500)],
    ['a lower price', input(7, 300)],
    ['the gate cleared', { usageControl: 'Download', paidAccess: null }],
    ['the gate omitted', { usageControl: 'Download' }],
  ])('lets %s through', async (_label, body) => {
    seedExisting({ status: ModelStatus.Published, gate: timed(7, 500) });

    await edit(body);

    expect(mockTx.modelVersion.update).toHaveBeenCalled();
  });

  it('lets a permanent gate be replayed or narrowed to a window', async () => {
    seedExisting({
      status: ModelStatus.Published,
      gate: { timeframeDays: null, terms: { download: { price: 500 } } },
    });

    await edit(input(0, 500, { permanent: true }));
    await edit(input(7, 500));

    expect(mockTx.modelVersion.update).toHaveBeenCalledTimes(2);
  });

  it('does not restrict a version that is not published yet', async () => {
    seedExisting({ status: ModelStatus.Draft, gate: timed(7, 500) });

    await edit(input(30, 900));

    expect(mockTx.modelVersion.update).toHaveBeenCalled();
  });

  const gen = (generation: unknown, download: number | null = 500) => ({
    timeframeDays: 7,
    terms: { ...(download == null ? {} : { download: { price: download } }), generation },
  });
  const body = (terms: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    usageControl: 'Download',
    paidAccess: { timeframeDays: 7, terms, ...extra },
  });

  it('refuses switching to bundled generation when that raises the generation price', async () => {
    seedExisting({ status: ModelStatus.Published, gate: gen({ price: 100 }) });

    await expect(edit(body({ download: { price: 500 } }))).rejects.toThrowError(/increase.*price/i);
  });

  it('refuses turning free generation into bundled (paid) generation', async () => {
    seedExisting({ status: ModelStatus.Published, gate: gen({ free: true }) });

    await expect(edit(body({ download: { price: 500 } }))).rejects.toThrowError(/increase.*price/i);
  });

  it('lets a Download version become generation-only at the same effective price', async () => {
    seedExisting({ status: ModelStatus.Published, gate: gen(undefined, 500) });

    await edit(body({ generation: { price: 500 } }));

    expect(mockTx.modelVersion.update).toHaveBeenCalled();
  });

  it('lets generation drop to a cheaper explicit price or to free', async () => {
    seedExisting({ status: ModelStatus.Published, gate: gen(undefined, 500) });

    await edit(body({ download: { price: 500 }, generation: { price: 200 } }));
    await edit(body({ download: { price: 500 }, generation: { free: true } }));

    expect(mockTx.modelVersion.update).toHaveBeenCalledTimes(2);
  });

  it('still guards a version that is Draft now but was published before', async () => {
    seedExisting({
      status: ModelStatus.Draft,
      initialPublishedAt: new Date(Date.now() - 86_400_000),
      gate: timed(7, 500),
    });

    await expect(edit(input(14))).rejects.toThrowError(/increase.*timeframe/i);
  });

  it('does not let an ended gate block a later write', async () => {
    seedExisting({
      status: ModelStatus.Published,
      gate: { ...timed(7, 500), endsAt: new Date(Date.now() - 86_400_000) },
    });

    await edit(input(14, 900));

    expect(mockTx.modelVersion.update).toHaveBeenCalled();
  });

  it('leaves a moderator free to increase it', async () => {
    seedExisting({ status: ModelStatus.Published, gate: timed(7, 500) });

    await edit(input(30, 900), true);

    expect(mockTx.modelVersion.update).toHaveBeenCalled();
  });
});

// The REST early-access endpoint writes the same gate without going through the upsert.
describe('updateModelVersionPaidAccess — early access cannot grow after publish', () => {
  const seed = (status: ModelStatus) => {
    dbMock.dbWrite.modelVersion.findUniqueOrThrow.mockResolvedValue({
      id: VERSION_ID,
      baseModel: 'SDXL 1.0',
      usageControl: 'Download',
      modelId: MODEL_ID,
      meta: null,
      status,
      initialPublishedAt: null,
      model: { userId: OWNER_ID },
    });
    dbMock.dbWrite.paidAccess.findUnique.mockResolvedValue({
      timeframeDays: 7,
      terms: { download: { price: 500 } },
      endsAt: null,
    });
  };
  const update = (timeframeDays: number, price: number, isModerator = false) =>
    updateModelVersionPaidAccess({
      id: VERSION_ID,
      paidAccess: { timeframeDays, terms: { download: { price } } },
      isModerator,
    } as never);

  it.each([
    ['a longer window', 14, 500, /increase.*timeframe/i],
    ['a higher price', 7, 900, /increase.*price/i],
  ] as const)('refuses %s on a published version', async (_label, days, price, error) => {
    seed(ModelStatus.Published);

    await expect(update(days, price)).rejects.toThrowError(error);

    expect(writePaidAccessForModelVersion).not.toHaveBeenCalled();
  });

  it('lets a shorter window through', async () => {
    seed(ModelStatus.Published);

    await update(3, 500);

    expect(writePaidAccessForModelVersion).toHaveBeenCalled();
  });

  it('guards an unpublished version that was published before', async () => {
    seed(ModelStatus.Draft);
    dbMock.dbWrite.modelVersion.findUniqueOrThrow.mockResolvedValue({
      id: VERSION_ID,
      baseModel: 'SDXL 1.0',
      usageControl: 'Download',
      modelId: MODEL_ID,
      meta: null,
      status: ModelStatus.Draft,
      initialPublishedAt: new Date(Date.now() - 86_400_000),
      model: { userId: OWNER_ID },
    });

    await expect(update(14, 500)).rejects.toThrowError(/increase.*timeframe/i);
  });

  it('does not restrict an unpublished version or a moderator', async () => {
    seed(ModelStatus.Draft);
    await update(30, 900);
    seed(ModelStatus.Published);
    await update(30, 900, true);

    expect(writePaidAccessForModelVersion).toHaveBeenCalledTimes(2);
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
