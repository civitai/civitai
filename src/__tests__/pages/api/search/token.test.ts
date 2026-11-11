import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';
import type * as AuthSession from '~/server/auth/get-server-auth-session';
import type * as FeatureFlags from '~/server/services/feature-flags.service';
import type * as BrowsingLevel from '~/server/utils/browsing-level';
import { COMICS_SEARCH_INDEX, MODELS_SEARCH_INDEX } from '~/server/common/constants';
import { buildSearchRules } from '~/server/meilisearch/search-token';
import { publicBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

const { mockGetServerAuthSession, mockGetFeatureFlagsLazy, mockDomainCap } = vi.hoisted(() => ({
  mockGetServerAuthSession: vi.fn(),
  mockGetFeatureFlagsLazy: vi.fn(),
  mockDomainCap: vi.fn(),
}));

// Real cap by default. A signed-in viewer's real cap is SFW, which is also the fail-closed
// default, so tests that must prove the cap is forwarded override it with a different one.
vi.mock('~/server/utils/browsing-level', async (importOriginal) => {
  const actual = await importOriginal<typeof BrowsingLevel>();
  mockDomainCap.mockImplementation(actual.requestDomainBrowsingLevelCap);
  return { ...actual, requestDomainBrowsingLevelCap: mockDomainCap };
});

vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  getFeatureFlagsLazy: mockGetFeatureFlagsLazy,
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
    url: '/api/search/token',
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
  // civitai.com: signed out PG, signed in PG/PG-13.
  mockGetFeatureFlagsLazy.mockReturnValue({ canViewNsfw: false });
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
    expect(decodeRules(body.token)).toEqual(
      buildSearchRules({ browsingLevelCap: publicBrowsingLevelsFlag })
    );
    expect(cacheControl).toBe('private, no-store');
  });

  it('takes the moderator decision from the session, not from the request', async () => {
    mockGetServerAuthSession.mockResolvedValue({ user: { id: 42, isModerator: false } });
    mockDomainCap.mockReturnValueOnce(publicBrowsingLevelsFlag);
    const { body } = await requestToken(
      { isModerator: 'true', moderator: '1', mod: 'true' },
      { 'x-moderator': 'true' }
    );
    const browsingLevelCap = publicBrowsingLevelsFlag;
    expect(decodeRules(body.token)).toEqual(
      buildSearchRules({ id: 42, isModerator: false, browsingLevelCap })
    );
    expect(decodeRules(body.token)).not.toEqual(
      buildSearchRules({ id: 42, isModerator: true, browsingLevelCap })
    );
  });

  it('gives a moderator session the moderator rules, still held to the site level', async () => {
    mockGetServerAuthSession.mockResolvedValue({ user: { id: 7, isModerator: true } });
    mockDomainCap.mockReturnValueOnce(publicBrowsingLevelsFlag);
    const { body } = await requestToken();
    const rules = decodeRules(body.token);
    expect(rules).toEqual(
      buildSearchRules({ id: 7, isModerator: true, browsingLevelCap: publicBrowsingLevelsFlag })
    );
    expect(rules).not.toEqual(buildSearchRules({ id: 7, isModerator: true }));
    expect(rules[MODELS_SEARCH_INDEX].filter).toContain('nsfwLevel');
    expect(rules[COMICS_SEARCH_INDEX].filter).toContain('nsfwLevel');
  });

  it('holds a signed-out token to PG', async () => {
    const { body } = await requestToken();
    const rules = decodeRules(body.token);
    expect(rules[COMICS_SEARCH_INDEX].filter).toBe(
      'nsfwLevel IS NOT EMPTY AND nsfwLevel NOT IN [2, 4, 8, 16, 32]'
    );
    expect(rules[MODELS_SEARCH_INDEX].filter).toBe(
      '((poi != true) AND (availability != Private)) AND (nsfwLevel=1)'
    );
  });

  it('a signed-in viewer where the site caps nothing gets no level clause', async () => {
    mockGetFeatureFlagsLazy.mockReturnValue({ canViewNsfw: true });
    mockGetServerAuthSession.mockResolvedValue({ user: { id: 42, isModerator: false } });
    const { body } = await requestToken();
    expect(JSON.stringify(decodeRules(body.token))).not.toContain('nsfwLevel');
  });

  it('a client-sent verified-bot header does not lift the signed-out cap', async () => {
    mockGetFeatureFlagsLazy.mockReturnValue({ canViewNsfw: true });
    const { body } = await requestToken({}, { 'x-civitai-verified-bot': 'googlebot' });
    expect(decodeRules(body.token)).toEqual(
      buildSearchRules({ browsingLevelCap: publicBrowsingLevelsFlag })
    );
  });

  it('answers { token: null } while no signing key is configured', async () => {
    setEnv({ SEARCH_TOKEN_API_KEY: undefined, SEARCH_TOKEN_API_KEY_UID: undefined });
    const { body, cacheControl } = await requestToken();
    expect(body).toEqual({ token: null });
    expect(cacheControl).toBe('private, no-store');
  });
});
