import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { ModelStatus, ModelUsageControl } from '~/shared/utils/prisma/enums';

// A version on a non-commercial base model can't charge: no licensing fee, no paid access, no early
// access (a timed gate). Flux.2 Klein 4B is Apache 2.0 and stays monetizable, so it is the control for
// every refusal. Scaffold mirrors model-version.base-model-attestation.service.test.ts.

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

import {
  publishModelVersionById,
  updateModelVersionPaidAccess,
  upsertModelVersion,
} from '~/server/services/model-version.service';

const KLEIN_9B = 'Flux.2 Klein 9B';
const KLEIN_9B_BASE = 'Flux.2 Klein 9B-base';
const KLEIN_4B = 'Flux.2 Klein 4B';
const MODEL_ID = 42;
const OWNER_ID = 7;
const VERSION_ID = 100;
const NON_COMMERCIAL = /non-commercial/;
const REACHED_WRITE = 'reached the write';

// Evaluates the guard's endsAt filter against one stored gate, so a guard that stops refusing a running
// gate, or starts refusing an ended one, fails here instead of reading a canned answer.
const gateMatches = (endsAt: Date | null, or?: { endsAt?: null | { gt?: Date } }[]) =>
  !!or?.some((clause) =>
    clause.endsAt === null
      ? endsAt === null
      : clause.endsAt?.gt != null && endsAt != null && endsAt > clause.endsAt.gt
  );

const terms = { accessPrice: 500 };
const permanentGate = { permanent: true, terms };
const earlyAccess = { permanent: false, timeframeDays: 7, terms };

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.$transaction.mockImplementation((fn: (tx: typeof mockTx) => unknown) =>
    fn(mockTx)
  );
});

describe('upsertModelVersion — non-commercial base model', () => {
  const create = (baseModel: string, input: Record<string, unknown>) => {
    dbMock.dbWrite.model.findUniqueOrThrow.mockResolvedValue({
      nsfw: false,
      meta: null,
      userId: OWNER_ID,
      poi: false,
      availability: 'Public',
      type: 'LORA',
    });
    dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([]);
    mockTx.modelVersion.create.mockRejectedValue(new Error(REACHED_WRITE));
    return upsertModelVersion({
      modelId: MODEL_ID,
      name: 'v1',
      baseModel,
      usageControl: ModelUsageControl.Download,
      actorUserId: OWNER_ID,
      rightsAffirmed: true,
      ...input,
    } as never);
  };

  it.each([KLEIN_9B, KLEIN_9B_BASE])('refuses a licensing fee on %s', async (baseModel) => {
    await expect(create(baseModel, { licensingFee: 5 })).rejects.toThrowError(NON_COMMERCIAL);
    expect(mockTx.modelVersion.create).not.toHaveBeenCalled();
  });

  it('refuses paid access on a 9B version', async () => {
    await expect(create(KLEIN_9B, { paidAccess: permanentGate })).rejects.toThrowError(
      NON_COMMERCIAL
    );
    expect(mockTx.modelVersion.create).not.toHaveBeenCalled();
  });

  it('refuses early access on a 9B version', async () => {
    await expect(create(KLEIN_9B, { paidAccess: earlyAccess })).rejects.toThrowError(
      NON_COMMERCIAL
    );
    expect(mockTx.modelVersion.create).not.toHaveBeenCalled();
  });

  it('lets a free 9B version through to the write (control)', async () => {
    await expect(create(KLEIN_9B, {})).rejects.toThrowError(REACHED_WRITE);
  });

  it('lets a 4B version with a fee through to the write (control)', async () => {
    await expect(create(KLEIN_4B, { licensingFee: 5 })).rejects.toThrowError(REACHED_WRITE);
  });

  it('lets a 4B version with early access through to the write (control)', async () => {
    await expect(create(KLEIN_4B, { paidAccess: earlyAccess })).rejects.toThrowError(REACHED_WRITE);
  });
});

describe('upsertModelVersion — a stored fee moving onto a non-commercial base model', () => {
  const edit = (storedBaseModel: string, baseModel: string) => {
    dbMock.dbWrite.model.findUniqueOrThrow.mockResolvedValue({
      nsfw: false,
      meta: null,
      userId: OWNER_ID,
      poi: false,
      availability: 'Public',
      type: 'LORA',
    });
    dbMock.dbWrite.modelVersion.findUniqueOrThrow.mockResolvedValue({
      id: VERSION_ID,
      status: ModelStatus.Published,
      trainingStatus: null,
      publishedAt: new Date('2026-09-01'),
      baseModel: storedBaseModel,
      usageControl: ModelUsageControl.Download,
      licensingFee: 5,
      meta: null,
      model: { id: MODEL_ID, meta: null, availability: 'Public', type: 'LORA' },
      monetization: null,
    });
    mockTx.modelVersion.update.mockResolvedValue({ id: VERSION_ID, modelId: MODEL_ID });
    // No licensingFee key: the shape of a partial write, which keeps whatever fee is stored.
    return upsertModelVersion({
      id: VERSION_ID,
      modelId: MODEL_ID,
      name: 'v1',
      baseModel,
      usageControl: ModelUsageControl.Download,
      actorUserId: OWNER_ID,
    } as never);
  };
  const writtenFee = () => mockTx.modelVersion.update.mock.calls[0]?.[0]?.data?.licensingFee;

  it('clears a 4B fee when the version moves to 9B without resending it', async () => {
    await edit(KLEIN_4B, KLEIN_9B).catch(() => undefined);
    expect(mockTx.modelVersion.update).toHaveBeenCalled();
    expect(writtenFee()).toBeNull();
  });

  it('keeps the stored fee on a 4B edit that omits it (control)', async () => {
    await edit(KLEIN_4B, KLEIN_4B).catch(() => undefined);
    expect(mockTx.modelVersion.update).toHaveBeenCalled();
    expect(writtenFee()).toBeUndefined();
  });
});

