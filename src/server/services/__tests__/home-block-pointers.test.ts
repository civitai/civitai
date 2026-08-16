import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock, redisMock } from '~/__tests__/mocks';
import type * as CacheHelpers from '~/server/utils/cache-helpers';
import type * as CollectionService from '~/server/services/collection.service';
import { HomeBlockType } from '~/shared/utils/prisma/enums';

vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  fetchThroughCache: async (_key: string, fetcher: () => Promise<unknown>) => fetcher(),
}));

// Only the two reads the Collection branch makes. `getCollectionById` throws for an unknown id,
// which would fail these tests for a reason unrelated to what they assert.
vi.mock('~/server/services/collection.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CollectionService>()),
  getCollectionById: vi.fn(async ({ input }: { input: { id: number } }) => ({
    id: input.id,
    name: `collection-${input.id}`,
  })),
  getCollectionItemsByCollectionId: vi.fn(async () => ({ items: [], nextCursor: undefined })),
}));

const { getHomeBlockData, resolveHomeBlockMetadata } = await import(
  '~/server/services/home-block.service'
);
const { getHomeBlockCached } = await import('~/server/services/home-block-cache.service');

const SOURCE_META = {
  title: 'Featured Images',
  description: 'Ran out of Buzz while playing?',
  collection: { id: 107, limit: 8, rows: 2 },
};

/** A clone as it exists after this change: a pointer with nothing of its own. */
const POINTER = { id: 900, type: HomeBlockType.Collection, metadata: {}, sourceId: 3 };

function stubSystemBlocks(rows: { id: number; metadata: unknown }[]) {
  dbMock.dbRead.homeBlock.findMany.mockImplementation(async (args: any) =>
    args?.where?.userId === -1 ? rows : []
  );
}

describe('a linked clone is a pointer, not a copy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubSystemBlocks([{ id: 3, metadata: SOURCE_META }]);
  });

  it('resolves a clone to its source metadata', async () => {
    const metadata = await resolveHomeBlockMetadata(POINTER);

    expect(metadata).toEqual(SOURCE_META);
  });

  it('takes the whole source object rather than merging field by field', async () => {
    // The stale-typo case: a clone carrying an old copy must not keep any part of it. A
    // field-wise merge would leave the outdated description in place, which is the live bug.
    const stale = {
      ...POINTER,
      metadata: { title: 'Featured Images', description: 'Ran out of Buzz while play?' },
    };

    const metadata = await resolveHomeBlockMetadata(stale);

    expect(metadata.description).toBe('Ran out of Buzz while playing?');
  });

  it('leaves a genuinely user-owned block alone', async () => {
    const own = { id: 901, metadata: { title: 'Mine' }, sourceId: null };

    expect(await resolveHomeBlockMetadata(own)).toEqual({ title: 'Mine' });
  });

  it('renders a Collection clone from the SOURCE collection id', async () => {
    // Collection was excluded from read-through before this change, so a clone rendered whatever
    // collection its own snapshot named. An emptied clone would resolve to no collection at all
    // and return null — the block would silently vanish rather than error.
    const result = await getHomeBlockData({ homeBlock: POINTER, input: {} });

    expect(result).not.toBeNull();
    expect(result?.metadata.collection?.id).toBe(107);
  });

  it('keys a clone cache entry off the resolved collection id, not the empty column', async () => {
    redisMock.redis.packed.get.mockResolvedValue(null);

    const result = await getHomeBlockCached(POINTER);

    // The shared entry: ~114k clones of collection 107 address one key. Keying off the clone's
    // own (now empty) metadata yields `undefined`, and getHomeBlockCached returns null for that —
    // a block that stops rendering with no error anywhere. Assert that first, so the failure says
    // so instead of blowing up on the missing call below.
    expect(result, 'clone resolved to no cache key, so the block would not render').not.toBeNull();

    const [key] = (redisMock.redis.packed.get.mock.calls.at(-1) ?? ['<no cache read>']) as [string];
    expect(key).toContain(':107:');
    expect(key).not.toContain('undefined');
  });

  it('returns the caller row identity on a shared cache hit', async () => {
    // The stored copy carries whichever row filled it first. Content is shared between clones;
    // id is not, and the caller places the block on the page by id.
    redisMock.redis.packed.get.mockResolvedValue({
      id: 999,
      type: HomeBlockType.Collection,
      metadata: SOURCE_META,
    });

    const result = await getHomeBlockCached(POINTER);

    expect(result?.id).toBe(900);
  });
});
