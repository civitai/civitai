import { describe, it, expect, vi } from 'vitest';
import {
  createResilientSearchClient,
  isMeiliCommunicationError,
} from '~/components/Search/resilientSearchClient';

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
    expect(onError).toHaveBeenCalledWith(badQueryError);
  });

  it('handles an empty requests array without crashing', async () => {
    const client = createResilientSearchClient(
      makeClient({ search: vi.fn().mockRejectedValue(commError) }),
      { retryDelayMs: 0 }
    );
    const result = await client.search!([] as any);
    expect(result.results).toEqual([]);
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
