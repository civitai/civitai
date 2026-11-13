import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { NsfwLevel } from '~/server/common/enums';
import type { BrowsingSettingsAddon } from '~/shared/constants/browsing-settings-addons';
import {
  allBrowsingLevelsFlag,
  publicBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { getModelsWithVersions } from '~/server/services/model.service';
import { runModelSearch } from '~/server/services/model-search.service';
import { getImagesForModelVersionCache } from '~/server/services/image.service';
import { getBrowsingSettingAddons } from '~/server/services/system-cache';
import type * as SystemCache from '~/server/services/system-cache';

/**
 * Card images on the REST model routes (`/api/v1/models`, `/api/v1/models/{id}`, and the block
 * catalogs through `runModelSearch`) all come from `getModelsWithVersions`. They follow the
 * browsing-settings exclusions resolved at the request's level, also on a by-id lookup that skips
 * them for finding the model. Runs the real `getModelsRaw` and addon resolution over a stubbed
 * addon list.
 */

const OWNER = 7;
const MODEL = 100;
const VERSION = 200;
const MATURE_TAG = 5351; // excluded only by an R+ rule
const ANY_LEVEL_TAG = 5249; // excluded at every level
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
vi.mock('~/server/meilisearch/client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  searchClient: undefined,
}));
vi.mock('~/client-utils/edge-url', () => ({ getEdgeUrl: (url: string) => url }));
vi.mock('~/server/services/file.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDownloadFilename: vi.fn(() => 'model.safetensors'),
}));
vi.mock('~/server/common/model-helpers', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createModelFileDownloadUrl: vi.fn(() => '/download'),
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
          minor: false,
          sfwOnly: false,
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
  getPublicPaidAccessForModelVersions: vi.fn(async () => new Map()),
}));
vi.mock('~/server/services/model-file.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  // One primary file, which the REST list needs to serve a version at all.
  getFilesForModelVersionCache: vi.fn(async () => ({
    200: {
      files: [
        {
          id: 1,
          name: 'model.safetensors',
          type: 'Model',
          sizeKB: 1,
          metadata: { format: 'SafeTensor', size: 'pruned', fp: 'fp16' },
          hashes: [],
          visibility: 'Public',
        },
      ],
    },
  })),
}));
vi.mock('~/server/services/creator-program.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getUserMetricPrivacyDefaultsMap: vi.fn(async () => new Map()),
  getValidCreatorMembershipMap: vi.fn(async () => new Map()),
}));
vi.mock('~/server/services/generation/coverage-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  nextCoverageEnabled: vi.fn(async () => false),
}));

const image = (
  id: number,
  extra: { tags?: number[]; poi?: boolean; minor?: boolean; userId?: number } = {}
) => ({
  id,
  userId: OWNER,
  modelVersionId: VERSION,
  nsfwLevel: NsfwLevel.PG,
  url: `u${id}`,
  hash: `h${id}`,
  name: null,
  poi: false,
  minor: false,
  tags: [],
  ...extra,
});

// 1 untagged (the control), 2 tagged at R+, 3 tagged at every level, 4 another tag, 5 a minor
// flag, 6 a poi flag.
const IMAGES = [
  image(1),
  image(2, { tags: [MATURE_TAG] }),
  image(3, { tags: [ANY_LEVEL_TAG] }),
  image(4, { tags: [OTHER_TAG] }),
  image(5, { minor: true }),
  image(6, { poi: true }),
];

const ADDONS: BrowsingSettingsAddon[] = [
  {
    type: 'some',
    nsfwLevels: [NsfwLevel.PG, NsfwLevel.PG13, NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX],
    disablePoi: true,
    excludedTagIds: [ANY_LEVEL_TAG],
  },
  {
    type: 'some',
    nsfwLevels: [NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX],
    disableMinor: true,
    excludedTagIds: [MATURE_TAG],
  },
];

type Viewer = { id: number; isModerator?: boolean; username?: string } | undefined;

