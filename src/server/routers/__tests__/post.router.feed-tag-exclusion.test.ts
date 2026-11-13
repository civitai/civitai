import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CacheHelpers from '~/server/utils/cache-helpers';
import type * as Caches from '~/server/redis/caches';
import type * as ModelService from '~/server/services/model.service';
import type * as SystemCache from '~/server/services/system-cache';
import type * as UserPreferences from '~/server/services/user-preferences.service';
import { NsfwLevel } from '~/server/common/enums';
import { PostSort } from '~/server/common/enums';
import type { BrowsingSettingsAddon } from '~/shared/constants/browsing-settings-addons';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { publicBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { ApiKeyType, MetricTimeframe } from '~/shared/utils/prisma/enums';

/**
 * The post feed's images follow the viewer's hidden tags and the browsing-settings exclusions at
 * the request's level on the server, whatever the request sent: a caller that never sends them
 * (signed out, a session, an API key) gets the same filtered feed. Runs the real procedure,
 * middleware, handler, service and addon resolution over stubbed posts, images and addon rules.
 */

const CREATOR = 7;
const ANY_LEVEL_TAG = 5249; // excluded at every level
const MATURE_TAG = 5351; // excluded only at R and above
const VIEWER_HIDDEN_TAG = 42; // a tag the signed-in viewer hid

const h = vi.hoisted(() => ({
  addons: [] as unknown[],
  hiddenTagsByUser: {} as Record<number, { id: number; hidden: boolean }[]>,
  // How many post rows the query returns: the real one returns `limit + 1`.
  rows: undefined as number | undefined,
}));

const POSTS = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((id) => ({
  id,
  userId: CREATOR,
  cursorId: id,
  title: null,
  publishedAt: new Date('2026-01-01T00:00:00Z'),
  modelVersionId: null,
  collectionId: null,
  nsfwLevel: NsfwLevel.PG,
}));
const image = (id: number, postId: number, over: Record<string, unknown> = {}) => ({
  id,
  postId,
  userId: CREATOR,
  nsfwLevel: NsfwLevel.PG,
  poi: false,
  minor: false,
  tagIds: [] as number[],
  ...over,
});
const IMAGES = [
  image(11, 1),
  image(21, 2, { tagIds: [ANY_LEVEL_TAG] }),
  image(31, 3, { tagIds: [MATURE_TAG] }),
  image(41, 4, { tagIds: [VIEWER_HIDDEN_TAG] }),
  // Its first image is excluded, its second is not: the post stays, with that one.
  image(51, 5, { tagIds: [ANY_LEVEL_TAG] }),
  image(52, 5),
  image(61, 6, { poi: true }), // poi is disabled at every level
  image(71, 7, { minor: true }), // minor is disabled at R and above
  image(81, 8, { nsfwLevel: NsfwLevel.R, minor: true }),
  image(91, 9, { nsfwLevel: NsfwLevel.Blocked }),
  image(92, 9, { nsfwLevel: 0 }), // unrated
];

vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  queryCache: () => async () => POSTS.slice(0, h.rows).map((p) => ({ ...p })),
}));
// Mocked whole: spreading the original loads post.service first, which then binds the real one.
vi.mock('~/server/services/image.service', () => ({
  // As the real query: an image of the asked level, and any rating when no level is asked.
  getImagesForPosts: vi.fn(async ({ browsingLevel }: { browsingLevel?: number }) =>
    IMAGES.filter((i) => !browsingLevel || (i.nsfwLevel & browsingLevel) !== 0).map((i) => ({
      ...i,
    }))
  ),
  getImageMetricsObject: vi.fn(),
  imagesForModelVersionsCache: { bust: vi.fn() },
  queueImageSearchIndexUpdate: vi.fn(),
}));
vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof SystemCache>()),
  getBrowsingSettingAddons: vi.fn(async () => h.addons),
  getBlockedBrowsingTags: vi.fn(async () => []),
}));
vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserPreferences>()),
  getAllHiddenForUser: vi.fn(async ({ userId = -1 }: { userId?: number }) => ({
    hiddenTags: h.hiddenTagsByUser[userId] ?? [],
    hiddenImages: [],
    hiddenModels: [],
    hiddenUsers: [],
  })),
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof Caches>()),
  userBasicCache: { fetch: vi.fn(async () => ({})) },
  postStatCache: { fetch: vi.fn(async () => ({})) },
}));
vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelService>()),
  getHeldGalleryLevel: vi.fn(async () => undefined),
  isModelGalleryWithheld: vi.fn(async () => false),
}));

const { postRouter } = await import('~/server/routers/post.router');

type Viewer = { id: number; isModerator?: boolean } | undefined;
const caller = (user: Viewer, apiKey: boolean | 'full' = false) =>
  postRouter.createCaller({
    user: user && { ...user, username: `user${user.id}`, showNsfw: true },
    acceptableOrigin: true,
    tokenScope: apiKey === true ? TokenScope.MediaRead : TokenScope.Full,
    // A personal API key's credential, as the auth layer sets it; none for a session.
    ...(apiKey ? { apiKeyId: 1, apiKeyType: ApiKeyType.User, subject: { type: 'apiKey' } } : {}),
    apiKeyId: apiKey ? 1 : null,
    req: { headers: {}, cookies: {} },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: { canViewNsfw: true, isGreen: false },
    track: {},
  } as never);

