import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  createResilientSearchClient,
  isMeiliApiError,
  isMeiliCommunicationError,
  MEILI_QUERY_ERROR_TYPE,
} from '~/components/Search/resilientSearchClient';

// The SDK's `faro` export is a bare `{}` until `initializeFaro` runs, which never happens
// in test — so the reporting path has to be driven by standing an `api` on it.
const { faro } = vi.hoisted(() => ({ faro: {} as Record<string, unknown> }));
vi.mock('@grafana/faro-web-sdk', () => ({ faro }));

const pushError = vi.fn();
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  pushError.mockClear();
  for (const key of Object.keys(faro)) delete faro[key];
  Object.assign(faro, { api: { pushError } });
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => consoleError.mockRestore());

// Minimal fake requests shaped like what react-instantsearch passes through.
const twoRequests = [
  { indexName: 'models', params: { query: 'cat' } },
  { indexName: 'images', params: { query: 'cat' } },
] as any;

const okResponse = {
  results: [
    { hits: [{ id: 1 }], nbHits: 1, page: 0, nbPages: 1, hitsPerPage: 1, processingTimeMS: 3, query: 'cat', params: '' },
  ],
} as any;

const commError = Object.assign(new Error('NetworkError when attempting to fetch resource'), {
  name: 'MeiliSearchCommunicationError',
});

// What Meilisearch answers with when a query names an attribute it can't filter on —
// the `/search/comics` bug this split exists for.
const apiError = Object.assign(new Error('Attribute `genre` is not filterable.'), {
  name: 'MeiliSearchApiError',
  code: 'invalid_search_facets',
  type: 'invalid_request',
  httpStatus: 400,
});

// `@meilisearch/instant-meilisearch`'s `.search` rethrows as `new Error(e_1)`, so on
// the real `/search` path the class, `code` and `httpStatus` are gone by the time we see it.
const rewrappedApiError = new Error(String(apiError));

function makeClient(overrides: Record<string, any> = {}) {
  return {
    search: vi.fn(),
    searchForFacetValues: vi.fn(),
    clearCache: vi.fn(),
    ...overrides,
  } as any;
}

describe('isMeiliCommunicationError', () => {
  it('matches the MeiliSearchCommunicationError name (any casing)', () => {
    expect(isMeiliCommunicationError({ name: 'MeiliSearchCommunicationError' })).toBe(true);
  });

  it('matches network-ish messages across browser engines', () => {
    expect(isMeiliCommunicationError(new Error('NetworkError when attempting to fetch'))).toBe(true);
    expect(isMeiliCommunicationError(new Error('Failed to fetch'))).toBe(true);
    expect(isMeiliCommunicationError(new Error('Load failed'))).toBe(true);
  });

  it('does not match unrelated / falsy errors', () => {
    expect(isMeiliCommunicationError(null)).toBe(false);
    expect(isMeiliCommunicationError(undefined)).toBe(false);
    expect(isMeiliCommunicationError(new Error('invalid_request: bad filter'))).toBe(false);
  });

  it('does not match a query the server answered and rejected', () => {
    expect(isMeiliCommunicationError(apiError)).toBe(false);
    expect(isMeiliCommunicationError(rewrappedApiError)).toBe(false);
  });
});

describe('isMeiliApiError', () => {
  it('matches a MeiliSearchApiError by name', () => {
    expect(isMeiliApiError(apiError)).toBe(true);
  });

  it('matches the adapter-rewrapped form, where only the message survives', () => {
    expect(rewrappedApiError.name).toBe('Error'); // the class really is gone
    expect('httpStatus' in rewrappedApiError).toBe(false);
    expect(isMeiliApiError(rewrappedApiError)).toBe(true);
  });

  it('needs a query-rejection shape, not merely a 4xx', () => {
    expect(isMeiliApiError({ httpStatus: 400 })).toBe(false);
    expect(isMeiliApiError({ httpStatus: 404 })).toBe(false);
    expect(isMeiliApiError({ httpStatus: '400' })).toBe(false);
  });

  it('leaves auth, quota and rate-limit answers on the availability path', () => {
    const meiliError = (message: string, httpStatus: number, code: string) =>
      Object.assign(new Error(message), { name: 'MeiliSearchApiError', code, httpStatus });

    expect(isMeiliApiError(meiliError('The provided API key is invalid.', 401, 'invalid_api_key'))).toBe(false);
    expect(isMeiliApiError(meiliError('forbidden', 403, 'invalid_api_key'))).toBe(false);
    expect(isMeiliApiError(meiliError('too many requests', 429, 'too_many_requests'))).toBe(false);
  });

  it('lets a present httpStatus outrank the name — a Meili 5xx is not our bug', () => {
    const serverError = Object.assign(new Error('Attribute `genre` is not filterable.'), {
      name: 'MeiliSearchApiError',
      code: 'invalid_search_facets',
      httpStatus: 500,
    });
    expect(isMeiliApiError(serverError)).toBe(false);
  });

  it('does not match a communication error or a falsy value', () => {
    expect(isMeiliApiError(commError)).toBe(false);
    expect(isMeiliApiError(new Error(String(commError)))).toBe(false);
    expect(isMeiliApiError(null)).toBe(false);
    expect(isMeiliApiError(undefined)).toBe(false);
  });
});

