import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as HotReads3 from '@civitai/db-queries/hot-reads-3';
import type * as Caches from '~/server/redis/caches';
import type * as CoverageSource from '~/server/services/generation/coverage-source';
import type * as GenerationService from '~/server/services/generation/generation.service';
import type * as ModelService from '~/server/services/model.service';
import type * as SystemCache from '~/server/services/system-cache';
import { ModelStatus } from '~/shared/utils/prisma/enums';
import { installUserCosmeticCacheFake } from '~/test-utils/userCosmeticCacheFake';

const { getModel } = vi.hoisted(() => ({ getModel: vi.fn() }));

// The Kysely reads the handler makes after the model row: no posts, no suggested resources, no
// owner settings. Their rows, against a real database, are pinned in
// src/server/services/__tests__/hot-reads-3.kysely-parity.test.ts.
vi.mock('@civitai/db-queries/hot-reads-3', async (importOriginal) => ({
  ...(await importOriginal<typeof HotReads3>()),
  listModelPagePosts: vi.fn(async () => []),
  countSuggestedResources: vi.fn(async () => 0),
  getUserSettings: vi.fn(async () => undefined),
}));
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
 * On civitai.com the model page shows a model's .com title and description to every viewer, its
 * owner and moderators included. Only the editor's read keeps the stored .red pair, and only for
 * someone allowed to edit.
 */

const OWNER = 10;
const owner = { id: OWNER, isModerator: false };
const moderator = { id: 20, isModerator: true };
const stranger = { id: 30, isModerator: false };
// `canViewNsfw` off is civitai.com.
const COM = { canViewNsfw: false };
const RED = { canViewNsfw: true };

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

const get = (user: object | undefined, features: object, forEditor?: boolean) =>
  getModelHandler({ input: { id: 1, forEditor }, ctx: { user, features } } as never);

describe('model.getById .com face', () => {
  it.each([
    ['owner', owner],
    ['moderator', moderator],
    ['non-owner', stranger],
    ['signed-out viewer', undefined],
  ])('the .com page shows the .com face to the %s', async (_, user) => {
    const model = await get(user, COM);
    expect(model.name).toBe('Com title');
    expect(model.description).toBe('<p>Com description</p>');
  });

  it.each([
    ['owner', owner],
    ['moderator', moderator],
  ])('the editor read gives the %s the stored .red pair and the .com pair', async (_, user) => {
    const model = await get(user, COM, true);
    expect(model.name).toBe('Red title');
    expect(model.description).toBe('<p>Red description</p>');
    expect(model.sfwName).toBe('Com title');
    expect(model.sfwDescription).toBe('<p>Com description</p>');
  });

  it('the editor read gives a non-owner nothing new', async () => {
    const model = await get(stranger, COM, true);
    expect(model.name).toBe('Com title');
    expect(model.description).toBe('<p>Com description</p>');
    expect(model.sfwName).toBeNull();
    expect(model.sfwDescription).toBeNull();
  });

  it.each([
    ['owner', owner, 'detected', false],
    ['moderator', moderator, 'detected', true],
    ['non-owner', stranger, null, false],
    ['signed-out viewer', undefined, null, false],
  ])(
    'the listing re-check removal reaches the %s only as it should',
    async (_, user, told, seesRecord) => {
      const comFaceRemoved = {
        at: '2026-11-05T00:00:00.000Z',
        sfwCoverImageId: 5,
        reason: 'detected',
        detail: 'CHECK-REASON-TEXT',
      };
      const stored = await getModel();
      getModel.mockResolvedValue({ ...stored, meta: { comFaceRemoved } });

      const model = await get(user, COM);

      expect(model.comFaceRemoved).toBe(told);
      // The check's reason is for moderators only; the owner is told which fields were read.
      if (!seesRecord) expect(JSON.stringify(model)).not.toContain('CHECK-REASON-TEXT');
      expect((model.meta as Record<string, unknown> | null)?.comFaceRemoved).toEqual(
        seesRecord ? comFaceRemoved : undefined
      );
    }
  );

  it('civitai.red keeps the .red face for an owner who browses mature content', async () => {
    const model = await get({ ...owner, showNsfw: true, browsingLevel: 31 }, RED);
    expect(model.name).toBe('Red title');
  });
});
