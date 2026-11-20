import type { dbWrite } from '~/server/db/client';
import { offlineAccessJustification } from '~/shared/constants/token-scope.constants';

// What an App Store connect listing says about its OAuth client's offline access, read on the site
// side. The auth hub decides the grant from the same rows in its own DB layer
// (apps/auth/src/lib/server/oauth/listing-offline.ts); a change to either definition here changes
// what the hub does, so change both.

type ClientListingRow = {
  id: string;
  kind: string;
  status: string;
  revisionOfId: string | null;
  connectScopeJustifications: unknown;
};

/**
 * Whether a listing in `rows`, other than `excludeListingIds`, is an approved top-level off-site
 * listing that declares offline access. `rows` are the listings of one OAuth client.
 */
export function otherApprovedListingDeclaresOffline(
  rows: ClientListingRow[],
  excludeListingIds: string[]
): boolean {
  return rows.some(
    (r) =>
      r.kind === 'offsite' &&
      r.status === 'approved' &&
      r.revisionOfId === null &&
      !excludeListingIds.includes(r.id) &&
      offlineAccessJustification(r.connectScopeJustifications) != null
  );
}

/**
 * Another approved listing on this OAuth client declares offline access, so the hub keeps granting
 * it to the client whatever `excludeListingIds` (one app's listing and its live parent) say.
 */
export async function anotherApprovedListingDeclaresOffline(
  client: Pick<typeof dbWrite, 'appListing'>,
  opts: { connectClientId: string; excludeListingIds: string[] }
): Promise<boolean> {
  const rows = await client.appListing.findMany({
    where: { connectClientId: opts.connectClientId },
    select: {
      id: true,
      kind: true,
      status: true,
      revisionOfId: true,
      connectScopeJustifications: true,
    },
  });
  return otherApprovedListingDeclaresOffline(rows, opts.excludeListingIds);
}

/**
 * Whether the listing was ever live, whatever its status now: it is `approved` or `removed`
 * (removed is only reachable from live), an `approved` publish request points at it, or it has a
 * moderation event. The hub's `anyEverLive` is the same rule over the same rows.
 */
export async function listingEverLive(
  client: Pick<typeof dbWrite, 'appListingPublishRequest' | 'appListingModerationEvent'>,
  listing: { id: string; status: string }
): Promise<boolean> {
  if (listing.status === 'approved' || listing.status === 'removed') return true;
  const approvedRequest = await client.appListingPublishRequest.findFirst({
    where: { appListingId: listing.id, status: 'approved' },
    select: { id: true },
  });
  if (approvedRequest) return true;
  const event = await client.appListingModerationEvent.findFirst({
    where: { appListingId: listing.id },
    select: { id: true },
  });
  return event != null;
}
