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

const { getHomeBlockData, getHomeBlocks, resolveHomeBlockMetadata } = await import(
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

  it('refuses to resolve a source that is not a system block', async () => {
    // The fallback for a source missing from the system map must be scoped to userId -1. A row
    // pointed at another USER's block would otherwise render that stranger's content and title,
    // with no own metadata left to fall back to.
    dbMock.dbRead.homeBlock.findFirst.mockImplementation(async (args: any) =>
      args?.where?.userId === -1 ? null : { metadata: { title: "Another user's block" } }
    );

    const metadata = await resolveHomeBlockMetadata({
      metadata: { title: 'mine' },
      sourceId: 55555,
    });

    expect(metadata).toEqual({ title: 'mine' });
    expect(dbMock.dbRead.homeBlock.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: -1 }) })
    );
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

  it('returns the caller row identity on a shared cache hit, keeping the cached payload', async () => {
    // The stored copy carries whichever row filled it first. Content is shared between clones;
    // id is not, and the caller places the block on the page by id — and authorizes a delete on
    // its userId. The payload has to survive that overlay: dropping it renders every cached
    // block empty, which no assertion on `id` alone would notice.
    redisMock.redis.packed.get.mockResolvedValue({
      id: 999,
      userId: 4242,
      type: HomeBlockType.Collection,
      metadata: SOURCE_META,
      collection: { id: 3870938, items: [{ id: 1 }] },
    });

    const result = await getHomeBlockCached({ ...POINTER, userId: 7 });

    expect(result?.id).toBe(900);
    expect(result?.userId).toBe(7);
    expect(result?.collection).toEqual({ id: 3870938, items: [{ id: 1 }] });
  });

  it('keys clones of one source onto a single entry for the id-keyed types', async () => {
    // Leaderboard/Feed/FeaturedCollections/Announcement key on the SOURCE, so ~62k Leaderboard
    // clones share one entry — and the existing homeBlockCacheBust calls, which all pass the
    // system block's id, reach them. Per-row keys would leave each clone stale until its own TTL.
    redisMock.redis.packed.get.mockResolvedValue(null);
    stubSystemBlocks([{ id: 4, metadata: { leaderboards: [] } }]);

    await getHomeBlockCached({
      id: 777,
      type: HomeBlockType.Leaderboard,
      metadata: {},
      sourceId: 4,
    });
    const [cloneKey] = redisMock.redis.packed.get.mock.calls.at(-1) as [string];

    await getHomeBlockCached({ id: 4, type: HomeBlockType.Leaderboard, metadata: {} });
    const [sourceKey] = redisMock.redis.packed.get.mock.calls.at(-1) as [string];

    expect(cloneKey, 'clone keyed on its own row, so a bust on the source cannot reach it').toBe(
      sourceKey
    );
  });

  it('resolves metadata for the block LIST, not only the by-id path', async () => {
    // src/pages/home/index.tsx hands list-level metadata straight to the block components, which
    // render the title and link from it. Skipping resolution here blanks both for every
    // customized user while every by-id fetch still looks correct.
    dbMock.dbRead.$queryRaw.mockResolvedValue([{ exists: true }]);
    dbMock.dbRead.homeBlock.findMany.mockImplementation(async (args: any) => {
      if (args?.where?.userId === -1) return [{ id: 3, metadata: SOURCE_META }];
      if (args?.where?.permanent === true) return [];
      return [{ id: 900, type: HomeBlockType.Collection, metadata: {}, sourceId: 3, index: 1 }];
    });

    const blocks = await getHomeBlocks({ userId: 7 });

    expect((blocks[0].metadata as { title?: string }).title).toBe('Featured Images');
  });
});
