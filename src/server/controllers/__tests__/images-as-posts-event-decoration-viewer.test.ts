import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ImageService from '~/server/services/image.service';
import type * as Promotion from '~/shared/utils/promotion';

/**
 * The model gallery's posts view (image.getImagesAsPostsInfinite) reads its pinned posts, its
 * sponsored post and its page through three separate fetches. Before launch only a flagged viewer
 * sees event hats, and a fetch that names no viewer is treated as signed out, so each one has to
 * name the session user or that part of the gallery shows no hats while the image feed does.
 */
const { fetches } = vi.hoisted(() => ({
  fetches: vi.fn(async () => ({ items: [], nextCursor: undefined })),
}));

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getAllImages: fetches,
  getAllImagesIndex: fetches,
  filterPinnedImagesToVersion: async (images: unknown[]) => images,
}));
vi.mock('~/server/services/model.service', () => ({
  getGallerySettingsByModelId: async () => ({ pinnedPosts: { 10: [100] }, hiddenImages: {} }),
}));
vi.mock('~/server/services/promotion.service', () => ({
  getSponsoredGalleryPost: async () => ({ postId: 200, imageIds: [], servingLevel: 1 }),
}));
vi.mock('~/shared/utils/promotion', async (importOriginal) => ({
  ...(await importOriginal<typeof Promotion>()),
  sponsoredBrowsingLevel: () => 1,
}));

const { getImagesAsPostsInfiniteHandler } = await import('~/server/controllers/image.controller');

const user = { id: 5 };
const input = {
  limit: 10,
  modelId: 1,
  modelVersionId: 10,
  include: [],
  browsingLevel: 1,
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.resourceReview.findMany.mockResolvedValue([] as never);
});

describe('getImagesAsPostsInfiniteHandler event decorations', () => {
  it.each([false, true])(
    'names the session user on the pinned, sponsored and page fetches (index feed: %s)',
    async (imageIndexFeed) => {
      await getImagesAsPostsInfiniteHandler({
        input,
        ctx: { user, features: { imageIndexFeed }, req: { headers: {} } } as never,
      });
      const calls = fetches.mock.calls.map(
        (c) => (c as unknown as [{ postIds?: number[]; eventDecorationViewer?: unknown }])[0]
      );
      // Pinned, sponsored and at least one page: all three are reached, or this proves nothing.
      expect(calls.some((c) => c.postIds?.includes(100))).toBe(true);
      expect(calls.some((c) => c.postIds?.includes(200))).toBe(true);
      expect(calls.some((c) => !c.postIds)).toBe(true);
      for (const call of calls) expect(call.eventDecorationViewer).toBe(user);
    }
  );
});

/**
 * Naming the viewer is safe only while this route caches nothing per URL: `edgeCacheIt` sets an
 * edge TTL even for a signed-in caller, which would serve one viewer's preview hats to everyone.
 * Drop the viewer before adding a cache here.
 */
describe('image.getImagesAsPostsInfinite stays per-viewer', () => {
  it('has no cache middleware', () => {
    const router = readFileSync(join(process.cwd(), 'src/server/routers/image.router.ts'), 'utf8');
    const start = router.indexOf('getImagesAsPostsInfinite: ');
    expect(start, 'getImagesAsPostsInfinite procedure not found').toBeGreaterThan(-1);
    const end = router.indexOf('.query(getImagesAsPostsInfiniteHandler)', start);
    expect(end).toBeGreaterThan(start);
    const route = router.slice(start, end);
    expect(route).not.toMatch(/edgeCacheIt|cacheIt/);
    expect(route).not.toMatch(/\.use\(/);
  });
});
