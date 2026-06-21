import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// App Blocks review SERVICE — upsert gates + aggregate + cache bust.
//
// Pins (money + correctness):
//   - create vs update: isFirstReview ONLY on create (drives the once-per
//     reward); update returns false.
//   - GATES: rating range; NO self-review (app owner rejected); NOT-installed
//     rejected; one-per-user via the unique (we read existing → update branch).
//   - getAppRatingTotals SQL excludes mod-excluded rows AND self-reviews.
//   - cache bust fires on upsert (the app tag + the global-mean tag).
// ---------------------------------------------------------------------------

const { mockDb, mockBust, capturedRatingSql } = vi.hoisted(() => ({
  mockDb: {
    appBlock: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    blockUserSubscription: {
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
    },
    appBlockReview: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      create: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
      update: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
      delete: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    },
  },
  mockBust: vi.fn(async () => undefined),
  capturedRatingSql: { value: '' as string },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDb, dbWrite: mockDb }));

// queryCache: bypass Redis — execute the query and capture the SQL so we can
// assert the exclude + self-review filters are present.
vi.mock('~/server/utils/cache-helpers', () => ({
  queryCache: () => async (query: { sql?: string }) => {
    if (query && typeof query === 'object' && typeof query.sql === 'string') {
      capturedRatingSql.value = query.sql;
    }
    // Return a single aggregate row so getAppRatingTotals projects it.
    return [{ avg_rating: 4.25, review_count: 8 }];
  },
  bustCacheTag: (...args: unknown[]) => mockBust(...args),
}));

vi.mock('~/server/common/constants', () => ({ CacheTTL: { hour: 3600 } }));

import {
  bustAppRatingCache,
  getAppRatingTotals,
  setAppReviewExcluded,
  upsertAppBlockReview,
} from '~/server/services/appBlockReview.service';

beforeEach(() => {
  vi.clearAllMocks();
  capturedRatingSql.value = '';
  // Default: app owned by user 99, viewer installed.
  mockDb.appBlock.findUnique.mockResolvedValue({ app: { userId: 99 } });
  mockDb.blockUserSubscription.findFirst.mockResolvedValue({ id: 'bus_1' });
  mockDb.appBlockReview.findUnique.mockResolvedValue(null);
  mockDb.appBlockReview.create.mockResolvedValue({
    id: 1,
    appBlockId: 'ab_1',
    rating: 5,
    recommended: true,
  });
  mockDb.appBlockReview.update.mockResolvedValue({
    id: 1,
    appBlockId: 'ab_1',
    rating: 4,
    recommended: true,
  });
});

describe('upsertAppBlockReview — create vs update', () => {
  it('CREATE branch returns isFirstReview=true and inserts', async () => {
    const res = await upsertAppBlockReview({ userId: 7, appBlockId: 'ab_1', rating: 5 });
    expect(res.isFirstReview).toBe(true);
    expect(mockDb.appBlockReview.create).toHaveBeenCalledTimes(1);
    expect(mockDb.appBlockReview.update).not.toHaveBeenCalled();
  });

  it('UPDATE branch returns isFirstReview=false (no second-award) and updates', async () => {
    mockDb.appBlockReview.findUnique.mockResolvedValue({ id: 1 });
    const res = await upsertAppBlockReview({ userId: 7, appBlockId: 'ab_1', rating: 4 });
    expect(res.isFirstReview).toBe(false);
    expect(mockDb.appBlockReview.update).toHaveBeenCalledTimes(1);
    expect(mockDb.appBlockReview.create).not.toHaveBeenCalled();
  });

  it('busts the rating cache (app tag + global-mean tag) on upsert', async () => {
    await upsertAppBlockReview({ userId: 7, appBlockId: 'ab_1', rating: 5 });
    expect(mockBust).toHaveBeenCalledTimes(1);
    const tags = mockBust.mock.calls[0][0] as string[];
    expect(tags).toContain('app-rating:ab_1');
    expect(tags).toContain('app-rating:global-mean');
  });
});

describe('upsertAppBlockReview — anti-abuse gates', () => {
  it('rejects an out-of-range rating (0 / 6 / non-integer)', async () => {
    for (const bad of [0, 6, 3.5]) {
      await expect(
        upsertAppBlockReview({ userId: 7, appBlockId: 'ab_1', rating: bad })
      ).rejects.toThrow();
    }
    expect(mockDb.appBlockReview.create).not.toHaveBeenCalled();
  });

  it('rejects a SELF-REVIEW (the app owner reviewing their own app)', async () => {
    mockDb.appBlock.findUnique.mockResolvedValue({ app: { userId: 7 } }); // owner == viewer
    await expect(
      upsertAppBlockReview({ userId: 7, appBlockId: 'ab_1', rating: 5 })
    ).rejects.toThrow(/your own app/i);
    expect(mockDb.appBlockReview.create).not.toHaveBeenCalled();
  });

  it('rejects when the viewer has NOT installed (no enabled subscription)', async () => {
    mockDb.blockUserSubscription.findFirst.mockResolvedValue(null);
    await expect(
      upsertAppBlockReview({ userId: 7, appBlockId: 'ab_1', rating: 5 })
    ).rejects.toThrow(/install/i);
    expect(mockDb.appBlockReview.create).not.toHaveBeenCalled();
  });

  it('only counts an ENABLED install (findFirst is scoped to enabled=true)', async () => {
    await upsertAppBlockReview({ userId: 7, appBlockId: 'ab_1', rating: 5 });
    const where = (mockDb.blockUserSubscription.findFirst.mock.calls[0][0] as { where: any }).where;
    expect(where).toMatchObject({ appBlockId: 'ab_1', userId: 7, enabled: true });
  });

  it('rejects for a missing app block', async () => {
    mockDb.appBlock.findUnique.mockResolvedValue(null);
    await expect(
      upsertAppBlockReview({ userId: 7, appBlockId: 'ab_missing', rating: 5 })
    ).rejects.toThrow();
  });
});

describe('getAppRatingTotals — aggregate excludes mod-excluded + self-reviews', () => {
  it('SQL excludes `exclude` rows AND the app owner self-review', async () => {
    const totals = await getAppRatingTotals('ab_1');
    expect(totals).toEqual({ avgRating: 4.25, reviewCount: 8 });
    const sql = capturedRatingSql.value;
    expect(sql).toMatch(/NOT\s+abr\.exclude/i);
    // Self-review exclusion: owner (OauthClient.userId) vs reviewer, NULL-safe.
    expect(sql).toMatch(/oc\."userId"\s+IS DISTINCT FROM\s+abr\.user_id/i);
    expect(sql).toMatch(/AVG\(abr\.rating\)/i);
  });
});

describe('setAppReviewExcluded — mod control busts the cache', () => {
  it('flips exclude + busts the app rating cache', async () => {
    mockDb.appBlockReview.update.mockResolvedValue({ id: 5, appBlockId: 'ab_9', exclude: true });
    const res = await setAppReviewExcluded({ id: 5, exclude: true });
    expect(res).toEqual({ id: 5, appBlockId: 'ab_9', exclude: true });
    expect(mockBust).toHaveBeenCalledTimes(1);
    expect(mockBust.mock.calls[0][0]).toContain('app-rating:ab_9');
  });
});

describe('bustAppRatingCache', () => {
  it('busts both the per-app tag and the global-mean tag', async () => {
    await bustAppRatingCache('ab_x');
    expect(mockBust).toHaveBeenCalledWith(['app-rating:ab_x', 'app-rating:global-mean']);
  });
});
