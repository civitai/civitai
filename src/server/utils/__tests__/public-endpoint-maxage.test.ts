import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Covers the optional per-endpoint `maxAge` on `PublicEndpoint`. by-hash
 * model-version lookups are near-immutable (a file's hash never changes; the
 * mapping only shifts on version unpublish/delete), so they opt into a longer
 * edge TTL than the shared 5-minute default meant for volatile list endpoints.
 * The default MUST stay 300s for every other caller.
 *
 * Exercises the REAL `PublicEndpoint` wrapper with only the heavy module-load
 * imports stubbed (mirrors public-endpoint-cache-override.test.ts).
 */

vi.mock('@civitai/next-axiom', () => ({
  withAxiom:
    (handler: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      handler(...args),
}));
// `allowedOrigins` at module load spreads `env.TRPC_ORIGINS` (must be iterable)
// and reads `env.NEXTAUTH_URL`; default everything else to undefined.
vi.mock('~/env/server', () => ({
  env: new Proxy(
    { TRPC_ORIGINS: [] as string[], NEXTAUTH_URL: undefined } as Record<string, unknown>,
    { get: (t, p: string) => (p in t ? t[p] : undefined) }
  ),
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

describe('PublicEndpoint per-endpoint maxAge', () => {
  beforeEach(() => vi.clearAllMocks());

  it('applies a longer s-maxage (and half-of-that SWR) when maxAge is provided', async () => {
    const { req, res, headers } = makeReqRes();
    // 24h — exercises the SWR = floor(maxAge/2) derivation for a large value.
    const handler = PublicEndpoint(async () => undefined, ['GET'], { maxAge: 60 * 60 * 24 });

    await handler(req, res);

    expect(headers['Cache-Control']).toBe('public, s-maxage=86400, stale-while-revalidate=43200');
  });

  it('emits the 1h TTL used by the by-hash single-lookup endpoint', async () => {
    const { req, res, headers } = makeReqRes();
    // Matches by-hash/[hash].ts: conservative 1h edge TTL until a purge-on-takedown hook lands.
    const handler = PublicEndpoint(async () => undefined, ['GET'], { maxAge: 60 * 60 });

    await handler(req, res);

    expect(headers['Cache-Control']).toBe('public, s-maxage=3600, stale-while-revalidate=1800');
  });

  it('keeps the 300s / 150s default when maxAge is omitted (backward compatible)', async () => {
    const { req, res, headers } = makeReqRes();
    const handler = PublicEndpoint(async () => undefined, ['GET']);

    await handler(req, res);

    expect(headers['Cache-Control']).toBe('public, s-maxage=300, stale-while-revalidate=150');
  });
});
