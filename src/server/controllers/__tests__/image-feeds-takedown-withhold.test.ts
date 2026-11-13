import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { ApiKeyType } from '~/shared/utils/prisma/enums';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import type * as ImageService from '~/server/services/image.service';
import type * as ModelService from '~/server/services/model.service';
import type * as PostService from '~/server/services/post.service';
import { NsfwLevel } from '~/server/common/enums';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { ModelModifier } from '~/shared/utils/prisma/enums';

const { fetches, versionImages, posts } = vi.hoisted(() => ({
  posts: vi.fn(async () => ({ items: [{ id: 100 }], nextCursor: undefined })),
  fetches: vi.fn(async () => ({
    items: [{ id: 1, postId: 100, nsfwLevel: 1, user: { id: 5 } }],
    nextCursor: undefined,
  })),
  versionImages: vi.fn(async (ids: number[]) =>
    Object.fromEntries(
      ids.map((id) => [id, { modelVersionId: id, images: [{ id: 1, nsfwLevel: 1, userId: 5 }] }])
    )
  ),
}));

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getAllImages: fetches,
  getAllImagesIndex: fetches,
  getImagesForModelVersionCache: versionImages,
}));
// The real withhold check; the gallery hold and settings are other suites' concern.
vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelService>()),
  getGallerySettingsByModelId: async () => null,
  getHeldGalleryLevel: async () => undefined,
  getHeldLevelsByPost: async () => new Map(),
}));
const { addons } = vi.hoisted(() => ({ addons: [] as object[] }));
vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getBrowsingSettingAddons: async () => addons,
  getBlockedBrowsingTags: async () => [],
}));
vi.mock('~/server/services/post.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PostService>()),
  getPostsInfinite: posts,
}));
vi.mock('~/server/services/promotion.service', () => ({
  getSponsoredGalleryPost: async () => undefined,
}));

const {
  getInfiniteImagesHandler,
  getImagesAsPostsInfiniteHandler,
  getImagesForModelVersionHandler,
} = await import('~/server/controllers/image.controller');
const { getPostsInfiniteHandler } = await import('~/server/controllers/post.controller');

const OWNER = 5;
// Model 1 (version 10) is taken down; model 2 (version 20) is not.
const modes: Record<number, ModelModifier | null> = { 1: ModelModifier.TakenDown, 2: null };

type User = { id: number; isModerator?: boolean };
const ctx = (user?: User, subject?: unknown) =>
  ({
    user,
    subject,
    features: { imageIndexFeed: true },
    req: { headers: {} },
    ip: '127.0.0.1',
  } as never);
const feedInput = (selector: object) =>
  ({ limit: 10, include: [], browsingLevel: allBrowsingLevelsFlag, ...selector } as never);

const surfaces = [
  [
    'image.getInfinite by version',
    (user?: User, subject?: unknown, versionId = 10) =>
      getInfiniteImagesHandler({
        input: feedInput({ modelVersionId: versionId }),
        ctx: ctx(user, subject),
      }).then((result) => result.items),
  ],
  [
    'image.getInfinite by model',
    (user?: User, subject?: unknown, versionId = 10) =>
      getInfiniteImagesHandler({
        input: feedInput({ modelId: versionId / 10 }),
        ctx: ctx(user, subject),
      }).then((result) => result.items),
  ],
  // Post 100 is on version 10 and post 200 on version 20; review n is of version 10n.
  [
    'image.getInfinite by post',
    (user?: User, subject?: unknown, versionId = 10) =>
      getInfiniteImagesHandler({
        input: feedInput({ postId: versionId * 10 }),
        ctx: ctx(user, subject),
      }).then((result) => result.items),
  ],
  [
    'image.getInfinite by a page of posts',
    (user?: User, subject?: unknown, versionId = 10) =>
      getInfiniteImagesHandler({
        input: feedInput({ postIds: [versionId * 10] }),
        ctx: ctx(user, subject),
      }).then((result) => result.items),
  ],
  [
    'image.getInfinite by review',
    (user?: User, subject?: unknown, versionId = 10) =>
      getInfiniteImagesHandler({
        input: feedInput({ reviewId: versionId / 10 }),
        ctx: ctx(user, subject),
      }).then((result) => result.items),
  ],
  [
    'image.getImagesAsPostsInfinite',
    (user?: User, subject?: unknown, versionId = 10) =>
      getImagesAsPostsInfiniteHandler({
        input: feedInput({ modelId: versionId / 10, modelVersionId: versionId }),
        ctx: ctx(user, subject),
      }).then((result) => result.items),
  ],
  [
    'post.getInfinite by version',
    (user?: User, subject?: unknown, versionId = 10) =>
      getPostsInfiniteHandler({
        input: feedInput({ modelVersionId: versionId }),
        ctx: ctx(user, subject),
      }).then((result) => result.items),
  ],
  [
    'image.getImagesForModelVersion',
    (user?: User, subject?: unknown, versionId = 10) =>
      getImagesForModelVersionHandler({ input: { id: versionId }, ctx: ctx(user, subject) }).then(
        (result) => Object.values(result).flatMap((entry) => entry.images)
      ),
  ],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  installFakeCacheRedis();
  // The version's model: unflagged, owned by OWNER.
  dbMock.dbRead.modelVersion.findUnique.mockResolvedValue({
    modelId: 10,
    model: { userId: OWNER, minor: false, sfwOnly: false },
  } as never);
  dbMock.dbRead.modelVersion.findMany.mockImplementation((async ({
    where,
  }: {
    where: { id: { in: number[] } };
  }) => where.id.in.map((id) => ({ id, modelId: id / 10 }))) as never);
  dbMock.dbRead.model.findMany.mockImplementation((async ({
    where,
  }: {
    where: { id: { in: number[] } };
  }) => where.id.in.map((id) => ({ userId: OWNER, mode: modes[id] ?? null }))) as never);
  dbMock.dbRead.resourceReview.findMany.mockResolvedValue([] as never);
  dbMock.dbRead.post.findMany.mockImplementation((async ({
    where,
  }: {
    where: { id: { in: number[] } };
  }) => where.id.in.map((id) => ({ id, modelVersionId: id / 10 }))) as never);
  dbMock.dbRead.resourceReview.findUnique.mockImplementation((async ({
    where,
  }: {
    where: { id: number };
  }) => ({ modelVersionId: where.id * 10 })) as never);
});

