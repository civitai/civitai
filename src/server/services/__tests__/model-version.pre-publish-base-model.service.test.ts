import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { ModelStatus, ModelUsageControl } from '~/shared/utils/prisma/enums';

// A public or scheduled version moved onto a gated base model would skip the pre-publish gate, which
// runs only when a version is published, so the edit is refused. Scaffold mirrors
// model-version.non-commercial-monetization.service.test.ts.

const { mockTx, writePaidAccessForModelVersion } = vi.hoisted(() => ({
  mockTx: {
    modelVersion: { create: vi.fn(), update: vi.fn(), findUniqueOrThrow: vi.fn() },
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(async () => []),
  },
  writePaidAccessForModelVersion: vi.fn(),
}));

vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, dbReadFallbackCounter: { inc: vi.fn() } };
});
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/cloudflare/client', () => ({ purgeCache: vi.fn() }));
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
  writePaidAccessForModelVersion,
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
vi.mock('~/server/services/buzz.service', () => ({}));
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
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  preventModelVersionLag: vi.fn(),
  preventReplicationLag: vi.fn(),
}));

import { upsertModelVersion } from '~/server/services/model-version.service';

const MODEL_ID = 42;
const OWNER_ID = 7;
const VERSION_ID = 100;
const REACHED_WRITE = 'reached the write';
const REFUSED = /create a new version/;

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.$transaction.mockImplementation((fn: (tx: typeof mockTx) => unknown) =>
    fn(mockTx)
  );
  dbMock.dbWrite.model.findUniqueOrThrow.mockResolvedValue({
    nsfw: false,
    meta: null,
    userId: OWNER_ID,
    poi: false,
    availability: 'Public',
    type: 'LORA',
  });
  dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([]);
  mockTx.modelVersion.update.mockRejectedValue(new Error(REACHED_WRITE));
  mockTx.modelVersion.create.mockRejectedValue(new Error(REACHED_WRITE));
});

const edit = (
  stored: { status: ModelStatus; baseModel: string; meta?: Record<string, unknown> },
  baseModel: string,
  {
    isModerator = false,
    isNew = false,
    meta,
  }: { isModerator?: boolean; isNew?: boolean; meta?: Record<string, unknown> } = {}
) => {
  const row = {
    id: VERSION_ID,
    meta: {},
    ...stored,
    trainedWords: [],
    model: { id: MODEL_ID, availability: 'Public', meta: null, type: 'LORA' },
    monetization: null,
  };
  for (const client of [dbMock.dbWrite, dbMock.dbRead]) {
    client.modelVersion.findUnique.mockResolvedValue(row as never);
    client.modelVersion.findUniqueOrThrow.mockResolvedValue(row as never);
  }
  const id = isNew ? undefined : VERSION_ID;
  return upsertModelVersion({
    id,
    modelId: MODEL_ID,
    name: 'v1',
    baseModel,
    usageControl: ModelUsageControl.Download,
    actorUserId: OWNER_ID,
    rightsAffirmed: true,
    isModerator,
    ...(meta ? { meta } : {}),
  } as never);
};

describe('upsertModelVersion — moving a version onto a pre-publish-review base model', () => {
  it.each([ModelStatus.Published, ModelStatus.Scheduled])(
    'refuses to move a %s version onto Fibo 2.0',
    async (status) => {
      await expect(edit({ status, baseModel: 'SDXL 1.0' }, 'Fibo 2.0')).rejects.toThrowError(
        REFUSED
      );
      expect(mockTx.modelVersion.update).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['a draft onto Fibo 2.0', { status: ModelStatus.Draft, baseModel: 'SDXL 1.0' }, 'Fibo 2.0'],
    [
      'a published version to another base',
      { status: ModelStatus.Published, baseModel: 'SDXL 1.0' },
      'Pony',
    ],
    [
      'a published Fibo 2.0 version kept on it',
      { status: ModelStatus.Published, baseModel: 'Fibo 2.0' },
      'Fibo 2.0',
    ],
  ])('lets %s through to the write (control)', async (_, stored, baseModel) => {
    await expect(edit(stored, baseModel)).rejects.toThrowError(REACHED_WRITE);
  });

  it('lets a moderator make the change (control)', async () => {
    await expect(
      edit({ status: ModelStatus.Published, baseModel: 'SDXL 1.0' }, 'Fibo 2.0', {
        isModerator: true,
      })
    ).rejects.toThrowError(REACHED_WRITE);
  });

  it('lets a new version on Fibo 2.0 through to the write (control)', async () => {
    await expect(
      edit({ status: ModelStatus.Published, baseModel: 'SDXL 1.0' }, 'Fibo 2.0', { isNew: true })
    ).rejects.toThrowError(REACHED_WRITE);
  });
});

