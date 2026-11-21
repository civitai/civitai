import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';
import type * as AuthSession from '~/server/auth/get-server-auth-session';
import type * as FeatureFlags from '~/server/services/feature-flags.service';
import type * as RegionBlocking from '~/server/utils/region-blocking';
import { constants } from '~/server/common/constants';
import { buildSearchRules } from '~/server/meilisearch/search-token';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { ApiKeyType } from '~/shared/utils/prisma/enums';

const { mockGetServerAuthSession, mockGetFeatureFlagsLazy, mockRateLimit, mockRegionBlocked } =
  vi.hoisted(() => ({
    mockGetServerAuthSession: vi.fn(),
    mockGetFeatureFlagsLazy: vi.fn(),
    mockRateLimit: vi.fn(),
    mockRegionBlocked: vi.fn(),
  }));

vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  getFeatureFlagsLazy: mockGetFeatureFlagsLazy,
}));

vi.mock('~/server/utils/site-search-rate-limit', () => ({
  checkSiteSearchRateLimit: mockRateLimit,
}));

vi.mock('~/server/utils/region-blocking', async (importOriginal) => ({
  ...(await importOriginal<typeof RegionBlocking>()),
  isAPIAccessBlocked: mockRegionBlocked,
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

async function requestToken(query: Record<string, string> = {}, headers = {}, context?: object) {
  const res = {
    statusCode: 200,
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
    context,
  } as unknown as NextApiRequest;
  // The wrapper swaps response methods on entry; keep the spies from before the call.
  const spies = {
    json: res.json as any,
    status: res.status as any,
    end: res.end as any,
    setHeader: res.setHeader as any,
  };
  const handler = (await import('~/pages/api/search/token')).default;
  await handler(req, res);
  const body = spies.json.mock.calls.at(-1)?.[0];
  const cacheControl = spies.setHeader.mock.calls
    .filter(([name]: [string]) => name === 'Cache-Control')
    .at(-1)?.[1];
  return {
    body,
    cacheControl,
    status: spies.status.mock.calls.at(-1)?.[0] ?? res.statusCode,
    ended: spies.end.mock.calls.at(-1)?.[0],
  };
}

const signedIn = { id: 42, isModerator: false };
const moderator = { id: 7, isModerator: true };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetServerAuthSession.mockResolvedValue(null);
  // A site that caps nothing for a signed-in viewer; capped tests narrow it.
  mockGetFeatureFlagsLazy.mockReturnValue({ canViewNsfw: true });
  mockRateLimit.mockResolvedValue({ allowed: true });
  mockRegionBlocked.mockReturnValue(false);
  setEnv({
    SEARCH_TOKEN_API_KEY: 'parent-key',
    SEARCH_TOKEN_API_KEY_UID: '6062abda-a5aa-4414-ac91-ecd7944c0f8d',
    NEXT_PUBLIC_SEARCH_HOST: 'http://localhost:7700',
  });
});
afterEach(() => resetEnv());

// A token filters top-level documents only; a model's nested images are dropped by the proxy.
// So a capped viewer must never hold a token, or nested images above the cap reach them.
describe('GET /api/search/token on a capped site', () => {
  it.each([
    ['a signed-out visitor', null, true],
    ['a signed-out visitor on the SFW site', null, false],
    ['a signed-in viewer on the SFW site', signedIn, false],
    ['a moderator on the SFW site', moderator, false],
  ])(
    'gives %s no token, so no nested image over the cap can reach them',
    async (_label, user, canViewNsfw) => {
      mockGetFeatureFlagsLazy.mockReturnValue({ canViewNsfw });
      mockGetServerAuthSession.mockResolvedValue(user ? { user } : null);
      const { body, cacheControl } = await requestToken();
      expect(body).toEqual({ token: null });
      expect(cacheControl).toBe('private, no-store');
    }
  );

  it('a client-sent verified-bot header does not earn a signed-out visitor a token', async () => {
    const { body } = await requestToken({}, { 'x-civitai-verified-bot': 'googlebot' });
    expect(body).toEqual({ token: null });
  });
});

describe('GET /api/search/token where the site caps nothing', () => {
  it('gives a signed-in viewer their rules with no level clause, never cacheable', async () => {
    mockGetServerAuthSession.mockResolvedValue({ user: signedIn });
    const { body, cacheControl } = await requestToken();
    const rules = decodeRules(body.token);
    expect(rules).toEqual(buildSearchRules({ ...signedIn, browsingLevelCap: null }));
    expect(JSON.stringify(rules)).not.toContain('nsfwLevel');
    expect(cacheControl).toBe('private, no-store');
  });

  it('takes the moderator decision from the session, not from the request', async () => {
    mockGetServerAuthSession.mockResolvedValue({ user: signedIn });
    const { body } = await requestToken(
      { isModerator: 'true', moderator: '1', mod: 'true' },
      { 'x-moderator': 'true' }
    );
    const rules = decodeRules(body.token);
    expect(rules).toEqual(buildSearchRules({ ...signedIn, browsingLevelCap: null }));
    expect(rules).not.toEqual(
      buildSearchRules({ ...signedIn, isModerator: true, browsingLevelCap: null })
    );
  });

  it('gives a moderator session the moderator rules', async () => {
    mockGetServerAuthSession.mockResolvedValue({ user: moderator });
    const { body } = await requestToken();
    expect(decodeRules(body.token)).toEqual(
      buildSearchRules({ ...moderator, browsingLevelCap: null })
    );
  });

  it.each([
    ['a scoped key', TokenScope.ModelsRead, false],
    ['a full-access key', TokenScope.Full, true],
  ])(
    'gives a moderator on %s moderator rules only when it is full access',
    async (_, tokenScope, asModerator) => {
      mockGetServerAuthSession.mockResolvedValue({ user: moderator });
      const context = {
        tokenScope,
        apiKeyId: 1,
        apiKeyType: ApiKeyType.User,
        subject: { type: 'apiKey', id: 1 },
      };
      const { body } = await requestToken({}, {}, context);
      expect(decodeRules(body.token)).toEqual(
        buildSearchRules({
          id: asModerator ? moderator.id : undefined,
          isModerator: asModerator,
          browsingLevelCap: null,
        })
      );
    }
  );

  // The caller's own poi and Private models are in the token only where tRPC would show them the owner view.
  it.each([
    ['a session', undefined, true],
    [
      'a full-access key',
      {
        tokenScope: TokenScope.Full,
        apiKeyId: 1,
        apiKeyType: ApiKeyType.User,
        subject: { type: 'apiKey', id: 1 },
      },
      true,
    ],
    [
      'a scoped key',
      {
        tokenScope: TokenScope.ModelsRead,
        apiKeyId: 1,
        apiKeyType: ApiKeyType.User,
        subject: { type: 'apiKey', id: 1 },
      },
      false,
    ],
    [
      'an app token',
      {
        tokenScope: TokenScope.Full,
        apiKeyId: 2,
        apiKeyType: ApiKeyType.Access,
        subject: { type: 'oauth', id: 'client-abc' },
      },
      false,
    ],
  ])(
    'a signed-in viewer on %s gets their own models in the token only with the owner view',
    async (_, context, own) => {
      mockGetServerAuthSession.mockResolvedValue({ user: signedIn });
      const { body } = await requestToken({}, {}, context);
      expect(decodeRules(body.token)).toEqual(
        buildSearchRules({
          id: own ? signedIn.id : undefined,
          isModerator: false,
          browsingLevelCap: null,
        })
      );
    }
  );

  it('gives the system account moderator rules on its own scoped key', async () => {
    const system = { id: constants.system.user.id, isModerator: true };
    mockGetServerAuthSession.mockResolvedValue({ user: system });
    const context = {
      tokenScope: TokenScope.ModelsRead,
      apiKeyId: 3,
      apiKeyType: ApiKeyType.User,
      subject: { type: 'apiKey', id: 3 },
    };
    const { body } = await requestToken({}, {}, context);
    expect(decodeRules(body.token)).toEqual(
      buildSearchRules({ ...system, browsingLevelCap: null })
    );
  });

  it('answers { token: null } while no signing key is configured', async () => {
    mockGetServerAuthSession.mockResolvedValue({ user: signedIn });
    setEnv({ SEARCH_TOKEN_API_KEY: undefined, SEARCH_TOKEN_API_KEY_UID: undefined });
    const { body, cacheControl } = await requestToken();
    expect(body).toEqual({ token: null });
    expect(cacheControl).toBe('private, no-store');
  });
});

describe('GET /api/search/token, request policy', () => {
  it('a viewer over the search rate limit gets a 429 and no token', async () => {
    mockGetServerAuthSession.mockResolvedValue({ user: signedIn });
    mockRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 5 });
    const { status, body } = await requestToken();
    expect(status).toBe(429);
    expect(body?.token).toBeUndefined();
  });

  it('a blocked region gets a 451 and no token', async () => {
    mockGetServerAuthSession.mockResolvedValue({ user: signedIn });
    mockRegionBlocked.mockReturnValue(true);
    const { status, body, ended } = await requestToken();
    expect(status).toBe(451);
    expect(body).toBeUndefined();
    expect(String(ended)).toContain('not available in your region');
  });
});
