import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '~/server/createContext';
import type * as ImageService from '~/server/services/image.service';
import type * as PostService from '~/server/services/post.service';
import {
  allBrowsingLevelsFlag,
  nsfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { NsfwLevel } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const { getAllImages, getAllImagesIndex, getPostsInfinite, heldLevel, heldByPost } = vi.hoisted(
  () => ({
    heldByPost: vi.fn(),
    getAllImages: vi.fn(async () => ({ items: [], nextCursor: undefined })),
    getAllImagesIndex: vi.fn(async () => ({ items: [], nextCursor: undefined })),
    getPostsInfinite: vi.fn(async () => ({ items: [], nextCursor: undefined })),
    heldLevel: vi.fn(),
  })
);

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getAllImages,
  getAllImagesIndex,
}));
vi.mock('~/server/services/post.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PostService>()),
  getPostsInfinite,
}));
vi.mock('~/server/services/model.service', () => ({
  getHeldGalleryLevel: heldLevel,
  getHeldLevelsByPost: heldByPost,
}));

const { getInfiniteImagesHandler } = await import('~/server/controllers/image.controller');
const { getPostsInfiniteHandler } = await import('~/server/controllers/post.controller');

const ctx = (imageIndexFeed: boolean, isModerator = false) =>
  ({
    user: { id: 7, isModerator },
    features: { imageIndexFeed, datapacketRead: false },
    req: { headers: {} },
    ip: '127.0.0.1',
  } as unknown as Context);

// Each selector a caller can pick one model's images by, on the backend it is served from.
const imageRequests = [
  ['a version, from the index', { modelVersionId: 10 }, true, getAllImagesIndex],
  ['a version, from the database', { modelVersionId: 10 }, false, getAllImages],
  ['a model', { modelId: 1 }, true, getAllImages],
  ['a review', { reviewId: 3 }, false, getAllImages],
  ['a post', { postId: 100 }, true, getAllImages],
  ['a page of posts', { postIds: [100] }, true, getAllImages],
] as const;

const fetchedLevel = (fetch: typeof getAllImages) =>
  (fetch.mock.calls[0] as unknown as [{ browsingLevel: number }])[0].browsingLevel;

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps a resolved or rejected value, so one test's would reach the next.
  heldLevel.mockReset();
  heldByPost.mockReset().mockResolvedValue(new Map());
});

