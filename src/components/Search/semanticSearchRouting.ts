import type { InstantSearchProps } from 'react-instantsearch';
import type { RequestParams } from '~/components/Search/semanticImageSearchClient';

type SearchClient = NonNullable<InstantSearchProps['searchClient']>;
type SearchRequests = Parameters<SearchClient['search']>[0];

/**
 * A search client that answers the requests `isRouted` picks with `searchIndex` and sends the
 * rest to `client` in one call, keeping each result at its request's position.
 */
export function routeToSemanticSearch(
  client: SearchClient,
  isRouted: (indexName: string) => boolean,
  searchIndex: (indexName: string, params: RequestParams) => Promise<unknown>
): SearchClient {
  return {
    ...client,
    async search(requests: SearchRequests) {
      const routed = requests.map((r) => isRouted(r.indexName));
      if (!routed.some(Boolean)) return client.search(requests);

      const others = requests.filter((_, i) => !routed[i]);
      const [otherResponse, routedResults] = await Promise.all([
        others.length ? client.search(others) : Promise.resolve({ results: [] }),
        Promise.all(
          requests.map((request, i) =>
            routed[i]
              ? searchIndex(request.indexName, (request.params ?? {}) as RequestParams)
              : undefined
          )
        ),
      ]);
      let next = 0;
      return {
        results: requests.map((_, i) =>
          routed[i] ? routedResults[i] : (otherResponse.results as unknown[])[next++]
        ),
      };
    },
  } as unknown as SearchClient;
}
