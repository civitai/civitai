import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { imageTagsCount, logToAxiom } = vi.hoisted(() => ({
  imageTagsCount: vi.fn(),
  logToAxiom: vi.fn(async () => undefined),
}));

vi.mock('../axiom', () => ({ logToAxiom }));

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

vi.mock('../redis', () => ({ getRedis: () => redis }));
vi.mock('../image-tags-count', () => ({
  countImageTagsNeedingReview: imageTagsCount,
  IMAGE_TAGS_COUNT_TIMEOUT_MS: 120_000,
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
vi.mock('../knights/inquisitor.service', () => ({ countInquisitorQueue: async () => 6 }));
vi.mock('../knights/link-review.service', () => ({ countPendingLinkReviews: async () => 2 }));

const { getSidebarCounts } = await import('../sidebar-counts.service');
const { IMAGE_TAGS_COUNT_TIMEOUT_MS } = await import('../image-tags-count');

beforeEach(() => {
  redis.store.clear();
  vi.clearAllMocks();
  imageTagsCount.mockReset();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('sidebar counts when the image-tags count is slow', () => {
  it('answers the other counts without waiting for it, and reports it unavailable', async () => {
    imageTagsCount.mockReturnValue(new Promise(() => {}));

    const pending = getSidebarCounts();
    await vi.advanceTimersByTimeAsync(3_000);
    const { counts, unavailable } = await pending;

    expect(counts).toMatchObject({
      knightsInquisitor: 6,
      knightsLinkReviews: 2,
      modelFlagsAppeals: 4,
    });
    expect(counts).not.toHaveProperty('imageTags');
    expect(unavailable).toContain('imageTags');
  });

  it('stands in the last value a fill landed while the next one is slow', async () => {
    imageTagsCount.mockResolvedValueOnce(9);
    expect((await getSidebarCounts()).counts.imageTags).toBe(9);

    imageTagsCount.mockReturnValue(new Promise(() => {}));
    const pending = getSidebarCounts();
    await vi.advanceTimersByTimeAsync(3_000);
    const { counts, unavailable } = await pending;

    expect(counts.imageTags).toBe(9);
    expect(unavailable).not.toContain('imageTags');
  });
});

describe('the image-tags scan is single-flight across servers', () => {
  const lockKey = () => [...redis.store.keys()].find((key) => key.includes('fill-lock'));

  it('does not start a second scan while one is running, and answers from the last value', async () => {
    imageTagsCount.mockResolvedValueOnce(9);
    await getSidebarCounts();
    imageTagsCount.mockReturnValue(new Promise(() => {}));

    const first = getSidebarCounts();
    await vi.advanceTimersByTimeAsync(3_000);
    await first;
    expect(imageTagsCount).toHaveBeenCalledTimes(2);

    const second = getSidebarCounts();
    await vi.advanceTimersByTimeAsync(0);
    const { counts } = await second;

    expect(imageTagsCount).toHaveBeenCalledTimes(2);
    expect(counts.imageTags).toBe(9);
  });

  it('releases the lock when the scan lands, so the next fill scans again', async () => {
    imageTagsCount.mockResolvedValue(4);
    await getSidebarCounts();
    await vi.advanceTimersByTimeAsync(0);

    expect(lockKey()).toBeUndefined();
    await getSidebarCounts();
    expect(imageTagsCount).toHaveBeenCalledTimes(2);
  });

  it('keeps the lock after a failed scan, so it is retried when the lock expires and not every refresh', async () => {
    imageTagsCount.mockRejectedValue(new Error('canceling statement due to statement timeout'));

    const { unavailable } = await getSidebarCounts();
    await vi.advanceTimersByTimeAsync(0);
    expect(unavailable).toContain('imageTags');
    expect(lockKey()).toBeDefined();

    await getSidebarCounts();
    expect(imageTagsCount).toHaveBeenCalledTimes(1);
  });

  it('logs a failed scan with the part and the error message', async () => {
    imageTagsCount.mockRejectedValue(new Error('canceling statement due to statement timeout'));

    await getSidebarCounts();
    await vi.advanceTimersByTimeAsync(0);

    expect(logToAxiom).toHaveBeenCalledWith({
      type: 'sidebar-count-fill-failed',
      part: 'image-tags',
      message: 'canceling statement due to statement timeout',
    });
  });

  it("does not release a lock another server took after this one's expired", async () => {
    let land!: (count: number) => void;
    imageTagsCount.mockReturnValue(new Promise<number>((resolve) => (land = resolve)));
    const pending = getSidebarCounts();
    await vi.advanceTimersByTimeAsync(3_000);
    await pending;

    redis.store.set(lockKey()!, 'another-servers-token');
    land(5);
    await vi.advanceTimersByTimeAsync(0);

    expect(redis.store.get(lockKey()!)).toBe('another-servers-token');
  });

  it('holds the lock for longer than the scan is allowed to run', async () => {
    imageTagsCount.mockReturnValue(new Promise(() => {}));
    const pending = getSidebarCounts();
    await vi.advanceTimersByTimeAsync(3_000);
    await pending;

    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining('fill-lock'),
      expect.any(String),
      expect.objectContaining({ NX: true, EX: expect.any(Number) })
    );
    const call = redis.set.mock.calls.find(([key]) => String(key).includes('fill-lock'));
    const ex = (call?.[2] as { EX: number }).EX;
    expect(ex * 1000).toBeGreaterThan(IMAGE_TAGS_COUNT_TIMEOUT_MS);
  });
});
