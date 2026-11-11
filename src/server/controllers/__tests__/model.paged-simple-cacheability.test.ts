import { describe, expect, it, vi } from 'vitest';

import type * as ModelService from '~/server/services/model.service';

const { getModels } = vi.hoisted(() => ({ getModels: vi.fn() }));

vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelService>()),
  getModels,
}));

import { getModelsPagedSimpleHandler } from '~/server/controllers/model.controller';

/**
 * `getModels` reports a caller-dependent row set through `isPrivate` — the shape
 * no cache key can carry, since it turns on the caller's identity rather than a
 * role. getModelsInfiniteHandler has always acted on it; this handler shares the
 * result and must too.
 */
async function canCacheAfter(isPrivate: boolean) {
  getModels.mockResolvedValue({ items: [], isPrivate });
  const ctx = { user: undefined, cache: { canCache: true } };

  await getModelsPagedSimpleHandler({ input: { limit: 10 }, ctx } as never);

  return ctx.cache.canCache;
}

describe('getModelsPagedSimpleHandler cacheability', () => {
  it('refuses caching when getModels reports a caller-dependent row set', async () => {
    await expect(canCacheAfter(true)).resolves.toBe(false);
  });

  it('leaves caching enabled otherwise', async () => {
    await expect(canCacheAfter(false)).resolves.toBe(true);
  });
});

describe('getModelsPagedSimpleHandler with needsReview', () => {
  // getModels as the database answers it: version rows only when the select asks for them.
  async function versionFor(user: { id: number; isModerator?: boolean } | undefined) {
    getModels.mockImplementation(async ({ select }: { select: { modelVersions: unknown } }) => ({
      items: [
        {
          id: 1,
          name: 'model',
          nsfw: false,
          meta: null,
          ...(select.modelVersions
            ? { modelVersions: [{ id: 7, name: 'v2', meta: { needsReview: true } }] }
            : {}),
        },
      ],
      isPrivate: false,
    }));
    const result = await getModelsPagedSimpleHandler({
      input: { limit: 10, needsReview: true },
      ctx: { user },
    } as never);
    return result.items[0].modelVersion;
  }

  it('returns no version under review to a non-moderator or signed out', async () => {
    expect(await versionFor({ id: 77 })).toBeUndefined();
    expect(await versionFor(undefined)).toBeUndefined();
  });

  it('returns the version under review to a moderator', async () => {
    expect(await versionFor({ id: 78, isModerator: true })).toMatchObject({ id: 7 });
  });
});
