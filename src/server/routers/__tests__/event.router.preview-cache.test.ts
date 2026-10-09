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

type Access = 'closed' | 'preview' | 'open' | 'ended';
const { access, service } = vi.hoisted(() => {
  const access = { viewer: 'open' as Access, signedOut: 'open' as Access };
  const ok = () => vi.fn(async () => ({ ok: 1 }));
  return {
    access,
    service: {
      // The access a viewer gets; signed out (viewer undefined) is the public's.
      getViewerEventAccess: vi.fn(async ({ viewer }: { viewer?: unknown }) =>
        viewer ? access.viewer : access.signedOut
      ),
      getEventData: ok(),
      getTeamScores: ok(),
      getTeamScoreHistory: ok(),
      getEventPartners: ok(),
      getEventRewards: ok(),
      getEventContributors: ok(),
      getEventStandings: ok(),
      getEventCosmeticScores: ok(),
      getWornEventHat: ok(),
    },
  };
});
vi.mock('~/server/services/event.service', () => service);

import { redisMock } from '~/__tests__/mocks/redis.mock';
import { eventRouter } from '~/server/routers/event.router';
import { willEdgeCache } from '~/server/trpc/edge-cache-headers';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * Event routes are edge-cached by URL, and getDonors is also cached in Redis, for everyone. A viewer
 * who sees the event differently from the public (a tester in the preview, a moderator while the
 * flag's base is off after the start) must never have their response cached, and a viewer who
 * cannot see the event must be refused before any cache can answer. Runs each route's real
 * middleware chain and reads the ROOT context, which is what `responseMeta` turns into
 * Cache-Control (see model.router.edge-cache-chain.test.ts).
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

// Every public event read, with the service function behind it.
const ROUTES = {
  getData: 'getEventData',
  getTeamScores: 'getTeamScores',
  getTeamScoreHistory: 'getTeamScoreHistory',
  getPartners: 'getEventPartners',
  getRewards: 'getEventRewards',
  getDonors: 'getEventContributors',
  getStandings: 'getEventStandings',
  getCosmeticScores: 'getEventCosmeticScores',
  getWornHat: 'getWornEventHat',
} as const;
// getData's edgeCacheIt is commented out, so it is gated but never edge-cached.
const EDGE_CACHED = Object.keys(ROUTES).filter((r) => r !== 'getData');
const VIEWER = { id: 10 };

// What createContext gives a signed-in caller: nothing cacheable unless a middleware writes it.
const rootCtx = (user?: Ctx['user']): Ctx => ({
  user,
  acceptableOrigin: true,
  tokenScope: TokenScope.Full,
  cache: { browserTTL: 0, edgeTTL: 0, staleWhileRevalidate: 0, canCache: true, skip: false },
  features: {},
});

async function runChain(name: string, user: Ctx['user'] = VIEWER) {
  const middlewares = procedures[name]._def.middlewares;
  const input = { event: 'birthday2026', cosmetics: [], entityType: 'Image', entityId: 1 };
  const root = rootCtx(user);
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
  return { root };
}

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.redis.packed.get.mockResolvedValue(null);
  redisMock.redis.packed.set.mockResolvedValue(undefined);
  redisMock.redis.eval.mockResolvedValue(1);
});

describe.each(EDGE_CACHED)('event.%s caching', (name) => {
  it('never caches a tester’s preview response', async () => {
    Object.assign(access, { viewer: 'preview', signedOut: 'closed' });
    expect(willEdgeCache((await runChain(name)).root.cache)).toBe(false);
  });

  it('never caches a flagged viewer’s response while the base is off after the start', async () => {
    Object.assign(access, { viewer: 'open', signedOut: 'closed' });
    expect(willEdgeCache((await runChain(name)).root.cache)).toBe(false);
  });

  // Positive control: without it, "not cached" would also pass if the cache were inert here.
  it('caches it once everyone sees the same event', async () => {
    Object.assign(access, { viewer: 'open', signedOut: 'open' });
    expect(willEdgeCache((await runChain(name)).root.cache)).toBe(true);
  });

  it('asks about this viewer and about a signed-out one', async () => {
    Object.assign(access, { viewer: 'preview', signedOut: 'closed' });
    await runChain(name);
    expect(service.getViewerEventAccess.mock.calls.map(([a]) => a)).toEqual([
      { event: 'birthday2026', viewer: VIEWER },
      { event: 'birthday2026', viewer: undefined },
    ]);
  });
});

describe.each(Object.entries(ROUTES))('event.%s gate', (name, serviceFn) => {
  it('refuses a viewer who cannot see the event before reaching any cache or the service', async () => {
    Object.assign(access, { viewer: 'closed', signedOut: 'closed' });
    await expect(runChain(name)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(redisMock.redis.packed.get).not.toHaveBeenCalled();
    expect(service[serviceFn]).not.toHaveBeenCalled();
  });

  it('serves a viewer who can', async () => {
    Object.assign(access, { viewer: 'preview', signedOut: 'closed' });
    await runChain(name);
    expect(service[serviceFn]).toHaveBeenCalledTimes(1);
  });
});

describe('event.getDonors Redis cache', () => {
  it('never stores a response the public would not get, and stores one it would', async () => {
    Object.assign(access, { viewer: 'open', signedOut: 'closed' });
    await runChain('getDonors');
    expect(redisMock.redis.packed.set).not.toHaveBeenCalled();

    Object.assign(access, { viewer: 'open', signedOut: 'open' });
    await runChain('getDonors');
    expect(redisMock.redis.packed.set).toHaveBeenCalled();
  });
});
