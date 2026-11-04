import { isMatureContentRating } from '~/server/utils/server-domain';
import {
  listingVisibleInStore,
  type AppListingVisibility,
  type ListingAudienceFloor,
} from '~/shared/utils/app-listing-visibility';
import { narrowStoreScope, type StoreVisibilityScope } from '~/shared/utils/store-visibility-scope';

/**
 * The app-layer half of "may this request open this listing's public store page", as a
 * pure predicate over one already-loaded row.
 *
 * It was the body of `loadStoreVisibleListingRow` in `app-listing.service.ts` and moved
 * here unchanged so a second reader — the viewer's "My apps" home, which resolves many
 * listings at once — applies the SAME gate instead of a re-derived copy. The detail,
 * card, social-image and fork-parent reads still reach it through that loader.
 *
 * Every term fails closed, in this order:
 *   1. an absent or unrecognised scope (`narrowStoreScope` → `none`) admits nothing;
 *   2. a shadow revision (`revisionOfId` set) is never a store listing;
 *   3. the per-listing level gate (`listingVisibleInStore`): status allowlist, then the
 *      level, then the viewer's audience floor — this is what drops `removed`
 *      (delisted / unpublished), `rejected` and unreviewed rows;
 *   4. `public-external` admits off-site listings only;
 *   5. an on-site listing whose block never deployed has no origin to serve;
 *   6. a mature listing is hidden off a red-capable host.
 *
 * Pure and DB-free so it can be unit-tested without a client.
 */
export type StoreGateRow = {
  status: string;
  kind: string;
  contentRating: string | null;
  /** `undefined` is treated as "not a revision" — the loader's `where` already pins it. */
  revisionOfId?: string | null;
  appBlock: { currentVersionDeployedAt: Date | null } | null;
};

export function storeVisibleListingRowGate(args: {
  row: StoreGateRow;
  visibility: AppListingVisibility | null;
  scope: StoreVisibilityScope | undefined;
  floor: ListingAudienceFloor;
  redCapable: boolean;
}): boolean {
  const { row, visibility, floor, redCapable } = args;
  const scope = narrowStoreScope(args.scope);
  if (scope === 'none') return false;
  if (row.revisionOfId != null) return false;
  if (!listingVisibleInStore({ status: row.status, visibility, floor })) return false;
  if (scope === 'public-external' && row.kind !== 'offsite') return false;
  if (row.kind === 'onsite' && row.appBlock?.currentVersionDeployedAt == null) return false;
  if (!redCapable && isMatureContentRating(row.contentRating)) return false;
  return true;
}
