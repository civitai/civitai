import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as FliptClient from '~/server/flipt/client';
import type * as ImageService from '~/server/services/image.service';

/**
 * The seam between `getImagesAsPostsInfiniteHandler` and `shareFeedUsers`: with
 * `image-feed-shared-users` AND `trpc-fast-superjson-shared-refs` on, every image of one creator
 * (and its post) carries ONE `user` object; with either off, the handler's output is what it was.
 * The values are the same either way.
 */

const { fetches, flag } = vi.hoisted(() => ({
  fetches: vi.fn(),
  flag: { sharedUsers: null as boolean | null, sharedRefs: null as boolean | null },
}));

vi.mock('~/server/flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof FliptClient>();
  return {
    ...actual,
    isFliptSync: (key: string, ...rest: [string?, Record<string, string>?]) =>
      key === 'image-feed-shared-users'
        ? flag.sharedUsers
        : key === 'trpc-fast-superjson-shared-refs'
        ? flag.sharedRefs
        : actual.isFliptSync(key, ...rest),
  };
});
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getAllImages: fetches,
  getAllImagesIndex: fetches,
  getPostImageCounts: async () => new Map(),
  filterPinnedImagesToVersion: async (images: unknown[]) => images,
}));
vi.mock('~/server/services/model.service', () => ({
  getGallerySettingsByModelId: async () => ({ pinnedPosts: {}, hiddenImages: {} }),
  getHeldGalleryLevel: async () => undefined,
  isModelGalleryWithheld: async () => false,
}));
vi.mock('~/server/services/promotion.service', () => ({
  getSponsoredGalleryPost: async () => undefined,
}));

const { getImagesAsPostsInfiniteHandler } = await import('~/server/controllers/image.controller');
const { resetFeedSharedUsersGateForTests } = await import('~/server/utils/feed-shared-users');

// Two posts by creator 1 (three images, two images) and one by creator 2; each image's `user` is
// its own object, as `getAllImages` builds it.
const ROWS = [
  { id: 1, postId: 500, userId: 1 },
  { id: 2, postId: 500, userId: 1 },
  { id: 3, postId: 500, userId: 1 },
  { id: 4, postId: 600, userId: 1 },
  { id: 5, postId: 600, userId: 1 },
  { id: 6, postId: 700, userId: 2 },
];
const toImage = ({ userId, ...row }: (typeof ROWS)[number]) => ({
  ...row,
  nsfwLevel: 1,
  index: row.id,
  sortAt: new Date('2026-10-01'),
  user: {
    id: userId,
    username: `creator-${userId}`,
    image: null,
    deletedAt: null,
    cosmetics: [],
    profilePicture: null,
  },
  stats: {},
});

beforeEach(() => {
  vi.clearAllMocks();
  resetFeedSharedUsersGateForTests();
  flag.sharedUsers = null;
  // The prerequisite flag on by default here, so each case below varies `image-feed-shared-users`.
  flag.sharedRefs = true;
  dbMock.dbRead.resourceReview.findMany.mockResolvedValue([] as never);
  fetches.mockImplementation(async () => ({ items: ROWS.map(toImage) }));
});

const run = () =>
  getImagesAsPostsInfiniteHandler({
    input: {
      limit: 10,
      modelId: 1,
      modelVersionId: 10,
      include: [],
      browsingLevel: 1,
      sort: 'Newest',
    } as never,
    ctx: {
      user: { id: 5 },
      features: { imageIndexFeed: true, galleryLazyPostImages: false },
      req: { headers: {} },
    } as never,
  });

type Page = Awaited<ReturnType<typeof run>>;
const usersOf = (page: Page) =>
  page.items.flatMap((post) => [post.user, ...post.images.map((image) => image.user)]);
const distinctObjects = (users: unknown[]) => new Set(users).size;

describe('getImagesAsPostsInfiniteHandler — image-feed-shared-users', () => {
  it('shares one user object per creator across posts and images when on', async () => {
    flag.sharedUsers = true;
    const page = await run();
    // Positive control: the page really holds several images per creator.
    expect(page.items.flatMap((post) => post.images)).toHaveLength(6);
    expect(distinctObjects(usersOf(page))).toBe(2);
    const creator1 = page.items.find((post) => post.postId === 500)!.user;
    for (const post of page.items.filter((p) => p.user.id === 1)) {
      expect(post.user).toBe(creator1);
      for (const image of post.images) expect(image.user).toBe(creator1);
    }
  });

  it.each([
    ['off', false],
    ['unknown (no Flipt key yet)', null],
  ])('leaves every image its own user object when %s', async (_label, value) => {
    flag.sharedUsers = value;
    const page = await run();
    // The post shares its first image's `user`, as before the flag: 3 posts, 6 images.
    expect(distinctObjects(usersOf(page))).toBe(6);
  });

  it.each([
    ['off', false],
    ['unknown (no Flipt key yet)', null],
  ])(
    'leaves every image its own user object while trpc-fast-superjson-shared-refs is %s',
    async (_label, value) => {
      // Sharing with the fast walk unable to reuse a shared object would make it bail.
      flag.sharedUsers = true;
      flag.sharedRefs = value;
      const page = await run();
      expect(distinctObjects(usersOf(page))).toBe(6);
    }
  );

  it('serves the same values on and off', async () => {
    flag.sharedUsers = false;
    const off = await run();
    resetFeedSharedUsersGateForTests();
    flag.sharedUsers = true;
    const on = await run();
    expect(on).toStrictEqual(off);
    // A consumer-facing field survives on every image.
    for (const post of on.items)
      for (const image of post.images) expect(image.user.username).toBe(`creator-${post.user.id}`);
  });
});
