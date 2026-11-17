import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CollectionService from '~/server/services/collection.service';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { HomeBlockType } from '~/shared/utils/prisma/enums';

/**
 * Home blocks that render the same for every viewer show only collections everyone may read
 * (Public or Unlisted), and only such a collection is written to the shared rendered entry.
 */

const reads = vi.hoisted(() => new Map<number, string>());

vi.mock('~/server/services/collection.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CollectionService>()),
  getCollectionById: vi.fn(async ({ input }: { input: { id: number } }) =>
    reads.has(input.id) ? { id: input.id, read: reads.get(input.id) } : null
  ),
  getCollectionItemsByCollectionId: vi.fn(async () => ({ items: [], nextCursor: undefined })),
}));

vi.mock('~/server/jobs/refresh-featured-collections-eligibility', () => ({
  getFeaturedCollectionsState: async () => null,
}));

const packedSet = redisMock.redis.packed.set;
const { getHomeBlockData } = await import('~/server/services/home-block.service');
const { getHomeBlockCached } = await import('~/server/services/home-block-cache.service');

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.redis.packed.get.mockResolvedValue(null);
  reads.clear();
});

describe('the featured collections block', () => {
  it('shows only the pooled collections everyone may read', async () => {
    reads.set(1, 'Public').set(2, 'Unlisted').set(3, 'Private');
    const block = await getHomeBlockData({
      homeBlock: {
        id: 50,
        type: HomeBlockType.FeaturedCollections,
        metadata: { featuredCollections: { collectionIds: [1, 2, 3] } },
      } as never,
      input: { withCoreData: true },
    });
    const picked = (block as { pickedCollections: { collection: { id: number } }[] })
      .pickedCollections;
    expect(picked.map((p) => p.collection.id).sort()).toEqual([1, 2]);
  });
});

describe('the shared rendered entry', () => {
  const block = {
    id: 9,
    type: HomeBlockType.Collection,
    metadata: { collection: { id: 90 } },
  } as Parameters<typeof getHomeBlockCached>[0];

  it.each(['Public', 'Unlisted'])(
    'keeps a %s collection block for every viewer (control)',
    async (read) => {
      reads.set(90, read);
      await getHomeBlockCached(block, undefined, block.metadata);
      expect(packedSet).toHaveBeenCalledTimes(1);
    }
  );

  it('never writes a Private collection block to it', async () => {
    reads.set(90, 'Private');
    const served = await getHomeBlockCached(block, undefined, block.metadata);
    // It is still rendered (a system block may point at one); it is only not kept.
    expect((served as { collection?: { read: string } }).collection?.read).toBe('Private');
    expect(packedSet).not.toHaveBeenCalled();
  });
});
