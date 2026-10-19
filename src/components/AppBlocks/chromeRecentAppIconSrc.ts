/**
 * The one decision behind each "Recently run" row's icon in the app-block chrome: which url,
 * if any, it may draw. Pure, so the node `unit` project covers it (the browser suites are not
 * run in CI).
 *
 * 🔴 THE ONLY INPUT IS THE LIVE, SERVER-GATED LISTING READ. The icon comes from
 * `appListings.getAppDetail` (through `useChromeListingDetail`), whose `iconUrl` the server
 * has already put through `listing-media-audience.ts` for THIS request: the host's red
 * capability, the viewer's browsing level and the listing's `content_rating`, with blocked,
 * unrated, pending and moderation-flagged images returned as `null`. Nothing here re-decides
 * visibility, and nothing here can see a recents entry: the recents store never keeps an icon
 * url (`recentlyOpenedAppsStore.ts`), and `selectChromeRecentApps` strips one from any entry
 * it is handed, so a url that came from localStorage has no path to this function.
 *
 * FAIL CLOSED. Loading, an error (a 404 for a listing that is missing, unapproved, scope-,
 * deploy- or maturity-gated, or any other fault), an absent row, and a gated-out icon all
 * return `null`, and the caller draws the generic app glyph for `null`. An error wins over
 * data React Query may still hold from an earlier success.
 */
export function chromeRecentAppIconSrc(read: {
  detail: { iconUrl: string | null } | undefined;
  isLoading: boolean;
  error: unknown;
}): string | null {
  if (read.isLoading || read.error) return null;
  const url = read.detail?.iconUrl;
  return typeof url === 'string' && url.length > 0 ? url : null;
}
