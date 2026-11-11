import { describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const { session } = vi.hoisted(() => ({ session: vi.fn(async (): Promise<unknown> => null) }));

// Module-scope allowlists and the router tree; none of them decides the cache settings.
vi.mock('~/server/utils/origin-helpers', () => ({
  isAllowedOriginRequest: () => true,
  hostFromUrl: (v: string) => v,
  allowedOriginHosts: new Set<string>(),
}));
vi.mock('~/server/utils/server-domain', () => ({
  getRequestDomainColor: () => 'blue',
  getAllServerHosts: () => ['civitai.com'],
}));
vi.mock('~/server/auth/get-server-auth-session', () => ({ getServerAuthSession: session }));
vi.mock('~/server/services/feature-flags.service', () => ({
  getFeatureFlagsLazy: vi.fn(() => ({})),
}));
vi.mock('~/server/routers', () => ({ appRouter: {} }));
vi.mock('~/server/trpc', () => ({ createCallerFactory: () => (ctx: unknown) => ctx }));

const { createContext } = await import('../createContext');

const cacheFor = async (query: Record<string, string>) => {
  const req = { headers: {}, socket: {}, cookies: {}, query } as unknown as NextApiRequest;
  const res = { once: vi.fn(), writableEnded: false } as unknown as NextApiResponse;
  return (await createContext({ req, res })).cache;
};
const none = { edgeTTL: 0, browserTTL: 0, staleWhileRevalidate: 0 };

describe('createContext cache settings', () => {
  it('a signed-out single call keeps the edge cache', async () => {
    expect(await cacheFor({})).toMatchObject({
      edgeTTL: 60,
      browserTTL: 60,
      staleWhileRevalidate: 30,
    });
  });

  // Its headers are written before any procedure runs, so no resolver can opt a crawler's
  // uncapped answer back out; the browser only batches when signed in.
  it('a signed-out streamed batch is never cached', async () => {
    expect(await cacheFor({ batch: '1' })).toMatchObject(none);
  });

  it('a signed-in call is never cached, batched or not', async () => {
    session.mockResolvedValue({ user: { id: 1 } });
    expect(await cacheFor({})).toMatchObject(none);
    expect(await cacheFor({ batch: '1' })).toMatchObject(none);
    session.mockResolvedValue(null);
  });
});