describe('image.getInfinite on a held model', () => {
  it.each(imageRequests)(
    'serves %s only at the held level',
    async (_name, selector, imageIndexFeed, fetch) => {
      heldLevel.mockResolvedValue(NsfwLevel.PG);
      const input = { limit: 10, include: [], browsingLevel: allBrowsingLevelsFlag, ...selector };

      await getInfiniteImagesHandler({ input: input as never, ctx: ctx(imageIndexFeed) });

      expect(heldLevel).toHaveBeenCalledWith(expect.objectContaining(selector));
      expect(fetchedLevel(fetch)).toBe(NsfwLevel.PG);
    }
  );

  it('returns an empty storyline, fetching nothing, when its held chapters share no level', async () => {
    heldLevel.mockResolvedValue(0);
    const input = {
      limit: 10,
      include: [],
      browsingLevel: allBrowsingLevelsFlag,
      postIds: [100, 200],
    };

    const result = await getInfiniteImagesHandler({ input: input as never, ctx: ctx(true) });

    expect(result.items).toEqual([]);
    expect(getAllImages).not.toHaveBeenCalled();
    expect(getAllImagesIndex).not.toHaveBeenCalled();
  });

  it('returns an empty page, fetching nothing, when no asked level is held', async () => {
    heldLevel.mockResolvedValue(NsfwLevel.PG);
    const input = {
      limit: 10,
      include: [],
      browsingLevel: nsfwBrowsingLevelsFlag,
      modelVersionId: 10,
    };

    const result = await getInfiniteImagesHandler({ input: input as never, ctx: ctx(true) });

    expect(result.items).toEqual([]);
    expect(getAllImagesIndex).not.toHaveBeenCalled();
    expect(getAllImages).not.toHaveBeenCalled();
  });

  it('serves a moderator the level asked for, where a non-moderator is held', async () => {
    heldLevel.mockResolvedValue(NsfwLevel.PG);
    const input = {
      limit: 10,
      include: [],
      browsingLevel: allBrowsingLevelsFlag,
      modelVersionId: 10,
    };

    await getInfiniteImagesHandler({ input: input as never, ctx: ctx(true, true) });
    await getInfiniteImagesHandler({ input: input as never, ctx: ctx(true) });

    const levels = getAllImagesIndex.mock.calls.map(
      (call) => (call as unknown as [{ browsingLevel: number }])[0].browsingLevel
    );
    expect(levels).toEqual([allBrowsingLevelsFlag, NsfwLevel.PG]);
  });

  it('holds a moderator who comes through an app they authorised', async () => {
    heldLevel.mockResolvedValue(NsfwLevel.PG);
    const input = {
      limit: 10,
      include: [],
      browsingLevel: allBrowsingLevelsFlag,
      modelVersionId: 10,
    };

    await getInfiniteImagesHandler({
      input: input as never,
      ctx: { ...ctx(true, true), subject: { type: 'oauth', id: 'app' } } as unknown as Context,
    });

    expect(fetchedLevel(getAllImagesIndex)).toBe(NsfwLevel.PG);
  });

  it('serves nothing when it cannot tell whether the model is held', async () => {
    heldLevel.mockRejectedValueOnce(new Error('cache down'));
    const input = {
      limit: 10,
      include: [],
      browsingLevel: allBrowsingLevelsFlag,
      modelVersionId: 10,
    };

    await expect(
      getInfiniteImagesHandler({ input: input as never, ctx: ctx(true) })
    ).rejects.toThrow();
    expect(getAllImagesIndex).not.toHaveBeenCalled();
  });

  it.each([
    ['a signed-in moderator', {}, true],
    [
      'a moderator on a full-access key',
      {
        apiKeyId: 1,
        apiKeyType: 'User',
        subject: { type: 'apiKey', id: 1 },
        tokenScope: TokenScope.Full,
      },
      true,
    ],
    ['a moderator through an app', { subject: { type: 'oauth', id: 'app' } }, false],
  ])(
    "exempts %s from a hub's held models only on a full credential",
    async (_name, credential, exempt) => {
      heldLevel.mockResolvedValue(undefined);
      const input = { limit: 10, include: [], browsingLevel: allBrowsingLevelsFlag, hubId: 3 };

      await getInfiniteImagesHandler({
        input: input as never,
        ctx: {
          ...ctx(true, true),
          features: { imageIndexFeed: true, userHubs: true },
          ...credential,
        } as unknown as Context,
      });

      expect(getAllImagesIndex).toHaveBeenCalledWith(
        expect.objectContaining({ holdExempt: exempt })
      );
    }
  );

  it('holds a signed-out viewer', async () => {
    heldLevel.mockResolvedValue(NsfwLevel.PG);
    const input = {
      limit: 10,
      include: [],
      browsingLevel: allBrowsingLevelsFlag,
      modelVersionId: 10,
    };

    await getInfiniteImagesHandler({
      input: input as never,
      ctx: { ...ctx(true), user: undefined } as unknown as Context,
    });

    expect(fetchedLevel(getAllImagesIndex)).toBe(NsfwLevel.PG);
  });

  it('leaves an unheld model at the level asked for', async () => {
    heldLevel.mockResolvedValue(undefined);
    const input = {
      limit: 10,
      include: [],
      browsingLevel: allBrowsingLevelsFlag,
      modelVersionId: 10,
    };

    await getInfiniteImagesHandler({ input: input as never, ctx: ctx(true) });

    expect(fetchedLevel(getAllImagesIndex)).toBe(allBrowsingLevelsFlag);
  });
});

