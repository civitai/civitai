import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as HotReads3 from '@civitai/db-queries/hot-reads-3';
import type * as Caches from '~/server/redis/caches';
import type * as CoverageSource from '~/server/services/generation/coverage-source';
import type * as GenerationService from '~/server/services/generation/generation.service';
import type * as ModelService from '~/server/services/model.service';
import type * as SystemCache from '~/server/services/system-cache';
import { ModelStatus } from '~/shared/utils/prisma/enums';
import { autoNsfwTextHash } from '~/server/services/auto-nsfw';

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
 * The model editor reads `model.getById`, a public procedure. The owner of a model the save-time
 * text filter marked mature gets the field and category; nobody gets the matched text.
 */

const OWNER = 10;
const NAME = 'model name';
const DESCRIPTION = 'model description';

beforeEach(() => {
  vi.clearAllMocks();
  getModel.mockResolvedValue({
    id: 1,
    name: NAME,
    description: DESCRIPTION,
    poi: false,
    minor: false,
    sfwOnly: false,
    nsfw: true,
    nsfwLevel: 4,
    lockedProperties: ['nsfw'],
    status: ModelStatus.Published,
    meta: {
      profanityMatches: ['PLACEHOLDER_MATCHED_TERM'],
      systemNsfwLock: {
        source: 'profanity-filter',
        at: '2026-01-01T00:00:00.000Z',
        fields: ['description'],
        category: 'mature-language',
        textHash: autoNsfwTextHash(NAME, DESCRIPTION),
      },
    },
    metrics: [],
    modelVersions: [],
    user: { id: OWNER, username: 'owner', deletedAt: null },
  });
});

const read = (user?: { id: number; isModerator: boolean }, forEditor = true) =>
  getModelHandler({ input: { id: 1, forEditor }, ctx: { user, features: {} } } as never);

describe('model.getById mature lock reason', () => {
  it('gives the owner the field and category, and the payload no matched text or hash', async () => {
    const model = await read({ id: OWNER, isModerator: false });

    expect(model.matureLockReason).toStrictEqual({
      fields: ['description'],
      category: 'mature-language',
    });
    const payload = JSON.stringify(model);
    expect(payload).not.toContain('PLACEHOLDER_MATCHED_TERM');
    expect(payload).not.toContain(autoNsfwTextHash(NAME, DESCRIPTION));
  });

  it.each([
    ['a visitor', undefined],
    ['another user', { id: 20, isModerator: false }],
    ['a moderator', { id: 30, isModerator: true }],
  ])('gives %s no reason', async (_, user) => {
    expect((await read(user)).matureLockReason).toBeNull();
  });

  it('gives the owner no reason on the public model page', async () => {
    expect((await read({ id: OWNER, isModerator: false }, false)).matureLockReason).toBeNull();
  });
});
