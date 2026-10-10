import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Caches from '~/server/redis/caches';

/**
 * `cosmetic.getViewerEventDecorations` answers with the VIEWER's hats, which before launch only a
 * flagged viewer may see. It reuses `getEventDecorationsForEntity` with the session user, so the
 * access rule is the feeds' own; the event engine is cut at `getVisibleDecorationEvents`, which is
 * where that rule is asked. The ids are the caller's, so only public content may answer.
 */
const FLAGGED = 101;
const UNFLAGGED = 102;
const EVENT = 'birthday2026';
const ENTITIES = ['Image', 'Model', 'Article'] as const;

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
import { TokenScope } from '~/shared/constants/token-scope.constants';

const decoration = (entity: string, id: number) => ({
  id: 90,
  name: 'Party Cap',
  type: 'ContentDecoration',
  source: 'Claim',
  data: { type: 'hat', event: EVENT, url: 'hat.png' },
  equippedToId: id,
  equippedToType: entity,
  userId: 5,
});

function callerFor(user: { id: number } | undefined, cache = { edgeTTL: 0, browserTTL: 0 }) {
  return cosmeticRouter.createCaller({
    user,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache,
    features: {},
    track: { action: vi.fn(() => Promise.resolve(true)) },
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  visibleEvents.mockImplementation(
    async (_entity: string, viewer?: { id: number }) =>
      new Set(viewer?.id === FLAGGED ? [EVENT] : [])
  );
  for (const entity of ENTITIES) {
    // Ids 1 and 2 wear a hat; only 1 is public.
    decorationFetch[entity].mockResolvedValue({
      1: decoration(entity, 1),
      2: decoration(entity, 2),
    });
    publicFetch[entity].mockResolvedValue({ 1: { id: 1 } });
  }
});

describe('cosmetic.getViewerEventDecorations', () => {
  it.each(ENTITIES)('gives a flagged viewer the %s hats on public ids', async (entityType) => {
    const result = await callerFor({ id: FLAGGED }).getViewerEventDecorations({
      entityType,
      ids: [1, 2, 3],
    });
    expect(Object.keys(result)).toEqual(['1']);
    expect(result[1]?.equippedToType).toBe(entityType);
    expect(result[1]).not.toHaveProperty('userId');
    expect(visibleEvents).toHaveBeenCalledWith(
      entityType,
      expect.objectContaining({ id: FLAGGED })
    );
    expect(decorationFetch[entityType]).toHaveBeenCalledWith([1, 2, 3], expect.anything());
    // Only the worn ids are checked for visibility.
    expect(publicFetch[entityType]).toHaveBeenCalledWith([1, 2]);
  });

  it('gives a signed-in viewer the flag is off for nothing', async () => {
    const result = await callerFor({ id: UNFLAGGED }).getViewerEventDecorations({
      entityType: 'Image',
      ids: [1],
    });
    expect(result).toEqual({});
  });

  it('refuses a signed-out caller', async () => {
    await expect(
      callerFor(undefined).getViewerEventDecorations({ entityType: 'Image', ids: [1] })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(decorationFetch.Image).not.toHaveBeenCalled();
  });

  it('refuses more than 100 ids and types that wear nothing', async () => {
    const caller = callerFor({ id: FLAGGED });
    const ids = Array.from({ length: 101 }, (_, i) => i + 1);
    await expect(
      caller.getViewerEventDecorations({ entityType: 'Image', ids })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.getViewerEventDecorations({ entityType: 'Post' as never, ids: [1] })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(decorationFetch.Image).not.toHaveBeenCalled();
  });

  it('turns off edge caching for the response', async () => {
    // Starts cacheable, so a route that lost noEdgeCache would leave these standing.
    const cache = { edgeTTL: 3600, browserTTL: 600 };
    await callerFor({ id: FLAGGED }, cache).getViewerEventDecorations({
      entityType: 'Image',
      ids: [1],
    });
    expect(cache).toMatchObject({ edgeTTL: 0, browserTTL: 0 });
  });
});

/**
 * Deliberate: a cached answer would publish a flagged viewer's pre-launch hats to whoever is served
 * it next. An edge-cacheable variant belongs in its own procedure, not this one. The rate limit is
 * pinned by text: it stands down in tests (middleware.trpc `isTest`).
 */
describe('cosmetic.getViewerEventDecorations stays per-viewer', () => {
  it('is authenticated, no-edge-cache, rate limited, and has no cache middleware', () => {
    const router = readFileSync(path.resolve(__dirname, '../cosmetic.router.ts'), 'utf8');
    const start = router.indexOf('getViewerEventDecorations: ');
    expect(start, 'getViewerEventDecorations procedure not found').toBeGreaterThan(-1);
    const end = router.indexOf('.query(', start);
    expect(end).toBeGreaterThan(start);
    const route = router.slice(start, end);
    expect(route).toMatch(/^getViewerEventDecorations: protectedProcedure\b/);
    expect(route).toContain('.use(noEdgeCache())');
    // The value too: a flagged homepage asks about a dozen times a load, so a tight limit would
    // starve its blocks of hats with nothing else red.
    expect(route).toContain('.use(rateLimit({ limit: 120, period: CacheTTL.xs }))');
    expect(route).not.toMatch(/edgeCacheIt|cacheIt/);
    // Add another middleware only after checking it keeps the answer per viewer, then widen this.
    expect(route.match(/\.use\(/g)).toHaveLength(2);
  });
});
