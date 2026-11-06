import { beforeEach, describe, expect, it, vi } from 'vitest';

const { countPendingCsamHolds, countEvidenceHoldsEnding, peek } = vi.hoisted(() => ({
  peek: vi.fn(),
  countPendingCsamHolds: vi.fn(),
  countEvidenceHoldsEnding: vi.fn(),
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
  getMinorQueueCounts: async () => ({ pending: 1, pendingWithDetection: 0 }),
  getHeldDetectionModelCount: async () => 5,
  getFlaggedCount: async () => 0,
}));
vi.mock('../strike-review.service', () => ({ countStrikeReview: async () => 0 }));
vi.mock('../site-appeals.service', () => ({ countSiteAppeals: async () => 0 }));
vi.mock('../tickets/snapshot', () => ({ ticketSnapshot: { peek } }));
vi.mock('../csam-holds.queries', () => ({ countPendingCsamHolds }));
vi.mock('@civitai/db-queries/evidence-hold', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  countEvidenceHoldsEnding,
}));

const { getSidebarCounts } = await import('../sidebar-counts.service');

beforeEach(() => {
  redis.store.clear();
  vi.clearAllMocks();
  vi.useRealTimers();
  countPendingCsamHolds.mockResolvedValue(0);
  countEvidenceHoldsEnding.mockResolvedValue(null);
});

describe('sidebar ticket counts', () => {
  it('answers without ticket badges, and without marking anything unavailable, when the peek never resolves', async () => {
    vi.useFakeTimers();
    peek.mockReturnValue(new Promise(() => {}));
    const pending = getSidebarCounts();
    await vi.advanceTimersByTimeAsync(3_001);
    const { counts, unavailable } = await pending;
    expect(counts).not.toHaveProperty('ticketsModeration');
    expect(counts).not.toHaveProperty('ticketsSupport');
    expect(counts).toMatchObject({ modelFlagsAppeals: 4 });
    expect(unavailable).not.toContain('ticketsModeration');
  });

  it('includes the ticket badges when the peek answers', async () => {
    peek.mockResolvedValue({
      tickets: [{ id: '1', status: 2, cfFeature: null, tags: [] }],
    });
    expect((await getSidebarCounts()).counts).toHaveProperty('ticketsSupport');
  });
});
