import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  getMinorQueueCounts,
  getHeldDetectionModelCount,
  getFlaggedCount,
}));

vi.mock('../strike-review.service', () => ({ countStrikeReview }));
vi.mock('../site-appeals.service', () => ({ countSiteAppeals }));

const { getSidebarCounts, LAST_GOOD_MS } = await import('../sidebar-counts.service');

beforeEach(() => {
  redis.store.clear();
  vi.clearAllMocks();
  getFlaggedCount.mockResolvedValue(0);
  getHeldDetectionModelCount.mockResolvedValue(3);
  getMinorQueueCounts.mockResolvedValue({ pending: 10, pendingWithDetection: 1 });
});

describe('sidebar counts for Model Flags', () => {
  it('shows Auto-flagged in models, the same total as the list', async () => {
    getFlaggedCount.mockResolvedValue(15);
    const counts = (await getSidebarCounts()).counts;
    expect(counts).toMatchObject({ modelFlagsAppeals: 4, modelFlagsAuto: 15 });
    // The whole queue: no search, every source and label.
    expect(getFlaggedCount).toHaveBeenCalledWith();
    expect(counts).not.toHaveProperty('modelFlagsReview');
    expect(counts).not.toHaveProperty('modelFlagsMatches');
  });

  it('counts Needs review per kind of lead, a model with both kinds once', async () => {
    expect((await getSidebarCounts()).counts).toMatchObject({
      modelFlagsNeedsReview: 12,
      modelFlagsNeedsReviewDetections: 3,
      modelFlagsNeedsReviewMatches: 10,
    });
  });

  it('drops only the Needs review badges that need a count that failed', async () => {
    getMinorQueueCounts.mockRejectedValue(new Error('slow'));
    const counts = (await getSidebarCounts()).counts;
    expect(counts).toMatchObject({ modelFlagsNeedsReviewDetections: 3 });
    expect(counts).not.toHaveProperty('modelFlagsNeedsReview');
    expect(counts).not.toHaveProperty('modelFlagsNeedsReviewMatches');
    expect((await getSidebarCounts()).unavailable).toEqual(
      expect.arrayContaining(['modelFlagsNeedsReview', 'modelFlagsNeedsReviewMatches'])
    );
  });

  it('drops Auto-flagged, without blanking the other badges, when its count fails', async () => {
    getFlaggedCount.mockRejectedValue(new Error('db down'));
    const counts = (await getSidebarCounts()).counts;
    expect(counts).not.toHaveProperty('modelFlagsAuto');
    expect(counts).toMatchObject({ modelFlagsAppeals: 4, modelFlagsNeedsReview: 12 });
  });
});

describe('sidebar count strikeReview', () => {
  it('is the strike review queue total', async () => {
    countStrikeReview.mockResolvedValue(163);
    expect((await getSidebarCounts()).counts).toMatchObject({ strikeReview: 163 });
  });

  it('is dropped, without blanking the other badges, when its query fails', async () => {
    countStrikeReview.mockRejectedValue(new Error('db down'));
    const counts = (await getSidebarCounts()).counts;
    expect(counts).not.toHaveProperty('strikeReview');
    expect(counts).toMatchObject({ modelFlagsAppeals: 4 });
  });
});

describe('sidebar count site appeals', () => {
  it('is one badge per queue, keyed as the nav entries are', async () => {
    countSiteAppeals.mockResolvedValue({ Account: 3, Article: 0, Model: 2, Other: 7 });
    expect((await getSidebarCounts()).counts).toMatchObject({
      siteAppealsAccount: 3,
      siteAppealsArticle: 0,
      siteAppealsModel: 2,
      siteAppealsOther: 7,
    });
  });

  it('is dropped, without blanking the other badges, when its query fails', async () => {
    countSiteAppeals.mockRejectedValue(new Error('db down'));
    const counts = (await getSidebarCounts()).counts;
    expect(counts).not.toHaveProperty('siteAppealsAccount');
    expect(counts).toMatchObject({ modelFlagsAppeals: 4 });
  });
});

