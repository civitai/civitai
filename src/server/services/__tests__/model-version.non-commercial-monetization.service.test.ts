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
const OLDER_NON_COMMERCIAL = ['Flux.1 Krea', 'Flux.1 Kontext', 'Flux.2 D', 'Stable Cascade'];
const COMMERCIAL_CONTROLS = ['Flux.1 D', 'SDXL 1.0'];
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

  it.each([KLEIN_9B, KLEIN_9B_BASE, ...OLDER_NON_COMMERCIAL])(
    'refuses a licensing fee on %s',
    async (baseModel) => {
      await expect(create(baseModel, { licensingFee: 5 })).rejects.toThrowError(NON_COMMERCIAL);
      expect(mockTx.modelVersion.create).not.toHaveBeenCalled();
    }
  );

  it.each(
    OLDER_NON_COMMERCIAL.flatMap((baseModel) => [
      [baseModel, 'paid access', permanentGate] as const,
      [baseModel, 'early access', earlyAccess] as const,
    ])
  )('refuses %s with %s', async (baseModel, _, gate) => {
    await expect(create(baseModel, { paidAccess: gate })).rejects.toThrowError(NON_COMMERCIAL);
    expect(mockTx.modelVersion.create).not.toHaveBeenCalled();
  });

  it.each(COMMERCIAL_CONTROLS)(
    'lets a %s version with a fee and early access through to the write (control)',
    async (baseModel) => {
      await expect(
        create(baseModel, { licensingFee: 5, paidAccess: earlyAccess })
      ).rejects.toThrowError(REACHED_WRITE);
    }
  );

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

describe('upsertModelVersion — changing the base model of a non-commercial version', () => {
  const relabel = ({
    stored = KLEIN_9B,
    to = 'SDXL 1.0',
    publishedAt = new Date('2026-09-01') as Date | null,
    initialPublishedAt = publishedAt,
    status = publishedAt ? ModelStatus.Published : ModelStatus.Draft,
    isModerator = false,
    locked,
  }: {
    stored?: string;
    to?: string;
    publishedAt?: Date | null;
    initialPublishedAt?: Date | null;
    status?: ModelStatus;
    isModerator?: boolean;
    /** The row the transaction reads under its lock, when it differs from the first read. */
    locked?: Record<string, unknown>;
  } = {}) => {
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
      status,
      trainingStatus: null,
      publishedAt,
      initialPublishedAt,
      baseModel: stored,
      usageControl: ModelUsageControl.Download,
      licensingFee: null,
      meta: null,
      model: { id: MODEL_ID, meta: null, availability: 'Public', type: 'LORA' },
      monetization: null,
    });
    if (locked)
      mockTx.$queryRaw.mockResolvedValueOnce([
        { name: 'v1', trainedWords: [], trainingStatus: null, ...locked },
      ] as never);
    mockTx.modelVersion.update.mockRejectedValue(new Error(REACHED_WRITE));
    return upsertModelVersion({
      id: VERSION_ID,
      modelId: MODEL_ID,
      name: 'v1',
      baseModel: to,
      usageControl: ModelUsageControl.Download,
      actorUserId: OWNER_ID,
      isModerator,
    } as never);
  };
  const KEEPS_BASE_MODEL = new RegExp(
    `published on "${KLEIN_9B}", which is licensed for non-commercial use, so its base model can't be changed`
  );

  it.each(['SDXL 1.0', KLEIN_4B, 'Flux.1 Krea'])(
    'refuses an owner moving a published 9B version to %s',
    async (to) => {
      await expect(relabel({ to })).rejects.toThrowError(KEEPS_BASE_MODEL);
      expect(mockTx.modelVersion.update).not.toHaveBeenCalled();
    }
  );

  it('refuses when the version was published between the first read and the lock', async () => {
    await expect(
      relabel({
        publishedAt: null,
        locked: {
          baseModel: KLEIN_9B,
          status: ModelStatus.Published,
          publishedAt: new Date(),
          initialPublishedAt: new Date(),
        },
      })
    ).rejects.toThrowError(KEEPS_BASE_MODEL);
    expect(mockTx.modelVersion.update).not.toHaveBeenCalled();
  });

  // The private-model flow sends published versions back to Draft with publishedAt cleared.
  it('refuses a 9B version that was published and is a draft again', async () => {
    await expect(
      relabel({ publishedAt: null, initialPublishedAt: new Date('2026-09-01') })
    ).rejects.toThrowError(KEEPS_BASE_MODEL);
  });

  it('refuses an unpublished 9B version with no publish dates (legacy row)', async () => {
    await expect(
      relabel({ publishedAt: null, status: ModelStatus.Unpublished })
    ).rejects.toThrowError(KEEPS_BASE_MODEL);
  });

  // Deliberate: scheduling locks the base model. A version published ahead of its schedule keeps the
  // future date in initialPublishedAt, so a date check would unlock it once it went back to Draft.
  it('refuses a 9B version scheduled for later', async () => {
    const later = new Date(Date.now() + 86_400_000);
    await expect(
      relabel({ publishedAt: later, status: ModelStatus.Scheduled })
    ).rejects.toThrowError(KEEPS_BASE_MODEL);
  });

  it('refuses a 9B draft that went live ahead of a schedule and was sent back to Draft', async () => {
    await expect(
      relabel({
        publishedAt: null,
        initialPublishedAt: new Date(Date.now() + 86_400_000),
        status: ModelStatus.Draft,
      })
    ).rejects.toThrowError(KEEPS_BASE_MODEL);
  });

  it('lets a moderator correct a published 9B version (control)', async () => {
    await expect(relabel({ isModerator: true })).rejects.toThrowError(REACHED_WRITE);
  });

  it('lets an owner relabel a 9B draft that was never published (control)', async () => {
    await expect(relabel({ publishedAt: null })).rejects.toThrowError(REACHED_WRITE);
  });

  it('lets an owner save a published 9B version without changing its base model (control)', async () => {
    await expect(relabel({ to: KLEIN_9B })).rejects.toThrowError(REACHED_WRITE);
  });

  it('lets an owner move a published commercial version to another base model (control)', async () => {
    await expect(relabel({ stored: KLEIN_4B })).rejects.toThrowError(REACHED_WRITE);
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

  it.each(
    OLDER_NON_COMMERCIAL.flatMap((baseModel) => [
      [baseModel, 'paid access', permanentGate] as const,
      [baseModel, 'early access', earlyAccess] as const,
    ])
  )('refuses %s %s', async (baseModel, _, gate) => {
    await expect(update(baseModel, gate)).rejects.toThrowError(NON_COMMERCIAL);
    expect(writePaidAccessForModelVersion).not.toHaveBeenCalled();
  });

  it.each(COMMERCIAL_CONTROLS)(
    'lets early access on a %s version through to the write (control)',
    async (baseModel) => {
      await expect(update(baseModel, earlyAccess)).rejects.toThrowError(REACHED_WRITE);
    }
  );
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
