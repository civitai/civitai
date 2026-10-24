/**
 * App Blocks — the PUBLISHED forks of one store listing: the "N forks" count and the paged list
 * on a parent's store page.
 *
 * 🔴 "PUBLISHED" MEANS STORE-VISIBLE TO THIS VIEWER, and it is stated ONCE, by reusing the store
 * grid's own predicate (`storeEligibilityWhere` + `listingLevelVisibilityFilter`) rather than a
 * second spelling of it. So a fork is counted and listed exactly when this viewer could find it in
 * the `/apps` store: approved (or admitted by its visibility level), not a revision draft, an
 * on-site fork only once it has deployed, not mature on a SFW host, and within the viewer's store
 * scope. A pending, rejected, removed, private or never-deployed fork is in neither the count nor
 * the list — and the count and the list can never disagree, because they share the WHERE clause.
 *
 * 🔴 MANUAL-APPLY COLUMNS. `fork_of_listing_id` (and the store predicate's `visibility`) may not
 * exist yet. A missing column first retries with the pre-feature level predicate — the same
 * fallback the store grid uses for `visibility` — and if the fork column itself is missing the
 * answer is "no forks", never an error.
 *
 * Not cached: the count and the page are read only on a parent's detail page by viewers holding
 * the `app-blocks-fork` flag, and both are index-served (`app_listings_fork_of_listing_id_idx`).
 */

import { Prisma } from '@prisma/client';

import type {
  ListingForkItem,
  ListingForksPage,
} from '~/server/schema/blocks/app-listing-read.schema';
import { isMissingColumnError } from '~/server/services/blocks/app-listing-source-repo.service';
import {
  listingLevelVisibilityFilter,
  storeEligibilityWhere,
} from '~/server/services/blocks/app-listing.service';
import type { ForkReadClient } from '~/server/services/blocks/app-fork.service';
import type { ListingAudienceFloor } from '~/shared/utils/app-listing-visibility';
import type { StoreVisibilityScope } from '~/shared/utils/store-visibility-scope';

export const EMPTY_FORKS_PAGE: ListingForksPage = Object.freeze({
  totalCount: 0,
  items: [],
  nextCursor: null,
}) as ListingForksPage;

/**
 * One page of `parentListingId`'s published forks, newest first, plus the total.
 *
 * The caller has already checked that the viewer may see the PARENT; this function answers only
 * "which of its forks may this viewer see".
 */
export async function listListingForks(
  db: ForkReadClient,
  args: {
    parentListingId: string;
    cursor?: string | null;
    limit: number;
    scope: StoreVisibilityScope;
    floor: ListingAudienceFloor;
    redCapable: boolean;
  }
): Promise<ListingForksPage> {
  const cursor = args.cursor ?? null;
  const run = async (levelFilter: Prisma.Sql): Promise<ListingForksPage> => {
    const eligible = storeEligibilityWhere({
      levelFilter,
      kind: null,
      category: null,
      redCapable: args.redCapable,
      scope: args.scope,
    });
    const where = Prisma.sql`al.fork_of_listing_id = ${args.parentListingId} AND ${eligible}`;
    const [countRows, pageRows] = await Promise.all([
      db.$queryRaw`SELECT count(*)::int AS "n"
          FROM app_listings al
          LEFT JOIN app_blocks ab ON ab.id = al.app_block_id
          WHERE ${where}` as Promise<Array<{ n: number }>>,
      db.$queryRaw`SELECT al.id, al.slug, al.name
          FROM app_listings al
          LEFT JOIN app_blocks ab ON ab.id = al.app_block_id
          WHERE ${where}
            AND (${cursor}::text IS NULL OR al.id < ${cursor}::text)
          ORDER BY al.id DESC
          LIMIT ${args.limit + 1}` as Promise<ListingForkItem[]>,
    ]);
    const items = pageRows
      .slice(0, args.limit)
      .map((r) => ({ id: r.id, slug: r.slug, name: r.name }));
    const last = items[items.length - 1];
    return {
      totalCount: Number(countRows[0]?.n ?? 0),
      items,
      nextCursor: pageRows.length > args.limit && last ? last.id : null,
    };
  };

  try {
    return await run(listingLevelVisibilityFilter(args.floor));
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;
  }
  // Either `visibility` or `fork_of_listing_id` is missing. Retry with the pre-feature level
  // predicate (no `visibility`); if it is the fork column that is missing, there are no forks.
  try {
    return await run(Prisma.sql`al.status = 'approved'`);
  } catch (err) {
    if (isMissingColumnError(err)) return EMPTY_FORKS_PAGE;
    throw err;
  }
}