describe('updateModelVersionPaidAccess — non-commercial base model', () => {
  const update = (baseModel: string, paidAccess: unknown) => {
    dbMock.dbWrite.modelVersion.findUniqueOrThrow.mockResolvedValue({
      id: VERSION_ID,
      baseModel,
      usageControl: ModelUsageControl.Download,
      modelId: MODEL_ID,
      meta: null,
      model: { userId: OWNER_ID },
    });
    writePaidAccessForModelVersion.mockRejectedValue(new Error(REACHED_WRITE));
    return updateModelVersionPaidAccess({
      id: VERSION_ID,
      paidAccess,
      rightsAffirmed: true,
      actorUserId: OWNER_ID,
    } as never);
  };

  it.each([
    ['paid access', permanentGate],
    ['early access', earlyAccess],
  ])('refuses %s on a 9B version', async (_, gate) => {
    await expect(update(KLEIN_9B, gate)).rejects.toThrowError(NON_COMMERCIAL);
    expect(writePaidAccessForModelVersion).not.toHaveBeenCalled();
  });

  it('lets early access on a 4B version through to the write (control)', async () => {
    await expect(update(KLEIN_4B, earlyAccess)).rejects.toThrowError(REACHED_WRITE);
  });
});

// A fee or gate stored before the licence was flagged must not go live with the version: a pending
// timed gate would start early access at publish.
describe('publishModelVersionById — stored charges on a non-commercial base model', () => {
  const seed = ({
    baseModel = KLEIN_9B,
    fee = false,
    gate,
  }: {
    baseModel?: string;
    fee?: boolean;
    /** The stored gate's endsAt: null is pending or permanent; omit for no gate. */
    gate?: Date | null;
  } = {}) => {
    dbMock.dbRead.modelVersion.findUniqueOrThrow.mockResolvedValue({
      id: VERSION_ID,
      name: 'v1',
      baseModel,
      publishedAt: null,
      meta: {},
      model: {
        userId: OWNER_ID,
        type: 'LORA',
        name: 'model',
        availability: 'Public',
        publishedAt: null,
        nsfw: false,
        meta: {},
      },
    });
    // Answer only the queries the guard should be making, so a guard that stops filtering on fee or
    // on an open gate reads nothing and lets the version through.
    dbMock.dbWrite.modelVersion.findMany.mockImplementation((async (args: {
      where?: { licensingFee?: { gt?: number } };
    }) => (fee && args?.where?.licensingFee?.gt === 0 ? [{ id: VERSION_ID }] : [])) as never);
    dbMock.dbWrite.paidAccess.findMany.mockImplementation((async (args: {
      where?: { OR?: { endsAt?: null | { gt?: Date } }[] };
    }) =>
      gate !== undefined && gateMatches(gate, args?.where?.OR)
        ? [{ entityId: VERSION_ID }]
        : []) as never);
    dbMock.dbWrite.paidAccess.findFirst.mockResolvedValue(null);
    mockTx.modelVersion.update.mockRejectedValue(new Error(REACHED_WRITE));
  };
  const publish = () => publishModelVersionById({ id: VERSION_ID, enforceTakedown: false });

  it('refuses a 9B version that still stores a licensing fee', async () => {
    seed({ fee: true });
    await expect(publish()).rejects.toThrowError(NON_COMMERCIAL);
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a 9B draft with a pending early-access gate', async () => {
    seed({ gate: null });
    await expect(publish()).rejects.toThrowError(NON_COMMERCIAL);
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a 9B version whose timed gate is still running', async () => {
    seed({ gate: new Date(Date.now() + 86_400_000) });
    await expect(publish()).rejects.toThrowError(NON_COMMERCIAL);
  });

  it('publishes a 9B version whose gate has already ended (control)', async () => {
    seed({ gate: new Date(Date.now() - 86_400_000) });
    await expect(publish()).rejects.toThrowError(REACHED_WRITE);
  });

  it('publishes a 9B version with no charges (control)', async () => {
    seed();
    await expect(publish()).rejects.toThrowError(REACHED_WRITE);
  });

  it('publishes a 4B version with a fee (control)', async () => {
    seed({ baseModel: KLEIN_4B, fee: true });
    await expect(publish()).rejects.toThrowError(REACHED_WRITE);
  });
});
