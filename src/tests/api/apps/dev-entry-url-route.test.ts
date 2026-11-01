import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import type * as AppBlocksFlag from '~/server/services/app-blocks-flag';
import type * as DevTunnelSession from '~/server/services/blocks/dev-tunnel-session';

/**
 * GET /api/apps/dev/entry-url?blockId= — a freshly signed dev-tunnel entry URL for the
 * `/apps/dev/<blockId>` page's Retry, behind the page's own gates.
 *
 * `AuthedEndpoint` and `requireFullScopeSession` are the REAL ones: only the session lookup is
 * stubbed, so the unauthenticated and bearer-token cases exercise the route's actual wrapper.
 * The resolver chain (`resolveDevTunnelPageFrame` → `resolveDevTunnelFrame` → token signing and
 * host validation) is real too; only its data sources are stubbed (flags, registry, tunnel record,
 * DNS). That the page and this route refuse the SAME requests is pinned in
 * `src/tests/pages/apps/dev/dev-tunnel-page.test.ts`.
 */

const m = vi.hoisted(() => ({
  session: { current: null as null | { user: Record<string, unknown> } },
  /** What the real session lookup writes to `req.context` for each `Authorization` header. */
  bearerContexts: {} as Record<string, Record<string, unknown>>,
  features: vi.fn<(...a: unknown[]) => Promise<Record<string, boolean>>>(),
  devTunnelEnabled: vi.fn<(...a: unknown[]) => Promise<boolean>>(),
  resolveDev: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  activeTunnel: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  hostPublished: vi.fn<(host: string) => Promise<boolean>>(),
  sign: vi.fn(),
}));

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async ({ req }: { req: NextApiRequest }) => {
    const credential = m.bearerContexts[req.headers.authorization ?? ''];
    if (credential) Object.assign(req, { context: { ...credential } });
    return m.session.current;
  }),
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlagsAsync: (...a: unknown[]) => m.features(...a),
}));
vi.mock('~/server/services/app-blocks-flag', async (importOriginal) => ({
  ...(await importOriginal<typeof AppBlocksFlag>()),
  isAppBlocksDevTunnelEnabled: (...a: unknown[]) => m.devTunnelEnabled(...a),
  isAppBlocksDevTunnelUnsubmittedSpendEnabled: async () => true,
}));
vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: { resolveDevPageBlockForAuthor: (...a: unknown[]) => m.resolveDev(...a) },
}));
vi.mock('~/server/services/blocks/dev-tunnel.service', () => ({
  getActiveDevTunnel: (...a: unknown[]) => m.activeTunnel(...a),
}));
vi.mock('~/server/services/blocks/dev-tunnel-dns.service', () => ({
  isDevTunnelHostPublished: (host: string) => m.hostPublished(host),
}));
// The real signer, observed: a spy that delegates, so a signature can be asserted absent.
vi.mock('~/server/services/blocks/dev-tunnel-session', async (importOriginal) => {
  const real = await importOriginal<typeof DevTunnelSession>();
  m.sign.mockImplementation(real.signDevTunnelAccessToken);
  return { ...real, signDevTunnelAccessToken: m.sign };
});

const { env } = await import('~/env/server');
const handler = (await import('~/pages/api/apps/dev/entry-url')).default as unknown as (
  req: NextApiRequest,
  res: NextApiResponse
) => Promise<void>;

