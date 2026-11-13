import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { getModelsWithImagesAndModelVersions } from '~/server/services/model.service';
import { getImagesForModelVersionCache } from '~/server/services/image.service';
import { enforceBlockedBrowsingTagsForModels } from '~/server/services/blocked-browsing-tags.service';
import type { SessionUser } from '~/types/session';

redisMock.redis.packed.get.mockImplementation(async () => null);
redisMock.redis.packed.set.mockImplementation(async () => undefined);

const OWNER = 7;
const MODEL = 100;
const VERSION = 200;

vi.mock('~/server/services/image.service', () => ({
  getImagesForModelVersion: vi.fn(),
  getImagesForModelVersionCache: vi.fn(),
  queueImageSearchIndexUpdate: vi.fn(),
}));
vi.mock('~/server/flipt/client', () => ({
  isFlipt: vi.fn().mockResolvedValue(false),
  FLIPT_FEATURE_FLAGS: {},
}));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTagsForModels: vi.fn(),
}));
const { modelRow } = vi.hoisted(() => ({ modelRow: { nsfw: false } }));
vi.mock('~/server/db/pgDb', () => ({
  pgDbRead: {
    cancellableQuery: async () => ({
      result: async () => [
        {
          id: 100,
          userId: 7,
          name: 'model',
          type: 'LORA',
          nsfw: modelRow.nsfw,
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

const image = (id: number, nsfwLevel: number, extra: { poi?: boolean; minor?: boolean } = {}) => ({
  id,
  userId: OWNER,
  modelVersionId: VERSION,
  nsfwLevel,
  url: `u${id}`,
  hash: `h${id}`,
  poi: false,
  minor: false,
  tags: [],
  ...extra,
});

async function cardImages(
  browsingLevel: number,
  opts: { user?: Partial<SessionUser>; disablePoi?: boolean; disableMinor?: boolean } = {}
) {
  vi.mocked(enforceBlockedBrowsingTagsForModels).mockImplementation(async (input) => {
    // Stands in for the addon resolution getModelsRaw runs on the viewer's input.
    if (opts.disablePoi) input.disablePoi = true;
    if (opts.disableMinor) input.disableMinor = true;
    return { emptyResult: false };
  });
  const { items } = await getModelsWithImagesAndModelVersions({
    input: { browsingLevel, limit: 10, sort: 'Newest', period: 'AllTime' } as never,
    user: opts.user as SessionUser | undefined,
    metricPrivacyEnabled: false,
  });
  return items.find((m) => m.id === MODEL)?.images.map((i) => i.id) ?? [];
}

describe('getModelsWithImagesAndModelVersions card images', () => {
  beforeEach(() => {
    modelRow.nsfw = false;
    vi.mocked(getImagesForModelVersionCache).mockResolvedValue({
      [VERSION]: {
        modelVersionId: VERSION,
        images: [image(1, 1), image(4, 4), image(8, 8), image(16, 16)],
      },
    } as never);
  });

  it('sends a signed-out level-1 viewer no image above that level', async () => {
    expect(await cardImages(1)).toEqual([1]);
  });

  it('still sends a level-31 viewer every level', async () => {
    expect(await cardImages(31, { user: { id: 99 } })).toEqual([1, 4, 8, 16]);
  });

  it('keeps an nsfw model up to the viewer highest level, as the client does', async () => {
    modelRow.nsfw = true;
    vi.mocked(getImagesForModelVersionCache).mockResolvedValue({
      [VERSION]: {
        modelVersionId: VERSION,
        images: [image(1, 1), image(2, 2), image(4, 4), image(8, 8)],
      },
    } as never);
    expect(await cardImages(1 | 4, { user: { id: 99 } })).toEqual([1, 2, 4]);
  });

  it('leaves a caller that passes no browsing level unfiltered', async () => {
    expect(await cardImages(undefined as never)).toEqual([1, 4, 8, 16]);
  });

  describe('poi and minor flags', () => {
    beforeEach(() => {
      vi.mocked(getImagesForModelVersionCache).mockResolvedValue({
        [VERSION]: {
          modelVersionId: VERSION,
          images: [image(1, 1), image(2, 1, { poi: true }), image(3, 1, { minor: true })],
        },
      } as never);
    });

    it('drops flagged entries when the viewer settings hide them', async () => {
      expect(await cardImages(1, { disablePoi: true, disableMinor: true })).toEqual([1]);
    });

    it('keeps them when the settings do not hide them', async () => {
      expect(await cardImages(1)).toEqual([1, 2, 3]);
    });

    it('keeps them for their owner', async () => {
      expect(
        await cardImages(1, { user: { id: OWNER }, disablePoi: true, disableMinor: true })
      ).toEqual([1, 2, 3]);
    });
  });
});
