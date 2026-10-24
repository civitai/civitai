import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { envMock } from '~/__tests__/mocks/env.mock';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// `MixedAuthEndpoint` and `getServerAuthSession` are deliberately unmocked: the guard reads the
// `req.context` they populate, so mocking them would make these tests vacuous.
const { hubSession, bearerSession, createFreshdeskToken } = vi.hoisted(() => ({
  hubSession: { current: null as null | { user: Record<string, unknown> } },
  bearerSession: vi.fn(),
  createFreshdeskToken: vi.fn(async () => 'minted-id-token'),
}));

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/auth/bearer-token', () => ({ getSessionFromBearerToken: bearerSession }));
vi.mock('~/server/auth/session-client', () => ({
  getHubSession: vi.fn(async () => hubSession.current),
  maybeRollHubCookie: vi.fn(async () => undefined),
  maybeUpgradeLegacySession: vi.fn(async () => undefined),
  sessionClient: { getSessionUserById: vi.fn(async () => null) },
}));
vi.mock('~/server/integrations/freshdesk', () => ({
  createFreshdeskToken,
  upsertContact: vi.fn(),
}));

const handler = (await import('~/pages/api/auth/freshdesk')).default as unknown as (
  req: NextApiRequest,
  res: NextApiResponse
) => Promise<void>;

const SSO_URL = 'https://support.example.test/sso';
const USER = { id: 4242, username: 'someone', email: 'someone@example.test', bannedAt: null };

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
    method: 'GET',
    url: `/api/auth/freshdesk?nonce=n&state=s${queryToken ? `&token=${queryToken}` : ''}`,
    headers: { host: 'civitai.com', ...(authorization ? { authorization } : {}) },
    query: { nonce: 'n', state: 's', ...(queryToken ? { token: queryToken } : {}) },
    cookies: {},
  } as unknown as NextApiRequest;
  let statusCode = 200;
  let body: unknown;
  let redirectedTo: string | undefined;
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
    redirect(url: string) {
      statusCode = 307;
      redirectedTo = url;
      return res;
    },
    setHeader: () => res,
    getHeader: () => undefined,
    end: () => res,
    on: () => res,
    once: () => res,
  } as unknown as NextApiResponse;
  await handler(req, res);
  return { status: statusCode, body, redirectedTo };
}

beforeEach(() => {
  vi.clearAllMocks();
  hubSession.current = null;
  bearerSession.mockResolvedValue(null);
  envMock.set({ FRESHDESK_JWT_SECRET: 'test-secret', FRESHDESK_JWT_URL: SSO_URL });
});

const REFUSED = {
  error: 'This action requires a signed-in session or a full-access personal API key',
};

describe('GET /api/auth/freshdesk credential requirements', () => {
  it('serves a browser session', async () => {
    hubSession.current = { user: USER };
    const { redirectedTo } = await call();
    expect(redirectedTo).toBe(`${SSO_URL}?id_token=minted-id-token&state=s`);
    expect(createFreshdeskToken).toHaveBeenCalledTimes(1);
  });

  it('serves a personal API key holding the full scope', async () => {
    bearerSession.mockResolvedValue(personalKey(TokenScope.Full));
    const { redirectedTo } = await call({ authorization: 'Bearer personal-full' });
    expect(redirectedTo).toBe(`${SSO_URL}?id_token=minted-id-token&state=s`);
    expect(createFreshdeskToken).toHaveBeenCalledTimes(1);
  });

  it('still sends a caller with no credential to sign in', async () => {
    const { redirectedTo } = await call();
    expect(redirectedTo).toMatch(/^\/login\?/);
    expect(createFreshdeskToken).not.toHaveBeenCalled();
  });

  it('refuses a personal API key with a reduced scope', async () => {
    bearerSession.mockResolvedValue(personalKey(TokenScope.Full & ~TokenScope.UserRead));
    const { status, body } = await call({ authorization: 'Bearer personal-reduced' });
    expect(status).toBe(403);
    expect(body).toEqual(REFUSED);
    expect(createFreshdeskToken).not.toHaveBeenCalled();
  });

  it('refuses a System API key, even with the full scope', async () => {
    bearerSession.mockResolvedValue(nonOauthKey('System', TokenScope.Full));
    const { status, body } = await call({ authorization: 'Bearer system-full' });
    expect(status).toBe(403);
    expect(body).toEqual(REFUSED);
    expect(createFreshdeskToken).not.toHaveBeenCalled();
  });

  it('refuses an OAuth access token, including one granted the full scope', async () => {
    for (const scope of [TokenScope.Full, TokenScope.UserRead]) {
      bearerSession.mockResolvedValue(oauthToken(scope));
      const { status, body } = await call({ authorization: 'Bearer oauth-access' });
      expect(status, `OAuth token with scope ${scope}`).toBe(403);
      expect(body).toEqual(REFUSED);
    }
    expect(createFreshdeskToken).not.toHaveBeenCalled();
  });

  it('refuses a token passed in the query string, even a full-scope personal key', async () => {
    bearerSession.mockResolvedValue(personalKey(TokenScope.Full));
    const { status, body } = await call({ queryToken: 'personal-full' });
    expect(status).toBe(403);
    expect(body).toEqual(REFUSED);
    expect(createFreshdeskToken).not.toHaveBeenCalled();
  });
});
