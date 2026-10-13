import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { redisMock } from '~/__tests__/mocks';
import type * as ClickhouseClient from '~/server/clickhouse/client';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// The wrappers and `getServerAuthSession` are deliberately unmocked: the rule reads the
// `req.context` the session layer populates, so mocking either would make these tests vacuous.
const { hubSession, bearerSession } = vi.hoisted(() => ({
  hubSession: { current: null as null | { user: Record<string, unknown> } },
  bearerSession: vi.fn(),
}));

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/auth/bearer-token', () => ({ getSessionFromBearerToken: bearerSession }));
vi.mock('~/server/auth/session-client', () => ({
  getHubSession: vi.fn(async () => hubSession.current),
  maybeRollHubCookie: vi.fn(async () => undefined),
  maybeUpgradeLegacySession: vi.fn(async () => undefined),
  sessionClient: { getSessionUserById: vi.fn(async () => null) },
}));
vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  Tracker: class {
    retoolAudit = vi.fn();
  },
}));

const { ModEndpoint } = await import('~/server/utils/endpoint-helpers');
const { defineModeratorEndpoint } = await import('~/server/utils/moderator-endpoint');

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

const modEndpointHandler = vi.fn(async (_req: NextApiRequest, res: NextApiResponse) => {
  res.status(200).json({ ok: true });
});
const moderatorEndpointHandler = vi.fn(async () => ({ ok: true }));

const wrappers: {
  name: string;
  handler: Handler;
  inner: ReturnType<typeof vi.fn>;
  notModerator: number;
}[] = [
  {
    name: 'ModEndpoint',
    handler: ModEndpoint(modEndpointHandler, ['POST']) as unknown as Handler,
    inner: modEndpointHandler,
    notModerator: 401,
  },
  {
    name: 'defineModeratorEndpoint',
    handler: defineModeratorEndpoint('test.credentialProbe', {
      summary: 'Probe.',
      handler: moderatorEndpointHandler,
    }) as unknown as Handler,
    inner: moderatorEndpointHandler,
    notModerator: 403,
  },
];

const MODERATOR = { id: 4242, username: 'mod', isModerator: true, bannedAt: null, permissions: [] };
const MEMBER = { ...MODERATOR, isModerator: false };

const nonOauthKey = (apiKeyType: string | undefined, tokenScope: number, user = MODERATOR) => ({
  user,
  apiKeyId: 11,
  ...(apiKeyType ? { apiKeyType } : {}),
  subject: { type: 'apiKey', id: 11 },
  tokenScope,
  buzzLimit: null,
});
const personalKey = (tokenScope: number, user = MODERATOR) => nonOauthKey('User', tokenScope, user);
const oauthToken = (apiKeyType: string, tokenScope: number) => ({
  user: MODERATOR,
  apiKeyId: 12,
  apiKeyType,
  subject: { type: 'oauth', id: 'client-abc' },
  tokenScope,
  buzzLimit: null,
});

const PATH = '/api/mod/probe';
const FULL_SESSION_REQUIRED = {
  error: 'This action requires a signed-in session or a full-access personal API key',
};

async function call(
  wrapper: (typeof wrappers)[number],
  { authorization, queryToken }: { authorization?: string; queryToken?: string } = {}
) {
  const req = {
    method: 'POST',
    url: queryToken ? `${PATH}?token=${queryToken}` : PATH,
    headers: { host: 'civitai.com', ...(authorization ? { authorization } : {}) },
    query: queryToken ? { token: queryToken } : {},
    body: {},
    cookies: {},
  } as unknown as NextApiRequest;
  let statusCode = 200;
  let body: unknown;
  const headers = new Map<string, unknown>();
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
    setHeader(name: string, value: unknown) {
      headers.set(name.toLowerCase(), value);
      return res;
    },
    getHeader: (name: string) => headers.get(name.toLowerCase()),
    end: () => res,
    on: () => res,
    once: () => res,
  } as unknown as NextApiResponse;
  await wrapper.handler(req, res);
  return { status: statusCode, body };
}

