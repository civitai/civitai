import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@civitai/next-axiom', () => ({
  withAxiom:
    (handler: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      handler(...args),
}));
vi.mock('~/env/server', () => ({
  env: new Proxy(
    { TRPC_ORIGINS: [] as string[], NEXTAUTH_URL: 'https://civitai.com' } as Record<string, unknown>,
    { get: (t, p: string) => (p in t ? t[p] : undefined) }
  ),
}));
vi.mock('~/server/db/db-helpers', () => ({ checkNotUpToDate: vi.fn() }));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: vi.fn(),
}));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => ({ user: { id: 1 } })),
}));
vi.mock('~/server/utils/key-generator', () => ({ generateSecretHash: vi.fn() }));
vi.mock('~/server/utils/server-domain', () => ({ getAllServerHosts: vi.fn(() => []) }));
vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
vi.mock('~/server/utils/errorHandling', () => ({ isClientAbortError: vi.fn(() => false) }));

import { AuthedEndpoint, MixedAuthEndpoint, PublicEndpoint } from '../endpoint-helpers';
import { createRealApiPair } from './real-api-response';

const APP = 'https://brawl.example';

function preflight(origin: string) {
  return createRealApiPair({
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'authorization',
    },
  });
}

describe('/api/v1 CORS for an app calling with its own token', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['PublicEndpoint', PublicEndpoint],
    ['MixedAuthEndpoint', MixedAuthEndpoint],
    ['AuthedEndpoint', AuthedEndpoint],
  ] as const)('%s lets a browser app send Authorization, and caches the answer', async (_, wrap) => {
    const handler = vi.fn(async () => undefined);
    const { req, res, header } = preflight(APP);

    await expect(wrap(handler, ['GET'])(req, res)).resolves.toBeUndefined();

    expect(res.statusCode).toBe(200);
    expect(header('Access-Control-Allow-Origin')).toBe('*');
    expect(String(header('Access-Control-Allow-Headers'))).toMatch(/\bAuthorization\b/);
    expect(header('Access-Control-Allow-Credentials')).toBeUndefined();
    expect(header('Access-Control-Max-Age')).toBe('7200');
    expect(handler).not.toHaveBeenCalled();
  });

  it('serves an authed route to a token from another origin, without offering it cookies', async () => {
    const handler = vi.fn(async (_req, res) => void res.status(200).json({ ok: true }));
    const { req, res, header } = createRealApiPair({
      headers: { origin: APP, authorization: 'Bearer token' },
    });

    await AuthedEndpoint(handler, ['GET'])(req, res);

    expect(handler).toHaveBeenCalledOnce();
    expect(header('Access-Control-Allow-Origin')).toBe('*');
    expect(header('Access-Control-Allow-Credentials')).toBeUndefined();
  });

  it('still offers civitai.com its cookies, for its own origin only', async () => {
    const { req, res, header } = preflight('https://civitai.com');

    await AuthedEndpoint(vi.fn(), ['GET'])(req, res);

    expect(header('Access-Control-Allow-Origin')).toBe('https://civitai.com');
    expect(header('Access-Control-Allow-Credentials')).toBe('true');
    expect(String(header('Vary'))).toMatch(/\bOrigin\b/);
  });

  it('does not take a look-alike host for civitai.com', async () => {
    const { req, res, header } = preflight('https://civitai.com.example');

    await AuthedEndpoint(vi.fn(), ['GET'])(req, res);

    expect(header('Access-Control-Allow-Origin')).toBe('*');
    expect(header('Access-Control-Allow-Credentials')).toBeUndefined();
  });

  it('still refuses a method a mixed route does not serve', async () => {
    const { req, res } = createRealApiPair({ method: 'DELETE', headers: { origin: APP } });

    await MixedAuthEndpoint(vi.fn(), ['GET'])(req, res);

    expect(res.statusCode).toBe(405);
  });
});
