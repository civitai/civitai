/**
 * App Listing OWNERSHIP TRANSFER — the strings both sides of the wire have to agree on.
 *
 * 🔴 IN `shared/` SO THERE IS EXACTLY ONE COPY. The refusal below is produced by the
 * server and rendered verbatim by the Collaborators tab, and the component test asserts
 * the rendered text against it. Leaving it in the service would have forced that test to
 * either import a module whose graph reaches the database client, or to keep a
 * hand-copied paraphrase — and a paraphrase is exactly how a user-facing message drifts
 * out from under the assertion that is supposed to pin it.
 *
 * `app-ownership-transfer.service.ts` imports and RE-EXPORTS it, so every existing
 * server-side import keeps working and there is still only one definition.
 */

/**
 * The message a connect-linked off-site listing is refused with, at initiate AND again
 * in-transaction at accept. Asserted verbatim on both sides.
 *
 * 🔴 IT NAMES A REMEDY. Moving an off-site listing that carries an `OauthClient` would
 * either hand over live credentials the recipient never asked for, or split ownership
 * between the listing and the client. Both are refused; "unlink the OAuth client first"
 * is the one thing the owner can actually do about it, so the UI must not swallow this
 * into a generic error.
 */
export const CONNECT_CLIENT_TRANSFER_REFUSAL =
  'This listing is linked to an OAuth application. Ownership transfer would either hand ' +
  'over that application’s credentials or split ownership between the listing and the ' +
  'client, so it is not available for connect listings. Unlink the OAuth client first.';

/**
 * 🔴 THE ONE PREDICATE for "may this listing's ownership move?", written once so the
 * initiate-time check, the in-tx accept-time re-assert, and the COLLABORATORS TAB cannot
 * drift apart.
 *
 * On-site listings are unaffected: their connect column is always null (an on-site
 * listing's OauthClient is reached through the AppBlock, and THAT one does move).
 *
 * 🔴 IT MOVED HERE FROM `app-ownership-transfer.service.ts`, FOR THE SAME REASON THE
 * MESSAGE ABOVE DID, and the reason is a shipped defect rather than tidiness. The
 * Collaborators tab needs this verdict BEFORE the owner picks a recipient — otherwise the
 * transfer control renders enabled on a listing the server will always refuse, and the
 * owner learns that only after choosing someone. The tab cannot import the service (its
 * module graph reaches the database client), so the choice was "a second copy of the rule
 * in the component" or "one copy both sides import". A second copy is how the UI and the
 * server end up disagreeing about who may transfer. The service RE-EXPORTS this, so every
 * existing server-side import keeps working and there is still only one definition.
 */
export function refusesTransferForConnectClient(listing: {
  kind: string;
  connectClientId: string | null;
}): boolean {
  return listing.kind === 'offsite' && listing.connectClientId != null;
}
