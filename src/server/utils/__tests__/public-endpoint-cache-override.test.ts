import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Audit fix for PR #2664: the model-download endpoint uses `PublicEndpoint`,
 * whose wrapper sets `Cache-Control: public, s-maxage=300, …` on EVERY response
 * BEFORE the handler runs. PR #2664 turns a delivery-worker / storage-resolver
 * resolve FAILURE into a 404. Because a resolve failure can be TRANSIENT (a
 * storage outage, not a permanently-missing file), that 404 must NOT be
 * CDN-edge-cached for 5 min — the endpoint sets `Cache-Control: no-store` on the
 * `resolve-failed` path specifically.
 *
 * This test pins the load-bearing mechanism: a `res.setHeader('Cache-Control', …)`
 * INSIDE the handler overrides the `PublicEndpoint` default (last-write-wins;
 * headers are not flushed until the handler sends). It exercises the REAL
 * `PublicEndpoint` wrapper, with only the heavy module-load imports stubbed.
 */

// endpoint-helpers.ts pulls a wide server graph at module load (env, db, auth,
// axiom, prom). Stub the pieces that touch real infra so the module imports in
// isolation. withAxiom must invoke the handler; instrumentApiResponse is a
// no-op here.
vi.mock('@civitai/next-axiom', () => ({
  withAxiom:
    (handler: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      handler(...args),
}));
// `allowedOrigins` at module load spreads `env.TRPC_ORIGINS` (must be iterable)
// and reads `env.NEXTAUTH_URL`; default everything else to undefined.
vi.mock('~/env/server', () => ({
  env: new Proxy({ TRPC_ORIGINS: [] as string[], NEXTAUTH_URL: undefined } as Record<
    string,
    unknown
  >, { get: (t, p: string) => (p in t ? t[p] : undefined) }),
}));
vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('~/server/db/db-helpers', () => ({ checkNotUpToDate: vi.fn() }));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: vi.fn(),
}));
vi.mock('~/server/auth/get-server-auth-session', () => ({ getServerAuthSession: vi.fn() }));
vi.mock('~/server/utils/key-generator', () => ({ generateSecretHash: vi.fn() }));
vi.mock('~/server/utils/server-domain', () => ({ getAllServerHosts: vi.fn(() => []) }));
vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
vi.mock('~/server/utils/errorHandling', () => ({ isClientAbortError: vi.fn(() => false) }));

import { PublicEndpoint } from '../endpoint-helpers';

type HeaderBag = Record<string, string | string[]>;

function makeReqRes(method = 'GET') {
  const headers: HeaderBag = {};
  const req = { method, headers: {}, query: {} } as never;
  const res = {
    setHeader: vi.fn((k: string, v: string | string[]) => {
      headers[k] = v;
    }),
    getHeader: (k: string) => headers[k],
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
  } as never;
  return { req, res, headers };
}

describe('PublicEndpoint Cache-Control override (PR #2664 resolve-failed 404)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets the public s-maxage cache header by default (the cacheable deterministic 404 path)', async () => {
    const { req, res, headers } = makeReqRes();
    const handler = PublicEndpoint(async () => undefined, ['GET']);

    await handler(req, res);

    // This is the default a deterministic by-id `not-found` 404 keeps — stable,
    // safe to edge-cache.
    expect(headers['Cache-Control']).toBe(
      'public, s-maxage=300, stale-while-revalidate=150'
    );
  });

  it('lets a handler override the default with no-store (the transient resolve-failed 404 path)', async () => {
    const { req, res, headers } = makeReqRes();
    const handler = PublicEndpoint(async (_req, response) => {
      // Mirrors the endpoint's `resolve-failed` branch: override the
      // PublicEndpoint default so a transient resolve failure is NOT edge-cached.
      response.setHeader('Cache-Control', 'private, no-store');
      response.status(404).send('File not found');
    }, ['GET']);

    await handler(req, res);

    // The override WINS: setHeader replaces, and the handler runs AFTER
    // addPublicCacheHeaders, before any flush.
    expect(headers['Cache-Control']).toBe('private, no-store');
    expect(headers['Cache-Control']).not.toContain('s-maxage');
  });
});
