import { beforeEach, describe, expect, it, vi } from 'vitest';

const { countPendingCsamHolds, countEvidenceHoldsEnding } = vi.hoisted(() => ({
  countPendingCsamHolds: vi.fn(),
  countEvidenceHoldsEnding: vi.fn(),
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
  getMinorQueueCounts: async () => ({ pending: 1, pendingWithDetection: 0 }),
  getHeldDetectionModelCount: async () => 5,
  getFlaggedCount: async () => 0,
}));
vi.mock('../strike-review.service', () => ({ countStrikeReview: async () => 0 }));
vi.mock('../site-appeals.service', () => ({ countSiteAppeals: async () => 0 }));
vi.mock('../csam-holds.queries', () => ({ countPendingCsamHolds }));
vi.mock('@civitai/db-queries/evidence-hold', () => ({ countEvidenceHoldsEnding }));

const { getSidebarCounts } = await import('../sidebar-counts.service');

beforeEach(() => vi.clearAllMocks());

describe('sidebar count csamTextHolds', () => {
  it('is the pending csam hold total', async () => {
    countPendingCsamHolds.mockResolvedValue(3);
    expect(await getSidebarCounts()).toMatchObject({ csamTextHolds: 3, modelFlagsAppeals: 4 });
  });

  it('is dropped, without blanking the other badges, when its query fails', async () => {
    countPendingCsamHolds.mockRejectedValue(new Error('db down'));
    const counts = await getSidebarCounts();
    expect(counts).not.toHaveProperty('csamTextHolds');
    expect(counts).toMatchObject({ modelFlagsAppeals: 4 });
  });
});

describe('sidebar count evidenceHoldsEnding', () => {
  it('is the number of owners whose hold is ending', async () => {
    countEvidenceHoldsEnding.mockResolvedValue({ owners: 2, earliest: new Date() });
    expect(await getSidebarCounts()).toMatchObject({ evidenceHoldsEnding: 2 });
  });

  it('is dropped, without blanking the other badges, when its query fails', async () => {
    countEvidenceHoldsEnding.mockRejectedValue(new Error('db down'));
    const counts = await getSidebarCounts();
    expect(counts).not.toHaveProperty('evidenceHoldsEnding');
    expect(counts).toMatchObject({ heldDetections: 5 });
  });
});
