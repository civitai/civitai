import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ApiKeyService from '~/server/services/api-key.service';
import type * as AppAssistantService from '~/server/services/app-assistant/app-assistant.service';
import type * as AssistantRunnerTokens from '~/server/services/app-assistant/assistant-runner-tokens';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import type * as UserService from '~/server/services/user.service';
import { OnboardingSteps } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// `AuthedEndpoint` and `getServerAuthSession` are deliberately unmocked: the guard reads the
// `req.context` they populate, so mocking them would make these tests vacuous.
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
vi.mock('~/server/services/api-key.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiKeyService>()),
  addApiKey: vi.fn(async () => 'minted-api-key'),
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: vi.fn(async () => 'minted-orchestrator-token'),
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlagsLazy: vi.fn(() => ({ trainingStudioUi: true })),
  // `appAssistantRemoteRunner`: the run-grant route also needs the server runner on for the user.
  getFeatureFlagsAsync: vi.fn(async () => ({
    appBlocks: true,
    appAssistant: true,
    appAssistantRemoteRunner: true,
  })),
  computeUserFeatureFlagsOverlay: vi.fn(() => ({})),
  getFliptGatedEligibility: vi.fn(() => ({})),
}));
vi.mock('~/server/services/app-assistant/app-assistant.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppAssistantService>()),
  enableAppAssistant: vi.fn(async () => undefined),
  mintAppAssistantToken: vi.fn(async () => ({
    token: 'minted-assistant-token',
    expiresAt: '2099-01-01T00:00:00Z',
  })),
  hasAppAssistantConsent: vi.fn(async () => true),
}));
vi.mock('~/server/services/app-assistant/assistant-runner-tokens', async (importOriginal) => ({
  ...(await importOriginal<typeof AssistantRunnerTokens>()),
  isAssistantRunnerConfigured: () => true,
  signRunGrant: vi.fn(async () => ({
    token: 'minted-run-grant',
    expiresAt: '2099-01-01T00:00:00Z',
  })),
  signRunnerViewerToken: vi.fn(async () => ({
    token: 'minted-viewer-token',
    expiresAt: '2099-01-01T00:00:00Z',
  })),
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  getUserSettings: vi.fn(async () => ({ features: {} })),
}));

const { addApiKey } = await import('~/server/services/api-key.service');
const { getOrchestratorToken } = await import('~/server/orchestrator/get-orchestrator-token');
const { enableAppAssistant, mintAppAssistantToken } = await import(
  '~/server/services/app-assistant/app-assistant.service'
);
const { signRunGrant, signRunnerViewerToken } = await import(
  '~/server/services/app-assistant/assistant-runner-tokens'
);

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<void>;

const routes: {
  name: string;
  path: string;
  handler: Handler;
  minted: () => unknown;
  query?: Record<string, string>;
}[] = [
  {
    name: 'GET /api/user/orchestrator-key',
    path: '/api/user/orchestrator-key',
    handler: (await import('~/pages/api/user/orchestrator-key')).default as unknown as Handler,
    minted: () => addApiKey,
  },
  {
    name: 'GET /api/training-studio/host',
    path: '/api/training-studio/host',
    handler: (await import('~/pages/api/training-studio/host')).default as unknown as Handler,
    minted: () => getOrchestratorToken,
  },
  {
    name: '/api/apps/assistant/token',
    path: '/api/apps/assistant/token',
    handler: (await import('~/pages/api/apps/assistant/token')).default as unknown as Handler,
    minted: () => mintAppAssistantToken,
  },
  {
    name: 'GET /api/apps/assistant/run-grant',
    path: '/api/apps/assistant/run-grant',
    handler: (await import('~/pages/api/apps/assistant/run-grant')).default as unknown as Handler,
    minted: () => signRunGrant,
    query: { conversationId: 'c1', idempotencyKey: 'k1' },
  },
  {
    name: 'GET /api/apps/assistant/runner-viewer-token',
    path: '/api/apps/assistant/runner-viewer-token',
    handler: (await import('~/pages/api/apps/assistant/runner-viewer-token'))
      .default as unknown as Handler,
    minted: () => signRunnerViewerToken,
  },
];

const USER = {
  id: 4242,
  username: 'someone',
  bannedAt: null,
  muted: false,
  onboarding: OnboardingSteps.Buzz,
  emailVerified: new Date('2026-01-01'),
};

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

