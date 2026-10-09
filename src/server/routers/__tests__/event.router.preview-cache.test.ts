import { beforeEach, describe, expect, it, vi } from 'vitest';

// `edgeCacheIt` returns early when `!isProd`; see model.router.edge-cache-chain.test.ts.
vi.mock('~/env/other', () => ({ isDev: false, isProd: true, isTest: false, isPreview: false }));
vi.mock('~/env/client', () => ({
  env: {
    NEXT_PUBLIC_BASE_URL: 'http://localhost:3000',
    NEXT_PUBLIC_CIVITAI_LINK: 'http://localhost:3000',
  },
  formatErrors: () => [],
}));

const { service } = vi.hoisted(() => ({
  service: {
    getEventAccess: vi.fn(async () => 'open'),
    getEventStandings: vi.fn(async () => ({ teams: [] })),
    getEventContributors: vi.fn(async () => ({ allTime: [], day: [], teams: {} })),
  },
}));
vi.mock('~/server/services/event.service', () => service);

import { redisMock } from '~/__tests__/mocks/redis.mock';
import { eventRouter } from '~/server/routers/event.router';
import { willEdgeCache } from '~/server/trpc/edge-cache-headers';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * A previewer (a tester or moderator, before launch) is served an event the public cannot see yet,
 * through procedures that are edge-cached and, for getDonors, Redis-cached for everyone. Their
 * responses must never land in either cache. Runs the real middleware chain and reads the ROOT
 * context, which is what `responseMeta` turns into Cache-Control (see the model chain test).
 */
type Ctx = {
  user?: { id: number; isModerator?: boolean };
  acceptableOrigin: boolean;
  tokenScope: number;
  cache: {
    browserTTL: number;
    edgeTTL: number;
    staleWhileRevalidate: number;
    canCache: boolean;
    skip: boolean;
  };
  features: Record<string, boolean>;
};
type Middleware = (opts: {
  input?: unknown;
  ctx: Ctx;
  next: (opts?: { ctx?: Partial<Ctx> }) => unknown;
  path: string;
  getRawInput: () => Promise<unknown>;
  type: string;
}) => Promise<unknown>;

const procedures = (
  eventRouter as unknown as {
    _def: { procedures: Record<string, { _def: { middlewares: Middleware[] } }> };
  }
)._def.procedures;

// What createContext gives a signed-in caller: nothing cacheable unless a middleware writes it.
const rootCtx = (): Ctx => ({
  user: { id: 10 },
  acceptableOrigin: true,
  tokenScope: TokenScope.Full,
  cache: { browserTTL: 0, edgeTTL: 0, staleWhileRevalidate: 0, canCache: true, skip: false },
  features: {},
});

async function runChain(name: string) {
  const middlewares = procedures[name]._def.middlewares;
  const input = { event: 'birthday2026' };
  const root = rootCtx();
  let i = 0;
  const step = async (ctx: Ctx): Promise<unknown> => {
    if (i >= middlewares.length) return { ok: true, data: { ok: 1 }, marker: undefined, ctx };
    return middlewares[i++]({
      input,
      ctx,
      path: `event.${name}`,
      getRawInput: async () => input,
      type: 'query',
      next: (opts?: { ctx?: Partial<Ctx> }) =>
        step(opts?.ctx ? ({ ...ctx, ...opts.ctx } as Ctx) : ctx),
    });
  };
  await step(root);
  return root;
}

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.redis.packed.get.mockResolvedValue(null);
  redisMock.redis.packed.set.mockResolvedValue(undefined);
  redisMock.redis.eval.mockResolvedValue(1);
});

describe('event routes during the preview', () => {
  it('never edge-caches a previewer’s standings', async () => {
    service.getEventAccess.mockResolvedValue('preview');
    expect(willEdgeCache((await runChain('getStandings')).cache)).toBe(false);
  });

  // Positive control: without it, "not cached" would also pass if edgeCacheIt were inert here.
  it('edge-caches the same response once the event is open', async () => {
    service.getEventAccess.mockResolvedValue('open');
    expect(willEdgeCache((await runChain('getStandings')).cache)).toBe(true);
  });

  it('never writes a previewer’s response to the shared Redis cache either', async () => {
    service.getEventAccess.mockResolvedValue('preview');
    await runChain('getDonors');
    expect(redisMock.redis.packed.set).not.toHaveBeenCalled();

    service.getEventAccess.mockResolvedValue('open');
    await runChain('getDonors');
    expect(redisMock.redis.packed.set).toHaveBeenCalled();
  });
});
