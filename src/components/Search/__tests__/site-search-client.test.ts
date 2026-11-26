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
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer public-key' },
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
    respond(200, { token: 'tok-1', expiresAt: Date.now() + 3_600_000 });
    respond(200, { results: [] });
    await searchFetch('http://localhost/api/search/multi-search', { method: 'POST' });

    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('http://search.test/multi-search');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer tok-1');
  });

  it.each([
    ['the server mints no token', () => respond(200, { token: null })],
    ['the token endpoint fails', () => respond(500, { message: 'down' })],
    [
      'the token endpoint is unreachable',
      () => fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')),
    ],
  ])('searches through /api/search with no key when %s', async (_label, tokenResponse) => {
    vi.stubGlobal('fetch', fetchMock);
    tokenResponse();
    respond(200, { results: [] });
    await searchFetch('http://localhost/api/search/multi-search', {
      method: 'POST',
      headers: { Authorization: 'Bearer public-key' },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2); // the token route, then the proxy only
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe('/api/search/multi-search');
    expect(new Headers(init.headers).get('Authorization')).toBeNull();
  });

  it('switches back to the proxy on the next request once the flag turns on', async () => {
    vi.stubGlobal('fetch', fetchMock);
    respond(200, { token: 'tok-1', expiresAt: Date.now() + 3_600_000 });
    respond(200, { results: [] });
    await searchFetch('/api/search/multi-search', { method: 'POST' });

    setSiteSearchProxyEnabled(true);
    respond(200, { results: [] });
    await searchFetch('/api/search/multi-search', { method: 'POST' });
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/search/multi-search');
  });
});

describe('searchFetch on the token path: collections go through /api/search only', () => {
  const COLLECTIONS = 'collections_v3';
  const token = () => respond(200, { token: 'tok-1', expiresAt: Date.now() + 3_600_000 });
  const multi = (queries: object[], extra: object = {}) =>
    searchFetch('http://localhost/api/search/multi-search', {
      method: 'POST',
      body: JSON.stringify({ queries, ...extra }),
    });
  const sentQueries = (call: unknown[]) =>
    JSON.parse((call[1] as RequestInit).body as string).queries;

  it('a single-index collections search goes to the proxy, without the token', async () => {
    vi.stubGlobal('fetch', fetchMock);
    token();
    respond(200, { hits: [] });
    await searchFetch(`http://localhost/api/search/indexes/${COLLECTIONS}/search`, {
      method: 'POST',
      body: '{}',
    });
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe(`/api/search/indexes/${COLLECTIONS}/search`);
    expect(new Headers(init.headers).get('Authorization')).toBeNull();
  });

  it('a mixed multi-search sends collections to the proxy and the rest, unchanged, to Meilisearch', async () => {
    vi.stubGlobal('fetch', fetchMock);
    token();
    const models = { indexUid: 'models_v9', q: 'cat', filter: ['type = LORA'], limit: 5 };
    const articles = { indexUid: 'articles_v5', q: 'cat' };
    const collections = { indexUid: COLLECTIONS, q: 'cat' };
    // Requests leave in order: the proxy part, then the direct part.
    respond(200, { results: [{ indexUid: COLLECTIONS, hits: ['c'] }] });
    respond(200, {
      results: [
        { indexUid: 'models_v9', hits: ['m'] },
        { indexUid: 'articles_v5', hits: ['a'] },
      ],
    });

    const body = await multi([models, collections, articles]);

    const [proxyCall, directCall] = fetchMock.mock.calls.slice(1);
    expect(proxyCall[0]).toBe('/api/search/multi-search');
    expect(sentQueries(proxyCall)).toEqual([collections]);
    expect(new Headers((proxyCall[1] as RequestInit).headers).get('Authorization')).toBeNull();
    expect(directCall[0]).toBe('http://search.test/multi-search');
    // Exactly the queries, and the token, the direct path would have sent on its own.
    expect(sentQueries(directCall)).toEqual([models, articles]);
    expect(new Headers((directCall[1] as RequestInit).headers).get('Authorization')).toBe(
      'Bearer tok-1'
    );
    expect(body.results.map((r: { hits: string[] }) => r.hits[0])).toEqual(['m', 'c', 'a']);
  });

  it('control: a multi-search without collections goes straight to Meilisearch, once', async () => {
    vi.stubGlobal('fetch', fetchMock);
    token();
    respond(200, { results: [] });
    await multi([{ indexUid: 'models_v9', q: 'cat' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe('http://search.test/multi-search');
  });

  it('a federated multi-search, which the proxy does not serve, stays on the token path', async () => {
    vi.stubGlobal('fetch', fetchMock);
    token();
    respond(200, { hits: [] });
    await multi([{ indexUid: COLLECTIONS }, { indexUid: 'models_v9' }], { federation: {} });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe('http://search.test/multi-search');
  });
});
