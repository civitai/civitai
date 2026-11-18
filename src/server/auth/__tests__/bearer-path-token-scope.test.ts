import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import type * as KeyGenerator from '~/server/utils/key-generator';
import type * as PrincipalCache from '~/server/auth/api-key-principal-cache';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// Scoped API routes pass a request whose `req.context.tokenScope` is unset as a cookie session, so
// every bearer credential that resolves to a session must record its scope there.

const h = vi.hoisted(() => ({
  readCachedApiKey: vi.fn(),
  getHubSession: vi.fn(),
}));

vi.mock('~/server/utils/key-generator', async (importOriginal) => ({
  ...(await importOriginal<typeof KeyGenerator>()),
  generateSecretHash: (key: string) => key,
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: vi.fn(async (id: number) => ({ id, bannedAt: null })) },
  getHubSession: h.getHubSession,
  maybeRollHubCookie: vi.fn(),
}));
vi.mock('~/server/auth/api-key-principal-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof PrincipalCache>()),
  readCachedApiKey: h.readCachedApiKey,
}));

const { getServerAuthSession } = await import('~/server/auth/get-server-auth-session');

const SERVICE_TOKEN = 'test-service-token-0123456789abcdef';
const WIDE_SCOPE = TokenScope.ModelsRead | (1n << 32n);
const KEYS: Record<string, object> = {
  'user-key': { id: 1, type: 'User', clientId: null, tokenScope: Number(TokenScope.ModelsRead) },
  'system-key': {
    id: 2,
    type: 'System',
    clientId: null,
    tokenScope: Number(TokenScope.ModelsRead),
  },
  'oauth-access': {
    id: 3,
    type: 'Access',
    clientId: 'client-1',
    tokenScope: Number(TokenScope.ModelsRead),
  },
  'wide-key': { id: 4, type: 'User', clientId: null, tokenScope: 1, tokenScopeWide: WIDE_SCOPE },
};

function request(init: { authorization?: string; url?: string }) {
  return {
    url: init.url ?? '/api/v1/models',
    headers: init.authorization ? { authorization: init.authorization } : {},
    cookies: { 'civ-token': 'cookie' },
  } as {
    url: string;
    headers: Record<string, string>;
    cookies: object;
    context?: Record<string, unknown>;
  };
}

const resolve = (req: ReturnType<typeof request>) =>
  getServerAuthSession({ req: req as never, res: {} as never, scope: 'defer' });

beforeEach(() => {
  setEnv({ ORCHESTRATOR_SERVICE_TOKEN: SERVICE_TOKEN });
  h.readCachedApiKey.mockReset().mockResolvedValue({ apiKey: null, fill: false });
  h.getHubSession.mockReset().mockResolvedValue({ user: { id: 99 } });
  dbMock.dbWrite.apiKey.findFirst.mockReset().mockImplementation((async (args: {
    where: { key: string };
  }) => {
    const key = KEYS[args.where.key];
    return key && { userId: 5, lastUsedAt: new Date(), buzzLimit: null, expiresAt: null, ...key };
  }) as never);
  dbMock.dbRead.oauthConsent.findUnique.mockReset().mockResolvedValue(null as never);
});

describe('every bearer credential that resolves to a session records its token scope', () => {
  it.each([
    ['a personal API key', { authorization: 'Bearer user-key' }, TokenScope.ModelsRead],
    ['a system API key', { authorization: 'Bearer system-key' }, TokenScope.ModelsRead],
    ['an OAuth access token', { authorization: 'Bearer oauth-access' }, TokenScope.ModelsRead],
    ['a key given as ?token=', { url: '/api/v1/models?token=user-key' }, TokenScope.ModelsRead],
    ['a key with scope bits above 31', { authorization: 'Bearer wide-key' }, WIDE_SCOPE],
  ])('%s', async (_, init, scope) => {
    const req = request(init);
    expect((await resolve(req))?.user?.id).toBe(5);
    expect(req.context?.tokenScope).toBe(scope);
    expect(h.getHubSession).not.toHaveBeenCalled();
  });

  it.each([
    ['a hub-issued JWT', 'Bearer eyJhbGciOiJFUzI1NiIsInR5cCI6ImF0K2p3dCJ9.eyJzdWIiOiI1In0.c2ln'],
    ['the orchestrator service token', `Bearer ${SERVICE_TOKEN}`],
    ['a provider download token', 'Bearer provider:secret'],
    ['an unknown key', 'Bearer not-a-key'],
  ])('%s resolves to no session, and no cookie session in its place', async (_, authorization) => {
    const req = request({ authorization });
    expect(await resolve(req)).toBeNull();
    expect(req.context?.tokenScope).toBeUndefined();
    expect(h.getHubSession).not.toHaveBeenCalled();
  });
});
