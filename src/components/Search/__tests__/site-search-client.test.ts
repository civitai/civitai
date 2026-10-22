import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/env/client', () => ({
  env: {
    NEXT_PUBLIC_SEARCH_HOST: 'http://search.test/',
    NEXT_PUBLIC_SEARCH_CLIENT_KEY: 'public-key',
  },
  formatErrors: () => [],
}));

const { isMeiliApiError, isMeiliCommunicationError } = await import(
  '~/components/Search/resilientSearchClient'
);
const { resetSearchApiKey } = await import('~/components/Search/search-api-key');
const { searchFetch } = await import('~/components/Search/site-search-client');
const { setSiteSearchProxyEnabled } = await import('~/components/Search/site-search-transport');

const fetchMock = vi.fn();
const respond = (status: number, body: unknown) =>
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));

beforeEach(() => resetSearchApiKey());
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  setSiteSearchProxyEnabled(false);
});

describe('searchFetch with siteSearchProxy on', () => {
  beforeEach(() => setSiteSearchProxyEnabled(true));

  it('sends only the path to the same origin, and no search key', async () => {
    vi.stubGlobal('fetch', fetchMock);
    respond(200, { results: [] });
    await searchFetch('http://localhost/api/search/multi-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/search/multi-search');
    expect(new Headers(init.headers).has('Authorization')).toBe(false);
  });

  // The resilient client retries and raises the "temporarily unavailable" banner for an outage,
  // and reports a rejected query without the banner. The endpoint's status picks which.
  it('an unavailable backend reads as an outage, a rejected filter as a bad query', async () => {
    vi.stubGlobal('fetch', fetchMock);
    respond(502, { code: 'search_unavailable', message: 'Search is temporarily unavailable' });
    const outage = await searchFetch('/api/search/multi-search').catch((error) => error);
    expect(isMeiliCommunicationError(outage)).toBe(true);
    expect(isMeiliApiError(outage)).toBe(false);

    respond(400, { code: 'invalid_search_filter', message: 'Attribute `x` is not filterable.' });
    const rejected = await searchFetch('/api/search/multi-search').catch((error) => error);
    expect(isMeiliApiError(rejected)).toBe(true);
    expect(isMeiliCommunicationError(rejected)).toBe(false);
  });
});

describe('searchFetch with siteSearchProxy off (the kill switch)', () => {
  it('goes straight to Meilisearch with the viewer key, not through /api/search', async () => {
    vi.stubGlobal('fetch', fetchMock);
    respond(200, { token: null }); // the token endpoint: no signing key, so the public key
    respond(200, { results: [] });
    await searchFetch('http://localhost/api/search/multi-search', { method: 'POST' });

    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('http://search.test/multi-search');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer public-key');
  });

  it('switches back to the proxy on the next request once the flag turns on', async () => {
    vi.stubGlobal('fetch', fetchMock);
    respond(200, { token: null });
    respond(200, { results: [] });
    await searchFetch('/api/search/multi-search', { method: 'POST' });

    setSiteSearchProxyEnabled(true);
    respond(200, { results: [] });
    await searchFetch('/api/search/multi-search', { method: 'POST' });
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/search/multi-search');
  });
});
