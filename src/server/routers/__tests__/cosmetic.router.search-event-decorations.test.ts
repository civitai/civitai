import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Caches from '~/server/redis/caches';

// `edgeCacheIt` returns early unless `isProd`; `isTest` keeps `rateLimit` (and its Redis) out.
vi.mock('~/env/other', () => ({ isDev: false, isProd: true, isTest: true, isPreview: false }));
// `isProd` makes the client env schema require these; CI has no .env to supply them.
vi.mock('~/env/client', () => ({
  env: {
    NEXT_PUBLIC_BASE_URL: 'http://localhost:3000',
    NEXT_PUBLIC_CIVITAI_LINK: 'http://localhost:3000',
  },
  formatErrors: () => [],
}));

/**
 * `cosmetic.getEventDecorationsForSearch` gives the search grids their hats. From launch one answer
 * serves everyone, so it is cached at the edge; whenever a viewer sees otherwise, or the signed-out
 * see nothing, it must not be. The event engine is cut at `getVisibleDecorationEvents`, where the
 * flag is asked, and each case starts from an anonymous request's cacheable defaults, so a gate
 * that did nothing would leave a Cache-Control standing.
 */
const TESTER = 101;
const EVENT = 'birthday2026';
const OTHER_EVENT = 'otherEvent';

const { visibleEvents, decorationFetch, publicFetch } = vi.hoisted(() => ({
  visibleEvents: vi.fn(),
  decorationFetch: { Image: vi.fn(), Model: vi.fn(), Article: vi.fn() },
  publicFetch: { Image: vi.fn(), Model: vi.fn(), Article: vi.fn() },
}));

vi.mock('~/server/events/event-decoration-access', () => ({
  getVisibleDecorationEvents: visibleEvents,
}));
vi.mock('~/server/redis/caches', async (importOriginal) => {
  const actual = await importOriginal<typeof Caches>();
  const wrap = (fns: Record<string, (...args: unknown[]) => unknown>) =>
    Object.fromEntries(
      Object.entries(fns).map(([k, fn]) => [k, { fetch: (...args: unknown[]) => fn(...args) }])
    );
  return {
    ...actual,
    eventDecorationEntityCaches: wrap(decorationFetch),
    publicContentCaches: wrap(publicFetch),
  };
});

import { cosmeticRouter } from '~/server/routers/cosmetic.router';
import { willEdgeCache } from '~/server/trpc/edge-cache-headers';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const decoration = (id: number) => ({
  id: 90,
  name: 'Party Cap',
  type: 'ContentDecoration',
  source: 'Claim',
  data: { type: 'hat', event: EVENT, url: 'hat.png' },
  equippedToId: id,
  equippedToType: 'Model',
  userId: 5,
});

/** What `createContext` gives an anonymous request: cacheable unless something says otherwise. */
const anonymousDefaults = () => ({
  browserTTL: 60,
  edgeTTL: 60,
  staleWhileRevalidate: 30,
  canCache: true,
  skip: false,
});

function call(user: { id: number; isModerator?: boolean } | undefined, ids = [1, 2, 3]) {
  const cache = anonymousDefaults();
  const result = cosmeticRouter
    .createCaller({
      user,
      acceptableOrigin: true,
      tokenScope: TokenScope.Full,
      apiKeyId: null,
      req: { headers: {}, query: {} },
      res: { setHeader: () => undefined },
      cache,
      features: {},
      track: { action: vi.fn(() => Promise.resolve(true)) },
    } as never)
    .getEventDecorationsForSearch({ entityType: 'Model', ids });
  return { cache, result };
}

/** Who sees which events: the signed-out set, and per viewer id. */
function arrange(everyone: string[], byViewer: Record<number, string[]> = {}) {
  visibleEvents.mockImplementation(
    async (_entity: string, viewer?: { id: number }) =>
      new Set(viewer ? byViewer[viewer.id] ?? everyone : everyone)
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // Ids 1 and 2 wear a hat; only 1 is public.
  decorationFetch.Model.mockResolvedValue({ 1: decoration(1), 2: decoration(2) });
  publicFetch.Model.mockResolvedValue({ 1: { id: 1 } });
});