describe('image.getInfinite by a single selector that cannot be resolved', () => {
  it('serves another user no images of a post not yet found', async () => {
    dbMock.dbRead.post.findMany.mockResolvedValue([] as never);
    const { items } = await getInfiniteImagesHandler({
      input: feedInput({ postId: 300 }),
      ctx: ctx({ id: 99 }),
    });
    expect(items).toEqual([]);
  });
});

describe.each(surfaces)('%s on a taken-down model', (_name, run) => {
  it.each([
    ['a signed-out visitor', undefined, undefined],
    ['another user', { id: 99 }, undefined],
    [
      'a moderator through an app they authorised',
      { id: 99, isModerator: true },
      { type: 'oauth' },
    ],
    ['its owner through an app they authorised', { id: OWNER }, { type: 'oauth' }],
  ])('serves %s no images', async (_viewer, user, subject) => {
    expect(await run(user, subject)).toEqual([]);
  });

  it.each([
    ['its owner', { id: OWNER }],
    ['a moderator', { id: 99, isModerator: true }],
  ])('serves %s its images', async (_viewer, user) => {
    expect(await run(user)).not.toEqual([]);
  });

  it("serves another user the images of a model that isn't taken down", async () => {
    expect(await run({ id: 99 }, undefined, 20)).not.toEqual([]);
  });
});

describe('image.getImagesForModelVersion on a capped site', () => {
  const image = (id: number, nsfwLevel: number) => ({ id, nsfwLevel, userId: OWNER });
  const run = async (context: object) => {
    versionImages.mockResolvedValueOnce({
      20: {
        modelVersionId: 20,
        images: [
          image(1, NsfwLevel.PG),
          image(2, NsfwLevel.X),
          image(3, 0),
          image(4, NsfwLevel.PG | NsfwLevel.XXX),
          image(5, NsfwLevel.PG | NsfwLevel.PG13),
        ],
      },
    } as never);
    const result = await getImagesForModelVersionHandler({
      input: { id: 20 },
      ctx: { req: { headers: {} }, ip: '127.0.0.1', ...context } as never,
    });
    return result[20].images.map((i) => i.id);
  };

  it('sends a capped viewer only images whose every rating bit is inside the cap', async () => {
    expect(await run({ user: { id: 6 }, features: { canViewNsfw: false } })).toEqual([1, 5]);
    expect(await run({ features: { canViewNsfw: true } })).toEqual([1]);
  });

  it.each([
    ['the owner', { user: { id: OWNER }, features: { canViewNsfw: false } }],
    ['a moderator', { user: { id: 7, isModerator: true }, features: { canViewNsfw: false } }],
  ])('keeps every image for %s', async (_label, context) => {
    expect(await run(context)).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps every rated image for an uncapped viewer, and an unrated one only for its owner', async () => {
    expect(await run({ user: { id: 6 }, features: { canViewNsfw: true } })).toEqual([1, 2, 4, 5]);
  });

  it("keeps a verified crawler's answer out of the edge cache, since humans get a capped one", async () => {
    const cache = { edgeTTL: 60, browserTTL: 60, staleWhileRevalidate: 30 };
    const req = { headers: { 'x-civitai-verified-bot': 'googlebot' } };
    await run({ features: { canViewNsfw: true }, req, cache });
    expect(cache).toEqual({ edgeTTL: 0, browserTTL: 0, staleWhileRevalidate: 0 });

    const human = { edgeTTL: 60, browserTTL: 60, staleWhileRevalidate: 30 };
    await run({ features: { canViewNsfw: true }, req: { headers: {} }, cache: human });
    expect(human).toEqual({ edgeTTL: 60, browserTTL: 60, staleWhileRevalidate: 30 });
  });
});