async function call(
  route: (typeof routes)[number],
  {
    authorization,
    queryToken,
    method = 'GET',
    headers: extraHeaders = {},
  }: {
    authorization?: string;
    queryToken?: string;
    method?: string;
    headers?: Record<string, string>;
  } = {}
) {
  const query = { ...route.query, ...(queryToken ? { token: queryToken } : {}) };
  const search = new URLSearchParams(query).toString();
  const url = search ? `${route.path}?${search}` : route.path;
  const req = {
    method,
    url,
    headers: {
      host: 'civitai.com',
      ...(authorization ? { authorization } : {}),
      ...extraHeaders,
    },
    query,
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
  await route.handler(req, res);
  return { status: statusCode, body: body as Record<string, unknown> | undefined };
}

beforeEach(() => {
  vi.clearAllMocks();
  hubSession.current = null;
  bearerSession.mockResolvedValue(null);
});

describe.each(routes)('$name credential requirements', (route) => {
  it('serves a browser session', async () => {
    hubSession.current = { user: USER };
    const { status } = await call(route);
    expect(status).toBe(200);
    expect(route.minted()).toHaveBeenCalledTimes(1);
  });

  it('serves a personal API key holding the full scope', async () => {
    bearerSession.mockResolvedValue(personalKey(TokenScope.Full));
    const { status } = await call(route, { authorization: 'Bearer personal-full' });
    expect(status).toBe(200);
    expect(route.minted()).toHaveBeenCalledTimes(1);
  });

  it('refuses a personal API key with a reduced scope', async () => {
    bearerSession.mockResolvedValue(personalKey(TokenScope.Full & ~TokenScope.UserRead));
    const { status } = await call(route, { authorization: 'Bearer personal-reduced' });
    expect(status).toBe(403);
    expect(route.minted()).not.toHaveBeenCalled();
  });

  it('refuses a System API key, even with the full scope', async () => {
    bearerSession.mockResolvedValue(nonOauthKey('System', TokenScope.Full));
    const { status } = await call(route, { authorization: 'Bearer system-full' });
    expect(status).toBe(403);
    expect(route.minted()).not.toHaveBeenCalled();
  });

  it('refuses an OAuth access token, including one granted the full scope', async () => {
    for (const scope of [TokenScope.Full, TokenScope.UserRead]) {
      bearerSession.mockResolvedValue(oauthToken(scope));
      const { status } = await call(route, { authorization: 'Bearer oauth-access' });
      expect(status, `OAuth token with scope ${scope}`).toBe(403);
    }
    expect(route.minted()).not.toHaveBeenCalled();
  });

  it('refuses a token passed in the query string, even a full-scope personal key', async () => {
    bearerSession.mockResolvedValue(personalKey(TokenScope.Full));
    const { status } = await call(route, { queryToken: 'personal-full' });
    expect(status).toBe(403);
    expect(route.minted()).not.toHaveBeenCalled();
  });

  it('answers 401 when there is no credential at all', async () => {
    const { status } = await call(route);
    expect(status).toBe(401);
    expect(route.minted()).not.toHaveBeenCalled();
  });
});

describe('the minted credential is still returned to an allowed caller', () => {
  it('returns the new key from orchestrator-key', async () => {
    hubSession.current = { user: USER };
    dbMock.dbWrite.apiKey.deleteMany.mockResolvedValue({ count: 0 });
    expect((await call(routes[0])).body).toEqual({ key: 'minted-api-key' });
  });

  it('returns the token from training-studio/host', async () => {
    hubSession.current = { user: USER };
    expect((await call(routes[1])).body).toMatchObject({ token: 'minted-orchestrator-token' });
  });

  it('returns the token from apps/assistant/token', async () => {
    hubSession.current = { user: USER };
    const assistant = routes.find((r) => r.path === '/api/apps/assistant/token')!;
    expect((await call(assistant)).body).toEqual({
      token: 'minted-assistant-token',
      expiresAt: '2099-01-01T00:00:00Z',
    });
  });
});

describe('apps/assistant/token POST (turn the assistant on), through the real AuthedEndpoint', () => {
  const assistant = routes.find((r) => r.path === '/api/apps/assistant/token')!;
  beforeEach(() => {
    hubSession.current = { user: USER };
  });

  it('accepts a JSON POST from a browser session and writes consent', async () => {
    const { status } = await call(assistant, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(status).toBe(200);
    expect(enableAppAssistant).toHaveBeenCalledWith(USER.id);
  });

  it('refuses a POST that is not JSON (a cross-origin form) without writing anything', async () => {
    const { status } = await call(assistant, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(status).toBe(415);
    expect(enableAppAssistant).not.toHaveBeenCalled();
  });

  it('allows only GET and POST', async () => {
    expect((await call(assistant, { method: 'PUT' })).status).toBe(405);
    expect(enableAppAssistant).not.toHaveBeenCalled();
  });

  it('a GET never writes consent', async () => {
    await call(assistant);
    expect(enableAppAssistant).not.toHaveBeenCalled();
  });
});