beforeEach(() => {
  vi.clearAllMocks();
  hubSession.current = null;
  bearerSession.mockResolvedValue(null);
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn(async () => ['OK', 1]),
  }));
});

const REDUCED = TokenScope.Full & ~TokenScope.AIServicesWrite;

const refusedBearers: [string, Record<string, unknown>][] = [
  ['a full-scope OAuth access token', oauthToken('Access', TokenScope.Full)],
  ['a read-scope OAuth access token', oauthToken('Access', TokenScope.UserRead)],
  ['a full-scope OAuth refresh token', oauthToken('Refresh', TokenScope.Full)],
  ['a full-scope System key', nonOauthKey('System', TokenScope.Full)],
  ['a reduced-scope personal API key', personalKey(REDUCED)],
  ['a key whose type was not recorded', nonOauthKey(undefined, TokenScope.Full)],
  ['a full-scope User-typed key issued to an OAuth client', oauthToken('User', TokenScope.Full)],
];

describe.each(wrappers)('$name credential requirements', (wrapper) => {
  it('serves a moderator browser session', async () => {
    hubSession.current = { user: MODERATOR };
    expect((await call(wrapper)).status).toBe(200);
    expect(wrapper.inner).toHaveBeenCalledTimes(1);
  });

  it('serves a moderator personal API key holding the full scope', async () => {
    bearerSession.mockResolvedValue(personalKey(TokenScope.Full));
    expect((await call(wrapper, { authorization: 'Bearer personal-full' })).status).toBe(200);
    expect(wrapper.inner).toHaveBeenCalledTimes(1);
  });

  it.each(refusedBearers)('refuses a moderator presenting %s', async (_label, session) => {
    bearerSession.mockResolvedValue(session);
    const { status, body } = await call(wrapper, { authorization: 'Bearer token' });
    expect(status).toBe(403);
    expect(body).toEqual(FULL_SESSION_REQUIRED);
    expect(wrapper.inner).not.toHaveBeenCalled();
  });

  it('refuses an OAuth access token sent with a non-Bearer authorization header', async () => {
    bearerSession.mockResolvedValue(oauthToken('Access', TokenScope.Full));
    const { status, body } = await call(wrapper, { authorization: 'Token oauth-access' });
    expect(status).toBe(403);
    expect(body).toEqual(FULL_SESSION_REQUIRED);
    expect(wrapper.inner).not.toHaveBeenCalled();
  });

  it('refuses a token passed in the query string, even a full-scope personal key', async () => {
    bearerSession.mockResolvedValue(personalKey(TokenScope.Full));
    const { status, body } = await call(wrapper, { queryToken: 'personal-full' });
    expect(status).toBe(403);
    expect(body).toEqual(FULL_SESSION_REQUIRED);
    expect(wrapper.inner).not.toHaveBeenCalled();
  });

  it('refuses a non-moderator session', async () => {
    hubSession.current = { user: MEMBER };
    expect((await call(wrapper)).status).toBe(wrapper.notModerator);
    expect(wrapper.inner).not.toHaveBeenCalled();
  });

  it('refuses a non-moderator full-scope personal API key as a non-moderator', async () => {
    bearerSession.mockResolvedValue(personalKey(TokenScope.Full, MEMBER));
    const { status, body } = await call(wrapper, { authorization: 'Bearer personal-full' });
    expect(status).toBe(wrapper.notModerator);
    expect(body).not.toEqual(FULL_SESSION_REQUIRED);
    expect(wrapper.inner).not.toHaveBeenCalled();
  });

  it('refuses a non-moderator OAuth access token as a non-moderator', async () => {
    bearerSession.mockResolvedValue({ ...oauthToken('Access', TokenScope.Full), user: MEMBER });
    const { status, body } = await call(wrapper, { authorization: 'Bearer oauth-access' });
    expect(status).toBe(wrapper.notModerator);
    expect(body).not.toEqual(FULL_SESSION_REQUIRED);
    expect(wrapper.inner).not.toHaveBeenCalled();
  });

  it('answers 401 when there is no credential at all', async () => {
    expect((await call(wrapper)).status).toBe(401);
    expect(wrapper.inner).not.toHaveBeenCalled();
  });
});