const SECRET = 'test-nextauth-secret-eeeeeeeeeeeeeeeeeeee';
const AUTHOR = { id: 555, username: 'dev', isModerator: false };
// Distinct in every hex digit from the fixtures in the page tests.
const HOST = `dev-a1b2c3d4e5f60718.${env.APPS_DOMAIN}`;
const DEV_APP = {
  appBlockId: 'apb_dev',
  blockId: 'my-app',
  appId: 'appblk-my-app',
  status: 'pending',
  trustTier: 'unverified' as const,
  name: 'My App',
  sandbox: 'allow-scripts',
  scopes: [] as string[],
  bootSkeleton: false,
};
const tunnel = (host: string) => ({
  sessionId: 'bki_s',
  userId: AUTHOR.id,
  blockId: 'my-app',
  host,
  hardExpiresAt: 9e9,
  spendCapBuzz: 5000,
});
const { TokenScope } = await import('~/shared/constants/token-scope.constants');
const personalKey = (tokenScope: number) => ({
  apiKeyId: 1,
  apiKeyType: 'User',
  subject: { type: 'apiKey', id: 1 },
  tokenScope,
});
const SCOPED_BEARER = 'Bearer scoped-key';
const FULL_BEARER = 'Bearer full-key';
m.bearerContexts[SCOPED_BEARER] = personalKey(TokenScope.Full & ~TokenScope.UserRead);
m.bearerContexts[FULL_BEARER] = personalKey(TokenScope.Full);

