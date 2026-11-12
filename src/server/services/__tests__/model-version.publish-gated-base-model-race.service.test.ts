import { beforeEach, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// The pre-publish gate reads the base model before publishModelVersionById's transaction, so an
// owner's edit can move a draft onto a gated base model in between. The publish re-reads it under
// its lock and refuses a version gated now that the gate did not judge. Scaffold mirrors
// model-version.publish-lock-order.service.test.ts.

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
const OWNER_ID = 303;

const REACHED_WRITE = 'reached the write';
let lockedBaseModel: string;
/** Whether the version carries a link to a target the rule does not allow. */
let linkedElsewhere = false;
const isVersionBaseModelRead = (strings: unknown) =>
  Array.isArray(strings) && /SELECT id, "baseModel" FROM "ModelVersion"/.test(strings.join('?'));

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
  dbMock.dbWrite.modelVersion.update.mockRejectedValue(new Error(REACHED_WRITE));
  lockedBaseModel = 'Fibo 2.0';
  linkedElsewhere = false;
  dbMock.dbWrite.$queryRaw.mockImplementation((async (strings: unknown) =>
    isVersionBaseModelRead(strings)
      ? [{ id: VERSION_ID, baseModel: lockedBaseModel }]
      : linkedElsewhere && (strings as string[]).join('?').includes('"RecommendedResource"')
      ? [{ id: VERSION_ID }]
      : []) as never);
  dbMock.dbWrite.post.findMany.mockResolvedValue([]);
  dbMock.dbWrite.image.findMany.mockResolvedValue([]);
  dbMock.dbRead.modelFileHash.findMany.mockResolvedValue([]);
});

const publish = (gateJudgedVersionIds?: number[]) =>
  publishModelVersionById({
    id: VERSION_ID,
    enforceTakedown: !!gateJudgedVersionIds,
    gateJudgedVersionIds,
  });

it("refuses an owner's publish of a draft moved onto Fibo 2.0 after the gate read it", async () => {
  await expect(publish([])).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(dbMock.dbWrite.modelVersion.update).not.toHaveBeenCalled();
});

it('publishes it when the gate judged that version (control)', async () => {
  await expect(publish([VERSION_ID])).rejects.toThrowError(REACHED_WRITE);
});

it('publishes it when the version is still on an ungated base model (control)', async () => {
  lockedBaseModel = 'Illustrious';
  await expect(publish([])).rejects.toThrowError(REACHED_WRITE);
});

it('lets a moderator, who skips the gate, publish it (control)', async () => {
  await expect(publish(undefined)).rejects.toThrowError(REACHED_WRITE);
});

it('refuses publishing a gated version whose links point anywhere but an allowed target', async () => {
  linkedElsewhere = true;
  await expect(publish([VERSION_ID])).rejects.toThrowError(
    /official components or other reviewed versions/
  );
  expect(dbMock.dbWrite.modelVersion.update).not.toHaveBeenCalled();
});
