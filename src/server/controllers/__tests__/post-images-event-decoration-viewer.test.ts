import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ImageService from '~/server/services/image.service';

/**
 * The post page lists its images through image.getInfinite with a `postId`, which always takes the
 * DB path. Before launch only a flagged viewer sees event hats, and a fetch that names no viewer is
 * treated as signed out, so the handler must name the session user or the post page shows no hats
 * to the testers who wear them. To whoever changes this: the viewer is safe to name only because
 * image.getInfinite caches nothing per URL (see images-as-posts-event-decoration-viewer.test.ts for
 * the same rule on the gallery route).
 */
const { getAllImages, getAllImagesIndex } = vi.hoisted(() => ({
  getAllImages: vi.fn(async () => ({ items: [], nextCursor: undefined })),
  getAllImagesIndex: vi.fn(async () => ({ items: [], nextCursor: undefined })),
}));

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getAllImages,
  getAllImagesIndex,
}));

const { getInfiniteImagesHandler } = await import('~/server/controllers/image.controller');

const user = { id: 5 };
const input = { limit: 10, postId: 100, include: [], browsingLevel: 1 } as never;

beforeEach(() => vi.clearAllMocks());

describe('getInfiniteImagesHandler for a post', () => {
  it.each([false, true])(
    'names the session user on the post fetch (index feed: %s)',
    async (imageIndexFeed) => {
      await getInfiniteImagesHandler({
        input,
        ctx: { user, features: { imageIndexFeed }, req: { headers: {} } } as never,
      });
      const calls = [...getAllImages.mock.calls, ...getAllImagesIndex.mock.calls].map(
        (c) => (c as unknown as [{ postId?: number; eventDecorationViewer?: unknown }])[0]
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].postId).toBe(100);
      expect(calls[0].eventDecorationViewer).toBe(user);
    }
  );
});
