import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { buildBaseModelAttestation } from '~/shared/constants/base-model-attestation.constants';
import { ModelStatus } from '~/shared/utils/prisma/enums';

// The attestation gate at the two model-version.service writes that can make an H3 version public or
// bring a public one into scope. Scaffold mirrors model-version.owner-fields.service.test.ts.

const { mockTx, mockPreventReplicationLag } = vi.hoisted(() => ({
  mockTx: {
    modelVersion: { create: vi.fn(), update: vi.fn(), findUniqueOrThrow: vi.fn() },
    $executeRaw: vi.fn(),
    // The name/trained-words row lock; no stored row, so no conflict check.
    $queryRaw: vi.fn(async () => []),
  },
  mockPreventReplicationLag: vi.fn(),
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
  preventReplicationLag: mockPreventReplicationLag,
}));

import {
  publishModelVersionById,
  upsertModelVersion,
} from '~/server/services/model-version.service';

const H3 = 'MiniMax H3';
const MODEL_ID = 42;
const OWNER_ID = 7;
const MOD_ID = 99;
const VERSION_ID = 100;
const attestedMeta = () => ({ baseModelAttestation: buildBaseModelAttestation(OWNER_ID, H3) });

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.$transaction.mockImplementation((fn: (tx: typeof mockTx) => unknown) =>
    fn(mockTx)
  );
});

describe('publishModelVersionById — H3 attestation', () => {
  const seed = ({ baseModel = H3, meta = {} as unknown, type = 'LORA' } = {}) => {
    dbMock.dbRead.modelVersion.findUniqueOrThrow.mockResolvedValue({
      id: VERSION_ID,
      name: 'v1',
      baseModel,
      publishedAt: null,
      meta,
      model: {
        userId: OWNER_ID,
        type,
        name: 'model',
        availability: 'Public',
        publishedAt: null,
        nsfw: false,
        meta: {},
      },
    });
    dbMock.dbWrite.paidAccess.findFirst.mockResolvedValue(null);
    // The write happens inside the transaction; stopping there is enough to show the gate let it by.
    mockTx.modelVersion.update.mockRejectedValue(new Error('reached the write'));
  };

  it('refuses an unattested H3 LoRA before anything is written', async () => {
    seed();

    await expect(publishModelVersionById({ id: VERSION_ID })).rejects.toThrowError(
      /right to train and share/
    );
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
  });

  it('checks the meta the publish is about to write, not only the stored one', async () => {
    seed({ meta: attestedMeta() });

    await expect(publishModelVersionById({ id: VERSION_ID, meta: {} })).rejects.toThrowError(
      /right to train and share/
    );
  });

  it('lets an attested H3 LoRA through to the write', async () => {
    seed({ meta: attestedMeta() });

    await expect(publishModelVersionById({ id: VERSION_ID })).rejects.toThrowError(
      'reached the write'
    );
  });

  it('lets a non-H3 LoRA through without one (control)', async () => {
    seed({ baseModel: 'SDXL 1.0' });

    await expect(publishModelVersionById({ id: VERSION_ID })).rejects.toThrowError(
      'reached the write'
    );
  });
});

describe('upsertModelVersion — H3 attestation', () => {
  const seedExisting = ({
    baseModel = 'SDXL 1.0',
    status = ModelStatus.Published as ModelStatus,
    publishedAt = new Date('2026-09-01') as Date | null,
    meta = null as unknown,
    modelType = 'LORA',
    storedModelType = 'LORA',
  } = {}) => {
    dbMock.dbWrite.model.findUniqueOrThrow.mockResolvedValue({
      nsfw: false,
      meta: null,
      userId: OWNER_ID,
      poi: false,
      availability: 'Public',
      type: modelType,
    });
    dbMock.dbWrite.modelVersion.findUniqueOrThrow.mockResolvedValue({
      id: VERSION_ID,
      status,
      trainingStatus: null,
      publishedAt,
      baseModel,
      meta,
      model: { id: MODEL_ID, meta: null, availability: 'Public', type: storedModelType },
      monetization: null,
    });
    mockTx.modelVersion.update.mockResolvedValue({ id: VERSION_ID, modelId: MODEL_ID });
  };
  const edit = (input: Record<string, unknown>, actorUserId = OWNER_ID) =>
    upsertModelVersion({
      id: VERSION_ID,
      modelId: MODEL_ID,
      actorUserId,
      isModerator: actorUserId !== OWNER_ID,
      ...input,
    } as never);
  const writtenMeta = () => mockTx.modelVersion.update.mock.calls[0]?.[0]?.data?.meta;

  it('refuses switching a published version to H3 without the attestation', async () => {
    seedExisting();

    await expect(edit({ baseModel: H3 })).rejects.toThrowError(/right to train and share/);
    expect(mockTx.modelVersion.update).not.toHaveBeenCalled();
  });

  it('refuses a published H3 version whose model type moved into scope', async () => {
    seedExisting({ baseModel: H3, storedModelType: 'Workflows' });

    await expect(edit({ baseModel: H3 })).rejects.toThrowError(/right to train and share/);
  });

  it('records the attestation and lets the switch through when ticked', async () => {
    seedExisting();

    await edit({ baseModel: H3, baseModelAttested: true });

    expect(writtenMeta().baseModelAttestation).toEqual(
      expect.objectContaining({ userId: OWNER_ID, baseModel: H3, statement: expect.any(String) })
    );
    expect(mockPreventReplicationLag).toHaveBeenCalledWith('modelVersion', VERSION_ID);
  });

  it('records it on a draft, keeping the rest of the stored meta', async () => {
    seedExisting({
      baseModel: H3,
      status: ModelStatus.Draft,
      publishedAt: null,
      meta: { hideBuzz: true },
    });

    await edit({ baseModel: H3, baseModelAttested: true });

    expect(writtenMeta()).toEqual(
      expect.objectContaining({
        hideBuzz: true,
        baseModelAttestation: expect.objectContaining({ userId: OWNER_ID }),
      })
    );
  });

  it('refuses a moderator attesting on the creator’s behalf', async () => {
    seedExisting({ baseModel: H3, status: ModelStatus.Draft, publishedAt: null });

    await expect(edit({ baseModel: H3, baseModelAttested: true }, MOD_ID)).rejects.toThrowError(
      /owner/
    );
  });

  it('refuses a moderator creating an H3 version straight into Published', async () => {
    seedExisting();
    dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([]);
    mockTx.modelVersion.create.mockResolvedValue({ id: VERSION_ID, modelId: MODEL_ID });

    const create = (baseModel: string) =>
      upsertModelVersion({
        modelId: MODEL_ID,
        name: 'v2',
        baseModel,
        status: ModelStatus.Published,
        actorUserId: MOD_ID,
        isModerator: true,
      } as never);

    await expect(create(H3)).rejects.toThrowError(/right to train and share/);
    expect(mockTx.modelVersion.create).not.toHaveBeenCalled();

    // Control: the same create on another base model reaches the insert.
    await create('SDXL 1.0').catch(() => undefined);
    expect(mockTx.modelVersion.create).toHaveBeenCalled();
  });

  it('leaves a non-H3 edit alone (control)', async () => {
    seedExisting();

    await edit({ baseModel: 'Illustrious' });

    expect(mockTx.modelVersion.update).toHaveBeenCalled();
    expect(writtenMeta()).toBeUndefined();
  });
});
