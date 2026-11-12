import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// Model.lastVersionAt follows the newest published version: a first publish and an unpublish do a
// full recompute, and a republish only ever moves it forward. Republish used to skip it entirely,
// so a version that was unpublished (recomputed down) and republished left its model buried.

const { mockUpdateModelLastVersionAt } = vi.hoisted(() => ({
  mockUpdateModelLastVersionAt: vi.fn(),
}));

const { onStorySparkPostsHidden, onStorySparkPostsRestored } = vi.hoisted(() => ({
  onStorySparkPostsHidden: vi.fn(),
  onStorySparkPostsRestored: vi.fn(),
}));
vi.mock('~/server/events/points/hooks', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  onStorySparkPostsHidden,
  onStorySparkPostsRestored,
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
const { syncReviewsOfMovedPosts } = vi.hoisted(() => ({ syncReviewsOfMovedPosts: vi.fn() }));
vi.mock('~/server/services/resourceReview.visibility', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  syncReviewsOfMovedPosts,
}));
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

import {
  publishModelVersionById,
  unpublishModelVersionById,
} from '~/server/services/model-version.service';

const VERSION_ID = 3364560;
const MODEL_ID = 2503012;
const OWNER_ID = 131273;

const storedVersion = {
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
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.modelVersion.findUniqueOrThrow.mockResolvedValue(storedVersion as never);
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

describe('Model.lastVersionAt across a version publish lifecycle', () => {
  it('fully recomputes on a first publish', async () => {
    await publishModelVersionById({ id: VERSION_ID, enforceTakedown: false, republishing: false });

    expect(mockUpdateModelLastVersionAt).toHaveBeenCalledWith({
      id: MODEL_ID,
      onlyForward: false,
    });
  });

  it('fully recomputes on unpublish, so unpublishing the latest version drops the model back', async () => {
    dbMock.dbWrite.modelVersion.update.mockResolvedValue({
      id: VERSION_ID,
      model: { id: MODEL_ID, userId: OWNER_ID, nsfw: false },
    });
    dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([{ id: VERSION_ID, meta: null }]);
    dbMock.dbWrite.modelVersion.findUniqueOrThrow.mockResolvedValue({ status: 'Published' });

    await unpublishModelVersionById({ id: VERSION_ID, user: { id: OWNER_ID } as never });

    expect(mockUpdateModelLastVersionAt).toHaveBeenCalledWith({ id: MODEL_ID });
  });

  it('only moves it forward on a republish', async () => {
    await publishModelVersionById({ id: VERSION_ID, enforceTakedown: false, republishing: true });

    expect(mockUpdateModelLastVersionAt).toHaveBeenCalledWith({
      id: MODEL_ID,
      onlyForward: true,
    });
  });

  it('keeps the anti-bump guard on the version publishedAt a republish writes', async () => {
    await publishModelVersionById({ id: VERSION_ID, enforceTakedown: false, republishing: true });

    const publishedAtWrite = dbMock.dbWrite.$executeRaw.mock.calls
      .map(([strings]) => (strings as TemplateStringsArray).join('?'))
      .find((sql) => /UPDATE "ModelVersion"\s+SET "publishedAt"/.test(sql));
    expect(publishedAtWrite).toMatch(/"publishedAt" IS NULL OR "publishedAt" > NOW\(\)/);
  });
});

describe('a future-dated publish of a version', () => {
  const future = () => new Date(Date.now() + 86_400_000);
  const writtenStatus = () =>
    (dbMock.dbWrite.modelVersion.update.mock.calls[0][0] as { data: { status: string } }).data
      .status;

  it('schedules a draft version', async () => {
    await publishModelVersionById({
      id: VERSION_ID,
      publishedAt: future(),
      enforceTakedown: false,
    });
    expect(writtenStatus()).toBe('Scheduled');
  });

  // The replica still reads the version as a Draft; the read under the lock says it is live.
  it('leaves a live version live', async () => {
    const original = dbMock.dbWrite.$queryRaw.getMockImplementation();
    dbMock.dbWrite.$queryRaw.mockImplementation((async (strings: TemplateStringsArray) =>
      strings.join('?').includes('SELECT status FROM "ModelVersion"')
        ? [{ status: 'Published' }]
        : []) as never);
    try {
      await publishModelVersionById({
        id: VERSION_ID,
        publishedAt: future(),
        enforceTakedown: false,
      });
    } finally {
      dbMock.dbWrite.$queryRaw.mockImplementation(original as never);
    }
    expect(writtenStatus()).toBe('Published');
  });
});

describe('story sparks across a version publish lifecycle', () => {
  it("unpublishing forfeits the spark of each of the owner's posts on the version", async () => {
    dbMock.dbWrite.modelVersion.update.mockResolvedValue({
      id: VERSION_ID,
      model: { id: MODEL_ID, userId: OWNER_ID, nsfw: false },
    });
    dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([{ id: VERSION_ID, meta: null }]);
    dbMock.dbWrite.modelVersion.findUniqueOrThrow.mockResolvedValue({ status: 'Published' });
    dbMock.dbWrite.post.findMany.mockResolvedValue([{ id: 5 }, { id: 6 }]);

    await unpublishModelVersionById({ id: VERSION_ID, user: { id: OWNER_ID } as never });

    expect(onStorySparkPostsHidden).toHaveBeenCalledExactlyOnceWith({ postIds: [5, 6] });
  });

  it('republishing gives those sparks back', async () => {
    dbMock.dbWrite.post.findMany.mockResolvedValue([{ id: 5 }, { id: 6 }]);

    await publishModelVersionById({ id: VERSION_ID, enforceTakedown: false, republishing: true });

    expect(onStorySparkPostsRestored).toHaveBeenCalledExactlyOnceWith({ postIds: [5, 6] });
  });
});

describe('reviews written from the posts of a version', () => {
  // The guarded post UPDATE returns the posts it moved; an already-public post is not among them.
  const postUpdateMoves = (rows: { id: number }[]) =>
    dbMock.dbWrite.$queryRaw.mockImplementation((async (strings: TemplateStringsArray) =>
      Array.isArray(strings) && /UPDATE "Post"/.test(strings.join('?')) ? rows : []) as never);

  beforeEach(() => {
    dbMock.dbWrite.post.findMany.mockResolvedValue([{ id: 5 }, { id: 6 }]);
  });

  it('releases only the posts the publish moved, flagging the ones put back under their old date', async () => {
    postUpdateMoves([{ id: 5 }]);

    await publishModelVersionById({ id: VERSION_ID, enforceTakedown: false, republishing: true });

    expect(syncReviewsOfMovedPosts).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ change: 'publish', postIds: [5] })
    );
  });

  it('releases nothing again when every post was already public', async () => {
    postUpdateMoves([]);

    await publishModelVersionById({ id: VERSION_ID, enforceTakedown: false, republishing: true });

    expect(syncReviewsOfMovedPosts.mock.calls.flatMap(([arg]) => arg.postIds)).toEqual([]);
  });

  it("recounts the reviews of the version's posts when it is unpublished", async () => {
    dbMock.dbWrite.modelVersion.update.mockResolvedValue({
      id: VERSION_ID,
      model: { id: MODEL_ID, userId: OWNER_ID, nsfw: false },
    });
    dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([{ id: VERSION_ID, meta: null }]);
    dbMock.dbWrite.modelVersion.findUniqueOrThrow.mockResolvedValue({ status: 'Published' });

    await unpublishModelVersionById({ id: VERSION_ID, user: { id: OWNER_ID } as never });

    expect(syncReviewsOfMovedPosts).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ change: 'unpublish', postIds: [5, 6] })
    );
  });
});
