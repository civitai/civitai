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
