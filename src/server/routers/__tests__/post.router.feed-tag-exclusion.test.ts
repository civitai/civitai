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
import { MetricTimeframe } from '~/shared/utils/prisma/enums';

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
}));

const POSTS = [1, 2, 3, 4, 5, 6, 7].map((id) => ({
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
];

vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  queryCache: () => async () => POSTS.map((p) => ({ ...p })),
}));
// Mocked whole: spreading the original loads post.service first, which then binds the real one.
vi.mock('~/server/services/image.service', () => ({
  getImagesForPosts: vi.fn(async () => IMAGES.map((i) => ({ ...i }))),
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
const caller = (user: Viewer, apiKey = false) =>
  postRouter.createCaller({
    user: user && { ...user, username: `user${user.id}`, showNsfw: true },
    acceptableOrigin: true,
    tokenScope: apiKey ? TokenScope.MediaRead : TokenScope.Full,
    apiKeyId: apiKey ? 1 : null,
    req: { headers: {}, cookies: {} },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: { canViewNsfw: true, isGreen: false },
    track: {},
  } as never);

/** What the feed serves the caller: each listed post's image ids. Nothing is sent but the level. */
const feed = async (user: Viewer, browsingLevel: number, apiKey = false) => {
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
const ALL = { 1: [11], 2: [21], 3: [31], 4: [41], 5: [51, 52], 6: [61], 7: [71] };

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

  it("does not hold a moderator to the site's tags", async () => {
    expect(await feed({ id: 1, isModerator: true }, MATURE)).toEqual(ALL);
  });
});
