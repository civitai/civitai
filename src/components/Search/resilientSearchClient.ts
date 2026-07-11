import type { InstantSearchProps } from 'react-instantsearch';

/**
 * Resilient wrapper around a react-instantsearch `searchClient`.
 *
 * A Meilisearch backend blip surfaces to the browser as an UNCAUGHT
 * `MeiliSearchCommunicationError: NetworkError when attempting to fetch resource`
 * thrown out of the vendored `@meilisearch/instant-meilisearch` adapter. That
 * uncaught throw both spams Faro RUM (~1.6k/3h, 95% on `/search`) and breaks the
 * search UX for the user during the blip.
 *
 * This wrapper catches communication/network errors from `.search`
 * (and `.searchForFacetValues` when present), optionally retries once for
 * transient blips, and — if it still can't reach Meili — resolves to a VALID
 * empty InstantSearch response so react-instantsearch renders a normal empty
 * state instead of crashing. The error is NEVER re-thrown, so it stops being an
 * uncaught exception. Callers can observe the failure via `onError`/`onSuccess`
 * to surface a distinguishable "temporarily unavailable" banner (as opposed to a
 * misleading "no results found").
 *
 * Happy path is untouched: on a successful `.search` the base client's response
 * is returned verbatim (only `onSuccess` is invoked to clear any prior banner).
 */

type SearchClient = NonNullable<InstantSearchProps['searchClient']>;
type SearchMethod = SearchClient['search'];
type SearchRequests = Parameters<SearchMethod>[0];
type FacetRequests = Parameters<NonNullable<SearchClient['searchForFacetValues']>>[0];

// Lower-cased substrings that identify a Meili communication / network / connectivity
// failure. Covers the browser fetch wordings across engines (Firefox "NetworkError
// when attempting to fetch resource", Chrome "Failed to fetch", Safari "Load failed")
// plus the adapter's own error class name.
const COMMUNICATION_ERROR_SUBSTRINGS = [
  'networkerror',
  'failed to fetch',
  'load failed',
  'network request failed',
  'communication',
  'err_network',
  'err_connection',
  'err_internet_disconnected',
  'connection refused',
  'the network connection was lost',
];

function toLowerString(value: unknown): string {
  if (typeof value === 'string') return value.toLowerCase();
  if (value == null) return '';
  try {
    return String(value).toLowerCase();
  } catch {
    return '';
  }
}

/**
 * True for the transient Meili connectivity errors we want to retry + swallow.
 * Non-communication errors (e.g. a malformed-query 4xx) are still swallowed to
 * empty results by the wrapper, but are NOT retried and do not match here.
 */
export function isMeiliCommunicationError(err: unknown): boolean {
  if (!err) return false;
  const name = toLowerString((err as { name?: unknown })?.name);
  if (name === 'meilisearchcommunicationerror') return true;

  const message = toLowerString((err as { message?: unknown })?.message);
  const cause = toLowerString((err as { cause?: unknown })?.cause);
  return COMMUNICATION_ERROR_SUBSTRINGS.some(
    (needle) => message.includes(needle) || cause.includes(needle)
  );
}

/**
 * A valid, empty InstantSearch multi-search response of the same arity as the
 * incoming requests. Matches the shape react-instantsearch expects (mirrors the
 * empty-query short-circuit already used in `search.client.ts`).
 */
function emptySearchResults(requests: SearchRequests) {
  return {
    results: (requests ?? []).map(() => ({
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

function emptyFacetResults(requests: readonly unknown[]) {
  return (requests ?? []).map(() => ({
    facetHits: [],
    exhaustiveFacetsCount: true,
    processingTimeMS: 0,
  }));
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type ResilientSearchClientOptions = {
  /** Number of retries for a transient communication error before falling back. Default 1. */
  retries?: number;
  /** Delay (ms) between the failed attempt and the retry. Default 250. */
  retryDelayMs?: number;
  /** Invoked once when a search ultimately falls back to empty results (Meili unreachable). */
  onError?: (error: unknown) => void;
  /** Invoked on every successful search — lets callers clear a prior "unavailable" state. */
  onSuccess?: () => void;
};

/**
 * Wrap a react-instantsearch `searchClient` so a Meili outage degrades gracefully
 * to an empty result set instead of throwing an uncaught exception.
 */
export function createResilientSearchClient<T extends SearchClient>(
  client: T,
  options: ResilientSearchClientOptions = {}
): T {
  const { retries = 1, retryDelayMs = 250, onError, onSuccess } = options;

  const resilientSearch = async (requests: SearchRequests) => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await client.search(requests);
        onSuccess?.();
        return response;
      } catch (error) {
        lastError = error;
        // Only retry transient communication blips; a non-comm error won't get
        // better on retry, so fall back immediately.
        if (attempt < retries && isMeiliCommunicationError(error)) {
          await delay(retryDelayMs);
          continue;
        }
        break;
      }
    }
    onError?.(lastError);
    return emptySearchResults(requests);
  };

  const resilientFacetSearch = async (requests: FacetRequests) => {
    const baseFacetSearch = client.searchForFacetValues;
    try {
      const response = await baseFacetSearch!.call(client, requests);
      onSuccess?.();
      return response;
    } catch (error) {
      onError?.(error);
      return emptyFacetResults(requests);
    }
  };

  // The library's `search`/`searchForFacetValues` are generic over the hit type
  // (`<TObject>`). A concrete wrapper can't preserve that variance while also
  // awaiting the result for retry logic, so we assemble the object and cast once
  // at the boundary — the wrapper is generic-transparent at runtime (it either
  // returns the base client's response verbatim or a valid empty response of the
  // same shape). `searchForFacetValues` is only added when the base client
  // implements it (the Meili adapter does).
  return {
    ...client,
    search: resilientSearch,
    ...(typeof client.searchForFacetValues === 'function'
      ? { searchForFacetValues: resilientFacetSearch }
      : {}),
  } as unknown as T;
}
