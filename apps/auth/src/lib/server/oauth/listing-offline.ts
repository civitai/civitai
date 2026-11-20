import { offlineAccessJustification } from '@civitai/auth/token-scope';
import { db } from '$lib/server/db/db';
import { logAxiomError } from '$lib/server/axiom';

// Offline access for App Store CONNECT apps (flag `oauth-offline-grant` only; offline-grant.ts).
//
// An OAuth client that backs an off-site connect listing gets offline access (the "Stay connected"
// line, a refresh token, a sliding chain) only when one of its APPROVED listings declares
// `offline_access` with a justification. An undeclared listed client never gets it. A client no
// listing points at (Civitai's own apps, first-party spokes, plain OAuth apps) is not affected.
//
// LISTED means EVER LIVE: one of the client's listings has been approved at some point, whatever
// its status now. A formerly-live listing can sit in `pending` (a moderator's reset to pending, or
// an owner republish after an asset change), so status alone cannot tell. Any of these says it was
// live:
//   - its status is `approved` or `removed` (removed is only reachable from live);
//   - an `approved` publish request points at it (every approve leaves one);
//   - it has a moderation event (every moderation action applies to a listing that was live).
// A client whose listings are only first-time drafts, pending first submissions or rejected ones
// keeps the unlisted rule, so a first submission changes nothing for the app's existing users. A
// delisted app stays listed, so it does not regain offline access through the unlisted rule.
//
// Only `approved` listings DECLARE. A pending edit of a live listing sits on a shadow revision,
// which is always a draft, so its declaration counts only once approve copies it onto the live
// listing.
//
// Fail-closed: if the listings cannot be read, no client gets offline access for that request.
// The hub cannot tell a connect client from any other without the read, and granting a refresh
// token by mistake lasts 30 days, where refusing one only costs the user a sign-in later.

export type ClientOfflineListing = 'unlisted' | 'declared' | 'undeclared';

/** What the client's connect listings say about offline access. Throws if they cannot be read. */
export async function readClientOfflineListing(clientId: string): Promise<ClientOfflineListing> {
  const rows = await db
    .selectFrom('app_listings')
    .select(['id', 'status', 'connect_scope_justifications'])
    .where('connect_client_id', '=', clientId)
    .where('kind', '=', 'offsite')
    .execute();
  if (rows.length === 0) return 'unlisted';
  if (
    rows.some(
      (r) => r.status === 'approved' && offlineAccessJustification(r.connect_scope_justifications)
    )
  ) {
    return 'declared';
  }
  return (await anyEverLive(rows)) ? 'undeclared' : 'unlisted';
}

async function anyEverLive(rows: { id: string; status: string }[]): Promise<boolean> {
  if (rows.some((r) => r.status === 'approved' || r.status === 'removed')) return true;
  const ids = rows.map((r) => r.id);
  const approvedRequest = await db
    .selectFrom('app_listing_publish_requests')
    .select(['id'])
    .where('app_listing_id', 'in', ids)
    .where('status', '=', 'approved')
    .executeTakeFirst();
  if (approvedRequest) return true;
  const event = await db
    .selectFrom('app_listing_moderation_events')
    .select(['id'])
    .where('app_listing_id', 'in', ids)
    .executeTakeFirst();
  return event != null;
}

/**
 * Whether the hub may offer or issue offline access to this client: an unlisted client, or a listed
 * one whose approved listing declares it. `false` when the listings cannot be read.
 */
export async function offlineAllowedForClient(clientId: string): Promise<boolean> {
  try {
    return (await readClientOfflineListing(clientId)) !== 'undeclared';
  } catch (err) {
    void logAxiomError(err, { name: 'oauth.offline.listing-read-failed', clientId });
    return false;
  }
}
