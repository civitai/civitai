import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CivitaiAuth from '@civitai/auth';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { INSUFFICIENT_SCOPE_MESSAGE, type SessionScope } from '~/server/auth/session-scope';
import { constants } from '~/server/common/constants';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const h = vi.hoisted(() => ({
  bearer: null as Record<string, unknown> | null,
  hub: null as Record<string, unknown> | null,
  getSessionFromBearerToken: vi.fn(),
}));

vi.mock('@civitai/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof CivitaiAuth>()),
  createAuthVerifier: () => ({}),
}));
vi.mock('~/server/auth/bearer-token', () => ({
  getSessionFromBearerToken: h.getSessionFromBearerToken,
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: async () => null },
  getHubSession: async () => h.hub,
  maybeRollHubCookie: async () => undefined,
}));

const { getServerAuthSession } = await import('~/server/auth/get-server-auth-session');
const { getApiAuthSession } = await import('~/server/auth/api-auth-session');

const USER_ID = 990000101;

function bearerKey(tokenScope: bigint, extra: Record<string, unknown> = {}) {
  h.bearer = {
    user: { id: USER_ID, username: 'scoped' },
    tokenScope,
    apiKeyId: 41,
    apiKeyType: 'User',
    subject: { type: 'apiKey', id: 41 },
    buzzLimit: { limit: 10 },
    ...extra,
  };
}

function bearerRequest() {
  return {
    url: '/api/v1/models?limit=1',
    headers: { authorization: 'Bearer k' },
    cookies: {},
  } as {
    url: string;
    headers: Record<string, string>;
    cookies: object;
    context?: Record<string, unknown>;
  };
}

const resolve = (req: ReturnType<typeof bearerRequest>, scope?: SessionScope) =>
  getServerAuthSession({ req: req as never, res: {} as never, scope });

