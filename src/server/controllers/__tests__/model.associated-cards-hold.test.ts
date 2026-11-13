import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as ModelService from '~/server/services/model.service';
import { NsfwLevel } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { ApiKeyType } from '~/shared/utils/prisma/enums';

const OWNER = 7;
const MODEL = 100;
const VERSION = 200;
const OTHER_MODEL = 101;
const OTHER_VERSION = 201;

const { getModelsRaw, getImagesForModelVersion, modelRow } = vi.hoisted(() => ({
  getModelsRaw: vi.fn(),
  getImagesForModelVersion: vi.fn(),
  modelRow: { minor: false, sfwOnly: false },
}));

// The real holdShowcaseImages; only the model read is stubbed.
vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelService>()),
  getModelsRaw,
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getImagesForModelVersion,
}));
vi.mock('~/server/services/hot-reads-6.reads', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readModelAssociationTargetsViaKysely: vi.fn(async () => [
    { toModelId: 100, toArticleId: null },
    { toModelId: 101, toArticleId: null },
  ]),
}));
vi.mock('~/server/db/kyselyDb.lazy', () => ({ loadKyselyDb: async () => ({ kyselyRead: {} }) }));
vi.mock('~/server/services/promotion.service', () => ({ getSponsoredModel: async () => null }));
vi.mock('~/server/services/generation/coverage-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  nextCoverageEnabled: async () => false,
}));
vi.mock('~/server/services/generation/generation.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveCanGenerateForVersions: async () => new Map(),
}));
vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  HiddenUsers: { getCached: async () => [] },
  BlockedByUsers: { getCached: async () => [] },
  BlockedUsers: { getCached: async () => [] },
}));

import { getAssociatedResourcesCardDataHandler } from '~/server/controllers/model.controller';

const image = (id: number, nsfwLevel: number, extra: { poi?: boolean; minor?: boolean } = {}) => ({
  id,
  nsfwLevel,
  userId: OWNER,
  modelVersionId: VERSION,
  poi: false,
  minor: false,
  ...extra,
});

const scopedKey = {
  apiKeyId: 9,
  apiKeyType: ApiKeyType.User,
  subject: { type: 'apiKey', id: 9 },
  tokenScope: TokenScope.ModelsRead,
};

async function cardImages(
  ctx: { user?: { id: number; isModerator?: boolean } } & Record<string, unknown>,
  addons: { disablePoi?: boolean; disableMinor?: boolean } = {}
) {
  getModelsRaw.mockImplementation(async ({ input }: { input: Record<string, unknown> }) => {
    // Stands in for the addon resolution getModelsRaw runs on the input it is given.
    Object.assign(input, addons);
    return {
      items: [
        {
          id: OTHER_MODEL,
          name: 'other',
          nsfwLevel: 31,
          mode: null,
          ...modelRow,
          user: { id: 8 },
          modelVersions: [{ id: OTHER_VERSION }],
          hashes: [],
          tagsOnModels: [],
          rank: {},
          metricPrivacy: null,
        },
        {
          id: MODEL,
          name: 'model',
          nsfwLevel: 31,
          mode: null,
          ...modelRow,
          user: { id: OWNER },
          modelVersions: [{ id: VERSION }],
          hashes: [],
          tagsOnModels: [],
          rank: {},
          metricPrivacy: null,
        },
      ],
    };
  });
  const result = await getAssociatedResourcesCardDataHandler({
    input: { fromId: 1, type: 'model', browsingLevel: 31 },
    ctx: { features: {}, req: { headers: {} }, ...ctx },
  } as never);
  const cards = result as { id: number; images: { id: number }[] }[];
  const ids = (id: number) => cards.find((r) => r.id === id)?.images.map((i) => i.id) ?? [];
  lastOther = ids(OTHER_MODEL);
  return ids(MODEL);
}
let lastOther: number[] = [];

describe('associated-resource card images', () => {
  beforeEach(() => {
    modelRow.minor = false;
    modelRow.sfwOnly = false;
    redisMock.redis.get.mockResolvedValue(null);
    getImagesForModelVersion.mockResolvedValue([
      image(1, NsfwLevel.PG),
      image(2, NsfwLevel.PG13),
      image(3, NsfwLevel.X),
      image(4, NsfwLevel.PG, { poi: true }),
      image(5, NsfwLevel.PG, { minor: true }),
      { ...image(11, NsfwLevel.PG), userId: 8, modelVersionId: OTHER_VERSION },
      { ...image(13, NsfwLevel.X), userId: 8, modelVersionId: OTHER_VERSION },
    ]);
  });

  it('keeps an unheld model whole when no setting hides anything', async () => {
    expect(await cardImages({ user: { id: 99 } })).toEqual([1, 2, 3, 4, 5]);
  });

  it('drops poi and minor entries the viewer settings hide, each on its own', async () => {
    expect(await cardImages({ user: { id: 99 } }, { disablePoi: true })).toEqual([1, 2, 3, 5]);
    expect(await cardImages({ user: { id: 99 } }, { disableMinor: true })).toEqual([1, 2, 3, 4]);
  });

  // A guard: the route never sets pending, so the cache's images are all rated today.
  it('guard: drops an unrated image for a moderator on a scoped key, not on a session', async () => {
    getImagesForModelVersion.mockResolvedValue([image(1, NsfwLevel.PG), image(6, 0)]);
    expect(await cardImages({ user: { id: 5, isModerator: true }, ...scopedKey })).toEqual([1]);
    expect(await cardImages({ user: { id: 5, isModerator: true } })).toEqual([1, 6]);
  });

  describe('a minor or SFW-only model', () => {
    // Stored at PG: the PG-13 entry drops, which the SFW fallback level would keep.
    beforeEach(() => {
      modelRow.sfwOnly = true;
      redisMock.redis.get.mockResolvedValue(
        JSON.stringify({ sfwHeld: true, level: NsfwLevel.PG }) as never
      );
    });

    it('holds its card images at the stored gallery level', async () => {
      expect(await cardImages({ user: { id: 99 } })).toEqual([1, 4, 5]);
      expect(await cardImages({})).toEqual([1, 4, 5]);
      modelRow.sfwOnly = false;
      modelRow.minor = true;
      expect(await cardImages({ user: { id: 99 } })).toEqual([1, 4, 5]);
    });

    it('serves it whole to its owner and a moderator on a session', async () => {
      expect(await cardImages({ user: { id: OWNER } })).toEqual([1, 2, 3, 4, 5]);
      // Another creator's held model stays held for this owner.
      expect(lastOther).toEqual([11]);
      expect(await cardImages({ user: { id: 5, isModerator: true } })).toEqual([1, 2, 3, 4, 5]);
    });

    it('holds it for its owner or a moderator on a scoped key', async () => {
      expect(await cardImages({ user: { id: OWNER }, ...scopedKey })).toEqual([1, 4, 5]);
      expect(await cardImages({ user: { id: 5, isModerator: true }, ...scopedKey })).toEqual([
        1, 4, 5,
      ]);
    });
  });
});
