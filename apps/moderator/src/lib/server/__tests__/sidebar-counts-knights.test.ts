import { beforeEach, describe, expect, it, vi } from 'vitest';

const { countInquisitorQueue, countPendingLinkReviews } = vi.hoisted(() => ({
  countInquisitorQueue: vi.fn(),
  countPendingLinkReviews: vi.fn(),
}));

vi.mock('../cache', () => ({
  createCache: ({ fetch }: { fetch: () => Promise<unknown> }) => ({ get: () => fetch() }),
}));
const redis = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, opts?: { NX?: boolean }) => {
      if (opts?.NX && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
    eval: vi.fn(async (_script: string, opts: { keys: string[]; arguments: string[] }) =>
      store.get(opts.keys[0]) === opts.arguments[0] ? Number(store.delete(opts.keys[0])) : 0
    ),
  };
});

vi.mock('../image-tags-count', () => ({
  countImageTagsNeedingReview: async () => 0,
  IMAGE_TAGS_COUNT_TIMEOUT_MS: 120_000,
}));
vi.mock('../redis', () => ({ getRedis: () => redis }));
vi.mock('../db', () => ({
  dbRead: {
    selectFrom: () => {
      const chain: Record<string, unknown> = {};
      for (const m of ['innerJoin', 'select', 'where']) chain[m] = () => chain;
      chain.executeTakeFirst = async () => ({ count: 0 });
      return chain;
    },
  },
}));
vi.mock('../image-review.service', () => ({ getImageReviewCounts: async () => ({}) }));
vi.mock('../ingestion.service', () => ({
  countStuckIngestion: async () => 0,
  countIngestionErrorImages: async () => 0,
}));
vi.mock('../image-rating-review.service', () => ({ getImageRatingReviewCount: async () => 0 }));
vi.mock('../articles.service', () => ({ countModeratorArticles: async () => 0 }));
vi.mock('../rating-reviews.service', () => ({
  getRatingReviewCounts: async () => ({ Pending: 0 }),
}));
vi.mock('../reports.service', () => ({
  getReportCounts: async () => ({}),
  getReportLastActioned: async () => ({}),
  getReportOldestOpen: async () => ({}),
}));
vi.mock('../feedback.service', () => ({ countNewFeedback: async () => 0 }));
vi.mock('../removed-appeals.service', () => ({ countRemovedAppeals: async () => 0 }));
vi.mock('../minor-hash.service', () => ({
  getMinorFlagAppealGroups: async () => [{ count: 4 }],
  getMinorQueueCounts: async () => ({ pending: 1, pendingWithDetection: 0 }),
  getHeldDetectionModelCount: async () => 5,
  getFlaggedCount: async () => 0,
}));
vi.mock('../training-moderation.service', () => ({ countTrainingDataReview: async () => 0 }));
vi.mock('../strike-review.service', () => ({ countStrikeReview: async () => 0 }));
vi.mock('../site-appeals.service', () => ({ countSiteAppeals: async () => 0 }));
vi.mock('../csam-holds.queries', () => ({ countPendingCsamHolds: async () => 0 }));
vi.mock('../knights/inquisitor.service', () => ({ countInquisitorQueue }));
vi.mock('../knights/link-review.service', () => ({ countPendingLinkReviews }));

const { getSidebarCounts } = await import('../sidebar-counts.service');

beforeEach(() => {
  redis.store.clear();
  vi.clearAllMocks();
});

describe('sidebar counts for Knights of New Order', () => {
  it('reports the Inquisitor queue and the pending link reviews', async () => {
    countInquisitorQueue.mockResolvedValue(6);
    countPendingLinkReviews.mockResolvedValue(2);
    expect((await getSidebarCounts()).counts).toMatchObject({
      knightsInquisitor: 6,
      knightsLinkReviews: 2,
    });
  });

  it('drops the one whose query fails, without blanking the other badges', async () => {
    countInquisitorQueue.mockRejectedValue(new Error('db down'));
    countPendingLinkReviews.mockResolvedValue(2);
    const counts = (await getSidebarCounts()).counts;
    expect(counts).not.toHaveProperty('knightsInquisitor');
    expect(counts).toMatchObject({ knightsLinkReviews: 2, modelFlagsAppeals: 4 });
  });
});
