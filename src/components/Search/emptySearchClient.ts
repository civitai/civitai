// The empty `SearchResponse` shape `@meilisearch/instant-meilisearch` / `react-instantsearch`
// expect — one entry per request, no hits. Shared so the empty-query branches in
// `search.client.ts` and `AutocompleteSearch` stay in step if the response type gains a field.
export function emptyMeiliResults(requests: readonly unknown[]) {
  return {
    results: requests.map(() => ({
      hits: [],
      nbHits: 0,
      nbPages: 0,
      page: 0,
      processingTimeMS: 0,
      hitsPerPage: 0,
      exhaustiveNbHits: false,
      query: '',
      params: '',
    })),
  };
}
