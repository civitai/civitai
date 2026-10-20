import { generateKeyPairSync } from 'node:crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as AppAssistantService from '~/server/services/app-assistant/app-assistant.service';

const { mintMock, consentMock, refusalMock } = vi.hoisted(() => ({
  mintMock: vi.fn(),
  consentMock: vi.fn(),
  refusalMock: vi.fn(),
}));

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/services/app-assistant/app-assistant.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppAssistantService>()),
  mintAppAssistantToken: mintMock,
  hasAppAssistantConsent: consentMock,
  getAppAssistantRefusal: refusalMock,
}));
// The session gates are covered route by route in credential-minting-routes-session-scope.test.ts;
// here the signed-in user is given, and the test is about what the routes do for them.
vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  AuthedEndpoint:
    (handler: (req: NextApiRequest, res: NextApiResponse, user: unknown) => unknown) =>
    (req: NextApiRequest, res: NextApiResponse) =>
      handler(req, res, { id: 42 }),
}));
vi.mock('~/server/utils/require-full-scope-session', () => ({
  requireFullScopeSession: () => true,
}));

const { verifyRunGrant, signRunGrant, signRunnerViewerToken } = await import(
  '~/server/services/app-assistant/assistant-runner-tokens'
);
const mintRoute = (await import('~/pages/api/internal/app-assistant/runner-token')).default;
const grantRoute = (await import('~/pages/api/apps/assistant/run-grant')).default;

// TEST-ONLY values: a key pair generated for this run, and a placeholder secret.
const SECRET = 'test-only-runner-secret';
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const SIGNING_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown> | unknown;

async function call(
  handler: Handler,
  {
    method = 'POST',
    headers = {},
    body,
    query = {},
  }: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    query?: Record<string, string>;
  }
) {
  let status = 200;
  let json: Record<string, unknown> | undefined;
  const sent = new Map<string, unknown>();
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(value: Record<string, unknown>) {
      json = value;
      return res;
    },
    setHeader(name: string, value: unknown) {
      sent.set(name.toLowerCase(), value);
      return res;
    },
    getHeader: (name: string) => sent.get(name.toLowerCase()),
  } as unknown as NextApiResponse;
  await handler({ method, headers, body, query } as unknown as NextApiRequest, res);
  return { status, json, headers: sent };
}

const asRunner = { authorization: `Bearer ${SECRET}` };
const grantFor = async (fields: Partial<Parameters<typeof signRunGrant>[0]> = {}) =>
  (await signRunGrant({ userId: 42, conversationId: 'c-1', idempotencyKey: 'k-1', ...fields }))
    .token;

beforeEach(() => {
  vi.clearAllMocks();
  setEnv({
    ASSISTANT_RUNNER_SECRET: SECRET,
    ASSISTANT_RUNNER_SIGNING_KEY: SIGNING_KEY,
    ASSISTANT_RUNNER_GRANT_TTL_SECONDS: 7800,
  });
  mintMock.mockResolvedValue({ token: 'minted-chat-token', expiresAt: '2099-01-01T00:00:00Z' });
  consentMock.mockResolvedValue(true);
  refusalMock.mockResolvedValue(null);
  redisMock.sysRedis.incr.mockResolvedValue(1);
});

