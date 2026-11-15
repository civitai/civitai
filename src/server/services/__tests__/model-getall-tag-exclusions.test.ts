import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { NsfwLevel } from '~/server/common/enums';
import { HomeBlockType } from '~/shared/utils/prisma/enums';
import type { BrowsingSettingsAddon } from '~/shared/constants/browsing-settings-addons';
import { getModelsWithImagesAndModelVersions } from '~/server/services/model.service';
import { getHomeBlockData } from '~/server/services/home-block.service';
import { getHomeBlockCached } from '~/server/services/home-block-cache.service';
import {
  getImagesForModelVersion,
  getImagesForModelVersionCache,
} from '~/server/services/image.service';
import { getBrowsingSettingAddons } from '~/server/services/system-cache';
import type * as ModelService from '~/server/services/model.service';
import type * as SystemCache from '~/server/services/system-cache';
import type { SessionUser } from '~/types/session';

/**
 * Card images on `model.getAll` and the featured-models home block drop an image carrying a tag
 * the viewer's browsing settings exclude. The exclusions are resolved server-side by the real
 * `enforceBlockedBrowsingTagsForModels`; only the addon list it reads is stubbed.
 */

const OWNER = 7;
const MODEL = 100;
const VERSION = 200;
const EXCLUDED_TAG = 5249;
const OTHER_TAG = 42;

redisMock.redis.packed.get.mockImplementation(async () => null);
redisMock.redis.packed.set.mockImplementation(async () => undefined);

vi.mock('~/server/services/image.service', () => ({
  getImagesForModelVersion: vi.fn(),
  getImagesForModelVersionCache: vi.fn(),
  queueImageSearchIndexUpdate: vi.fn(),
}));
vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof SystemCache>()),
  getBrowsingSettingAddons: vi.fn(),
  getBlockedBrowsingTags: vi.fn(async () => []),
}));
vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelService>()),
  getFeaturedModels: vi.fn(async () => [{ modelId: 100, position: 1 }]),
}));
vi.mock('~/server/flipt/client', () => ({
  isFlipt: vi.fn().mockResolvedValue(false),
  FLIPT_FEATURE_FLAGS: {},
}));
vi.mock('~/server/db/pgDb', () => ({
  pgDbRead: {
    cancellableQuery: async () => ({
      result: async () => [
        {
          id: 100,
          userId: 7,
          name: 'model',
          type: 'LORA',
          nsfw: false,
          nsfwLevel: 31,
          status: 'Published',
          mode: null,
          rank: {},
          meta: null,
          cursorId: null,
        },
      ],
    }),
  },
  pgDbWrite: {},
  pgDbReadLong: {},
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  userBasicCache: { fetch: vi.fn(async () => ({ 7: { username: 'owner' } })) },
  dataForModelsCache: {
    fetch: vi.fn(async () => ({
      100: {
        versions: [
          {
            id: 200,
            status: 'Published',
            availability: 'Public',
            nsfwLevel: 31,
            baseModel: 'SDXL 1.0',
            flags: 0,
          },
        ],
        tags: [],
        hashes: [],
      },
    })),
  },
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getProfilePicturesForUsers: vi.fn(async () => ({})),
  getCosmeticsForUsers: vi.fn(async () => ({})),
}));
vi.mock('~/server/services/cosmetic.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getCosmeticsForEntity: vi.fn(async () => ({})),
  getEventDecorationsForEntity: vi.fn(async () => ({})),
}));
vi.mock('~/server/services/paid-access.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getModelPaidAccessGates: vi.fn(async () => new Map()),
}));
vi.mock('~/server/services/model-cover.service', () => ({
  getCoverImages: vi.fn(async () => new Map()),
}));
vi.mock('~/server/services/generation/coverage-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  nextCoverageEnabled: vi.fn(async () => false),
}));

const image = (id: number, tags: number[]) => ({
  id,
  userId: OWNER,
  modelVersionId: VERSION,
  nsfwLevel: NsfwLevel.PG,
  url: `u${id}`,
  hash: `h${id}`,
  poi: false,
  minor: false,
  tags,
});
// 1 is untagged, 2 carries the excluded tag, 3 carries another.
const IMAGES = [image(1, []), image(2, [EXCLUDED_TAG]), image(3, [OTHER_TAG])];

const excludeTag: BrowsingSettingsAddon[] = [
  {
    type: 'some',
    nsfwLevels: [NsfwLevel.PG, NsfwLevel.PG13, NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX],
    excludedTagIds: [EXCLUDED_TAG],
  },
];

