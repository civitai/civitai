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
 * in-transaction at accept — and, since the tab learned to refuse up front, the banner an
 * owner reads on every visit to the Collaborators tab of such a listing.
 *
 * 🔴 IT STATES A CONSTRAINT AND DOES NOT INSTRUCT. It used to end "Unlink the OAuth client
 * first", and that sentence was WRONG about this product: there is no unlink path.
 * `connectClientId` is REQUIRED at submit (`submitExternalListingSchema`, `z.string()
 * .min(1).max(64)`), it is immutable on edit (`offsite-listing.service::…` says so in as
 * many words), and the only writer of `connectClientId: null` anywhere in `src/server` is
 * `app-listing-mapper.ts`, which MINTS a listing from an AppBlock rather than unlinking an
 * existing one. So the remedy named an action the owner could not take.
 *
 * 🔴 THAT WAS SURVIVABLE WHILE THE STRING ONLY APPEARED AFTER A FAILED MUTATION, AND IS
 * NOT NOW. Promoting the refusal to an always-on banner promotes a false instruction to an
 * always-on instruction — a permanent dead end, on a surface whose whole purpose is to
 * stop the owner wasting effort. Nothing points at support or docs either: inventing a
 * "contact support" route would swap one unverified promise for another.
 *
 * 🔴 IT IS READ IN TWO PLACES AND MUST PARSE IN BOTH — as a tRPC error message at the API,
 * and as banner prose in the tab. Keep it a single self-contained sentence for that reason.
 * Adding a remedy later is a PRODUCT change (an unlink flow) and belongs with the code that
 * implements it, not here.
 */
export const CONNECT_CLIENT_TRANSFER_REFUSAL =
  'This listing is linked to an OAuth application, so its ownership cannot be transferred: ' +
  'moving it would either hand over that application’s credentials or split ownership ' +
  'between the listing and the client.';

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