/** What the feed serves the caller: each listed post's image ids. Nothing is sent but the level. */
const page = (user: Viewer, browsingLevel: number, apiKey: boolean | 'full' = false, limit = 20) =>
  caller(user, apiKey).getInfinite({
    limit,
    sort: PostSort.Newest,
    period: MetricTimeframe.AllTime,
    periodMode: 'published',
    browsingLevel,
  } as never);
const feed = async (user: Viewer, browsingLevel: number, apiKey: boolean | 'full' = false) => {
  const { items } = await caller(user, apiKey).getInfinite({
    limit: 20,
    sort: PostSort.Newest,
    period: MetricTimeframe.AllTime,
    periodMode: 'published',
    browsingLevel,
  } as never);
  return Object.fromEntries(items.map((p) => [p.id, p.images.map((i) => i.id)]));
};

const VIEWER = { id: 9 };
const MATURE = NsfwLevel.PG | NsfwLevel.R | NsfwLevel.X | NsfwLevel.XXX;
const ALL = { 1: [11], 2: [21], 3: [31], 4: [41], 5: [51, 52], 6: [61], 7: [71], 8: [81] };

beforeEach(() => {
  h.addons = [
    {
      type: 'some',
      nsfwLevels: [NsfwLevel.PG, NsfwLevel.PG13, NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX],
      excludedTagIds: [ANY_LEVEL_TAG],
      disablePoi: true,
    },
    {
      type: 'some',
      nsfwLevels: [NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX],
      excludedTagIds: [MATURE_TAG],
      disableMinor: true,
    },
  ] satisfies BrowsingSettingsAddon[];
  h.hiddenTagsByUser = { [VIEWER.id]: [{ id: VIEWER_HIDDEN_TAG, hidden: true }] };
  h.rows = undefined;
});

describe('post.getInfinite applies tag exclusions on the server', () => {
  it('serves every image when nothing is excluded (control)', async () => {
    h.addons = [];
    h.hiddenTagsByUser = {};
    expect(await feed(VIEWER, MATURE)).toEqual(ALL);
  });

  it('drops the every-level tag and poi for a signed-out caller, who is held to PG', async () => {
    expect(await feed(undefined, MATURE)).toEqual({ 1: [11], 3: [31], 4: [41], 5: [52], 7: [71] });
  });

  it.each([
    ['a session', false],
    ['an API key', true],
  ])(
    "drops, for %s at a mature level, the site's tags, poi and minor at that level and the viewer's hidden tag",
    async (_, apiKey) => {
      expect(await feed(VIEWER, MATURE, apiKey)).toEqual({ 1: [11], 5: [52] });
    }
  );

  it("keeps the site's mature-only tag and minor below R", async () => {
    expect(await feed(VIEWER, NsfwLevel.PG)).toEqual({ 1: [11], 3: [31], 5: [52], 7: [71] });
  });

  it("keeps every image of the creator's own posts for the creator", async () => {
    h.hiddenTagsByUser[CREATOR] = [{ id: VIEWER_HIDDEN_TAG, hidden: true }];
    expect(await feed({ id: CREATOR }, MATURE)).toEqual(ALL);
  });

  it.each([
    ['a session', false],
    ['a full-scope key', 'full'],
  ] as const)("does not hold a moderator to the site's tags through %s", async (_, apiKey) => {
    expect(await feed({ id: 1, isModerator: true }, MATURE, apiKey)).toEqual(ALL);
  });

  it("holds a moderator's narrow-scope key to the site's tags, as anyone's", async () => {
    expect(await feed({ id: 1, isModerator: true }, MATURE, true)).toEqual({
      1: [11],
      4: [41],
      5: [52],
    });
  });

  it.each([
    ['a session', false],
    ['an API key', true],
  ])(
    'reads an empty level as public for %s: no mature minor image, nothing blocked or unrated',
    async (_, apiKey) => {
      const { getImagesForPosts } = await import('~/server/services/image.service');
      vi.mocked(getImagesForPosts).mockClear();
      // Posts 8 (a mature minor image) and 9 (blocked and unrated images) are not served.
      expect(await feed(VIEWER, 0, apiKey)).toEqual({ 1: [11], 3: [31], 5: [52], 7: [71] });
      expect(vi.mocked(getImagesForPosts).mock.calls[0][0]).toMatchObject({
        browsingLevel: publicBrowsingLevelsFlag,
      });
    }
  );

  it("pages by the query's rows: a post that drops is not refilled, and the cursor is the row past the page", async () => {
    h.rows = 3; // limit 2, plus the one past the page
    const result = await page(undefined, NsfwLevel.PG, false, 2);
    // Post 2's only image is excluded: its slot is not refilled by post 3.
    expect(result.items.map((p) => p.id)).toEqual([1]);
    expect(result.nextCursor).toBeDefined();
    h.rows = 2;
    expect((await page(undefined, NsfwLevel.PG, false, 2)).nextCursor).toBeUndefined();
  });
});
