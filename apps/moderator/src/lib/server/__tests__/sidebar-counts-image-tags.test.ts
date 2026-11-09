import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { imageTagsCount } = vi.hoisted(() => ({ imageTagsCount: vi.fn() }));

vi.mock('../cache', () => ({
  createCache: ({ fetch }: { fetch: () => Promise<unknown> }) => ({ get: () => fetch() }),
}));
const redis = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => void store.set(key, value)),
  };
});

vi.mock('../redis', () => ({ getRedis: () => redis }));
vi.mock('../db', () => ({
  dbRead: {
    selectFrom: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const m of ['innerJoin', 'select', 'where']) chain[m] = () => chain;
      chain.executeTakeFirst = async () =>
        table.startsWith('TagsOnImageNew') ? imageTagsCount() : { count: 0 };
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
vi.mock('../strike-review.service', () => ({ countStrikeReview: async () => 0 }));
vi.mock('../site-appeals.service', () => ({ countSiteAppeals: async () => 0 }));
vi.mock('../csam-holds.queries', () => ({ countPendingCsamHolds: async () => 0 }));
vi.mock('../knights/inquisitor.service', () => ({ countInquisitorQueue: async () => 6 }));
vi.mock('../knights/link-review.service', () => ({ countPendingLinkReviews: async () => 2 }));

const { getSidebarCounts } = await import('../sidebar-counts.service');

beforeEach(() => {
  redis.store.clear();
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('sidebar counts when the image-tags count is slow', () => {
  it('answers the other counts without waiting for it, and reports it unavailable', async () => {
    imageTagsCount.mockReturnValue(new Promise(() => {}));

    const pending = getSidebarCounts();
    await vi.advanceTimersByTimeAsync(3_000);
    const { counts, unavailable } = await pending;

    expect(counts).toMatchObject({ knightsInquisitor: 6, knightsLinkReviews: 2, modelFlagsAppeals: 4 });
    expect(counts).not.toHaveProperty('imageTags');
    expect(unavailable).toContain('imageTags');
  });

  it('stands in the last value a fill landed while the next one is slow', async () => {
    imageTagsCount.mockResolvedValueOnce({ count: '9' });
    expect((await getSidebarCounts()).counts.imageTags).toBe(9);

    imageTagsCount.mockReturnValue(new Promise(() => {}));
    const pending = getSidebarCounts();
    await vi.advanceTimersByTimeAsync(3_000);
    const { counts, unavailable } = await pending;

    expect(counts.imageTags).toBe(9);
    expect(unavailable).not.toContain('imageTags');
  });
});