describe('Needs review badge while the file-match counts refill', () => {
  it('keeps the last counts instead of blanking when a refill outlasts the wait', async () => {
    expect((await getSidebarCounts()).counts).toMatchObject({ modelFlagsNeedsReview: 12 });

    vi.useFakeTimers();
    try {
      // A verdict busted the cache: the refill takes longer than the badge waits.
      getMinorQueueCounts.mockReturnValue(new Promise(() => {}));
      const pending = getSidebarCounts();
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await pending).counts).toMatchObject({
        modelFlagsNeedsReview: 12,
        modelFlagsNeedsReviewMatches: 10,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Needs review badge when a part does not answer', () => {
  const hang = () => new Promise<never>(() => {});
  /** One load under fake timers, run past both waits. */
  const slowLoad = async () => {
    const pending = getSidebarCounts();
    await vi.advanceTimersByTimeAsync(3_000);
    return pending;
  };

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps the total when the held-detection count times out after one landed', async () => {
    await getSidebarCounts();
    getHeldDetectionModelCount.mockReturnValue(hang());
    const { counts, unavailable } = await slowLoad();
    expect(counts).toMatchObject({ modelFlagsNeedsReview: 12, modelFlagsNeedsReviewDetections: 3 });
    expect(unavailable).not.toContain('modelFlagsNeedsReview');
  });

  it('keeps the total when the file-match counts fail after one landed', async () => {
    await getSidebarCounts();
    getMinorQueueCounts.mockRejectedValue(new Error('db down'));
    const { counts, unavailable } = await getSidebarCounts();
    expect(counts).toMatchObject({ modelFlagsNeedsReview: 12, modelFlagsNeedsReviewMatches: 10 });
    expect(unavailable).not.toContain('modelFlagsNeedsReview');
  });

  it('marks the badge unavailable, not smaller, when no count has landed', async () => {
    getHeldDetectionModelCount.mockReturnValue(hang());
    const { counts, unavailable } = await slowLoad();
    expect(counts).not.toHaveProperty('modelFlagsNeedsReview');
    expect(unavailable).toEqual(
      expect.arrayContaining(['modelFlagsNeedsReview', 'modelFlagsNeedsReviewDetections'])
    );
    expect(unavailable).not.toContain('modelFlagsNeedsReviewMatches');
  });

  it('treats a last count older than the limit as unknown', async () => {
    await getSidebarCounts();
    vi.setSystemTime(Date.now() + LAST_GOOD_MS + 1);
    getHeldDetectionModelCount.mockReturnValue(hang());
    expect((await slowLoad()).unavailable).toContain('modelFlagsNeedsReview');
  });

  it('keeps a fill that lands after its wait, for the next load', async () => {
    let land!: (c: { pending: number; pendingWithDetection: number }) => void;
    getMinorQueueCounts.mockReturnValue(new Promise((resolve) => (land = resolve)));
    expect((await slowLoad()).unavailable).toContain('modelFlagsNeedsReview');
    land({ pending: 10, pendingWithDetection: 1 });
    await vi.advanceTimersByTimeAsync(0);
    getMinorQueueCounts.mockReturnValue(hang());
    const { counts, unavailable } = await slowLoad();
    expect(counts).toMatchObject({ modelFlagsNeedsReview: 12 });
    expect(unavailable).not.toContain('modelFlagsNeedsReview');
  });

  it('keeps each last count for the limit', async () => {
    await getSidebarCounts();
    for (const part of ['held-detections', 'minor-queue'])
      expect(redis.set).toHaveBeenCalledWith(expect.stringContaining(part), expect.any(String), {
        EX: LAST_GOOD_MS / 1000,
      });
  });

  it('still answers when Redis does not', async () => {
    redis.set.mockRejectedValueOnce(new Error('redis down'));
    redis.set.mockRejectedValueOnce(new Error('redis down'));
    expect((await getSidebarCounts()).counts).toMatchObject({ modelFlagsNeedsReview: 12 });
    redis.get.mockRejectedValueOnce(new Error('redis down'));
    getHeldDetectionModelCount.mockReturnValue(hang());
    expect((await slowLoad()).unavailable).toContain('modelFlagsNeedsReview');
  });
});
