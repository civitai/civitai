import { generateKeyPairSync } from 'node:crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';
import type * as AppAssistantService from '~/server/services/app-assistant/app-assistant.service';

const { mintMock, consentMock, refusalMock, userRefusalMock, featuresMock } = vi.hoisted(() => ({
  mintMock: vi.fn(),
  consentMock: vi.fn(),
  refusalMock: vi.fn(),
  userRefusalMock: vi.fn(),
  featuresMock: vi.fn(),
}));

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/services/app-assistant/app-assistant.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppAssistantService>()),
  mintAppAssistantToken: mintMock,
  hasAppAssistantConsent: consentMock,
  getAppAssistantRefusal: refusalMock,
  getAppAssistantRefusalForUserId: userRefusalMock,
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
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getFeatureFlagsAsync: featuresMock,
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
  userRefusalMock.mockResolvedValue(null);
  featuresMock.mockResolvedValue({ appAssistantRemoteRunner: true });
});

describe('POST /api/internal/app-assistant/runner-token', () => {
  it('trades a current grant for a chat token, for the grant’s user', async () => {
    const { status, json, headers } = await call(mintRoute, {
      headers: asRunner,
      body: { grant: await grantFor(), purpose: 'chat' },
    });
    expect(status).toBe(200);
    expect(json).toEqual({ token: 'minted-chat-token', expiresAt: '2099-01-01T00:00:00Z' });
    expect(mintMock).toHaveBeenCalledWith(42, 'chat');
    expect(userRefusalMock).toHaveBeenCalledWith(42, { remoteRunner: true });
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
    // Control: the same grant mints before its expiry, so the 401 below is the expiry's.
    expect(
      (await call(mintRoute, { headers: asRunner, body: { grant: soon, purpose: 'chat' } })).status
    ).toBe(200);
    mintMock.mockClear();
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

  it('refuses with the terminal code refused when a gate refuses the user now (a ban), minting nothing', async () => {
    userRefusalMock.mockResolvedValue({
      status: 403,
      error: 'You cannot perform this action because your account has been banned',
    });
    const { status, json } = await call(mintRoute, {
      headers: asRunner,
      body: { grant: await grantFor(), purpose: 'chat' },
    });
    expect(status).toBe(403);
    expect(json).toEqual({
      error: 'You cannot perform this action because your account has been banned',
      code: 'refused',
    });
    expect(mintMock).not.toHaveBeenCalled();
  });

  it('refuses with refused when the App Assistant flag is off for the user', async () => {
    userRefusalMock.mockResolvedValue({
      status: 403,
      error: 'App Assistant is not available on this account',
    });
    const { status, json } = await call(mintRoute, {
      headers: asRunner,
      body: { grant: await grantFor(), purpose: 'chat' },
    });
    expect(status).toBe(403);
    expect(json).toMatchObject({ code: 'refused' });
    expect(mintMock).not.toHaveBeenCalled();
  });

  it('answers 503 unavailable, not refused, when the gates cannot be judged just now', async () => {
    userRefusalMock.mockResolvedValue({
      status: 503,
      error: 'App Assistant could not check this account just now',
      unavailable: true,
    });
    const { status, json } = await call(mintRoute, {
      headers: asRunner,
      body: { grant: await grantFor(), purpose: 'chat' },
    });
    expect(status).toBe(503);
    expect(json).toMatchObject({ code: 'unavailable' });
    expect(mintMock).not.toHaveBeenCalled();
  });

  it('mints only a sandbox token for a preview grant, never a chat token', async () => {
    const preview = await grantFor({ conversationId: 'preview:my-shop', use: 'preview' });
    const chat = await call(mintRoute, {
      headers: asRunner,
      body: { grant: preview, purpose: 'chat' },
    });
    expect(chat.status).toBe(403);
    expect(chat.json).toEqual({
      error: 'A preview grant mints sandbox tokens only',
      code: 'refused',
    });
    expect(mintMock).not.toHaveBeenCalled();
    // Control: the same grant gets a sandbox token, and a run grant still gets a chat token.
    const sandbox = await call(mintRoute, {
      headers: asRunner,
      body: { grant: preview, purpose: 'sandbox' },
    });
    expect(sandbox.status).toBe(200);
    expect(mintMock).toHaveBeenLastCalledWith(42, 'sandbox');
    const run = await call(mintRoute, {
      headers: asRunner,
      body: { grant: await grantFor(), purpose: 'chat' },
    });
    expect(run.status).toBe(200);
  });

  describe('the sandbox purpose, gated exactly as chat', () => {
    it.each(['chat', 'sandbox'] as const)(
      'mints a %s token for a user every gate lets through',
      async (purpose) => {
        mintMock.mockResolvedValue({
          token: `minted-${purpose}-token`,
          expiresAt: '2099-01-01T00:00:00Z',
        });
        const { status, json } = await call(mintRoute, {
          headers: asRunner,
          body: { grant: await grantFor(), purpose },
        });
        expect(status).toBe(200);
        expect(json).toEqual({
          token: `minted-${purpose}-token`,
          expiresAt: '2099-01-01T00:00:00Z',
        });
        expect(userRefusalMock).toHaveBeenCalledWith(42, { remoteRunner: true });
        expect(mintMock).toHaveBeenCalledWith(42, purpose);
      }
    );

    it.each(['chat', 'sandbox'] as const)(
      'refuses a %s token to a user a gate refuses now, minting nothing',
      async (purpose) => {
        userRefusalMock.mockResolvedValue({
          status: 403,
          error: 'You cannot perform this action because your account has been banned',
        });
        const { status, json } = await call(mintRoute, {
          headers: asRunner,
          body: { grant: await grantFor(), purpose },
        });
        expect(status).toBe(403);
        expect(json).toMatchObject({ code: 'refused' });
        expect(mintMock).not.toHaveBeenCalled();
      }
    );

    it.each(['chat', 'sandbox'] as const)(
      'answers %s unavailable when the gates cannot be judged just now',
      async (purpose) => {
        userRefusalMock.mockResolvedValue({
          status: 503,
          error: 'App Assistant could not check this account just now',
          unavailable: true,
        });
        const { status, json } = await call(mintRoute, {
          headers: asRunner,
          body: { grant: await grantFor(), purpose },
        });
        expect(status).toBe(503);
        expect(json).toMatchObject({ code: 'unavailable' });
        expect(mintMock).not.toHaveBeenCalled();
      }
    );

    it.each(['chat', 'sandbox'] as const)(
      'answers %s consent_required once the user turned App Assistant off',
      async (purpose) => {
        mintMock.mockResolvedValue(null);
        const { status, json } = await call(mintRoute, {
          headers: asRunner,
          body: { grant: await grantFor(), purpose },
        });
        expect(status).toBe(403);
        expect(json).toMatchObject({ code: 'consent_required' });
      }
    );

    it('needs the runner’s secret and a current grant for a sandbox token too', async () => {
      const grant = await grantFor();
      expect(
        (await call(mintRoute, { headers: {}, body: { grant, purpose: 'sandbox' } })).status
      ).toBe(401);
      const viewer = (await signRunnerViewerToken(42)).token;
      expect(
        (await call(mintRoute, { headers: asRunner, body: { grant: viewer, purpose: 'sandbox' } }))
          .status
      ).toBe(401);
      expect(mintMock).not.toHaveBeenCalled();
    });
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

  it('accepts the secret with a trailing newline on either side', async () => {
    setEnv({ ASSISTANT_RUNNER_SECRET: `${SECRET}\n` });
    const { status } = await call(mintRoute, {
      headers: { authorization: `bearer ${SECRET} ` },
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

  it('refuses while the server runner is off for the user, signing nothing', async () => {
    featuresMock.mockResolvedValue({ appAssistantRemoteRunner: false });
    const { status, json } = await call(grantRoute, { method: 'GET', query });
    expect(status).toBe(403);
    expect(json).toMatchObject({ code: 'runner_off' });
    expect(json).not.toHaveProperty('grant');
    // Control: the same request with the runner on is granted.
    featuresMock.mockResolvedValue({ appAssistantRemoteRunner: true });
    expect((await call(grantRoute, { method: 'GET', query })).status).toBe(200);
  });

  it('says in the grant whether the viewer may start subagents', async () => {
    featuresMock.mockResolvedValue({ appAssistantRemoteRunner: true, appAssistantSubagents: true });
    const on = await call(grantRoute, { method: 'GET', query });
    expect(await verifyRunGrant(on.json!.grant as string)).toMatchObject({ subagents: true });
    featuresMock.mockResolvedValue({ appAssistantRemoteRunner: true });
    const off = await call(grantRoute, { method: 'GET', query });
    expect(await verifyRunGrant(off.json!.grant as string)).toMatchObject({ subagents: false });
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

  it('signs a seven-minute preview grant for purpose=preview, never with subagents', async () => {
    featuresMock.mockResolvedValue({ appAssistantRemoteRunner: true, appAssistantSubagents: true });
    const preview = {
      conversationId: 'preview:my-shop',
      idempotencyKey: 'pk-1',
      purpose: 'preview',
    };
    const { status, json } = await call(grantRoute, { method: 'GET', query: preview });
    expect(status).toBe(200);
    const token = json!.grant as string;
    const [, payload] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    expect(claims).toMatchObject({
      sub: '42',
      cid: 'preview:my-shop',
      key: 'pk-1',
      use: 'preview',
    });
    expect(claims).not.toHaveProperty('subagents');
    expect((claims.exp as number) - (claims.iat as number)).toBe(420);
    // The runner's internal endpoints read it as any run grant (the runner decides what it is for).
    expect(await verifyRunGrant(token)).toMatchObject({
      userId: 42,
      conversationId: 'preview:my-shop',
    });
    // Control: without purpose, the same request signs a run grant, with no `use`.
    const run = await call(grantRoute, { method: 'GET', query });
    const [, runPayload] = (run.json!.grant as string).split('.');
    expect(JSON.parse(Buffer.from(runPayload!, 'base64url').toString())).not.toHaveProperty('use');
  });

  it('holds a preview grant to the same gates: refused while the server runner is off', async () => {
    featuresMock.mockResolvedValue({ appAssistantRemoteRunner: false });
    const preview = {
      conversationId: 'preview:my-shop',
      idempotencyKey: 'pk-1',
      purpose: 'preview',
    };
    const { status, json } = await call(grantRoute, { method: 'GET', query: preview });
    expect(status).toBe(403);
    expect(json).not.toHaveProperty('grant');
  });

  it('answers 400 to a purpose it does not know', async () => {
    const { status, json } = await call(grantRoute, {
      method: 'GET',
      query: { ...query, purpose: 'admin' },
    });
    expect(status).toBe(400);
    expect(json).not.toHaveProperty('grant');
  });

  it('answers 400 without a chat and a start, and 503 without a signing key', async () => {
    expect((await call(grantRoute, { method: 'GET', query: { conversationId: 'c' } })).status).toBe(
      400
    );
    setEnv({ ASSISTANT_RUNNER_SIGNING_KEY: undefined });
    expect((await call(grantRoute, { method: 'GET', query })).status).toBe(503);
  });
});