describe('createResilientSearchClient — happy path', () => {
  it('passes the base response through untouched and calls onSuccess (not onError)', async () => {
    const onError = vi.fn();
    const onSuccess = vi.fn();
    const base = makeClient({ search: vi.fn().mockResolvedValue(okResponse) });

    const client = createResilientSearchClient(base, { onError, onSuccess });
    const result = await client.search!(twoRequests);

    expect(result).toBe(okResponse); // byte-identical reference — no transformation
    expect(base.search).toHaveBeenCalledTimes(1);
    expect(base.search).toHaveBeenCalledWith(twoRequests);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('preserves other client members (spread + searchForFacetValues wrapped)', () => {
    const base = makeClient();
    const client = createResilientSearchClient(base);
    expect(typeof client.search).toBe('function');
    expect(typeof (client as any).clearCache).toBe('function');
    expect(typeof client.searchForFacetValues).toBe('function');
  });
});

describe('createResilientSearchClient — communication error fallback', () => {
  it('returns a valid empty response (no throw) and sets the unavailable flag via onError', async () => {
    const onError = vi.fn();
    const onSuccess = vi.fn();
    const base = makeClient({ search: vi.fn().mockRejectedValue(commError) });

    const client = createResilientSearchClient(base, {
      onError,
      onSuccess,
      retryDelayMs: 0,
    });

    const result = await client.search!(twoRequests);

    // Valid empty InstantSearch response, same arity as the requests.
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toEqual({
      hits: [],
      nbHits: 0,
      nbPages: 0,
      page: 0,
      processingTimeMS: 0,
      hitsPerPage: 0,
      exhaustiveNbHits: false,
      query: '',
      params: '',
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(commError);
    expect(onSuccess).not.toHaveBeenCalled();
    // An outage is not an app bug — it must not land in the RUM error stream.
    expect(pushError).not.toHaveBeenCalled();
  });

  it('retries a transient comm error exactly once, then falls back', async () => {
    const search = vi.fn().mockRejectedValue(commError);
    const client = createResilientSearchClient(makeClient({ search }), { retryDelayMs: 0 });

    const result = await client.search!(twoRequests);

    // default retries = 1 → initial attempt + one retry = 2 calls
    expect(search).toHaveBeenCalledTimes(2);
    expect(result.results).toHaveLength(2);
  });

  it('recovers if the retry succeeds — returns the response, calls onSuccess not onError', async () => {
    const onError = vi.fn();
    const onSuccess = vi.fn();
    const search = vi.fn().mockRejectedValueOnce(commError).mockResolvedValueOnce(okResponse);
    const client = createResilientSearchClient(makeClient({ search }), {
      onError,
      onSuccess,
      retryDelayMs: 0,
    });

    const result = await client.search!(twoRequests);

    expect(search).toHaveBeenCalledTimes(2);
    expect(result).toBe(okResponse);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('does NOT retry a non-communication error — falls back after one attempt', async () => {
    const onError = vi.fn();
    const badQueryError = new Error('invalid_request: unknown filter field');
    const search = vi.fn().mockRejectedValue(badQueryError);
    const client = createResilientSearchClient(makeClient({ search }), {
      onError,
      retryDelayMs: 0,
    });

    const result = await client.search!(twoRequests);

    expect(search).toHaveBeenCalledTimes(1); // no retry for non-transient errors
    expect(result.results).toHaveLength(2);
    // Unclassifiable — neither a known comm error nor a Meili API rejection. It keeps the
    // pre-split behaviour (banner, no report) so the fallback direction stays conservative.
    expect(onError).toHaveBeenCalledWith(badQueryError);
    expect(pushError).not.toHaveBeenCalled();
  });

  it('handles an empty requests array without crashing', async () => {
    const client = createResilientSearchClient(
      makeClient({ search: vi.fn().mockRejectedValue(commError) }),
      { retryDelayMs: 0 }
    );
    const result = await client.search!([] as any);
    expect(result.results).toEqual([]);
  });

  it('still raises the banner for an auth 4xx — a bad key is an incident, not a bad filter', async () => {
    const authError = Object.assign(new Error('The provided API key is invalid.'), {
      name: 'MeiliSearchApiError',
      code: 'invalid_api_key',
      httpStatus: 403,
    });
    const onError = vi.fn();
    const client = createResilientSearchClient(
      makeClient({ search: vi.fn().mockRejectedValue(authError) }),
      { onError, retryDelayMs: 0 }
    );

    const result = await client.search!(twoRequests);

    expect(result.results[0].hits).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('createResilientSearchClient — Meili rejected OUR query (4xx)', () => {
  it.each([
    ['a structured MeiliSearchApiError', apiError],
    ['the adapter-rewrapped form', rewrappedApiError],
  ])('%s: empty results, no availability banner, reported instead', async (_label, thrown) => {
    const onError = vi.fn();
    const onSuccess = vi.fn();
    const search = vi.fn().mockRejectedValue(thrown);

    const client = createResilientSearchClient(makeClient({ search }), {
      onError,
      onSuccess,
      retryDelayMs: 0,
    });
    const result = await client.search!(twoRequests);

    expect(result.results).toHaveLength(2);
    expect(result.results[0].hits).toEqual([]);
    // The whole point: search WAS reachable, so the "temporarily unavailable" banner is a lie.
    expect(onError).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(search).toHaveBeenCalledTimes(1); // retrying a malformed query can't help
    expect(pushError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it('tags the RUM beacon and carries the indexes, never the query', async () => {
    const client = createResilientSearchClient(
      makeClient({ search: vi.fn().mockRejectedValue(apiError) }),
      { retryDelayMs: 0 }
    );
    await client.search!(twoRequests);

    expect(pushError).toHaveBeenCalledWith(apiError, {
      type: MEILI_QUERY_ERROR_TYPE,
      context: { code: 'invalid_search_facets', httpStatus: '400', indexes: 'models,images' },
    });
    expect(JSON.stringify(pushError.mock.calls[0][1])).not.toContain('cat');
  });

  it('reports the same failing query ONCE, not once per keystroke', async () => {
    const client = createResilientSearchClient(
      makeClient({ search: vi.fn().mockRejectedValue(apiError) }),
      { retryDelayMs: 0 }
    );

    for (let i = 0; i < 5; i++) await client.search!(twoRequests);

    expect(pushError).toHaveBeenCalledTimes(1);
  });

  it('still reports when Faro is not initialised (bare `{}` export)', async () => {
    for (const key of Object.keys(faro)) delete faro[key];

    const client = createResilientSearchClient(
      makeClient({ search: vi.fn().mockRejectedValue(apiError) }),
      { retryDelayMs: 0 }
    );
    const result = await client.search!(twoRequests);

    expect(result.results).toHaveLength(2);
    expect(consoleError).toHaveBeenCalledTimes(1);
  });
});

describe('createResilientSearchClient — searchForFacetValues', () => {
  it('swallows a facet-search error and returns valid empty facet results', async () => {
    const onError = vi.fn();
    const base = makeClient({
      searchForFacetValues: vi.fn().mockRejectedValue(commError),
    });
    const client = createResilientSearchClient(base, { onError, retryDelayMs: 0 });

    const requests = [{ indexName: 'models', params: {} }, { indexName: 'images', params: {} }] as any;
    const result = await client.searchForFacetValues!(requests);

    expect(result).toEqual([
      { facetHits: [], exhaustiveFacetsCount: true, processingTimeMS: 0 },
      { facetHits: [], exhaustiveFacetsCount: true, processingTimeMS: 0 },
    ]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('splits the same way on a 4xx — empty facets, reported, no banner', async () => {
    const onError = vi.fn();
    const base = makeClient({ searchForFacetValues: vi.fn().mockRejectedValue(apiError) });
    const client = createResilientSearchClient(base, { onError, retryDelayMs: 0 });

    const result = await client.searchForFacetValues!([
      { indexName: 'models', params: {} },
    ] as any);

    expect(result).toEqual([{ facetHits: [], exhaustiveFacetsCount: true, processingTimeMS: 0 }]);
    expect(onError).not.toHaveBeenCalled();
    expect(pushError).toHaveBeenCalledTimes(1);
  });

  it('passes facet results through on success', async () => {
    const facetResponse = [{ facetHits: [{ value: 'x', count: 3 }], exhaustiveFacetsCount: true }];
    const base = makeClient({
      searchForFacetValues: vi.fn().mockResolvedValue(facetResponse),
    });
    const client = createResilientSearchClient(base);
    const result = await client.searchForFacetValues!([{ indexName: 'models', params: {} }] as any);
    expect(result).toBe(facetResponse);
  });

  it('leaves searchForFacetValues undefined when the base client lacks it', () => {
    const base = { search: vi.fn(), clearCache: vi.fn() } as any;
    const client = createResilientSearchClient(base);
    expect(client.searchForFacetValues).toBeUndefined();
  });
});
