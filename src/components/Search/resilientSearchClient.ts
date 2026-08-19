import { faro } from '@grafana/faro-web-sdk';
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
 * This wrapper catches everything `.search` (and `.searchForFacetValues` when
 * present) can throw and resolves to a VALID empty InstantSearch response, so
 * react-instantsearch renders a normal empty state instead of crashing. The error
 * is NEVER re-thrown. What happens next depends on WHOSE fault it was:
 *
 *   - COMMUNICATION error (Meili unreachable) — optionally retried for a transient
 *     blip, then reported to the caller via `onError` so it can render a
 *     distinguishable "temporarily unavailable" banner.
 *   - API error (Meili answered, with a 4xx describing a query WE built wrong —
 *     e.g. `invalid_search_filter` / `invalid_search_facets`) — never retried, and
 *     deliberately NOT routed through `onError`: search was reachable, so the
 *     "temporarily unavailable" banner would tell the user to retry something that
 *     can never work and would hide a real bug inside the outage signal. Reported to
 *     Faro RUM + the console instead; the user sees the ordinary empty state.
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

const MEILI_API_ERROR_NAME = 'meilisearchapierror';

/**
 * Faro exception `type` and console prefix for a Meili-rejected query. One token so
 * a Loki query and a `grep` of a browser console find the same thing.
 */
export const MEILI_QUERY_ERROR_TYPE = 'MeiliSearchQueryError';

/** Distinct query errors reported per client instance, so a bad filter can't beacon per keystroke. */
const MAX_REPORTED_QUERY_ERRORS = 10;

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
 * True when Meili ANSWERED and rejected the request as malformed — the transport worked,
 * the query did not. `httpStatus` is authoritative when present, so a Meili 5xx stays on
 * the "unavailable" path; the name/message fallbacks exist because the adapter's `.search`
 * rethrows as `new Error(e_1)`, which drops the class, `code` and `httpStatus` and
 * leaves the original name only inside the message.
 */
export function isMeiliApiError(err: unknown): boolean {
  if (!err) return false;

  const httpStatus = (err as { httpStatus?: unknown })?.httpStatus;
  if (typeof httpStatus === 'number') return httpStatus >= 400 && httpStatus < 500;

  if (toLowerString((err as { name?: unknown })?.name) === MEILI_API_ERROR_NAME) return true;
  return toLowerString((err as { message?: unknown })?.message).includes(MEILI_API_ERROR_NAME);
}

function errorSignature(error: unknown): string {
  const name = toLowerString((error as { name?: unknown })?.name);
  const code = toLowerString((error as { code?: unknown })?.code);
  const message = toLowerString((error as { message?: unknown })?.message);
  return `${name}|${code}|${message}`;
}

function indexNamesOf(requests: readonly unknown[] | undefined): string {
  const names = new Set<string>();
  for (const request of requests ?? []) {
    const indexName = (request as { indexName?: unknown })?.indexName;
    if (typeof indexName === 'string' && indexName) names.add(indexName);
  }
  return [...names].join(',');
}

/**
 * Report to Faro RUM (where it lands untagged, i.e. `error_category: real`) AND the
 * console: Faro only runs in production for a sampled session, so the console line is
 * the only signal a developer building a malformed filter locally ever gets.
 *
 * Carries index names but never the user's query.
 */
function reportQueryError(error: unknown, requests: readonly unknown[] | undefined) {
  const indexes = indexNamesOf(requests);
  const code = (error as { code?: unknown })?.code;
  const httpStatus = (error as { httpStatus?: unknown })?.httpStatus;

  try {
    const pushError = faro?.api?.pushError?.bind(faro.api);
    pushError?.(error instanceof Error ? error : new Error(String(error)), {
      type: MEILI_QUERY_ERROR_TYPE,
      context: {
        ...(typeof code === 'string' && code ? { code } : {}),
        ...(typeof httpStatus === 'number' ? { httpStatus: String(httpStatus) } : {}),
        ...(indexes ? { indexes } : {}),
      },
    });
  } catch {
    // Reporting must never break the search render.
  }

  console.error(`[${MEILI_QUERY_ERROR_TYPE}] Meilisearch rejected our query`, {
    indexes,
    error,
  });
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
  /** Invoked once when a search falls back to empty results because Meili was UNREACHABLE. */
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
  const reportedSignatures = new Set<string>();

  const handleFailure = (error: unknown, requests: readonly unknown[] | undefined) => {
    if (!isMeiliApiError(error)) {
      onError?.(error);
      return;
    }
    const signature = errorSignature(error);
    if (reportedSignatures.has(signature) || reportedSignatures.size >= MAX_REPORTED_QUERY_ERRORS)
      return;
    reportedSignatures.add(signature);
    reportQueryError(error, requests);
  };

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
    handleFailure(lastError, requests);
    return emptySearchResults(requests);
  };

  const resilientFacetSearch = async (requests: FacetRequests) => {
    const baseFacetSearch = client.searchForFacetValues;
    try {
      const response = await baseFacetSearch!.call(client, requests);
      onSuccess?.();
      return response;
    } catch (error) {
      handleFailure(error, requests);
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