async function call(
  query: Record<string, unknown>,
  { authorization, method = 'GET' }: { authorization?: string; method?: string } = {}
) {
  const search = new URLSearchParams(
    Object.entries(query).filter((e): e is [string, string] => typeof e[1] === 'string')
  ).toString();
  const req = {
    method,
    url: `/api/apps/dev/entry-url${search ? `?${search}` : ''}`,
    headers: { host: 'civitai.com', ...(authorization ? { authorization } : {}) },
    query,
    cookies: {},
  } as unknown as NextApiRequest;
  let status = 200;
  let body: unknown;
  const headers = new Map<string, unknown>();
  const res = {
    status(code: number) {
      status = code;
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
  await handler(req, res);
  return { status, body: body as Record<string, unknown> | undefined, headers };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  vi.stubEnv('NEXTAUTH_SECRET', SECRET);
  m.sign.mockClear();
  m.session.current = { user: AUTHOR };
  m.features.mockReset().mockResolvedValue({ appBlocks: true, appBlocksAuthor: true });
  m.devTunnelEnabled.mockReset().mockResolvedValue(true);
  m.resolveDev.mockReset().mockResolvedValue(DEV_APP);
  m.activeTunnel.mockReset().mockResolvedValue(tunnel(HOST));
  m.hostPublished.mockReset().mockResolvedValue(true);
});

const NOT_FOUND = { status: 404, body: { error: 'App not found' } };

describe('GET /api/apps/dev/entry-url', () => {
  it('gives the author a freshly signed entry URL on the tunnel host, uncached', async () => {
    const res = await call({ blockId: 'my-app' });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body ?? {}).sort()).toEqual(['host', 'iframeSrc']);
    expect(res.body?.host).toBe(HOST);
    expect(res.body?.iframeSrc).toMatch(
      new RegExp(`^https://${HOST.replace(/\./g, '\\.')}/\\?dev=[^&]+$`)
    );
    expect(res.headers.get('cache-control')).toBe('no-store');
    // Positive control for the `not.toHaveBeenCalled` assertions on the refusals below.
    expect(m.sign).toHaveBeenCalledExactlyOnceWith({ userId: AUTHOR.id, host: HOST });
    expect(m.resolveDev).toHaveBeenCalledWith('my-app', AUTHOR.id, expect.anything());
    expect(m.activeTunnel).toHaveBeenCalledWith(AUTHOR.id, 'my-app');
  });

  it('never takes the host from the request', async () => {
    const res = await call({ blockId: 'my-app', host: 'evil.example', iframeSrc: 'https://x/' });
    expect(res.status).toBe(200);
    expect(res.body?.host).toBe(HOST);
    expect(String(res.body?.iframeSrc)).not.toContain('evil.example');
  });

  it('unauthenticated → 401, and nothing is resolved', async () => {
    m.session.current = null;
    expect((await call({ blockId: 'my-app' })).status).toBe(401);
    expect(m.features).not.toHaveBeenCalled();
    expect(m.resolveDev).not.toHaveBeenCalled();
  });

  it('a scoped Authorization: Bearer credential → 403, and nothing is resolved', async () => {
    const res = await call({ blockId: 'my-app' }, { authorization: SCOPED_BEARER });
    expect(res.status).toBe(403);
    expect(m.resolveDev).not.toHaveBeenCalled();
  });

  it('a full-scope personal key in Authorization: Bearer is served (control for the 403 above)', async () => {
    const res = await call({ blockId: 'my-app' }, { authorization: FULL_BEARER });
    expect(res.status).toBe(200);
    expect(res.body?.host).toBe(HOST);
  });

  it('a ?token= query credential is refused before anything is resolved', async () => {
    const res = await call({ blockId: 'my-app', token: 'abc' });
    expect(res.status).toBe(403);
    expect(m.resolveDev).not.toHaveBeenCalled();
  });

  it.each([
    ['App Blocks off', () => m.features.mockResolvedValue({ appBlocksAuthor: true })],
    ['the author capability off', () => m.features.mockResolvedValue({ appBlocks: true })],
    ['the dev-tunnel kill switch off', () => m.devTunnelEnabled.mockResolvedValue(false)],
    ['a block the caller does not own', () => m.resolveDev.mockResolvedValue(null)],
  ])('%s → the same bare 404, and nothing is signed', async (_name, arrange) => {
    arrange();
    const res = await call({ blockId: 'my-app' });
    expect({ status: res.status, body: res.body }).toEqual(NOT_FOUND);
    expect(m.sign).not.toHaveBeenCalled();
    expect(m.hostPublished).not.toHaveBeenCalled();
  });

  it('a block that does not exist answers exactly like a foreign one', async () => {
    m.resolveDev.mockResolvedValue(null);
    const foreign = await call({ blockId: 'someone-elses-app' });
    const missing = await call({ blockId: 'no-such-app' });
    expect({ status: foreign.status, body: foreign.body }).toEqual(NOT_FOUND);
    expect({ status: missing.status, body: missing.body }).toEqual(NOT_FOUND);
  });

  it.each([[{}], [{ blockId: '' }], [{ blockId: 'x'.repeat(65) }], [{ blockId: ['a', 'b'] }]])(
    'a malformed request %j answers the same 404 and resolves nothing',
    async (query) => {
      const res = await call(query);
      expect({ status: res.status, body: res.body }).toEqual(NOT_FOUND);
      expect(m.resolveDev).not.toHaveBeenCalled();
    }
  );

  it('the kill switch is checked before ownership is resolved', async () => {
    m.devTunnelEnabled.mockResolvedValue(false);
    await call({ blockId: 'my-app' });
    expect(m.devTunnelEnabled).toHaveBeenCalledWith({ user: AUTHOR });
    expect(m.resolveDev).not.toHaveBeenCalled();
    expect(m.activeTunnel).not.toHaveBeenCalled();
  });

  it('the tunnel host is not published yet → 409, no entry URL', async () => {
    m.hostPublished.mockResolvedValue(false);
    const res = await call({ blockId: 'my-app' });
    expect(res.status).toBe(409);
    expect(m.hostPublished).toHaveBeenCalledWith(HOST);
    expect(JSON.stringify(res.body)).not.toContain('?dev=');
  });

  it('no live tunnel → 409, no entry URL', async () => {
    m.activeTunnel.mockResolvedValue(null);
    const res = await call({ blockId: 'my-app' });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).not.toContain('?dev=');
  });

  it('a tunnel record with an invalid host is never signed or reflected', async () => {
    m.activeTunnel.mockResolvedValue(tunnel(`evil.example/../${HOST}`));
    const res = await call({ blockId: 'my-app' });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).not.toContain('evil.example');
    expect(JSON.stringify(res.body)).not.toContain('?dev=');
  });

  it('only GET is allowed', async () => {
    expect((await call({ blockId: 'my-app' }, { method: 'POST' })).status).toBe(405);
    expect(m.resolveDev).not.toHaveBeenCalled();
  });
});
