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
 * 🔴 IT STATES A CONSTRAINT AND DOES NOT INSTRUCT — AND THE REASON RECORDED HERE UNTIL
 * #4126 WAS FALSE. It used to read "there is no unlink path", justified by an enumeration
 * of `data:` payloads writing `AppListing.connectClientId`. That
 * enumeration is sound about CALL SITES and structurally blind to a writer declared in the
 * SCHEMA: the relation is `connectClient OauthClient? @relation(..., onDelete: SetNull)`,
 * so deleting the `OauthClient` row issues `UPDATE app_listings SET connect_client_id =
 * NULL` on every listing referencing it, and `oauth-client.router::delete` performs
 * exactly that delete with no referencing-`AppListing` check (its only guard,
 * `rejectAppBlockClient`, covers App*Block* clients, which these are not).
 * **An owner-initiated route out of this refusal therefore EXISTS TODAY.** Do not re-derive
 * the old premise; it has been measured false once already.
 *
 * 🔴 THE COPY STILL NAMES NO REMEDY, NOW ON ITS MERITS RATHER THAN ON THAT PREMISE. #4126
 * re-took the decision with the route known to exist, and kept the constraint-only wording
 * for four reasons that survive it:
 *
 *   1. THE ROUTE IS NOT AN UNLINK, IT IS A DESTRUCTION. There is no "detach the client"
 *      operation; the only lever is deleting the OAuth application, which the delete
 *      confirmation in `OAuthAppsCard` itself describes as revoking every token and
 *      disconnecting every user. Copy that names it as the prerequisite for a listing
 *      transfer makes an irreversible act on a LIVE integration read as routine paperwork.
 *   2. ITS EFFECT ON THE LISTING IS SILENT AND UNWANTED. `SetNull` nulls the listing's
 *      `connectClientId`, stranding the `connectRequestedScopes` /
 *      `connectScopeJustifications` a moderator approved — and on an OAuth-connected
 *      listing with no `externalUrl` it leaves an approved listing whose primary CTA has
 *      no `href`, i.e. exactly the state `assertOffsiteListingActionable` exists to refuse
 *      at go-live. The "remedy" would walk the owner into a shape the go-live gate rejects.
 *   3. IT IS NOT RELIABLY AVAILABLE TO WHOEVER READS THE STRING.
 *      `loadConnectClientForListing` BYPASSES its owner check for a moderator, so a
 *      mod may link a client the listing owner does not own, while `oauthClient.delete`
 *      scopes on `userId: ctx.user.id` — on that shape the instruction is simply false for
 *      the owner. It is ALWAYS false for the recipient: this same constant is what
 *      `acceptBlockedReason` carries to `AppTransferOffersView`, and an offeree owns
 *      neither the listing nor the client. One string, two audiences, one of whom can
 *      never take the action.
 *   4. THE REFUSAL IS A DELIBERATE v1 CONSTRAINT, NOT AN OBSTACLE. Moving OAuth credentials
 *      is a materially different act from handing over a store listing (see the module
 *      header of `app-ownership-transfer.service.ts`). Copy that names a way around it
 *      implies transfer is MEANT to be reachable that way, and implicitly endorses the
 *      degraded listing in (2) as the intended path.
 *
 * 🔴 AND IT IS AN ALWAYS-ON BANNER, WHICH RAISES THE COST OF EVERY WORD. Since the tab
 * learned to refuse up front, whatever this says sits on the Collaborators tab on every
 * visit — so a remedy here is not advice taken once at a failure, it is a standing
 * invitation. Nothing points at support or docs either: inventing a "contact support"
 * route would swap one unverified promise for another.
 *
 * 🔴 IT IS READ IN TWO PLACES AND MUST PARSE IN BOTH — as a tRPC error message at the API,
 * and as banner prose in the tab. Keep it a single self-contained sentence for that reason.
 *
 * 🔴 WHAT WOULD REOPEN THIS: a real detach affordance (clear the column, keep the client),
 * or a delete confirmation that states the listing consequence, would make a remedy
 * truthful and safe to name. Either is a PRODUCT change and belongs with the code that
 * implements it. Until then the exact wording below is pinned by
 * `app-ownership-transfer.service.test.ts` — a whole-string equality, because a guard on
 * the word "unlink" alone is walkable by rewording.
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
