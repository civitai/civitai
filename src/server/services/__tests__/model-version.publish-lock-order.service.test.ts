import { Prisma } from '@prisma/client';
import { beforeEach, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// Every path that writes a model and its versions in one transaction must lock the model first:
// the model takedown and model publish paths do, and one taking the version first can deadlock them.
// call shape.

vi.mock('~/server/cloudflare/client', () => ({ purgeCache: vi.fn() }));
vi.mock('~/server/utils/url-helpers', () => ({
  getBaseUrl: () => 'https://civitai.com',
  getInternalUrl: () => 'http://localhost:3000',
}));
vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, dbReadFallbackCounter: { inc: vi.fn() } };
});
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/redis/caches', () => ({
  dataForModelsCache: { refresh: vi.fn() },
  modelVersionAccessCache: { refresh: vi.fn() },
  modelVersionPublicDonationGoalsCache: {},
  modelVersionResourceCache: {},
}));
vi.mock('~/server/redis/resource-data.redis', () => ({ resourceDataCache: { bust: vi.fn() } }));
vi.mock('~/server/search-index', () => ({
  modelsSearchIndex: { queueUpdate: vi.fn() },
  imagesSearchIndex: { queueUpdate: vi.fn() },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
}));
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createCachedObject: () => ({ fetch: vi.fn(async () => ({})), bust: vi.fn() }),
    bustFetchThroughCache: vi.fn(),
  };
});
vi.mock('~/server/services/auction.service', () => ({ deleteBidsForModelVersion: vi.fn() }));
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedLinkDomain: vi.fn(),
  throwOnBlockedUserContent: vi.fn(),
}));
vi.mock('~/server/services/buzz.service', () => ({}));
vi.mock('~/server/services/common.service', () => ({ hasEntityAccess: vi.fn() }));
vi.mock('~/server/services/donation-goal.service', () => ({ checkDonationGoalComplete: vi.fn() }));
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
  markFileReplaced: vi.fn(),
}));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, preventModelVersionLag: vi.fn() };
});
vi.mock('~/utils/s3-utils', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, deleteModelFileObjects: vi.fn() };
});

import { publishModelVersionById } from '~/server/services/model-version.service';

const VERSION_ID = 101;
const MODEL_ID = 202;
const OWNER_ID = 303;

const sqlOf = ([strings, ...values]: unknown[]) =>
  Prisma.sql(strings as TemplateStringsArray, ...values).text;

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.modelVersion.findUniqueOrThrow.mockResolvedValue({
    id: VERSION_ID,
    name: 'v1',
    baseModel: 'Illustrious',
    publishedAt: null,
    meta: {},
    // Never published, so the publish also writes the model row.
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
  dbMock.dbWrite.paidAccess.findFirst.mockResolvedValue(null);
  dbMock.dbWrite.modelVersion.update.mockResolvedValue({
    id: VERSION_ID,
    modelId: MODEL_ID,
    baseModel: 'Illustrious',
    model: { userId: OWNER_ID, id: MODEL_ID, type: 'LORA', nsfw: false },
  });
  dbMock.dbWrite.post.findMany.mockResolvedValue([]);
  dbMock.dbWrite.image.findMany.mockResolvedValue([]);
  dbMock.dbRead.modelFileHash.findMany.mockResolvedValue([]);
});

it.each([false, true])(
  'publishModelVersionById (enforceTakedown %s) locks the model before it writes the version',
  async (enforceTakedown) => {
    await publishModelVersionById({ id: VERSION_ID, enforceTakedown });

    const modelLock = dbMock.dbWrite.$queryRaw.mock.calls.findIndex((args) => {
      const sql = sqlOf(args);
      return sql.includes('FROM "Model"') && sql.includes('FOR NO KEY UPDATE');
    });
    expect(modelLock).toBeGreaterThanOrEqual(0);
    const lockOrder = dbMock.dbWrite.$queryRaw.mock.invocationCallOrder[modelLock];
    const versionWrite = dbMock.dbWrite.modelVersion.update.mock.invocationCallOrder[0];
    expect(versionWrite).toBeDefined();
    expect(lockOrder).toBeLessThan(versionWrite);
  }
);
