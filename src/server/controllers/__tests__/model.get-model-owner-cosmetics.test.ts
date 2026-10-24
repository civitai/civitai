import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Caches from '~/server/redis/caches';
import type * as CoverageSource from '~/server/services/generation/coverage-source';
import type * as GenerationService from '~/server/services/generation/generation.service';
import type * as ModelService from '~/server/services/model.service';
import type * as SystemCache from '~/server/services/system-cache';
import { ModelStatus } from '~/shared/utils/prisma/enums';
import { installUserCosmeticCacheFake } from '~/test-utils/userCosmeticCacheFake';

const { getModel } = vi.hoisted(() => ({ getModel: vi.fn() }));

vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelService>()),
  getModel,
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof Caches>()),
  modelTagCache: { fetch: vi.fn(async () => ({})) },
}));
vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof SystemCache>()),
  getCategoryTags: vi.fn(async () => []),
}));
vi.mock('~/server/services/generation/coverage-source', async (importOriginal) => ({
  ...(await importOriginal<typeof CoverageSource>()),
  coverageAudience: vi.fn(async () => ({ next: false, member: false })),
}));
vi.mock('~/server/services/generation/generation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof GenerationService>()),
  getResourceData: vi.fn(async () => []),
  resolveCanGenerateForVersions: vi.fn(async () => new Map()),
}));

const { getModelHandler } = await import('~/server/controllers/model.controller');

/**
 * `model.getById` fills the owner's profile picture and worn cosmetics from the user caches rather
 * than from relations nested in its Prisma select. The model page renders the owner from this
 * payload, so the owner must arrive in the nested-select shape.
 */

const OWNER = 10;
const picture = {
  id: 501,
  name: 'me.png',
  url: 'uuid-1',
  nsfwLevel: 1,
  hash: 'U00000',
  userId: OWNER,
  ingestion: 'Scanned',
  type: 'image',
  width: 512,
  height: 768,
  metadata: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  installUserCosmeticCacheFake({
    userCosmetics: [
      { userId: OWNER, cosmeticId: 1, data: null, equippedAt: new Date(), equippedToId: null },
      // A hat the owner placed on content; the owner chip never wore it.
      { userId: OWNER, cosmeticId: 2, data: null, equippedAt: new Date(), equippedToId: 77 },
    ],
    cosmetics: [
      { id: 1, name: 'Badge', type: 'Badge', source: 'Event', data: { url: 'b.png' }, flags: 0 },
      { id: 2, name: 'Hat', type: 'ContentDecoration', source: 'Event', data: {}, flags: 0 },
    ],
    profilePictures: [picture],
  });
  getModel.mockResolvedValue({
    id: 1,
    name: 'A model',
    poi: false,
    minor: false,
    nsfw: false,
    nsfwLevel: 1,
    status: ModelStatus.Published,
    meta: null,
    metrics: [],
    modelVersions: [],
    user: {
      id: OWNER,
      image: 'avatar.png',
      username: 'owner',
      deletedAt: null,
      rank: { leaderboardRank: 3 },
    },
  });
});

describe('model.getById owner', () => {
  it('does not ask Prisma for the owner picture or cosmetics', async () => {
    await getModelHandler({ input: { id: 1 }, ctx: { features: {} } } as never);

    const ownerSelect = getModel.mock.calls[0][0].select.user.select;
    expect(ownerSelect).not.toHaveProperty('profilePicture');
    expect(ownerSelect).not.toHaveProperty('cosmetics');
  });

  it('carries the picture and worn cosmetics from cache, in the nested-select shape', async () => {
    const model = await getModelHandler({ input: { id: 1 }, ctx: { features: {} } } as never);

    expect(model.user).toStrictEqual({
      id: OWNER,
      image: 'avatar.png',
      username: 'owner',
      deletedAt: null,
      rank: { leaderboardRank: 3 },
      profilePicture: picture,
      cosmetics: [
        {
          data: null,
          cosmetic: {
            id: 1,
            data: { url: 'b.png' },
            type: 'Badge',
            source: 'Event',
            name: 'Badge',
          },
        },
      ],
    });
  });
});