describe('upsertModelVersion — moving a version off a pre-publish-review base model', () => {
  it.each([
    ['a published one', { status: ModelStatus.Published, baseModel: 'Fibo 2.0' }],
    [
      'a draft a moderator holds',
      { status: ModelStatus.Draft, baseModel: 'Fibo 2.0', meta: { needsReview: true } },
    ],
    [
      'a draft a moderator declined',
      {
        status: ModelStatus.Draft,
        baseModel: 'Fibo 2.0',
        meta: { decliendAt: '2026-11-09T00:00:00Z' },
      },
    ],
  ])('refuses to move %s off Fibo 2.0', async (_, stored) => {
    await expect(edit(stored, 'SDXL 1.0')).rejects.toThrowError(/can't be changed/);
    expect(mockTx.modelVersion.update).not.toHaveBeenCalled();
  });

  it('lets an unheld draft move off Fibo 2.0 (control)', async () => {
    await expect(
      edit({ status: ModelStatus.Draft, baseModel: 'Fibo 2.0' }, 'SDXL 1.0')
    ).rejects.toThrowError(REACHED_WRITE);
  });
});

describe("upsertModelVersion — a publish that lands between the edit's read and its write", () => {
  // Same text as the stored row, so only its status differs from the edit's read.
  const lockedRow = (status: ModelStatus) => [
    {
      trainedWords: [],
      trainingStatus: null,
      baseModel: 'SDXL 1.0',
      status,
      publishedAt: status === ModelStatus.Published ? new Date() : null,
      initialPublishedAt: status === ModelStatus.Published ? new Date() : null,
      meta: {},
    },
  ];

  it('refuses the move onto Fibo 2.0 once the locked row is published', async () => {
    mockTx.$queryRaw.mockResolvedValueOnce(lockedRow(ModelStatus.Published) as never);
    await expect(
      edit({ status: ModelStatus.Draft, baseModel: 'SDXL 1.0' }, 'Fibo 2.0')
    ).rejects.toThrowError(REFUSED);
    expect(mockTx.modelVersion.update).not.toHaveBeenCalled();
  });

  it('keeps a moderator hold written after the read: meta merges over the locked row', async () => {
    mockTx.$queryRaw.mockResolvedValueOnce([
      { ...lockedRow(ModelStatus.Draft)[0], meta: { needsReview: true } },
    ] as never);
    await expect(
      edit({ status: ModelStatus.Draft, baseModel: 'SDXL 1.0' }, 'SDXL 1.0', {
        meta: { hideBuzz: true },
      })
    ).rejects.toThrowError(REACHED_WRITE);
    expect(mockTx.modelVersion.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ meta: expect.objectContaining({ needsReview: true }) }),
      })
    );
  });

  it('lets it through when the locked row is still a draft (control)', async () => {
    mockTx.$queryRaw.mockResolvedValueOnce(lockedRow(ModelStatus.Draft) as never);
    await expect(
      edit({ status: ModelStatus.Draft, baseModel: 'SDXL 1.0' }, 'Fibo 2.0')
    ).rejects.toThrowError(REACHED_WRITE);
  });
});
