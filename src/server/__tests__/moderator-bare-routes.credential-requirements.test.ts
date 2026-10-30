import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { setEnv } from '~/__tests__/mocks/env.mock';
import type * as BearerToken from '~/server/auth/bearer-token';
import type * as SessionClient from '~/server/auth/session-client';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// `getServerAuthSession` is deliberately unmocked: the rule reads the credential it records on the
// request.
const { hubSession, bearerSession } = vi.hoisted(() => ({
  hubSession: { current: null as null | { user: Record<string, unknown> } },
  bearerSession: vi.fn(),
}));

vi.mock('~/server/auth/bearer-token', async (importOriginal) => ({
  ...(await importOriginal<typeof BearerToken>()),
  getSessionFromBearerToken: bearerSession,
}));
vi.mock('~/server/auth/session-client', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionClient>()),
  getHubSession: vi.fn(async () => hubSession.current),
  maybeRollHubCookie: vi.fn(async () => undefined),
  maybeUpgradeLegacySession: vi.fn(async () => undefined),
}));

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

// Both answer 400 for the empty request below once the caller is admitted, before any work.
const routes: { name: string; method: string; path: string; handler: Handler }[] = [
  {
    name: 'POST /api/testing/model3d-seed',
    method: 'POST',
    path: '/api/testing/model3d-seed',
    handler: (await import('~/pages/api/testing/model3d-seed')).default as unknown as Handler,
  },
  {
    name: 'GET /api/media/ingest/[mediaId]',
    method: 'GET',
    path: '/api/media/ingest/not-a-number',
    handler: (await import('~/pages/api/media/ingest/[mediaId]')).default as unknown as Handler,
  },
];

const MODERATOR = { id: 4242, username: 'mod', isModerator: true, bannedAt: null };
const MEMBER = { ...MODERATOR, isModerator: false };

const nonOauthKey = (apiKeyType: string | undefined, tokenScope: number, user = MODERATOR) => ({
  user,
  apiKeyId: 11,
  ...(apiKeyType ? { apiKeyType } : {}),
  subject: { type: 'apiKey', id: 11 },
  tokenScope,
  buzzLimit: null,
});
const oauthToken = (tokenScope: number) => ({
  user: MODERATOR,
  apiKeyId: 12,
  apiKeyType: 'Access',
  subject: { type: 'oauth', id: 'client-abc' },
  tokenScope,
  buzzLimit: null,
});

const FULL_SESSION_REQUIRED = {
  error: 'This action requires a signed-in session or a full-access personal API key',
};

async function call(
  route: (typeof routes)[number],
  { authorization, queryToken }: { authorization?: string; queryToken?: string } = {}
) {
  const url = queryToken ? `${route.path}?token=${queryToken}` : route.path;
  const req = {
    method: route.method,
    url,
    headers: { host: 'civitai.com', ...(authorization ? { authorization } : {}) },
    query: { mediaId: 'not-a-number', ...(queryToken ? { token: queryToken } : {}) },
    body: {},
    cookies: {},
  } as unknown as NextApiRequest;
  let status = 0;
  let body: unknown;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(value: unknown) {
      body = value;
      return res;
    },
    setHeader: () => res,
    end: () => res,
  } as unknown as NextApiResponse;
  await route.handler(req, res);
  return { status, body };
}

const REDUCED = TokenScope.Full & ~TokenScope.AIServicesWrite;

const refusedBearers: [string, Record<string, unknown>][] = [
  ['a full-scope OAuth access token', oauthToken(TokenScope.Full)],
  ['a read-scope OAuth access token', oauthToken(TokenScope.UserRead)],
  ['a full-scope System key', nonOauthKey('System', TokenScope.Full)],
  ['a reduced-scope personal API key', nonOauthKey('User', REDUCED)],
  ['a key whose type was not recorded', nonOauthKey(undefined, TokenScope.Full)],
];

beforeEach(() => {
  vi.clearAllMocks();
  setEnv({ WEBHOOK_TOKEN: 'configured-service-token' });
  hubSession.current = null;
  bearerSession.mockResolvedValue(null);
});

describe.each(routes)('$name credential requirements', (route) => {
  it('admits a moderator browser session', async () => {
    hubSession.current = { user: MODERATOR };
    expect((await call(route)).status).toBe(400);
  });

  it('admits a moderator personal API key holding the full scope', async () => {
    bearerSession.mockResolvedValue(nonOauthKey('User', TokenScope.Full));
    expect((await call(route, { authorization: 'Bearer personal-full' })).status).toBe(400);
  });

  it('admits the service token', async () => {
    expect((await call(route, { queryToken: 'configured-service-token' })).status).toBe(400);
  });

  it.each(refusedBearers)('refuses a moderator presenting %s', async (_label, session) => {
    bearerSession.mockResolvedValue(session);
    expect(await call(route, { authorization: 'Bearer token' })).toEqual({
      status: 403,
      body: FULL_SESSION_REQUIRED,
    });
  });

  it('refuses a personal API key passed in the query string', async () => {
    bearerSession.mockResolvedValue(nonOauthKey('User', TokenScope.Full));
    expect(await call(route, { queryToken: 'personal-full' })).toEqual({
      status: 403,
      body: FULL_SESSION_REQUIRED,
    });
  });

  it('refuses a non-moderator OAuth access token as a non-moderator', async () => {
    bearerSession.mockResolvedValue({ ...oauthToken(TokenScope.Full), user: MEMBER });
    expect((await call(route, { authorization: 'Bearer oauth-access' })).status).toBe(401);
  });

  it('refuses a non-moderator session as a non-moderator', async () => {
    hubSession.current = { user: MEMBER };
    expect((await call(route)).status).toBe(401);
  });
});