async function cardImages({
  browsingLevel,
  user,
  byId = false,
}: {
  browsingLevel: number;
  user?: Viewer;
  byId?: boolean;
}) {
  const { items } = await getModelsWithVersions({
    input: {
      browsingLevel,
      sort: 'Highest Rated',
      period: 'AllTime',
      periodMode: 'published',
      favorites: false,
      hidden: false,
      take: 10,
      ...(byId && { ids: [MODEL], archived: true }),
    } as never,
    user,
    ...(byId && { ignoreBrowsingAddons: true }),
  });
  const model = items.find((m) => m.id === MODEL);
  if (!model) throw new Error('model not served');
  return model.modelVersions.flatMap((v) => v.images.map((i) => i.id));
}

beforeEach(() => {
  vi.mocked(getBrowsingSettingAddons).mockResolvedValue(ADDONS);
  vi.mocked(getImagesForModelVersionCache).mockResolvedValue({
    [VERSION]: { modelVersionId: VERSION, images: IMAGES },
  } as never);
  for (const table of [
    dbMock.dbRead.modelMetric,
    dbMock.dbRead.modelVersionMetric,
    dbMock.dbRead.modelVersion,
    dbMock.dbRead.recommendedResource,
  ])
    table.findMany.mockResolvedValue([] as never);
});

const SIGNED_IN = { id: 99, username: 'someone' };

describe('REST card images and the browsing-settings exclusions', () => {
  // A session and an API key reach this service as the same signed-in user.
  describe.each([
    ['signed out', undefined],
    ['signed in (session or API key)', SIGNED_IN],
  ] as const)('%s', (_label, user) => {
    it('at the default level, drops the every-level tag and poi, keeps the R+ tag and minor', async () => {
      expect(await cardImages({ browsingLevel: publicBrowsingLevelsFlag, user })).toEqual([
        1, 2, 4, 5,
      ]);
    });

    it('at every level (?nsfw=true), also drops the R+ tag and minor', async () => {
      expect(await cardImages({ browsingLevel: allBrowsingLevelsFlag, user })).toEqual([1, 4]);
    });
  });

  it('applies them on a by-id lookup that skips them for finding the model', async () => {
    expect(await cardImages({ browsingLevel: allBrowsingLevelsFlag, byId: true })).toEqual([1, 4]);
  });

  // Controls: the filter is the addons', and owners and moderators keep theirs.
  it('keeps every image when no addon excludes anything', async () => {
    vi.mocked(getBrowsingSettingAddons).mockResolvedValue([]);
    expect(await cardImages({ browsingLevel: allBrowsingLevelsFlag })).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('keeps every image for a moderator', async () => {
    expect(
      await cardImages({ browsingLevel: allBrowsingLevelsFlag, user: { id: 5, isModerator: true } })
    ).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("keeps the owner's own images for the owner", async () => {
    expect(
      await cardImages({
        browsingLevel: allBrowsingLevelsFlag,
        user: { id: OWNER, username: 'owner' },
      })
    ).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

// `/api/v1/models` and the block catalogs serve through `runModelSearch`; `?nsfw=true` there widens
// only the level filter on images, never the tag and flag exclusions.
describe('the REST list and block catalogs (runModelSearch)', () => {
  async function servedImages(opts: {
    browsingLevel: number;
    nsfwImagePassthrough: boolean;
    user?: Viewer;
  }) {
    const { items } = await runModelSearch(
      { limit: 10 } as Parameters<typeof runModelSearch>[0],
      {
        ...opts,
        user: opts.user,
        baseUrlOrigin: 'https://civitai.com',
      } as Parameters<typeof runModelSearch>[1]
    );
    type Served = { id: number; modelVersions: { images?: { id: number }[] }[] };
    const model = (items as Served[]).find((m) => m.id === MODEL);
    if (!model) throw new Error('model not served');
    return model.modelVersions.flatMap((v) => (v.images ?? []).map((i) => i.id));
  }

  it.each([
    ['signed out', undefined],
    ['signed in', SIGNED_IN],
  ] as const)('?nsfw=true serves %s no excluded card image', async (_label, user) => {
    expect(
      await servedImages({ browsingLevel: allBrowsingLevelsFlag, nsfwImagePassthrough: true, user })
    ).toEqual([1, 4]);
  });

  it('the default request drops the every-level tag and poi', async () => {
    expect(
      await servedImages({ browsingLevel: publicBrowsingLevelsFlag, nsfwImagePassthrough: false })
    ).toEqual([1, 2, 4, 5]);
  });
});
