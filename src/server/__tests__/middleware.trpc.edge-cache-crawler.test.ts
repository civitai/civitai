import { describe, expect, it, vi } from 'vitest';

// `edgeCacheIt` returns early when `!isProd`, so the TTL-assigning block only runs with this
// mocked true (as in `middleware.trpc.edge-cache-precedence.test.ts`).
vi.mock('~/env/other', () => ({ isDev: false, isProd: true, isTest: false, isPreview: false }));
vi.mock('~/env/client', () => ({
  env: {
    NEXT_PUBLIC_BASE_URL: 'http://localhost:3000',
    NEXT_PUBLIC_CIVITAI_LINK: 'http://localhost:3000',
  },
  formatErrors: () => [],
}));

import type { Context } from '~/server/createContext';
import { edgeCacheIt } from '~/server/middleware.trpc';
import { createCallerFactory, publicProcedure, router } from '~/server/trpc';
import { willEdgeCache } from '~/server/trpc/edge-cache-headers';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const testRouter = router({
  cached: publicProcedure.use(edgeCacheIt({ ttl: 120 })).query(() => ({ ok: true })),
  // A scheduled expiry overwrites the incoming TTL, so only the post-resolver check holds here.
  expiring: publicProcedure
    .use(edgeCacheIt({ expireAt: () => new Date(Date.now() + 900_000) }))
    .query(() => ({ ok: true })),
});
const createCaller = createCallerFactory(testRouter);

const rootCtx = (headers: Record<string, string>) => ({
  user: undefined,
  acceptableOrigin: true,
  tokenScope: TokenScope.Full,
  req: { headers, query: {} },
  cache: { browserTTL: 60, edgeTTL: 60, staleWhileRevalidate: 30, canCache: true, skip: false },
  features: { canViewNsfw: true },
});

describe('edgeCacheIt and verified crawlers', () => {
  it('CONTROL: a signed-out call gets the procedure TTL', async () => {
    const root = rootCtx({});
    await createCaller(root as unknown as Context).cached();
    expect(root.cache.edgeTTL).toBe(120);
    expect(willEdgeCache(root.cache)).toBe(true);
  });

  it("never raises the TTL for a verified crawler's call", async () => {
    const root = rootCtx({ 'x-civitai-verified-bot': 'googlebot' });
    root.cache.edgeTTL = 0;
    await createCaller(root as unknown as Context).cached();
    expect(root.cache.edgeTTL).toBe(0);
    expect(willEdgeCache(root.cache)).toBe(false);
  });

  it("never raises the TTL for a verified crawler's call, even with a scheduled expiry", async () => {
    const root = rootCtx({ 'x-civitai-verified-bot': 'googlebot' });
    root.cache.edgeTTL = 0;
    await createCaller(root as unknown as Context).expiring();
    expect(root.cache.edgeTTL).toBe(0);
  });
});
