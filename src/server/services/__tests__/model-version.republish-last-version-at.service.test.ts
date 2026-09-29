import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// Republishing a version the owner unpublished must recompute Model.lastVersionAt: the unpublish
// already recomputed it downward, and skipping it here left the model stuck at an older version's
// date. The recompute cannot bump the model — see model-republish-last-version-at.service.test.ts.

const { mockUpdateModelLastVersionAt } = vi.hoisted(() => ({
  mockUpdateModelLastVersionAt: vi.fn(),
}));

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
vi.mock('~/server/services/model.service', () => ({
  updateModelLastVersionAt: mockUpdateModelLastVersionAt,
}));
vi.mock('~/server/services/model-file.service', () => ({
  deleteFilesForModelVersionCache: vi.fn(),
  findOfficialFileByHash: vi.fn(),
  markFileReplaced: vi.fn(),
}));
vi.mock('~/server/services/paid-access.service', () => ({
  getPaidAccess: vi.fn(async () => ({})),
  writePaidAccessForModelVersion: vi.fn(),
  materializePaidAccessEndsAt: vi.fn(),
  bustPaidAccessCache: vi.fn(),
  paidAccessInputFromLegacyConfig: vi.fn(() => null),
  earlyAccessDonationGoalFromLegacyConfig: vi.fn(() => null),
  earlyAccessConfigFromPaidAccess: vi.fn(),
  bustModelSaleCache: vi.fn(),
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

const VERSION_ID = 3364560;
const MODEL_ID = 2503012;
const OWNER_ID = 131273;

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.modelVersion.findUniqueOrThrow.mockResolvedValue({
    id: VERSION_ID,
    name: 'H3',
    baseModel: 'Illustrious',
    model: {
      userId: OWNER_ID,
      name: 'model',
      availability: 'Public',
      publishedAt: new Date('2026-04-11'),
      nsfw: false,
      meta: {},
    },
  });
  dbMock.dbWrite.modelVersion.update.mockResolvedValue({
    id: VERSION_ID,
    modelId: MODEL_ID,
    baseModel: 'Illustrious',
    model: { userId: OWNER_ID, id: MODEL_ID, type: 'LORA', nsfw: false },
  });
  dbMock.dbWrite.$executeRaw.mockResolvedValue(0);
  dbMock.dbWrite.post.findMany.mockResolvedValue([]);
  dbMock.dbWrite.image.findMany.mockResolvedValue([]);
  dbMock.dbRead.modelFileHash.findMany.mockResolvedValue([]);
});

describe('publishModelVersionById — lastVersionAt on republish', () => {
  it('recomputes lastVersionAt when the version carries an unpublish stamp', async () => {
    await publishModelVersionById({ id: VERSION_ID, meta: { unpublishedBy: OWNER_ID } as never });

    expect(mockUpdateModelLastVersionAt).toHaveBeenCalledWith({ id: MODEL_ID });
  });

  it('keeps the anti-bump guard on the version publishedAt it recomputes from', async () => {
    await publishModelVersionById({ id: VERSION_ID });

    const publishedAtWrite = dbMock.dbWrite.$executeRaw.mock.calls
      .map(([strings]) => (strings as TemplateStringsArray).join('?'))
      .find((sql) => /UPDATE "ModelVersion"\s+SET "publishedAt"/.test(sql));
    expect(publishedAtWrite).toMatch(/"publishedAt" IS NULL OR "publishedAt" > NOW\(\)/);
  });
});