describe('image.getImagesForModelVersion viewer filtering', () => {
  const image = (
    id: number,
    extra: { poi?: boolean; minor?: boolean; nsfwLevel?: number } = {}
  ) => ({
    id,
    nsfwLevel: NsfwLevel.PG,
    userId: OWNER,
    ...extra,
  });
  const run = async (context: object, flags = { minor: false, sfwOnly: false }) => {
    versionImages.mockResolvedValueOnce({
      20: {
        modelVersionId: 20,
        images: [
          image(1),
          image(2, { poi: true }),
          image(3, { minor: true }),
          image(4, { nsfwLevel: NsfwLevel.X }),
          image(5, { nsfwLevel: NsfwLevel.PG13 }),
        ],
      },
    } as never);
    dbMock.dbRead.modelVersion.findUnique.mockResolvedValue({
      modelId: 10,
      model: { userId: OWNER, ...flags },
    } as never);
    const result = await getImagesForModelVersionHandler({
      input: { id: 20 },
      ctx: { req: { headers: {} }, ip: '127.0.0.1', ...context } as never,
    });
    return result[20].images.map((i) => i.id);
  };
  const uncapped = { user: { id: 6 }, features: { canViewNsfw: true } };

  beforeEach(() => {
    addons.length = 0;
  });

  it('drops poi and minor entries the resolved settings hide', async () => {
    addons.push({ type: 'some', nsfwLevels: [NsfwLevel.PG], disablePoi: true, disableMinor: true });
    expect(await run(uncapped)).toEqual([1, 4, 5]);
  });

  it('serves no images for a version with no row, except to a moderator', async () => {
    const noRow = async (context: object) => {
      versionImages.mockResolvedValueOnce({
        20: { modelVersionId: 20, images: [image(1)] },
      } as never);
      dbMock.dbRead.modelVersion.findUnique.mockResolvedValue(null as never);
      const result = await getImagesForModelVersionHandler({
        input: { id: 20 },
        ctx: { req: { headers: {} }, ip: '127.0.0.1', ...context } as never,
      });
      return result[20]?.images.map((i) => i.id) ?? [];
    };
    expect(await noRow(uncapped)).toEqual([]);
    // No owner id to match: an `undefined === undefined` owner check would let these through.
    expect(await noRow({ features: { canViewNsfw: true } })).toEqual([]);
    expect(
      await noRow({ user: { id: 7, isModerator: true }, features: { canViewNsfw: true } })
    ).toEqual([1]);
  });

  it('applies the poi and minor settings independently', async () => {
    addons.push({ type: 'some', nsfwLevels: [NsfwLevel.PG], disablePoi: true });
    expect(await run(uncapped)).toEqual([1, 3, 4, 5]);
    addons.length = 0;
    addons.push({ type: 'some', nsfwLevels: [NsfwLevel.PG], disableMinor: true });
    expect(await run(uncapped)).toEqual([1, 2, 4, 5]);
  });

  it('keeps them when no setting hides them, and for their owner', async () => {
    expect(await run(uncapped)).toEqual([1, 2, 3, 4, 5]);
    addons.push({ type: 'some', nsfwLevels: [NsfwLevel.PG], disablePoi: true, disableMinor: true });
    expect(await run({ user: { id: OWNER }, features: { canViewNsfw: true } })).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  describe('a minor or SFW-only model', () => {
    const held = { minor: false, sfwOnly: true };
    beforeEach(() => {
      const get = redisMock.redis.get.getMockImplementation();
      redisMock.redis.get.mockImplementation((async (key: string) =>
        key.startsWith('model:gallery-settings')
          ? JSON.stringify({ sfwHeld: true, level: NsfwLevel.PG })
          : get?.(key)) as never);
    });

    // Stored at PG: the PG-13 entry drops, which the SFW fallback level would keep.
    it('holds its showcase at the stored gallery level for an uncapped viewer', async () => {
      expect(await run(uncapped, held)).toEqual([1, 2, 3]);
      expect(await run(uncapped, { minor: true, sfwOnly: false })).toEqual([1, 2, 3]);
    });

    it('holds it for a moderator or the owner on a scoped key', async () => {
      const scoped = {
        apiKeyId: 9,
        apiKeyType: ApiKeyType.User,
        subject: { type: 'apiKey', id: 9 },
        tokenScope: TokenScope.ModelsRead,
      };
      expect(
        await run(
          { user: { id: 7, isModerator: true }, features: { canViewNsfw: true }, ...scoped },
          held
        )
      ).toEqual([1, 2, 3]);
      expect(
        await run({ user: { id: OWNER }, features: { canViewNsfw: true }, ...scoped }, held)
      ).toEqual([1, 2, 3]);
    });

    it('serves it whole to the owner and a moderator on a session', async () => {
      expect(await run({ user: { id: OWNER }, features: { canViewNsfw: true } }, held)).toEqual([
        1, 2, 3, 4, 5,
      ]);
      expect(
        await run({ user: { id: 7, isModerator: true }, features: { canViewNsfw: true } }, held)
      ).toEqual([1, 2, 3, 4, 5]);
    });
  });
});