describe("post.getInfinite on a held model's version", () => {
  const run = (browsingLevel: number) =>
    getPostsInfiniteHandler({
      input: { limit: 10, browsingLevel, modelVersionId: 10 } as never,
      ctx: ctx(true),
    });

  it('holds a moderator who comes through an app they authorised', async () => {
    heldLevel.mockResolvedValue(NsfwLevel.PG);

    await getPostsInfiniteHandler({
      input: { limit: 10, browsingLevel: allBrowsingLevelsFlag, modelVersionId: 10 } as never,
      ctx: { ...ctx(true, true), subject: { type: 'oauth', id: 'app' } } as unknown as Context,
    });

    expect(fetchedLevel(getPostsInfinite)).toBe(NsfwLevel.PG);
  });

  it('holds a page of posts named by id', async () => {
    heldLevel.mockResolvedValue(NsfwLevel.PG);

    await getPostsInfiniteHandler({
      input: { limit: 10, browsingLevel: allBrowsingLevelsFlag, ids: [100] } as never,
      ctx: ctx(true),
    });

    expect(heldLevel).toHaveBeenCalledWith(expect.objectContaining({ postIds: [100] }));
    expect(fetchedLevel(getPostsInfinite)).toBe(NsfwLevel.PG);
  });

  it('serves the posts only at the held level', async () => {
    heldLevel.mockResolvedValue(NsfwLevel.PG);

    await run(allBrowsingLevelsFlag);

    expect(heldLevel).toHaveBeenCalledWith(expect.objectContaining({ modelVersionId: 10 }));
    expect(fetchedLevel(getPostsInfinite)).toBe(NsfwLevel.PG);
  });

  it('returns an empty page, fetching nothing, when no asked level is held', async () => {
    heldLevel.mockResolvedValue(NsfwLevel.PG);

    const result = await run(nsfwBrowsingLevelsFlag);

    expect(result.items).toEqual([]);
    expect(getPostsInfinite).not.toHaveBeenCalled();
  });

  it('serves a moderator the level asked for, where a non-moderator is held', async () => {
    heldLevel.mockResolvedValue(NsfwLevel.PG);
    const input = { limit: 10, browsingLevel: allBrowsingLevelsFlag, modelVersionId: 10 } as never;

    await getPostsInfiniteHandler({ input, ctx: ctx(true, true) });
    await getPostsInfiniteHandler({ input, ctx: ctx(true) });

    const levels = getPostsInfinite.mock.calls.map(
      (call) => (call as unknown as [{ browsingLevel: number }])[0].browsingLevel
    );
    expect(levels).toEqual([allBrowsingLevelsFlag, NsfwLevel.PG]);
  });

  it('leaves an unheld version at the level asked for', async () => {
    heldLevel.mockResolvedValue(undefined);

    await run(allBrowsingLevelsFlag);

    expect(fetchedLevel(getPostsInfinite)).toBe(allBrowsingLevelsFlag);
  });
});

describe('image.getInfinite by image id', () => {
  const HELD_POST = 100;
  const OWNER = 50;
  const page = {
    items: [
      { id: 1, postId: HELD_POST, nsfwLevel: NsfwLevel.PG },
      { id: 2, postId: HELD_POST, nsfwLevel: NsfwLevel.X },
      { id: 3, postId: 200, nsfwLevel: NsfwLevel.X },
      { id: 4, postId: null, nsfwLevel: NsfwLevel.X },
    ],
    nextCursor: undefined,
  };
  const idsOf = (result: { items: { id: number }[] }) => result.items.map((image) => image.id);
  const run = (selector: object, imageIndexFeed: boolean, context = ctx(imageIndexFeed)) =>
    getInfiniteImagesHandler({
      input: { limit: 10, include: [], browsingLevel: allBrowsingLevelsFlag, ...selector } as never,
      ctx: context,
    });

  beforeEach(() => {
    heldLevel.mockResolvedValue(undefined);
    heldByPost.mockResolvedValue(new Map([[HELD_POST, { level: NsfwLevel.PG, ownerId: OWNER }]]));
    getAllImages.mockResolvedValue(page as never);
    getAllImagesIndex.mockResolvedValue(page as never);
  });

  it.each([
    ['ids, from the database', { ids: [1, 2, 3, 4] }, false],
    ['ids, from the index', { ids: [1, 2, 3, 4] }, true],
    ['an image id', { imageId: 2 }, false],
  ])(
    "leaves out an image above its post's held level, picked by %s",
    async (_, selector, index) => {
      expect(idsOf(await run(selector, index))).toEqual([1, 3, 4]);
    }
  );

  it("serves the model's owner and a moderator every image", async () => {
    const owner = { ...ctx(false), user: { id: OWNER } } as unknown as Context;
    expect(idsOf(await run({ ids: [1, 2, 3, 4] }, false, owner))).toEqual([1, 2, 3, 4]);
    expect(idsOf(await run({ ids: [1, 2, 3, 4] }, false, ctx(false, true)))).toEqual([1, 2, 3, 4]);
  });

  it("holds a signed-out viewer when the model's owner is not known", async () => {
    heldByPost.mockResolvedValue(new Map([[HELD_POST, { level: NsfwLevel.PG }]]));
    const signedOut = { ...ctx(false), user: undefined } as unknown as Context;
    expect(idsOf(await run({ ids: [1, 2, 3, 4] }, false, signedOut))).toEqual([1, 3, 4]);
  });

  it('leaves a feed that does not pick images by id as it was', async () => {
    expect(idsOf(await run({ username: 'someone' }, false))).toEqual([1, 2, 3, 4]);
    expect(heldByPost).not.toHaveBeenCalled();
  });
});