function apiRes() {
  return { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
}

const decisionLogs = () =>
  loggingMock.logToAxiom.mock.calls.filter(([entry]) => entry?.name === 'rest-scope-decision');

beforeEach(() => {
  resetEnv();
  setEnv({ REST_SCOPE_ENFORCE: 'enforce' });
  h.bearer = null;
  h.hub = null;
  h.getSessionFromBearerToken.mockReset();
  h.getSessionFromBearerToken.mockImplementation(async () => h.bearer);
  loggingMock.logToAxiom.mockClear();
});

describe('getServerAuthSession scope modes, enforcing', () => {
  it.each<[string, SessionScope | undefined, bigint, boolean]>([
    ['no mode, Full', undefined, TokenScope.Full, true],
    [
      'no mode, Full plus an opt-in bit',
      undefined,
      TokenScope.Full | TokenScope.AppBlocksSubmit,
      true,
    ],
    ['no mode, a narrow key', undefined, TokenScope.ModelsRead, false],
    ['scope held', { scope: TokenScope.ModelsRead }, TokenScope.ModelsRead, true],
    ['scope missing', { scope: TokenScope.ModelsRead }, TokenScope.MediaRead, false],
    ['scope inside Full', { scope: TokenScope.ModelsRead }, TokenScope.Full, true],
    [
      'anyOf, second bit held',
      { anyOf: [TokenScope.ModelsRead, TokenScope.AIServicesRead] },
      TokenScope.AIServicesRead,
      true,
    ],
    [
      'anyOf, none held',
      { anyOf: [TokenScope.ModelsRead, TokenScope.AIServicesRead] },
      TokenScope.MediaRead,
      false,
    ],
    ['anyOf with a zero bit', { anyOf: [TokenScope.None] }, TokenScope.MediaRead, false],
    ['defer, narrow', 'defer', TokenScope.MediaRead, true],
    ['defer, no bits', 'defer', TokenScope.None, true],
    ['selfGated, narrow', 'selfGated', TokenScope.MediaRead, true],
    ['selfGated, no bits', 'selfGated', TokenScope.None, false],
    ['anyScope, no bits', 'anyScope', TokenScope.None, true],
  ])('%s', async (_label, scope, tokenScope, served) => {
    bearerKey(tokenScope);
    const req = bearerRequest();
    const expected = served ? USER_ID : null;
    expect((await resolve(req, scope))?.user?.id ?? null).toBe(expected);
    // Again from the session memoized on the request.
    expect((await resolve(req, scope))?.user?.id ?? null).toBe(expected);
    expect(h.getSessionFromBearerToken).toHaveBeenCalledTimes(1);
  });

  it('records no credential when the bearer does not resolve or the session is a browser one', async () => {
    const credentialFields = ['tokenScope', 'apiKeyId', 'apiKeyType', 'subject', 'buzzLimit'];
    const invalid = bearerRequest();
    expect(await resolve(invalid)).toBeNull();
    for (const field of credentialFields) expect(invalid.context).not.toHaveProperty(field);

    h.hub = { user: { id: USER_ID } };
    const browser = { url: '/api/v1/models', headers: {}, cookies: {} } as ReturnType<
      typeof bearerRequest
    >;
    expect((await resolve(browser, { scope: TokenScope.VaultWrite }))?.user?.id).toBe(USER_ID);
    for (const field of credentialFields) expect(browser.context).not.toHaveProperty(field);
  });

  it('reads a scope recorded as a number like the same bigint', async () => {
    bearerKey(TokenScope.ModelsRead);
    const narrow = bearerRequest();
    await resolve(narrow, 'defer');
    narrow.context!.tokenScope = Number(TokenScope.ModelsRead);
    expect((await resolve(narrow, { scope: TokenScope.ModelsRead }))?.user?.id).toBe(USER_ID);
    expect(await resolve(narrow, { scope: TokenScope.VaultRead })).toBeNull();

    bearerKey(TokenScope.Full);
    const full = bearerRequest();
    await resolve(full, 'defer');
    full.context!.tokenScope = Number(TokenScope.Full);
    expect((await resolve(full))?.user?.id).toBe(USER_ID);
  });

  it('leaves a browser session alone whatever the mode', async () => {
    h.hub = { user: { id: USER_ID, isModerator: true } };
    const req = { url: '/api/v1/models', headers: {}, cookies: {} };
    const session = await getServerAuthSession({
      req: req as never,
      res: {} as never,
      scope: { scope: TokenScope.VaultWrite },
    });
    expect(session?.user).toEqual({ id: USER_ID, isModerator: true });
  });

  it('applies each call’s own mode to the memoized session', async () => {
    bearerKey(TokenScope.ModelsRead);
    const req = bearerRequest();
    expect((await resolve(req, 'defer'))?.user?.id).toBe(USER_ID);
    expect(await resolve(req, { scope: TokenScope.ModelsWrite })).toBeNull();
    expect((await resolve(req, { scope: TokenScope.ModelsRead }))?.user?.id).toBe(USER_ID);
    expect(h.getSessionFromBearerToken).toHaveBeenCalledTimes(1);
  });

  it('records the credential on req.context on every outcome', async () => {
    const fields = {
      tokenScope: TokenScope.ModelsRead,
      apiKeyId: 41,
      apiKeyType: 'User',
      subject: { type: 'apiKey', id: 41 },
      buzzLimit: { limit: 10 },
    };
    const outcomes: Array<[RestScope, SessionScope | undefined]> = [
      ['enforce', { scope: TokenScope.ModelsRead }],
      ['enforce', { scope: TokenScope.VaultRead }],
      ['report', { scope: TokenScope.VaultRead }],
      ['off', undefined],
    ];
    for (const [mode, scope] of outcomes) {
      setEnv({ REST_SCOPE_ENFORCE: mode });
      bearerKey(TokenScope.ModelsRead);
      const req = bearerRequest();
      await resolve(req, scope);
      expect(req.context).toMatchObject(fields);
      // The memo hit leaves them in place.
      await resolve(req, scope);
      expect(req.context).toMatchObject(fields);
    }
  });

  it('withholds moderator rights from a key that is not a full personal key', async () => {
    bearerKey(TokenScope.ModelsRead, { user: { id: USER_ID, isModerator: true } });
    const req = bearerRequest();
    const session = await resolve(req, { scope: TokenScope.ModelsRead });
    expect(session?.user?.isModerator).toBe(false);
    // The recorded session is not changed, so a later caller still sees the credential's user.
    expect((req.context?.session as { user: { isModerator: boolean } }).user.isModerator).toBe(
      true
    );
  });

  it('keeps moderator rights for a full personal key', async () => {
    bearerKey(TokenScope.Full, { user: { id: USER_ID, isModerator: true } });
    expect((await resolve(bearerRequest()))?.user?.isModerator).toBe(true);
  });

  it('withholds moderator rights from a narrow key on anyScope too', async () => {
    bearerKey(TokenScope.None, { user: { id: USER_ID, isModerator: true } });
    expect((await resolve(bearerRequest(), 'anyScope'))?.user?.isModerator).toBe(false);
  });

  it('keeps moderator rights for the internal system account’s key', async () => {
    bearerKey(TokenScope.ModelsRead, {
      user: { id: constants.system.user.id, isModerator: true },
      apiKeyType: 'System',
    });
    expect(
      (await resolve(bearerRequest(), { scope: TokenScope.ModelsRead }))?.user?.isModerator
    ).toBe(true);
  });

  it('keeps moderator rights where a per-operation check decides', async () => {
    bearerKey(TokenScope.ModelsRead, { user: { id: USER_ID, isModerator: true } });
    expect((await resolve(bearerRequest(), 'defer'))?.user?.isModerator).toBe(true);
  });
});

type RestScope = 'off' | 'report' | 'enforce';

describe('REST_SCOPE_ENFORCE', () => {
  it('report serves the session and logs the would-refuse decision once per route', async () => {
    setEnv({ REST_SCOPE_ENFORCE: 'report' });
    bearerKey(TokenScope.ModelsRead, {
      apiKeyType: 'Access',
      subject: { type: 'oauth', id: 'client-1' },
    });
    const req = bearerRequest();
    expect((await resolve(req, { scope: TokenScope.VaultRead }))?.user?.id).toBe(USER_ID);
    await resolve(req, { scope: TokenScope.VaultRead });
    expect(decisionLogs()).toHaveLength(1);
    const [entry] = decisionLogs()[0];
    expect(entry).toMatchObject({
      mode: 'report',
      route: '/api/v1/models',
      requiredScope: Number(TokenScope.VaultRead),
      tokenScope: Number(TokenScope.ModelsRead),
      apiKeyType: 'Access',
      clientId: 'client-1',
      payload: { outcome: 'refused' },
    });
    expect(entry.payload.apiKeyIdHash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(entry)).not.toContain(String(USER_ID));
    expect(Object.values(entry.payload)).not.toContain(41);
  });

  it('report logs a withheld moderator right and leaves it in place', async () => {
    setEnv({ REST_SCOPE_ENFORCE: 'report' });
    bearerKey(TokenScope.ModelsRead, { user: { id: USER_ID, isModerator: true } });
    const session = await resolve(bearerRequest(), { scope: TokenScope.ModelsRead });
    expect(session?.user?.isModerator).toBe(true);
    expect(decisionLogs().map(([entry]) => entry.payload.outcome)).toEqual(['moderator-withheld']);
  });

  const loggedRoute = async (url: string, query?: Record<string, string | string[]>) => {
    setEnv({ REST_SCOPE_ENFORCE: 'report' });
    bearerKey(TokenScope.ModelsRead);
    const req = { ...bearerRequest(), url, query };
    await resolve(req, { scope: TokenScope.VaultRead });
    const [entry] = decisionLogs()[0];
    return { route: entry.route as string, logged: JSON.stringify(entry) };
  };

  it('logs the route template, naming the dynamic params', async () => {
    const { route } = await loggedRoute('/api/download/models/123?type=Model&token=x', {
      modelVersionId: '123',
      type: 'Model',
      token: 'x',
    });
    expect(route).toBe('/api/download/models/[modelVersionId]');
  });

  it('logs a catch-all storage key by its param name only', async () => {
    const key = [
      'users',
      '77',
      'a3f1c2d4e5b6a7980123456789abcdef0123456789abcdef0123456789abcdef',
      'My Model.safetensors',
    ];
    const { route, logged } = await loggedRoute(
      `/api/storage/files/${key.map(encodeURIComponent).join('/')}`,
      { key }
    );
    expect(route).toBe('/api/storage/files/[...key]');
    expect(logged).not.toContain(
      'a3f1c2d4e5b6a7980123456789abcdef0123456789abcdef0123456789abcdef'
    );
    expect(logged).not.toContain('safetensors');
  });

  it('logs a hash segment by its param name only', async () => {
    const { route, logged } = await loggedRoute(
      '/api/v1/images/a3f1c2d4e5b6a7980123456789abcdef0123456789abcdef0123456789abcdef/meta',
      { hash: 'a3f1c2d4e5b6a7980123456789abcdef0123456789abcdef0123456789abcdef' }
    );
    expect(route).toBe('/api/v1/images/[hash]/meta');
    expect(logged).not.toContain(
      'a3f1c2d4e5b6a7980123456789abcdef0123456789abcdef0123456789abcdef'
    );
  });

  it('without a route template, logs only short lowercase non-hex segments', async () => {
    const { route, logged } = await loggedRoute(
      `/api/v1/models/123/a3f1c2d4e5b6a7980123456789abcdef0123456789abcdef0123456789abcdef/deadbeef/Bucket_Key/550e8400-e29b-41d4-a716-446655440000/latest?token=x`
    );
    expect(route).toBe('/api/v1/models/:segment/:segment/:segment/:segment/:segment/latest');
    expect(logged).not.toContain(
      'a3f1c2d4e5b6a7980123456789abcdef0123456789abcdef0123456789abcdef'
    );
    expect(logged).not.toContain('Bucket_Key');
  });

  it('logs a route param the caller repeats in the query string as :segment', async () => {
    const { route, logged } = await loggedRoute('/api/v1/creators/alice?username=alice', {
      username: 'alice',
    });
    expect(route).toBe('/api/v1/creators/:segment');
    expect(logged).not.toContain('alice');
  });

  it('never names or keeps a segment from a query-string key or value', async () => {
    const { route, logged } = await loggedRoute('/api/v1/models?evil_key=models', {
      evil_key: 'models',
    });
    expect(route).toBe('/api/v1/:segment');
    expect(logged).not.toContain('evil_key');
  });

  it('does not label the empty leading segment with an empty query value', async () => {
    const { route } = await loggedRoute('/api/v1/models?cursor=', { cursor: '' });
    expect(route).toBe('/api/v1/models');
  });

  it("names a page's route params from the page context", async () => {
    setEnv({ REST_SCOPE_ENFORCE: 'report' });
    bearerKey(TokenScope.ModelsRead);
    const req = { ...bearerRequest(), url: '/user/alice?token=k' };
    await getServerAuthSession({
      req: req as never,
      res: {} as never,
      query: { username: 'alice', token: 'k' },
    });
    expect(decisionLogs()[0][0].route).toBe('/user/[username]');
  });

  it('logs a long word, and a malformed escape, as :segment', async () => {
    const { route } = await loggedRoute(`/api/v1/models/${'z'.repeat(33)}/%E0%A4%A/latest`);
    expect(route).toBe('/api/v1/models/:segment/:segment/latest');
  });

  it('keys the api key id hash with the server secret', async () => {
    setEnv({ REST_SCOPE_ENFORCE: 'report' });
    const hashUnder = async (secret: string) => {
      setEnv({ NEXTAUTH_SECRET: secret });
      loggingMock.logToAxiom.mockClear();
      bearerKey(TokenScope.ModelsRead);
      await resolve(bearerRequest(), { scope: TokenScope.VaultRead });
      return decisionLogs()[0][0].payload.apiKeyIdHash as string;
    };
    const first = await hashUnder('secret-one');
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(await hashUnder('secret-one')).toBe(first);
    expect(await hashUnder('secret-two')).not.toBe(first);
    expect(first).not.toBe(createHash('sha256').update('41').digest('hex').slice(0, 16));
  });

  it('off neither refuses nor logs', async () => {
    setEnv({ REST_SCOPE_ENFORCE: 'off' });
    bearerKey(TokenScope.ModelsRead, { user: { id: USER_ID, isModerator: true } });
    const session = await resolve(bearerRequest(), { scope: TokenScope.VaultRead });
    expect(session?.user).toMatchObject({ id: USER_ID, isModerator: true });
    expect(decisionLogs()).toHaveLength(0);
  });
});

describe('getApiAuthSession insufficient scope', () => {
  it('refuse answers 403 and returns false', async () => {
    bearerKey(TokenScope.ModelsRead);
    const res = apiRes();
    const result = await getApiAuthSession(
      { req: bearerRequest() as never, res: res as never },
      { whenBanned: 'refuse', scope: { scope: TokenScope.MediaWrite }, insufficient: 'refuse' }
    );
    expect(result).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: INSUFFICIENT_SCOPE_MESSAGE });
  });

  it('anonymous returns no session and sends nothing', async () => {
    bearerKey(TokenScope.ModelsRead);
    const res = apiRes();
    const result = await getApiAuthSession(
      { req: bearerRequest() as never, res: res as never },
      { whenBanned: 'anonymous', scope: { scope: TokenScope.MediaRead } }
    );
    expect(result).toBeNull();
    expect(res.status).not.toHaveBeenCalled();
  });
});
