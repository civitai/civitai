import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/env/client', () => ({
  env: {
    NEXT_PUBLIC_SEARCH_HOST: 'http://search.test',
    NEXT_PUBLIC_SEARCH_CLIENT_KEY: 'public-key',
  },
  formatErrors: () => [],
}));

const { getSearchApiKey, resetSearchApiKey, searchFetch } = await import(
  '~/components/Search/search-api-key'
);

const SEARCH_URL = 'http://search.test/multi-search';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Answers the token endpoint from `tokens` (in order) and records the key each search carried. */
function stubNetwork(tokens: unknown[], searchStatus: (key: string | null) => number = () => 200) {
  const searchKeys: (string | null)[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/search/token') return json(tokens.shift() ?? { token: null });
    const auth = new Headers(init?.headers).get('Authorization');
    const key = auth?.replace('Bearer ', '') ?? null;
    searchKeys.push(key);
    const status = searchStatus(key);
    return status === 200
      ? json({ results: [] })
      : json({ message: 'The provided API key is invalid.', code: 'invalid_api_key' }, status);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, searchKeys };
}

const tokenCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter(([url]) => url === '/api/search/token').length;

beforeEach(() => resetSearchApiKey());
afterEach(() => vi.unstubAllGlobals());

describe('searchFetch', () => {
  it('without a signing key on the server, searches with the public key as before', async () => {
    const { fetchMock, searchKeys } = stubNetwork([{ token: null }]);
    await searchFetch(SEARCH_URL, { method: 'POST', headers: { Authorization: 'Bearer x' } });
    await searchFetch(SEARCH_URL, { method: 'POST' });

    expect(searchKeys).toEqual(['public-key', 'public-key']);
    // Asked once per page load, not per search.
    expect(tokenCalls(fetchMock)).toBe(1);
  });

  it('with a token, every search carries the token instead of the public key', async () => {
    const { searchKeys } = stubNetwork([{ token: 'tok-1', expiresAt: Date.now() + 3_600_000 }]);
    await searchFetch(SEARCH_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer public-key' },
    });
    expect(searchKeys).toEqual(['tok-1']);
  });

  it('refreshes a token that is about to expire', async () => {
    const { searchKeys } = stubNetwork([
      { token: 'tok-1', expiresAt: Date.now() + 60_000 },
      { token: 'tok-2', expiresAt: Date.now() + 3_600_000 },
    ]);
    await searchFetch(SEARCH_URL, { method: 'POST' });
    await searchFetch(SEARCH_URL, { method: 'POST' });
    expect(searchKeys).toEqual(['tok-1', 'tok-2']);
  });

  it('retries once with a fresh token when Meilisearch rejects the current one', async () => {
    const { searchKeys } = stubNetwork(
      [
        { token: 'revoked', expiresAt: Date.now() + 3_600_000 },
        { token: 'tok-2', expiresAt: Date.now() + 3_600_000 },
      ],
      (key) => (key === 'revoked' ? 403 : 200)
    );
    await expect(searchFetch(SEARCH_URL, { method: 'POST' })).resolves.toEqual({ results: [] });
    expect(searchKeys).toEqual(['revoked', 'tok-2']);
  });

  it('throws an error the resilient client classifies as a Meilisearch API error', async () => {
    stubNetwork([{ token: null }], () => 403);
    await expect(searchFetch(SEARCH_URL, { method: 'POST' })).rejects.toMatchObject({
      name: 'MeiliSearchApiError',
      code: 'invalid_api_key',
      httpStatus: 403,
    });
  });

  it('falls back to the public key while the token endpoint is unreachable', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(getSearchApiKey()).resolves.toBe('public-key');
  });
});