describe('cosmetic.getEventDecorationsForSearch after launch', () => {
  it('caches the signed-out answer at the edge, with no stale serving', async () => {
    arrange([EVENT]);
    const { cache, result } = call(undefined);
    expect(Object.keys(await result)).toEqual(['1']);
    expect(willEdgeCache(cache)).toBe(true);
    expect(cache).toMatchObject({ edgeTTL: 60, staleWhileRevalidate: 0 });
  });

  it('caches a signed-in answer that matches the signed-out one', async () => {
    arrange([EVENT]);
    const { cache, result } = call({ id: 7 });
    expect(Object.keys(await result)).toEqual(['1']);
    expect(willEdgeCache(cache)).toBe(true);
  });

  it('does not cache a viewer who sees more than the signed out', async () => {
    arrange([EVENT], { [TESTER]: [EVENT, OTHER_EVENT] });
    const { cache, result } = call({ id: TESTER });
    await result;
    expect(willEdgeCache(cache)).toBe(false);
  });

  it.each([
    ['a different set of the same size', [OTHER_EVENT]],
    ['fewer events than the signed out', []],
  ])('does not cache a viewer who sees %s', async (_, seen) => {
    arrange([EVENT], { [TESTER]: seen });
    const { cache, result } = call({ id: TESTER });
    await result;
    expect(willEdgeCache(cache)).toBe(false);
  });

  it('answers from the same read of the viewer that decided the caching', async () => {
    // A tester whose preview event drops out of one flag read and back into the next: the answer
    // must be built from the read that matched the signed out, or preview hats get cached.
    let reads = 0;
    visibleEvents.mockImplementation(async (_entity: string, viewer?: { id: number }) => {
      if (!viewer) return new Set([EVENT]);
      reads++;
      return new Set(reads === 1 ? [EVENT] : [EVENT, OTHER_EVENT]);
    });
    decorationFetch.Model.mockResolvedValue({
      1: decoration(1),
      3: { ...decoration(3), data: { type: 'hat', event: OTHER_EVENT, url: 'hat.png' } },
    });
    publicFetch.Model.mockResolvedValue({ 1: { id: 1 }, 3: { id: 3 } });
    const { cache, result } = call({ id: TESTER });
    expect(Object.keys(await result)).toEqual(['1']);
    expect(willEdgeCache(cache)).toBe(true);
    expect(reads).toBe(1);
  });

  it('does not cache after a kill switch, when the signed out see nothing again', async () => {
    // The base flag goes off post-launch: no shared answer exists, so nothing is cached and an
    // edge copy from before outlives it by no more than its TTL.
    arrange([], { [TESTER]: [EVENT] });
    for (const user of [undefined, { id: 7 }, { id: TESTER }]) {
      const { cache, result } = call(user && { ...user, isModerator: user.id === TESTER });
      await result;
      expect(willEdgeCache(cache)).toBe(false);
    }
  });
});

describe('cosmetic.getEventDecorationsForSearch in the preview', () => {
  beforeEach(() => arrange([], { [TESTER]: [EVENT] }));

  it("gives a tester their hats and never caches the tester's answer", async () => {
    const { cache, result } = call({ id: TESTER });
    expect(Object.keys(await result)).toEqual(['1']);
    expect(willEdgeCache(cache)).toBe(false);
    expect(cache).toMatchObject({ edgeTTL: 0, browserTTL: 0 });
  });

  it('does not cache the empty signed-out answer a tester could be served', async () => {
    const { cache, result } = call(undefined);
    expect(await result).toEqual({});
    expect(willEdgeCache(cache)).toBe(false);
  });
});

describe('cosmetic.getEventDecorationsForSearch input', () => {
  beforeEach(() => arrange([EVENT]));

  it.each([
    ['more than 100 ids', Array.from({ length: 101 }, (_, i) => i + 1)],
    ['unsorted ids', [2, 1]],
    ['repeated ids', [1, 1, 2]],
    ['no ids', []],
  ])('refuses %s, so none becomes its own cache key', async (_, ids) => {
    const { cache, result } = call(undefined, ids);
    await expect(result).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(decorationFetch.Model).not.toHaveBeenCalled();
    // Positive control for the defaults: a refused call never reached the gate either.
    expect(cache.edgeTTL).toBe(60);
  });

  it('accepts exactly 100 ascending ids', async () => {
    const ids = Array.from({ length: 100 }, (_, i) => i + 1);
    await expect(call(undefined, ids).result).resolves.toBeDefined();
    expect(decorationFetch.Model).toHaveBeenCalledWith(ids, expect.anything());
  });
});