const VIEWER = { id: 99 } as SessionUser;

async function feedImages(
  user: Partial<SessionUser> | undefined,
  input: Record<string, unknown> = {}
) {
  const { items } = await getModelsWithImagesAndModelVersions({
    input: { browsingLevel: 1, limit: 10, sort: 'Newest', period: 'AllTime', ...input } as never,
    user: user as SessionUser | undefined,
    metricPrivacyEnabled: false,
  });
  return items.find((m) => m.id === MODEL)?.images.map((i) => i.id) ?? [];
}

type FeaturedBlock = { featuredModels: { id: number; images: { id: number }[] }[] };
const featuredBlock = { id: 2, type: HomeBlockType.FeaturedModelVersion, metadata: {} };
const blockImages = (block: unknown) =>
  (block as FeaturedBlock).featuredModels.flatMap((m) => m.images.map((i) => i.id));

beforeEach(() => {
  vi.mocked(getBrowsingSettingAddons).mockResolvedValue(excludeTag);
  vi.mocked(getImagesForModelVersionCache).mockResolvedValue({
    [VERSION]: { modelVersionId: VERSION, images: IMAGES },
  } as never);
  vi.mocked(getImagesForModelVersion).mockResolvedValue(IMAGES as never);
});

describe('model.getAll card images and browsing-settings tag exclusions', () => {
  it('drops an image carrying an excluded tag for a signed-out viewer', async () => {
    expect(await feedImages(undefined)).toEqual([1, 3]);
  });

  it('drops it for a signed-in viewer', async () => {
    expect(await feedImages({ ...VIEWER })).toEqual([1, 3]);
  });

  it("applies the viewer's own excluded tags alongside the browsing-settings ones", async () => {
    expect(await feedImages({ ...VIEWER }, { excludedTagIds: [OTHER_TAG] })).toEqual([1]);
    vi.mocked(getBrowsingSettingAddons).mockResolvedValue([]);
    expect(await feedImages({ ...VIEWER }, { excludedTagIds: [OTHER_TAG] })).toEqual([1, 2]);
  });

  it('drops it on the pending path too', async () => {
    expect(await feedImages(undefined, { pending: true })).toEqual([1, 3]);
    expect(getImagesForModelVersion).toHaveBeenCalledWith(
      expect.objectContaining({ include: ['tags'] })
    );
  });

  // Positive controls: the filter is the addon's, not a blanket one.
  it('keeps every image when no addon excludes the tag', async () => {
    vi.mocked(getBrowsingSettingAddons).mockResolvedValue([]);
    expect(await feedImages(undefined)).toEqual([1, 2, 3]);
  });

  it('keeps every image for a moderator, whom the addons do not apply to', async () => {
    expect(await feedImages({ id: 5, isModerator: true })).toEqual([1, 2, 3]);
  });

  it("keeps every image on the owner's own feed", async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValueOnce({ id: OWNER } as never);
    expect(await feedImages({ id: OWNER, username: 'owner' }, { username: 'owner' })).toEqual([
      1, 2, 3,
    ]);
  });

  it("keeps the owner's own card images in a general feed, as the model query does", async () => {
    const owner = { id: OWNER, username: 'owner' };
    expect(await feedImages(owner)).toEqual([1, 2, 3]);
    expect(await feedImages(owner, { excludedTagIds: [OTHER_TAG] })).toEqual([1, 2, 3]);
    expect(await feedImages({ ...VIEWER }, { excludedTagIds: [OTHER_TAG] })).toEqual([1]);
  });
});

describe('featured models home block and browsing-settings tag exclusions', () => {
  it('drops the image from the block built for a signed-in viewer', async () => {
    const block = await getHomeBlockData({
      input: { limit: 56 },
      homeBlock: featuredBlock,
      user: { ...VIEWER },
    });
    expect(blockImages(block)).toEqual([1, 3]);
  });

  it('drops the image from the shared cached block', async () => {
    const block = await getHomeBlockCached(featuredBlock, undefined, {});
    expect(blockImages(block)).toEqual([1, 3]);
  });

  it('keeps the image when no addon excludes the tag', async () => {
    vi.mocked(getBrowsingSettingAddons).mockResolvedValue([]);
    const block = await getHomeBlockCached(featuredBlock, undefined, {});
    expect(blockImages(block)).toEqual([1, 2, 3]);
  });
});
