import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { env } from '~/env/server';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// `getServerAuthSession` is deliberately unmocked: the guard reads the `req.context` it
// populates, so mocking it would make these tests vacuous.
const { hubSession, bearerSession, checkRateLimit } = vi.hoisted(() => ({
  hubSession: { current: null as null | { user: Record<string, unknown> } },
  bearerSession: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/auth/bearer-token', () => ({ getSessionFromBearerToken: bearerSession }));
vi.mock('~/server/auth/session-client', () => ({
  getHubSession: vi.fn(async () => hubSession.current),
  maybeRollHubCookie: vi.fn(async () => undefined),
  maybeUpgradeLegacySession: vi.fn(async () => undefined),
  sessionClient: { getSessionUserById: vi.fn(async () => null) },
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlags: vi.fn(() => ({ appBlocks: true, canViewNsfw: false })),
}));
// The per-(subject, instance) limiter is the first step after the auth checks; refusing there
// ends the request with a status no auth check produces, so reaching it proves the caller passed.
vi.mock('~/server/services/block-token.service', () => ({
  BlockTokenService: { checkRateLimit, sign: vi.fn() },
}));

const handler = (await import('~/pages/api/v1/block-tokens')).default as unknown as (
  req: NextApiRequest,
  res: NextApiResponse
) => Promise<void>;

const USER = { id: 4242, username: 'someone', bannedAt: null, isModerator: true };

const nonOauthKey = (apiKeyType: 'User' | 'System', tokenScope: number) => ({
  user: USER,
  apiKeyId: 11,
  apiKeyType,
  subject: { type: 'apiKey', id: 11 },
  tokenScope,
  buzzLimit: null,
});
const personalKey = (tokenScope: number) => nonOauthKey('User', tokenScope);
const oauthToken = (tokenScope: number) => ({
  user: USER,
  apiKeyId: 12,
  apiKeyType: 'Access',
  subject: { type: 'oauth', id: 'client-abc' },
  tokenScope,
  buzzLimit: null,
});

async function call({
  authorization,
  queryToken,
}: { authorization?: string; queryToken?: string } = {}) {
  const req = {
    method: 'POST',
    url: queryToken ? `/api/v1/block-tokens?token=${queryToken}` : '/api/v1/block-tokens',
    headers: {
      origin: env.NEXTAUTH_URL as string,
      ...(authorization ? { authorization } : {}),
    },
    query: queryToken ? { token: queryToken } : {},
    cookies: {},
    body: { blockInstanceId: 'inst_1', slotContext: { modelId: 1, slotId: 'model.sidebar_top' } },
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as NextApiRequest;
  let statusCode = 0;
  let body: unknown;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(value: unknown) {
      body = value;
      return res;
    },
    send(value: unknown) {
      body = value;
      return res;
    },
    setHeader: () => res,
    getHeader: () => undefined,
    end: () => res,
  } as unknown as NextApiResponse;
  await handler(req, res);
  return { status: statusCode, body };
}

beforeEach(() => {
  vi.clearAllMocks();
  hubSession.current = null;
  bearerSession.mockResolvedValue(null);
  checkRateLimit.mockResolvedValue(false);
  redisMock.redis.incrBy.mockResolvedValue(1);
});

const REFUSED = {
  error: 'This action requires a signed-in session or a full-access personal API key',
};

describe('POST /api/v1/block-tokens credential requirements', () => {
  it('serves a browser session', async () => {
    hubSession.current = { user: USER };
    const { status } = await call();
    expect(status).toBe(429);
    expect(checkRateLimit).toHaveBeenCalledWith(USER.id, 'inst_1', expect.anything());
  });

  it('serves an anonymous viewer', async () => {
    const { status } = await call();
    expect(status).toBe(429);
    expect(checkRateLimit).toHaveBeenCalledWith(null, 'inst_1', expect.anything());
  });

  it('serves a personal API key holding the full scope', async () => {
    bearerSession.mockResolvedValue(personalKey(TokenScope.Full));
    const { status } = await call({ authorization: 'Bearer personal-full' });
    expect(status).toBe(429);
    expect(checkRateLimit).toHaveBeenCalledWith(USER.id, 'inst_1', expect.anything());
  });

  it('refuses a personal API key with a reduced scope', async () => {
    bearerSession.mockResolvedValue(personalKey(TokenScope.Full & ~TokenScope.UserRead));
    const { status, body } = await call({ authorization: 'Bearer personal-reduced' });
    expect(status).toBe(403);
    expect(body).toEqual(REFUSED);
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it('refuses a System API key, even with the full scope', async () => {
    bearerSession.mockResolvedValue(nonOauthKey('System', TokenScope.Full));
    const { status, body } = await call({ authorization: 'Bearer system-full' });
    expect(status).toBe(403);
    expect(body).toEqual(REFUSED);
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it('refuses an OAuth access token, including one granted the full scope', async () => {
    for (const scope of [TokenScope.Full, TokenScope.UserRead]) {
      bearerSession.mockResolvedValue(oauthToken(scope));
      const { status, body } = await call({ authorization: 'Bearer oauth-access' });
      expect(status, `OAuth token with scope ${scope}`).toBe(403);
      expect(body).toEqual(REFUSED);
    }
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it('refuses a token passed in the query string, even a full-scope personal key', async () => {
    bearerSession.mockResolvedValue(personalKey(TokenScope.Full));
    const { status, body } = await call({ queryToken: 'personal-full' });
    expect(status).toBe(403);
    expect(body).toEqual(REFUSED);
    expect(checkRateLimit).not.toHaveBeenCalled();
  });
});
