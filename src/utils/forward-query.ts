/**
 * Rebuilds a request's query string for a redirect `destination`, dropping the route params that are
 * already encoded in the new path. A Next.js `getServerSideProps` destination is used verbatim, so a
 * path without this silently discards the query — which is how `/bounties/entries/{id}?highlight=…`
 * was losing the comment a notification pointed at.
 *
 * `URLSearchParams` percent-encodes `#`, `@`, `/`, `\` and CR/LF, so a crafted param can't escape the
 * path or reach the Location header. Callers must still build the path itself from trusted values.
 */
export function forwardQuery(
  query: Record<string, string | string[] | undefined>,
  omit: string[] = []
) {
  const pairs: [string, string][] = [];
  for (const [key, value] of Object.entries(query)) {
    if (omit.includes(key) || value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) pairs.push([key, v]);
  }

  const search = new URLSearchParams(pairs).toString();
  return search ? `?${search}` : '';
}
