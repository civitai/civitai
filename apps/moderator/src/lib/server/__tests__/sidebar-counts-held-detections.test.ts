import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getRedetectedCount, countStrikeReview, countSiteAppeals } = vi.hoisted(() => ({
  getRedetectedCount: vi.fn(),
  countStrikeReview: vi.fn(),
  countSiteAppeals: vi.fn(),
}));

vi.mock('../cache', () => ({
  createCache: ({ fetch }: { fetch: () => Promise<unknown> }) => ({ get: () => fetch() }),
}));
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
vi.mock('../reports.service', () => ({ getReportCounts: async () => ({}) }));
vi.mock('../feedback.service', () => ({ countNewFeedback: async () => 0 }));
vi.mock('../removed-appeals.service', () => ({ countRemovedAppeals: async () => 0 }));
vi.mock('../minor-hash.service', () => ({
  getMinorFlagAppealGroups: async () => [{ count: 4 }],
  getMinorQueueCounts: async () => ({ pending: 1, auto: 2 }),
  getRedetectedCount,
}));

vi.mock('../strike-review.service', () => ({ countStrikeReview }));
vi.mock('../site-appeals.service', () => ({ countSiteAppeals }));

const { getSidebarCounts } = await import('../sidebar-counts.service');

beforeEach(() => vi.clearAllMocks());

describe('sidebar count heldDetections', () => {
  it('is the held-detection total', async () => {
    getRedetectedCount.mockResolvedValue(5);
    expect(await getSidebarCounts()).toMatchObject({ heldDetections: 5, modelFlagAppeals: 4 });
  });

  it('is dropped, without blanking the other badges, when its query fails', async () => {
    getRedetectedCount.mockRejectedValue(new Error('db down'));
    const counts = await getSidebarCounts();
    expect(counts).not.toHaveProperty('heldDetections');
    expect(counts).toMatchObject({ modelFlagAppeals: 4, minorHashMatches: 3 });
  });
});

describe('sidebar count strikeReview', () => {
  it('is the strike review queue total', async () => {
    countStrikeReview.mockResolvedValue(163);
    expect(await getSidebarCounts()).toMatchObject({ strikeReview: 163 });
  });

  it('is dropped, without blanking the other badges, when its query fails', async () => {
    countStrikeReview.mockRejectedValue(new Error('db down'));
    const counts = await getSidebarCounts();
    expect(counts).not.toHaveProperty('strikeReview');
    expect(counts).toMatchObject({ modelFlagAppeals: 4 });
  });
});

describe('sidebar count site appeals', () => {
  it('is one badge per queue, keyed as the nav entries are', async () => {
    countSiteAppeals.mockResolvedValue({ Account: 3, Article: 0, Model: 2, Other: 7 });
    expect(await getSidebarCounts()).toMatchObject({
      siteAppealsAccount: 3,
      siteAppealsArticle: 0,
      siteAppealsModel: 2,
      siteAppealsOther: 7,
    });
  });

  it('is dropped, without blanking the other badges, when its query fails', async () => {
    countSiteAppeals.mockRejectedValue(new Error('db down'));
    const counts = await getSidebarCounts();
    expect(counts).not.toHaveProperty('siteAppealsAccount');
    expect(counts).toMatchObject({ modelFlagAppeals: 4 });
  });
});
