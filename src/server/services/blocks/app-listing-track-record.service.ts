/**
 * App store — a developer's TRACK RECORD on a listing page: how many of their apps this viewer
 * could find in the store, and the counted reviews on those apps ("4 apps · 12 reviews").
 *
 * 🔴 "THEIR APPS" MEANS STORE-VISIBLE TO THIS VIEWER, and it is stated ONCE, by reusing the
 * store grid's own predicate (`storeEligibilityWhere` + `listingLevelVisibilityFilter`) with the
 * developer as one more term — the same reuse `app-listing-forks.service.ts` makes. So a private,
 * draft, pending, rejected, removed, never-deployed, mature-gated or out-of-scope listing is in
 * neither the count nor the review sum, and the number agrees with the developer's
 * "More by this developer" rail and profile Apps tab, which read `listAvailableListings` under
 * the same predicate.
 *
 * Reviews are the metric rollup's recommend + not-recommend counts, the same pair the listing
 * card's `reviewCount` reads.
 *
 * CACHED through `queryCache` for `CacheTTL.sm` under `APP_LISTING_CATALOG_TAG`, so every
 * catalog bust (approve, delist, relist, a level change) clears it with the grid. The viewer
 * axes that decide which ROWS count — scope, audience floor, host and the mature state — are
 * literal key segments, as in the catalog's `catalogPageCache`. The developer id is a bound
 * parameter in the hashed statement instead: the literal key is also the `cache_name` label on
 * the cache hit/miss counters, and a per-user segment would make that label unbounded. The
 * review rollup's writers do not bust (see the tag's header), so the review sum can lag by one
 * TTL window.
 *
 * 🔴 MANUAL-APPLY COLUMN. `visibility` may not exist yet: a missing column re-runs the
 * pre-feature level predicate (`al.status = 'approved'`), the fallback the store grid uses.
 */

import { Prisma } from '@prisma/client';

import { CacheTTL } from '~/server/common/constants';
import { dbRead } from '~/server/db/client';
import type { DeveloperTrackRecord } from '~/server/schema/blocks/app-listing-read.schema';
import type { StoreVisibilityScope } from '~/server/services/app-blocks-flag';
import { APP_LISTING_CATALOG_TAG } from '~/server/services/blocks/app-listing-cache.constants';
import { isMissingColumnError } from '~/server/services/blocks/app-listing-source-repo.service';
import { matureRatingsAllowed } from '~/server/services/blocks/app-listing-store-gate';
import { VISIBILITY_READ_DEGRADED_EVENT } from '~/server/services/blocks/app-listing-visibility.service';
import {
  listingLevelVisibilityFilter,
  storeEligibilityWhere,
} from '~/server/services/blocks/app-listing.service';
import { noteDegradedRead } from '~/server/services/blocks/degraded-read-log';
import { queryCache } from '~/server/utils/cache-helpers';
import type { ListingAudienceFloor } from '~/shared/utils/app-listing-visibility';

export async function getDeveloperTrackRecord(args: {
  userId: number;
  scope: StoreVisibilityScope;
  floor: ListingAudienceFloor;
  redCapable: boolean;
  /** The viewer's browsing level: an r/x app counts only when it includes that rating. */
  viewerBrowsingLevel: number | null | undefined;
}): Promise<DeveloperTrackRecord> {
  const mature = matureRatingsAllowed(args.redCapable, args.viewerBrowsingLevel);
  const cached = queryCache(
    dbRead,
    `appListingDeveloperTrackRecord:${args.scope}:${args.floor}:${
      args.redCapable ? 'red' : 'sfw'
    }:m${mature.r ? 'r' : '-'}${mature.x ? 'x' : '-'}`,
    'v1'
  );

  const run = (levelFilter: Prisma.Sql) =>
    cached<{ appCount: number; reviewCount: number }[]>(
      Prisma.sql`
    SELECT count(*)::int AS "appCount",
      COALESCE(sum(COALESCE(m.thumbs_up_count, 0) + COALESCE(m.thumbs_down_count, 0)), 0)::int
        AS "reviewCount"
    FROM app_listings al
    LEFT JOIN app_listing_metrics m ON m.app_listing_id = al.id
    LEFT JOIN app_blocks ab ON ab.id = al.app_block_id
    WHERE ${storeEligibilityWhere({
      levelFilter,
      kind: null,
      category: null,
      mature,
      scope: args.scope,
      userId: args.userId,
    })}
  `,
      { ttl: CacheTTL.sm, tag: [APP_LISTING_CATALOG_TAG] }
    );

  const rows = await run(listingLevelVisibilityFilter(args.floor)).catch((err: unknown) => {
    if (!isMissingColumnError(err)) throw err;
    noteDegradedRead(VISIBILITY_READ_DEGRADED_EVENT, err);
    return run(Prisma.sql`al.status = 'approved'`);
  });
  const row = rows[0];
  return {
    appCount: Number(row?.appCount ?? 0),
    reviewCount: Number(row?.reviewCount ?? 0),
  };
}
