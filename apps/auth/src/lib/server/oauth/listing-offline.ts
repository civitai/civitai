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
// The read: the listing rows themselves, from the database the hub already reads `OauthConsent`
// and `ApiKey` in. That is the least coupled way to see them. A call to the main app would add a
// network hop and a second service whose outage changes token issuance, and a copy of the flag on
// the client row would need a writer to keep it in step with every approve, delist and edit.
//
// LISTED means EVER LIVE: the client has a listing that has been approved, i.e. one now
// `approved` or `removed` (a removed listing was live, or it could not have been taken down or
// unpublished). A draft or pending first submission, or a rejected one, changes nothing for the
// app's existing users: the client keeps the unlisted rule until a listing goes live. A delisted
// app stays listed, so it does not fall back to the unlisted rule and regain offline access.
//
// Only `approved` listings DECLARE. A pending edit of a live listing sits on a shadow revision,
// which is always a draft, so its declaration counts only once approve copies it onto the live
// listing.
//
// Fail-closed: if the listings cannot be read, no client gets offline access for that request.
// The hub cannot tell a connect client from any other without the read, and granting a refresh
// token by mistake lasts 30 days, where refusing one only costs the user a sign-in later.

export type ClientOfflineListing = 'unlisted' | 'declared' | 'undeclared';

/** A listing in one of these has been approved at some point: it went live. */
const EVER_LIVE_STATUSES = ['approved', 'removed'];

/** What the client's connect listings say about offline access. Throws if they cannot be read. */
export async function readClientOfflineListing(clientId: string): Promise<ClientOfflineListing> {
  const rows = await db
    .selectFrom('app_listings')
    .select(['status', 'connect_scope_justifications'])
    .where('connect_client_id', '=', clientId)
    .where('kind', '=', 'offsite')
    .where('status', 'in', EVER_LIVE_STATUSES)
    .execute();
  if (rows.length === 0) return 'unlisted';
  return rows.some(
    (r) => r.status === 'approved' && offlineAccessJustification(r.connect_scope_justifications)
  )
    ? 'declared'
    : 'undeclared';
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
