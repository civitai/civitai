import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getFlaggedCount,
  getHeldDetectionModelCount,
  getMinorQueueCounts,
  countStrikeReview,
  countSiteAppeals,
} = vi.hoisted(() => ({
  getFlaggedCount: vi.fn(),
  getHeldDetectionModelCount: vi.fn(),
  getMinorQueueCounts: vi.fn(),
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
vi.mock('../reports.service', () => ({
  getReportCounts: async () => ({}),
  getReportLastActioned: async () => ({}),
}));
vi.mock('../feedback.service', () => ({ countNewFeedback: async () => 0 }));
vi.mock('../removed-appeals.service', () => ({ countRemovedAppeals: async () => 0 }));
vi.mock('../minor-hash.service', () => ({
  getMinorFlagAppealGroups: async () => [{ count: 4 }],
  getMinorQueueCounts,
  getHeldDetectionModelCount,
  getFlaggedCount,
}));

vi.mock('../strike-review.service', () => ({ countStrikeReview }));
vi.mock('../site-appeals.service', () => ({ countSiteAppeals }));

const { getSidebarCounts } = await import('../sidebar-counts.service');

beforeEach(() => {
  vi.clearAllMocks();
  getFlaggedCount.mockResolvedValue(0);
  getHeldDetectionModelCount.mockResolvedValue(3);
  getMinorQueueCounts.mockResolvedValue({ pending: 10, pendingWithDetection: 1 });
});

describe('sidebar counts for Model Flags', () => {
  it('shows Auto-flagged in models, the same total as the list', async () => {
    getFlaggedCount.mockResolvedValue(15);
    const counts = await getSidebarCounts();
    expect(counts).toMatchObject({ modelFlagsAppeals: 4, modelFlagsAuto: 15 });
    // The whole queue: no search, every source and label.
    expect(getFlaggedCount).toHaveBeenCalledWith();
    expect(counts).not.toHaveProperty('modelFlagsReview');
    expect(counts).not.toHaveProperty('modelFlagsMatches');
  });

  it('counts Needs review per kind of lead, a model with both kinds once', async () => {
    expect(await getSidebarCounts()).toMatchObject({
      modelFlagsNeedsReview: 12,
      modelFlagsNeedsReviewDetections: 3,
      modelFlagsNeedsReviewMatches: 10,
    });
  });

  it('drops only the Needs review badges that need a count that failed', async () => {
    getMinorQueueCounts.mockRejectedValue(new Error('slow'));
    const counts = await getSidebarCounts();
    expect(counts).toMatchObject({ modelFlagsNeedsReviewDetections: 3 });
    expect(counts).not.toHaveProperty('modelFlagsNeedsReview');
    expect(counts).not.toHaveProperty('modelFlagsNeedsReviewMatches');
  });

  it('drops Auto-flagged, without blanking the other badges, when its count fails', async () => {
    getFlaggedCount.mockRejectedValue(new Error('db down'));
    const counts = await getSidebarCounts();
    expect(counts).not.toHaveProperty('modelFlagsAuto');
    expect(counts).toMatchObject({ modelFlagsAppeals: 4, modelFlagsNeedsReview: 12 });
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
    expect(counts).toMatchObject({ modelFlagsAppeals: 4 });
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
    expect(counts).toMatchObject({ modelFlagsAppeals: 4 });
  });
});

describe('Needs review badge while the file-match counts refill', () => {
  it('keeps the last counts instead of blanking when a refill outlasts the wait', async () => {
    expect(await getSidebarCounts()).toMatchObject({ modelFlagsNeedsReview: 12 });

    vi.useFakeTimers();
    try {
      // A verdict busted the cache: the refill takes longer than the badge waits.
      getMinorQueueCounts.mockReturnValue(new Promise(() => {}));
      const pending = getSidebarCounts();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await pending).toMatchObject({
        modelFlagsNeedsReview: 12,
        modelFlagsNeedsReviewMatches: 10,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
