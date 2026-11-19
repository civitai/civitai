/**
 * Whether a `/apps` store card matches the store's text search: its name or tagline contains the
 * query, case-insensitively. The one rule for the client-side filter over loaded pages
 * (`AppListingsMarketplaceBody`) and for the server code that has to agree with it
 * (`app-index-search.service.ts`: the sub-listing cards it merges into an index answer, and the
 * comparison log's database side).
 *
 * `query` is used as given apart from trimming and case; an empty query matches every card.
 */
export function storeGridCardMatches(
  card: { name: string; tagline?: string | null },
  query: string
): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  return card.name.toLowerCase().includes(q) || (card.tagline ?? '').toLowerCase().includes(q);
}
