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

const OWNER = 10;
const owner = { id: OWNER, isModerator: false, showNsfw: true, browsingLevel: 31 };
const moderator = { id: 20, isModerator: true, showNsfw: true, browsingLevel: 31 };
const stranger = { id: 30, isModerator: false, showNsfw: true, browsingLevel: 31 };

beforeEach(() => {
  vi.clearAllMocks();
  installUserCosmeticCacheFake({ userCosmetics: [], cosmetics: [], profilePictures: [] });
  getModel.mockResolvedValue({
    id: 1,
    name: 'Red title',
    description: '<p>Red description</p>',
    sfwName: 'Com title',
    sfwDescription: '<p>Com description</p>',
    poi: false,
    minor: false,
    nsfw: false,
    nsfwLevel: 1,
    status: ModelStatus.Published,
    meta: null,
    metrics: [],
    modelVersions: [],
    user: { id: OWNER, image: null, username: 'owner', deletedAt: null },
  });
});

const get = (user: object | undefined, canViewNsfw: boolean) =>
  getModelHandler({ input: { id: 1 }, ctx: { user, features: { canViewNsfw } } } as never);

describe('model.getById stored .com pair', () => {
  it.each([
    ['non-owner', stranger],
    ['signed-out viewer', undefined],
  ])('is never sent to a %s, on either site', async (_, user) => {
    for (const canViewNsfw of [true, false]) {
      const model = await get(user, canViewNsfw);
      expect(model.sfwName).toBeNull();
      expect(model.sfwDescription).toBeNull();
    }
  });

  it.each([
    ['owner', owner],
    ['moderator', moderator],
  ])('is sent to the %s on either site', async (_, user) => {
    for (const canViewNsfw of [true, false]) {
      const model = await get(user, canViewNsfw);
      expect(model.sfwName).toBe('Com title');
      expect(model.sfwDescription).toBe('<p>Com description</p>');
    }
  });
});