describe('POST /api/internal/app-assistant/runner-token', () => {
  it('trades a current grant for a token of the purpose asked, for the grant’s user', async () => {
    const { status, json, headers } = await call(mintRoute, {
      headers: asRunner,
      body: { grant: await grantFor(), purpose: 'sandbox' },
    });
    expect(status).toBe(200);
    expect(json).toEqual({ token: 'minted-chat-token', expiresAt: '2099-01-01T00:00:00Z' });
    expect(mintMock).toHaveBeenCalledWith(42, 'sandbox');
    expect(headers.get('cache-control')).toBe('no-store');
  });

  it('answers 401 to a missing or wrong runner secret, and mints nothing', async () => {
    const grant = await grantFor();
    for (const headers of [
      {},
      { authorization: 'Bearer not-the-secret' },
      { authorization: SECRET },
    ]) {
      const { status } = await call(mintRoute, { headers, body: { grant, purpose: 'chat' } });
      expect(status, JSON.stringify(headers)).toBe(401);
    }
    expect(mintMock).not.toHaveBeenCalled();
  });

  it('answers 503 when the secret is not configured, even to a caller presenting a blank one', async () => {
    for (const secret of [undefined, '', '   ']) {
      setEnv({ ASSISTANT_RUNNER_SECRET: secret });
      const { status } = await call(mintRoute, {
        headers: { authorization: `Bearer ${secret ?? ''}` },
        body: { grant: await grantFor(), purpose: 'chat' },
      });
      expect(status).toBe(503);
    }
    expect(mintMock).not.toHaveBeenCalled();
  });

  it('refuses a grant that is expired, unsigned by civitai, or a viewer token (aud confusion)', async () => {
    setEnv({ ASSISTANT_RUNNER_GRANT_TTL_SECONDS: 60 });
    const soon = await grantFor();
    vi.useFakeTimers({ now: Date.now() + 10 * 60 * 1000, toFake: ['Date'] });
    try {
      const expired = await call(mintRoute, {
        headers: asRunner,
        body: { grant: soon, purpose: 'chat' },
      });
      expect(expired.status).toBe(401);
    } finally {
      vi.useRealTimers();
    }
    const viewer = (await signRunnerViewerToken(42)).token;
    const asViewer = await call(mintRoute, {
      headers: asRunner,
      body: { grant: viewer, purpose: 'chat' },
    });
    expect(asViewer).toMatchObject({ status: 401, json: { code: 'invalid_grant' } });
    const garbage = await call(mintRoute, {
      headers: asRunner,
      body: { grant: 'a.b.c', purpose: 'chat' },
    });
    expect(garbage.status).toBe(401);
    expect(mintMock).not.toHaveBeenCalled();
  });

  it('answers 403 consent_required once the user turned App Assistant off', async () => {
    mintMock.mockResolvedValue(null);
    const { status, json } = await call(mintRoute, {
      headers: asRunner,
      body: { grant: await grantFor(), purpose: 'chat' },
    });
    expect(status).toBe(403);
    expect(json).toMatchObject({ code: 'consent_required' });
  });

  it('stops a grant that mints far more than a run would', async () => {
    redisMock.sysRedis.incr.mockResolvedValue(61);
    redisMock.sysRedis.ttl.mockResolvedValue(120);
    const { status, headers } = await call(mintRoute, {
      headers: asRunner,
      body: { grant: await grantFor(), purpose: 'chat' },
    });
    expect(status).toBe(429);
    expect(headers.get('retry-after')).toBe('120');
    expect(mintMock).not.toHaveBeenCalled();
  });

  it('mints on when the rate limiter’s Redis is down', async () => {
    redisMock.sysRedis.incr.mockRejectedValue(new Error('redis down'));
    const { status } = await call(mintRoute, {
      headers: asRunner,
      body: { grant: await grantFor(), purpose: 'chat' },
    });
    expect(status).toBe(200);
  });

  it('refuses a body that is not a grant and a purpose', async () => {
    const { status } = await call(mintRoute, {
      headers: asRunner,
      body: { grant: await grantFor(), purpose: 'everything' },
    });
    expect(status).toBe(400);
    expect(mintMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/apps/assistant/run-grant', () => {
  const query = { conversationId: 'c-9', idempotencyKey: 'k-9' };

  it('signs a grant for the signed-in user, bound to the chat and the start it names', async () => {
    const { status, json } = await call(grantRoute, { method: 'GET', query });
    expect(status).toBe(200);
    expect(await verifyRunGrant(json!.grant as string)).toMatchObject({
      userId: 42,
      conversationId: 'c-9',
      idempotencyKey: 'k-9',
    });
    expect(Date.parse(json!.expiresAt as string) - Date.now()).toBeGreaterThan(7700 * 1000);
  });

  it('refuses without App Assistant consent', async () => {
    consentMock.mockResolvedValue(false);
    const { status, json } = await call(grantRoute, { method: 'GET', query });
    expect(status).toBe(403);
    expect(json).toMatchObject({ code: 'consent_required' });
  });

  it('refuses a user the App Assistant gates refuse', async () => {
    refusalMock.mockResolvedValue({ status: 403, error: 'banned' });
    const { status, json } = await call(grantRoute, { method: 'GET', query });
    expect(status).toBe(403);
    expect(json).toEqual({ error: 'banned' });
    expect(consentMock).not.toHaveBeenCalled();
  });

  it('answers 400 without a chat and a start, and 503 without a signing key', async () => {
    expect((await call(grantRoute, { method: 'GET', query: { conversationId: 'c' } })).status).toBe(
      400
    );
    setEnv({ ASSISTANT_RUNNER_SIGNING_KEY: undefined });
    expect((await call(grantRoute, { method: 'GET', query })).status).toBe(503);
  });
});
