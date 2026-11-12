import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ImageService from '~/server/services/image.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { ApiKeyType } from '~/shared/utils/prisma/enums';

/**
 * The post page lists its images through image.getInfinite with a `postId`, which always takes the
 * DB path. Before launch only a flagged viewer sees event hats, and a fetch that names no viewer is
 * treated as signed out, so the handler must name the viewer (eventViewerOf: a moderator counts only
 * on a session or a full-access key) or the post page shows no hats to the testers who wear them.
 * To whoever changes this: the viewer is safe to name only because image.getInfinite caches nothing
 * per URL (see images-as-posts-event-decoration-viewer.test.ts for
 * the same rule on the gallery route).
 */
const { getAllImages, getAllImagesIndex } = vi.hoisted(() => ({
  getAllImages: vi.fn(async () => ({ items: [], nextCursor: undefined })),
  getAllImagesIndex: vi.fn(async () => ({ items: [], nextCursor: undefined })),
}));

// Not a held-gallery test: no model is held.
vi.mock('~/server/services/model.service', () => ({
  getHeldGalleryLevel: async () => undefined,
  isModelGalleryWithheld: async () => false,
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getAllImages,
  getAllImagesIndex,
}));

const { getInfiniteImagesHandler } = await import('~/server/controllers/image.controller');

const moderator = { id: 5, isModerator: true };
const session = {};
const scopedKey = {
  apiKeyId: 9,
  apiKeyType: ApiKeyType.User,
  subject: { type: 'apiKey', id: 9 },
  tokenScope: TokenScope.MediaRead,
};
const input = { limit: 10, postId: 100, include: [], browsingLevel: 1 } as never;

beforeEach(() => vi.clearAllMocks());

describe('getInfiniteImagesHandler for a post', () => {
  it.each([
    [false, 'a session', session, true],
    [true, 'a session', session, true],
    [false, 'a scoped token', scopedKey, false],
    [true, 'a scoped token', scopedKey, false],
  ])(
    'names the viewer on the post fetch (index feed: %s, moderator on %s)',
    async (imageIndexFeed, _label, credential, isModerator) => {
      await getInfiniteImagesHandler({
        input,
        ctx: {
          user: moderator,
          ...credential,
          features: { imageIndexFeed },
          req: { headers: {} },
        } as never,
      });
      const calls = [...getAllImages.mock.calls, ...getAllImagesIndex.mock.calls].map(
        (c) => (c as unknown as [{ postId?: number; eventDecorationViewer?: unknown }])[0]
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].postId).toBe(100);
      expect(calls[0].eventDecorationViewer).toEqual({ id: 5, isModerator });
    }
  );
});

describe('getInfiniteImagesHandler on the index feed', () => {
  it.each([
    ['a session', session, true],
    ['a scoped token', scopedKey, false],
  ])('names the viewer (moderator on %s)', async (_label, credential, isModerator) => {
    await getInfiniteImagesHandler({
      input: { limit: 10, include: [], browsingLevel: 1 } as never,
      ctx: {
        user: moderator,
        ...credential,
        features: { imageIndexFeed: true },
        req: { headers: {} },
      } as never,
    });
    expect(getAllImages).not.toHaveBeenCalled();
    expect(getAllImagesIndex).toHaveBeenCalledTimes(1);
    const [arg] = getAllImagesIndex.mock.calls[0] as unknown as [
      { eventDecorationViewer?: unknown }
    ];
    expect(arg.eventDecorationViewer).toEqual({ id: 5, isModerator });
  });
});
