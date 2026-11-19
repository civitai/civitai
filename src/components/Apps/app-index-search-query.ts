/**
 * The `query` the `/apps` store grid sends to `appListings.listAvailable`, or undefined to send
 * none (and so keep the request, and its react-query key, exactly as without the feature).
 *
 * Sent only when the `app-index-search` flag is on AND the server has said this viewer's searches
 * can go to the app index (`indexSearchRoutable` on a page it answered; the server decides, since
 * it alone knows the viewer's audience floor and store scope). Until then, and for every viewer the
 * index never answers, the search stays the client-side filter over loaded pages.
 */
export function appIndexServerQuery(args: {
  flagOn: boolean;
  /** The last `indexSearchRoutable` a page carried; undefined before any page said. */
  serverRoutable: boolean | undefined;
  /** The debounced search box text. */
  search: string;
}): string | undefined {
  if (!args.flagOn || args.serverRoutable !== true) return undefined;
  const q = args.search.trim();
  return q === '' ? undefined : q;
}
