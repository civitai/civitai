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
