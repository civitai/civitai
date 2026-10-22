import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';
import type * as AuthSession from '~/server/auth/get-server-auth-session';
import type * as FeatureFlags from '~/server/services/feature-flags.service';
import { MODELS_SEARCH_INDEX, USERS_SEARCH_INDEX } from '~/server/common/constants';

const { mockGetServerAuthSession, mockGetFeatureFlagsLazy, mockRateLimit } = vi.hoisted(() => ({
  mockGetServerAuthSession: vi.fn(),
  mockGetFeatureFlagsLazy: vi.fn(),
  mockRateLimit: vi.fn(),
}));

vi.mock('~/server/utils/site-search-rate-limit', () => ({
  checkSiteSearchRateLimit: mockRateLimit,
}));

// `~/env/client` validates at import and throws on a missing NEXT_PUBLIC_* var.
vi.mock('~/env/client', () => ({
  env: { NEXT_PUBLIC_BASE_URL: 'http://localhost:3000' },
  formatErrors: () => [],
}));

vi.mock('~/server/auth/get-server-auth-session', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthSession>()),
  getServerAuthSession: mockGetServerAuthSession,
}));

vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  getFeatureFlagsLazy: mockGetFeatureFlagsLazy,
}));

const fetchMock = vi.fn();

async function post(path: string[], body: unknown) {
  const res = {
    status: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
    getHeader: vi.fn(),
  } as unknown as NextApiResponse;
  const req = {
    method: 'POST',
    headers: { host: 'example.test' },
    cookies: {},
    query: { path },
    body,
    socket: { remoteAddress: '10.0.0.1' },
  } as unknown as NextApiRequest;
  // The wrapper swaps response methods on entry; keep the spies from before the call.
  const spies = {
    json: res.json as any,
    status: res.status as any,
    setHeader: res.setHeader as any,
  };
  const handler = (await import('~/pages/api/search/[...path]')).default;
  await handler(req, res);
  return {
    status: spies.status.mock.calls.at(-1)?.[0],
    body: spies.json.mock.calls.at(-1)?.[0],
    cacheControl: spies.setHeader.mock.calls
      .filter(([name]: [string]) => name === 'Cache-Control')
      .at(-1)?.[1],
    retryAfter: spies.setHeader.mock.calls
      .filter(([name]: [string]) => name === 'Retry-After')
      .at(-1)?.[1],
  };
}

const sentQueries = () => JSON.parse(fetchMock.mock.calls.at(-1)[1].body).queries;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockImplementation(
    async () =>
      new Response(JSON.stringify({ results: [{ indexUid: MODELS_SEARCH_INDEX, hits: [] }] }))
  );
  mockGetServerAuthSession.mockResolvedValue(null);
  mockGetFeatureFlagsLazy.mockReturnValue({ canViewNsfw: true });
  mockRateLimit.mockResolvedValue({ allowed: true });
  setEnv({ NEXT_PUBLIC_SEARCH_HOST: 'http://search.test', SEARCH_TOKEN_API_KEY: 'server-key' });
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetEnv();
});

describe('POST /api/search/multi-search', () => {
  it('holds an anonymous query to the viewer clauses and drops params the UI never sends', async () => {
    const { status, cacheControl } = await post(['multi-search'], {
      queries: [
        { indexUid: MODELS_SEARCH_INDEX, q: 'x', filter: 'type = LORA', hybrid: { embedder: 'e' } },
      ],
    });
    expect(status).toBe(200);
    expect(cacheControl).toBe('private, no-store');
    expect(fetchMock.mock.calls[0][0]).toBe('http://search.test/multi-search');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer server-key');
    const [query] = sentQueries();
    expect(query).not.toHaveProperty('hybrid');
    expect(query.filter).toEqual([
      'type = LORA',
      'poi != true',
      'availability != Private',
      'nsfwLevel=1',
    ]);
  });

  it('takes the moderator decision from the session, not from the request', async () => {
    mockGetServerAuthSession.mockResolvedValue({ user: { id: 42, isModerator: false } });
    await post(['multi-search'], {
      isModerator: true,
      queries: [{ indexUid: MODELS_SEARCH_INDEX, q: '', isModerator: true }],
    });
    expect(sentQueries()[0].filter).toContain('poi != true OR user.id = 42');

    mockGetServerAuthSession.mockResolvedValue({ user: { id: 7, isModerator: true } });
    await post(['multi-search'], { queries: [{ indexUid: MODELS_SEARCH_INDEX, q: '' }] });
    expect(sentQueries()[0].filter).toBeUndefined();
  });

  it('caps a signed-in viewer on civitai.com to PG and PG-13', async () => {
    mockGetServerAuthSession.mockResolvedValue({ user: { id: 42, isModerator: true } });
    mockGetFeatureFlagsLazy.mockReturnValue({ canViewNsfw: false });
    await post(['multi-search'], { queries: [{ indexUid: MODELS_SEARCH_INDEX, q: '' }] });
    expect(sentQueries()[0].filter).toEqual(['nsfwLevel=1 OR nsfwLevel=2']);
  });

  it('refuses an index the site does not search, without calling the backend', async () => {
    const { status } = await post(['multi-search'], {
      queries: [
        { indexUid: USERS_SEARCH_INDEX, q: '' },
        { indexUid: 'models', q: '' },
      ],
    });
    expect(status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a backend that refuses our key as unavailable, not as a bad query', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: 'invalid_api_key' }), { status: 403 })
    );
    const { status, body } = await post(['multi-search'], {
      queries: [{ indexUid: MODELS_SEARCH_INDEX, q: '' }],
    });
    expect(status).toBe(502);
    expect(body.code).toBe('search_unavailable');
  });
});

describe('rate limit', () => {
  it('a viewer over the limit gets a 429 with Retry-After, and the backend is not called', async () => {
    mockGetServerAuthSession.mockResolvedValue({ user: { id: 42 } });
    mockRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 17 });
    const res = await post(['multi-search'], {
      queries: [{ indexUid: MODELS_SEARCH_INDEX, q: 'x' }],
    });
    expect(res.status).toBe(429);
    expect(res.retryAfter).toBe('17');
    expect(res.body).toMatchObject({ code: 'too_many_requests' });
    expect(mockRateLimit).toHaveBeenCalledWith(expect.objectContaining({ userId: 42 }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('other paths', () => {
  it('only the three search paths exist', async () => {
    for (const path of [
      ['indexes', MODELS_SEARCH_INDEX, 'documents'],
      ['keys'],
      ['indexes', MODELS_SEARCH_INDEX, 'settings'],
    ]) {
      expect((await post(path, {})).status).toBe(404);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
