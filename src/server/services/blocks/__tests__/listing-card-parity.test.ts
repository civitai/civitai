import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';

/**
 * The `cards` half of the listing parity fixture (`media-parity.json`; the media half is
 * `listing-media-parity.test.ts`). The read model's `parity_test.go` projects each fixture listing's
 * stream stats into a card; here the same stats go through the store's own card rules:
 *   - `recommend` is `recommendRollup` of the rollup counts, and the stream's `recommendPct` (which
 *     the read model passes through) is that rollup's;
 *   - `openCount` is `cardOpenCount`: a number on-site (0 with no metric), null off-site;
 *   - `reviewCount` is the sum of the rollup's counts, which `projectListingCard` computes inline.
 *
 * `app-listing.service` is imported for its pure exports; the mocks below only keep its import
 * graph off the database and Redis (the same set `app-listing.service.test.ts` uses).
 */

const { mockDbRead } = vi.hoisted(() => ({
  mockDbRead: {
    $queryRaw: vi.fn(async (): Promise<unknown[]> => []),
    appListing: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
  },
}));
vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbRead }));
vi.mock('~/env/server', () => ({ env: { APPS_DOMAIN: 'civit.ai' } }));
vi.mock('~/server/common/constants', () => ({ CacheTTL: { hour: 3600, sm: 180 } }));
vi.mock('~/server/utils/cache-helpers', () => ({
  queryCache:
    () =>
    async (sql: unknown): Promise<unknown[]> =>
      mockDbRead.$queryRaw(sql),
  bustCacheTag: vi.fn(async () => undefined),
}));

import { cardOpenCount, recommendRollup } from '~/server/services/blocks/app-listing.service';

type Stats = {
  recommendedCount: number;
  notRecommendedCount: number;
  recommendPct: number | null;
  reviewCount: number;
  openCount: number | null;
  installCount: number;
};
type Fixture = {
  listings: { slug: string; kind: 'onsite' | 'offsite'; stats: Stats }[];
  cards: Record<
    string,
    {
      recommend: {
        recommendedCount: number;
        notRecommendedCount: number;
        recommendPct: number | null;
      };
      reviewCount: number;
      openCount: number | null;
    }
  >;
};

const FIXTURE: Fixture = JSON.parse(
  readFileSync(
    join(process.cwd(), 'apps/app-index-go/internal/listingread/testdata/media-parity.json'),
    'utf8'
  )
);

describe('listing card parity (media-parity.json cards): the site side', () => {
  it('every fixture listing has a card expectation', () => {
    expect(Object.keys(FIXTURE.cards).sort()).toEqual(FIXTURE.listings.map((l) => l.slug).sort());
  });

  it.each(FIXTURE.listings.map((l) => [l.slug, l] as const))('%s', (slug, l) => {
    const want = FIXTURE.cards[slug];
    const recommend = recommendRollup({
      thumbsUpCount: l.stats.recommendedCount,
      thumbsDownCount: l.stats.notRecommendedCount,
    });
    expect(recommend).toEqual(want.recommend);
    // The stream's pct is the rollup's: the read model passes it through.
    expect(l.stats.recommendPct).toBe(recommend.recommendPct);
    expect(want.reviewCount).toBe(recommend.recommendedCount + recommend.notRecommendedCount);
    // `open_count` is NOT NULL DEFAULT 0 in the database; the stream's null is no metric row.
    expect(cardOpenCount({ kind: l.kind, metric: { openCount: l.stats.openCount ?? 0 } })).toBe(
      want.openCount
    );
  });
});
