/**
 * App Store Listings (W13) — P3a off-site URL guard (PURE, client-safe).
 *
 * A defense-in-depth scheme guard for the mod/author surfaces that render a
 * user-supplied `externalUrl` as a clickable anchor. The submit + approve procs
 * already re-validate that a stored `externalUrl` is https (see
 * `offsite-listing.service.ts`), but the review/my-submissions tables render the
 * raw stored value — this guard ensures a non-https value (e.g. a legacy row, or
 * a `javascript:`/`data:` value that slipped past an older code path) is shown as
 * INERT TEXT, never as an anchor a moderator can click.
 *
 * Deliberately NOT importing the server-only `safeExternalUrl` from
 * `app-listing.service.ts` (that pulls the server graph into a client bundle).
 */
export function isHttpsUrl(u: unknown): u is string {
  return typeof u === 'string' && /^https:\/\//i.test(u);
}
