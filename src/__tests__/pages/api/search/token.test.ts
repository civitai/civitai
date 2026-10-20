import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';
import type * as AuthSession from '~/server/auth/get-server-auth-session';
import { buildSearchRules } from '~/server/meilisearch/search-token';

const { mockGetServerAuthSession } = vi.hoisted(() => ({ mockGetServerAuthSession: vi.fn() }));

// `~/env/client` validates at import and throws on a missing NEXT_PUBLIC_* var.
vi.mock('~/env/client', () => ({
  env: { NEXT_PUBLIC_BASE_URL: 'http://localhost:3000' },
  formatErrors: () => [],
}));

vi.mock('~/server/auth/get-server-auth-session', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthSession>()),
  getServerAuthSession: mockGetServerAuthSession,
}));

const decodeRules = (token: string) =>
  JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8')).searchRules;

async function requestToken(query: Record<string, string> = {}, headers = {}) {
  const res = {
    status: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
    getHeader: vi.fn(),
  } as unknown as NextApiResponse;
  const req = {
    method: 'GET',
    headers: { host: 'example.test', ...headers },
    cookies: {},
    query,
    socket: { remoteAddress: '10.0.0.1' },
  } as unknown as NextApiRequest;
  // The wrapper swaps response methods on entry; keep the spies from before the call.
  const spies = { json: res.json as any, setHeader: res.setHeader as any };
  const handler = (await import('~/pages/api/search/token')).default;
  await handler(req, res);
  const body = spies.json.mock.calls.at(-1)?.[0];
  const cacheControl = spies.setHeader.mock.calls
    .filter(([name]: [string]) => name === 'Cache-Control')
    .at(-1)?.[1];
  return { body, cacheControl };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetServerAuthSession.mockResolvedValue(null);
  setEnv({
    SEARCH_TOKEN_API_KEY: 'parent-key',
    SEARCH_TOKEN_API_KEY_UID: '6062abda-a5aa-4414-ac91-ecd7944c0f8d',
    NEXT_PUBLIC_SEARCH_HOST: 'http://localhost:7700',
  });
});
afterEach(() => resetEnv());

describe('GET /api/search/token', () => {
  it('gives an anonymous caller the anonymous rules, never cacheable', async () => {
    const { body, cacheControl } = await requestToken();
    expect(decodeRules(body.token)).toEqual(buildSearchRules(null));
    expect(cacheControl).toBe('private, no-store');
  });

  it('takes the moderator decision from the session, not from the request', async () => {
    mockGetServerAuthSession.mockResolvedValue({ user: { id: 42, isModerator: false } });
    const { body } = await requestToken(
      { isModerator: 'true', moderator: '1', mod: 'true' },
      { 'x-moderator': 'true' }
    );
    expect(decodeRules(body.token)).toEqual(buildSearchRules({ id: 42, isModerator: false }));
    expect(decodeRules(body.token)).not.toEqual(buildSearchRules({ id: 42, isModerator: true }));
  });

  it('gives a moderator session the unfiltered rules', async () => {
    mockGetServerAuthSession.mockResolvedValue({ user: { id: 7, isModerator: true } });
    const { body } = await requestToken();
    expect(decodeRules(body.token)).toEqual(buildSearchRules({ id: 7, isModerator: true }));
  });

  it('answers { token: null } while no signing key is configured', async () => {
    setEnv({ SEARCH_TOKEN_API_KEY: undefined, SEARCH_TOKEN_API_KEY_UID: undefined });
    const { body, cacheControl } = await requestToken();
    expect(body).toEqual({ token: null });
    expect(cacheControl).toBe('private, no-store');
  });
});
