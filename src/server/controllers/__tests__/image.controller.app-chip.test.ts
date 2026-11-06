import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The image page's "Published with <app>" query — the controller→service SEAM.
 *
 * `readImageAppChip` owns the decision and its fail-open (pinned in
 * `image-app-chip.service.test.ts`); this file pins what only the handler can get
 * wrong: the requested id, the REQUEST's viewer, host and browsing level reach the
 * resolver, and the route is never edge-cached per URL (the answer is per viewer).
 */
const { mockReadImageAppChip } = vi.hoisted(() => ({
  mockReadImageAppChip: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
}));

vi.mock('~/server/services/blocks/image-app-chip.service', () => ({
  readImageAppChip: mockReadImageAppChip,
}));

const { getImagePublishedWithAppHandler } = await import('~/server/controllers/image.controller');

type HandlerCtx = Parameters<typeof getImagePublishedWithAppHandler>[0]['ctx'];

const IMAGE_ID = 145511044;
const HOST = 'civitai.red';
// Opted into PG and R (5 — distinct from every browsing-level constant), on a request whose
// features admit NSFW, so `getRequestBrowsingLevel` returns the saved level.
const VIEWER = { id: 77, isModerator: false, showNsfw: true, browsingLevel: 5 };
const CHIP = { slug: 'character-sheet-studio', name: 'Character Sheet Studio', iconUrl: null };

const ctx = (over: Record<string, unknown> = {}) =>
  ({
    user: VIEWER,
    features: { canViewNsfw: true },
    req: { headers: { host: HOST } },
    ...over,
  } as unknown as HandlerCtx);

beforeEach(() => {
  mockReadImageAppChip.mockReset();
  mockReadImageAppChip.mockResolvedValue(CHIP);
});

describe('getImagePublishedWithAppHandler', () => {
  it('returns the resolved chip for the requested image, as this viewer, on this host', async () => {
    const c = ctx();
    await expect(
      getImagePublishedWithAppHandler({ input: { id: IMAGE_ID }, ctx: c })
    ).resolves.toEqual(CHIP);
    expect(mockReadImageAppChip).toHaveBeenCalledTimes(1);
    expect(mockReadImageAppChip).toHaveBeenCalledWith({
      imageId: IMAGE_ID,
      ctx: c,
      host: HOST,
      viewerBrowsingLevel: 5,
    });
  });

  it('a missing host is passed as empty (the maturity gate fails closed on it)', async () => {
    await getImagePublishedWithAppHandler({
      input: { id: IMAGE_ID },
      ctx: ctx({ req: undefined }),
    });
    expect(mockReadImageAppChip.mock.calls[0][0]).toMatchObject({ host: '' });
  });

  it('answers null when the resolver does (an ordinary image)', async () => {
    mockReadImageAppChip.mockResolvedValue(null);
    await expect(
      getImagePublishedWithAppHandler({ input: { id: IMAGE_ID }, ctx: ctx() })
    ).resolves.toBeNull();
  });

  it('the route is registered and never edge-cached per URL', () => {
    const router = readFileSync(join(process.cwd(), 'src/server/routers/image.router.ts'), 'utf8');
    const start = router.indexOf('\n  getPublishedWithApp: ');
    expect(start, 'image.getPublishedWithApp procedure not found').toBeGreaterThan(-1);
    const end = router.indexOf('.query(getImagePublishedWithAppHandler)', start);
    expect(end).toBeGreaterThan(start);
    const route = router.slice(start, end);
    expect(route).not.toMatch(/edgeCacheIt|cacheIt/);
    expect(route).not.toMatch(/\.use\(/);
  });
});
