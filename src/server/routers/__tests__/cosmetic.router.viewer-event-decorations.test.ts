import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Caches from '~/server/redis/caches';

/**
 * `cosmetic.getViewerEventDecorations` answers with the VIEWER's hats, which before launch only a
 * flagged viewer may see. It reuses `getEventDecorationsForEntity` with the session user, so the
 * access rule is the feeds' own; the event engine is cut at `getVisibleDecorationEvents`, which is
 * where that rule is asked.
 */
const FLAGGED = 7665867;
const EVENT = 'birthday2026';

const { visibleEvents, decorationFetch } = vi.hoisted(() => ({
  visibleEvents: vi.fn(),
  decorationFetch: vi.fn(),
}));

vi.mock('~/server/events/event-decoration-access', () => ({
  getVisibleDecorationEvents: visibleEvents,
}));
vi.mock('~/server/redis/caches', async (importOriginal) => {
  const actual = await importOriginal<typeof Caches>();
  const fetch = (...args: unknown[]) => decorationFetch(...args);
  return {
    ...actual,
    eventDecorationEntityCaches: { Image: { fetch }, Model: { fetch }, Article: { fetch } },
  };
});

import { cosmeticRouter } from '~/server/routers/cosmetic.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const decoration = {
  id: 90,
  name: 'Party Cap',
  type: 'ContentDecoration',
  source: 'Claim',
  data: { type: 'hat', event: EVENT, url: 'hat.png' },
  equippedToId: 1,
  equippedToType: 'Image',
  userId: 5,
};

function callerFor(user: { id: number } | undefined) {
  return cosmeticRouter.createCaller({
    user,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0, browserTTL: 0 },
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
  decorationFetch.mockResolvedValue({ 1: decoration });
});

describe('cosmetic.getViewerEventDecorations', () => {
  it('gives a flagged viewer the hats on the ids asked', async () => {
    const result = await callerFor({ id: FLAGGED }).getViewerEventDecorations({
      entityType: 'Image',
      ids: [1, 2],
    });
    expect(result[1]?.id).toBe(90);
    expect(result[1]).not.toHaveProperty('userId');
    expect(visibleEvents).toHaveBeenCalledWith('Image', expect.objectContaining({ id: FLAGGED }));
    expect(decorationFetch).toHaveBeenCalledWith([1, 2], expect.anything());
  });

  it('gives a signed-in viewer the flag is off for nothing', async () => {
    const result = await callerFor({ id: 5 }).getViewerEventDecorations({
      entityType: 'Image',
      ids: [1],
    });
    expect(result).toEqual({});
  });

  it('refuses a signed-out caller', async () => {
    await expect(
      callerFor(undefined).getViewerEventDecorations({ entityType: 'Image', ids: [1] })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(decorationFetch).not.toHaveBeenCalled();
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
    expect(decorationFetch).not.toHaveBeenCalled();
  });
});

/**
 * Deliberate: a cached answer would publish a flagged viewer's pre-launch hats to whoever is served
 * it next. `noEdgeCache` is pinned because `edgeCacheIt` elsewhere writes an edge TTL even for a
 * signed-in caller. An edge-cacheable variant belongs in its own procedure, not this one.
 */
describe('cosmetic.getViewerEventDecorations stays per-viewer', () => {
  it('is authenticated, no-edge-cache, and has no cache middleware', () => {
    const router = readFileSync(path.resolve(__dirname, '../cosmetic.router.ts'), 'utf8');
    const start = router.indexOf('getViewerEventDecorations: ');
    expect(start, 'getViewerEventDecorations procedure not found').toBeGreaterThan(-1);
    const end = router.indexOf('.query(', start);
    expect(end).toBeGreaterThan(start);
    const route = router.slice(start, end);
    expect(route).toMatch(/^getViewerEventDecorations: protectedProcedure\b/);
    expect(route).toContain('.use(noEdgeCache())');
    expect(route).not.toMatch(/edgeCacheIt|cacheIt/);
    // The only middleware is noEdgeCache; add another only after checking it keeps the answer
    // per viewer, then widen this.
    expect(route.match(/\.use\(/g)).toHaveLength(1);
  });
});
