import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CivitaiAuth from '@civitai/auth';
import type * as AccountStanding from '~/server/services/account-standing.service';
import type * as ApiKeyService from '~/server/services/api-key.service';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const h = vi.hoisted(() => ({ bearer: null as Record<string, unknown> | null }));

vi.mock('@civitai/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof CivitaiAuth>()),
  createAuthVerifier: () => ({}),
}));
vi.mock('~/server/auth/bearer-token', () => ({
  getSessionFromBearerToken: async () => h.bearer,
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: async () => null },
  getHubSession: async () => null,
  maybeRollHubCookie: async () => undefined,
}));
vi.mock('~/server/services/account-standing.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AccountStanding>()),
  getAccountStanding: async () => ({ banned: false, muted: false }),
}));
vi.mock('~/server/services/api-key.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiKeyService>()),
  readApiKeyBuzzLimit: async () => null,
}));

const { default: meHandler } = await import('~/pages/api/v1/me');
const { AuthedEndpoint, MixedAuthEndpoint } = await import('~/server/utils/endpoint-helpers');

const USER = {
  id: 990000102,
  username: 'identity',
  image: 'avatar.png',
  tier: 'gold',
  subscriptions: { civitai: {} },
  email: 'identity@example.com',
};

function oauthToken(tokenScope: number) {
  h.bearer = {
    user: USER,
    tokenScope,
    apiKeyId: 52,
    apiKeyType: 'Access',
    subject: { type: 'oauth', id: 'client-2' },
    buzzLimit: null,
  };
}

async function call(handler: (req: never, res: never) => unknown) {
  const req = {
    method: 'GET',
    url: '/api/v1/me',
    headers: { authorization: 'Bearer t' },
    cookies: {},
    query: {},
  };
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn((body: unknown) => {
      res.body = body;
      return res;
    }),
    send: vi.fn((body: unknown) => {
      res.body = body;
      return res;
    }),
    setHeader: vi.fn(),
    getHeader: vi.fn(),
    end: vi.fn(),
  };
  await handler(req as never, res as never);
  return res;
}

beforeEach(() => {
  resetEnv();
  setEnv({ REST_SCOPE_ENFORCE: 'enforce' });
});

describe('/api/v1/me by token scope', () => {
  it('answers a token with no scope bits with its identity only', async () => {
    oauthToken(TokenScope.None);
    const res = await call(meHandler);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      id: USER.id,
      username: USER.username,
      image: USER.image,
      status: 'active',
      tokenScope: TokenScope.None,
      subject: { type: 'oauth', id: 'client-2' },
    });
  });

  it('keeps the full answer for a scoped token', async () => {
    oauthToken(TokenScope.UserRead);
    const res = await call(meHandler);
    expect(res.body).toMatchObject({ tier: 'gold', email: USER.email, subscriptions: ['civitai'] });
  });
});

describe('wrapper answers to a token short of the route scope', () => {
  const seen = vi.fn();
  const route = { scope: { scope: TokenScope.VaultRead } };

  it('AuthedEndpoint answers 403 without running the handler', async () => {
    oauthToken(TokenScope.ModelsRead);
    seen.mockClear();
    const res = await call(
      AuthedEndpoint(async (_req, r) => void seen() ?? r.status(200).json({}), ['GET'], route)
    );
    expect(res.statusCode).toBe(403);
    expect(seen).not.toHaveBeenCalled();
  });

  it('MixedAuthEndpoint runs the handler as anonymous', async () => {
    oauthToken(TokenScope.ModelsRead);
    seen.mockClear();
    await call(
      MixedAuthEndpoint(
        async (_req, r, user) => void seen(user) ?? r.status(200).json({}),
        ['GET'],
        route
      )
    );
    expect(seen).toHaveBeenCalledWith(undefined);
  });
});
