import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock, redisMock } from '~/__tests__/mocks';
import type { Context } from '~/server/createContext';
import type * as HotReads5 from '@civitai/db-queries/hot-reads-5';
import type * as CollectionService from '~/server/services/collection.service';
import type * as HomeBlockCache from '~/server/services/home-block-cache.service';
import type * as CacheHelpers from '~/server/utils/cache-helpers';
import { TRPCError } from '@trpc/server';
import { buildTrpcCacheHeaders } from '~/server/trpc/edge-cache-headers';
import { HomeBlockType } from '~/shared/utils/prisma/enums';
import { REDIS_KEYS } from '~/server/redis/client';

/**
 * A Collection home block shows its collection only to viewers who may read it, and only a
 * collection everyone may read is served from the caches every viewer shares.
 *
 * Driven through the real controller and service. The collection's permission rule runs for real
 * over a mocked collection row; the block row, the rendered data and the shared entry are faked.
 */

const state = vi.hoisted(() => ({
  // getHomeBlockCached: the shared entry every viewer reads.
  sharedCalls: [] as number[],
}));

const { getHomeBlockRow } = vi.hoisted(() => ({ getHomeBlockRow: vi.fn() }));
vi.mock('@civitai/db-queries/hot-reads-5', async (importOriginal) => ({
  ...(await importOriginal<typeof HotReads5>()),
  getHomeBlockRow,
}));

vi.mock('~/server/services/home-block-cache.service', async (importOriginal) => ({
  ...(await importOriginal<typeof HomeBlockCache>()),
  getHomeBlockCached: vi.fn(async (block: { id: number }, _d: unknown, metadata: unknown) => {
    state.sharedCalls.push(block.id);
    return { ...block, metadata, collection: { items: ['shared'] } };
  }),
}));

// The system-block metadata map, read through a shared cache: read straight through here.
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  fetchThroughCache: async (_key: string, fetcher: () => Promise<unknown>) => fetcher(),
}));

const { getCollectionItems } = vi.hoisted(() => ({ getCollectionItems: vi.fn() }));
vi.mock('~/server/services/collection.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CollectionService>()),
  getCollectionById: vi.fn(async ({ input }: { input: { id: number } }) => ({ id: input.id })),
  getCollectionItemsByCollectionId: getCollectionItems,
}));

// A Leaderboard block renders through this; it fails in the editor-list test.
vi.mock('~/server/services/leaderboard.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getLeaderboardsWithResults: vi.fn(async () => {
    throw new Error('read failed');
  }),
}));

const { getHomeBlocksByIdHandler, getHomeBlocksHandler, deleteUserHomeBlockHandler } = await import(
  '~/server/controllers/home-block.controller'
);
const { getHomeBlockCached } = await import('~/server/services/home-block-cache.service');
const { getCollectionById } = await import('~/server/services/collection.service');

const COLLECTION_OWNER = 100;
const BLOCK_OWNER = 200;
const STRANGER = { id: 300 };
const MOD = { id: 400, isModerator: true };
const BLOCK_ID = 7;
const COLLECTION_ID = 70;

type Collection = { read: string; userId: number; type: string };
let collection: Collection | null;
let block: { userId: number };

function seed(c: Collection | null, blockUserId = c?.userId ?? BLOCK_OWNER) {
  collection = c;
  block = { userId: blockUserId };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.sharedCalls.length = 0;
  getHomeBlockRow.mockImplementation(async (_db: unknown, id: number) =>
    id === BLOCK_ID
      ? {
          id,
          type: HomeBlockType.Collection,
          userId: block.userId,
          sourceId: null,
          metadata: { collection: { id: COLLECTION_ID } },
        }
      : undefined
  );
  dbMock.dbWrite.homeBlock.findUnique.mockResolvedValue(null as never);
  dbMock.dbRead.collection.findUnique.mockImplementation(
    (async () => collection && { read: collection.read, userId: collection.userId }) as never
  );
  // getUserCollectionPermissionsById's collection row.
  dbMock.dbRead.$queryRaw.mockImplementation((async (strings: TemplateStringsArray) =>
    // userHasCustomHomeBlocks
    strings.join('?').includes('FROM "HomeBlock" hb')
      ? [{ exists: true }]
      : strings.join('?').includes('FROM "Collection" c') && collection
      ? [
          {
            id: COLLECTION_ID,
            read: collection.read,
            write: 'Private',
            userId: collection.userId,
            type: collection.type,
            mode: null,
            collaborationDisabledAt: null,
            contributorPermissions: null,
            hasAcceptedSeat: false,
          },
        ]
      : []) as never);
  getCollectionItems.mockResolvedValue({ items: ['for-viewer'], nextCursor: undefined });
});

const ctxFor = (user?: { id: number; isModerator?: boolean }) =>
  ({
    user,
    // The defaults a request starts with (createContext), before edgeCacheIt runs.
    cache: {
      skip: false,
      canCache: true,
      edgeTTL: user ? 0 : 60,
      browserTTL: user ? 0 : 60,
      staleWhileRevalidate: 30,
    },
  } as unknown as Context);

const load = (ctx: Context) => getHomeBlocksByIdHandler({ ctx, input: { id: BLOCK_ID } });
const loadAs = (user?: { id: number; isModerator?: boolean }) => load(ctxFor(user));
const errorOf = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { code?: string; message?: string }) => ({ code: e.code, message: e.message })
  );
const itemsOf = (block: unknown) => (block as { collection: { items: string[] } }).collection.items;
const missing = async () => {
  return errorOf(getHomeBlocksByIdHandler({ ctx: ctxFor(), input: { id: 999 } }));
};

describe.each(['Image', 'Model', 'Article'])('a block of a %s collection', (type) => {
  it("answers someone else's Private collection exactly as a missing block, signed out and signed in", async () => {
    const notFound = await missing();
    expect(notFound).toMatchObject({ code: 'NOT_FOUND' });
    seed({ read: 'Private', userId: COLLECTION_OWNER, type });
    expect(await errorOf(loadAs())).toEqual(notFound);
    expect(await errorOf(loadAs(STRANGER))).toEqual(notFound);
    expect(getHomeBlockCached).not.toHaveBeenCalled();
    expect(getCollectionItems).not.toHaveBeenCalled();
  });

  it("serves a Private collection's block to its owner and a moderator, outside the shared entry", async () => {
    seed({ read: 'Private', userId: COLLECTION_OWNER, type });
    for (const user of [{ id: COLLECTION_OWNER }, MOD]) {
      const result = await loadAs(user);
      expect(itemsOf(result)).toEqual(['for-viewer']);
    }
    expect(getHomeBlockCached).not.toHaveBeenCalled();
    // The same read as the shared entry's: no viewer reaches it, so the body does not vary by caller.
    for (const [args] of getCollectionItems.mock.calls) expect(args.user).toBeUndefined();
  });

  it('serves a Public collection from the shared entry to anyone (control)', async () => {
    seed({ read: 'Public', userId: COLLECTION_OWNER, type }, BLOCK_OWNER);
    for (const user of [undefined, STRANGER]) {
      const result = await loadAs(user);
      expect(itemsOf(result)).toEqual(['shared']);
    }
    expect(state.sharedCalls).toEqual([BLOCK_ID, BLOCK_ID]);
  });
});

describe('Unlisted collections', () => {
  it("serves an Unlisted collection on its owner's own block from the shared entry", async () => {
    seed({ read: 'Unlisted', userId: COLLECTION_OWNER, type: 'Image' }, COLLECTION_OWNER);
    expect(await errorOf(loadAs())).toBeNull();
    expect(state.sharedCalls).toEqual([BLOCK_ID]);
  });

  it("serves someone else's Unlisted collection to the block's owner only, not to a stranger", async () => {
    seed({ read: 'Unlisted', userId: COLLECTION_OWNER, type: 'Image' }, BLOCK_OWNER);
    const notFound = await missing();
    expect(await errorOf(loadAs(STRANGER))).toEqual(notFound);
    expect(await errorOf(loadAs())).toEqual(notFound);
    const own = await loadAs({ id: BLOCK_OWNER });
    expect(itemsOf(own)).toEqual(['for-viewer']);
    expect(await errorOf(loadAs(MOD))).toBeNull();
    expect(getHomeBlockCached).not.toHaveBeenCalled();
  });

  describe('with the real shared entry', () => {
    // Every write of a rendered home block, to the entry every viewer reads.
    const sharedWrites = () =>
      redisMock.redis.packed.set.mock.calls.filter(([key]) =>
        String(key).startsWith(`${REDIS_KEYS.HOMEBLOCKS.BASE}:`)
      );

    const fakeCached = vi.mocked(getHomeBlockCached).getMockImplementation();
    const fakeCollection = vi.mocked(getCollectionById).getMockImplementation();
    afterEach(() => {
      vi.mocked(getHomeBlockCached).mockImplementation(fakeCached!);
      vi.mocked(getCollectionById).mockImplementation(fakeCollection!);
    });

    beforeEach(async () => {
      const actual = await vi.importActual<typeof HomeBlockCache>(
        '~/server/services/home-block-cache.service'
      );
      vi.mocked(getHomeBlockCached).mockImplementation(actual.getHomeBlockCached);
      redisMock.redis.packed.get.mockResolvedValue(null as never);
      // The rendered collection carries its read setting, which the shared entry checks.
      vi.mocked(getCollectionById).mockImplementation((async ({
        input,
      }: {
        input: { id: number };
      }) => ({
        id: input.id,
        read: collection?.read,
      })) as never);
    });

    // Unlisted counts as shared for the entry, so keeping this block out of it is all that holds.
    it("never writes someone else's Unlisted collection to it, for the block's owner or a stranger", async () => {
      seed({ read: 'Unlisted', userId: COLLECTION_OWNER, type: 'Image' }, BLOCK_OWNER);
      expect(itemsOf(await loadAs({ id: BLOCK_OWNER }))).toEqual(['for-viewer']);
      await errorOf(loadAs(STRANGER));
      expect(sharedWrites()).toEqual([]);
    });

    it("writes the owner's own Unlisted collection to it (control)", async () => {
      seed({ read: 'Unlisted', userId: COLLECTION_OWNER, type: 'Image' }, COLLECTION_OWNER);
      await loadAs(STRANGER);
      expect(sharedWrites()).toHaveLength(1);
    });
  });
});

describe('cache headers', () => {
  const headersFor = (ctx: Context, errorCount = 0) =>
    buildTrpcCacheHeaders({
      cache: ctx.cache,
      type: 'query',
      errorCount,
      paths: ['homeBlock.getHomeBlock'],
    }).headers['Cache-Control'];

  it('keeps an answer for one viewer out of every shared cache', async () => {
    seed({ read: 'Private', userId: COLLECTION_OWNER, type: 'Image' });
    const ctx = ctxFor({ id: COLLECTION_OWNER });
    // As edgeCacheIt would have set it for a cacheable answer.
    ctx.cache.edgeTTL = 180;
    ctx.cache.browserTTL = 60;
    await load(ctx);
    expect(ctx.cache.skip).toBe(true);
    expect(headersFor(ctx) ?? '').not.toMatch(/public|s-maxage/);
  });

  it('still sends the public cache header for a Public collection (control)', async () => {
    seed({ read: 'Public', userId: COLLECTION_OWNER, type: 'Image' });
    const ctx = ctxFor();
    await load(ctx);
    expect(headersFor(ctx)).toMatch(/^public, .*s-maxage=60/);
  });

  it('never sends the public cache header with the not-found answer', async () => {
    seed({ read: 'Private', userId: COLLECTION_OWNER, type: 'Image' });
    const ctx = ctxFor();
    expect(await errorOf(load(ctx))).toMatchObject({ code: 'NOT_FOUND' });
    expect(headersFor(ctx, 1) ?? '').not.toMatch(/public/);
  });
});

describe('deleting a block', () => {
  // One stored row owned by BLOCK_OWNER; findFirst answers only a where that matches it.
  const storedBlock = { id: BLOCK_ID, userId: BLOCK_OWNER };
  const deleteAs = (user: { id: number; isModerator?: boolean }) =>
    deleteUserHomeBlockHandler({ input: { id: BLOCK_ID }, ctx: { user } as never });

  beforeEach(() => {
    dbMock.dbRead.homeBlock.findFirst.mockImplementation((async ({
      where,
    }: {
      where: { id: number; userId?: number };
    }) =>
      where.id === storedBlock.id &&
      (where.userId === undefined || where.userId === storedBlock.userId)
        ? storedBlock
        : null) as never);
    dbMock.dbWrite.homeBlock.delete.mockResolvedValue({ id: BLOCK_ID } as never);
  });

  it('lets the owner delete a block whose collection they may no longer read', async () => {
    seed({ read: 'Private', userId: COLLECTION_OWNER, type: 'Image' }, BLOCK_OWNER);
    await expect(deleteAs({ id: BLOCK_OWNER })).resolves.toMatchObject({ id: BLOCK_ID });
    expect(dbMock.dbWrite.homeBlock.delete).toHaveBeenCalledWith({
      where: { id: BLOCK_ID, userId: BLOCK_OWNER },
    });
  });

  it("answers a stranger's delete as a missing block, not a refusal", async () => {
    expect(await errorOf(deleteAs(STRANGER))).toMatchObject({ code: 'NOT_FOUND' });
    expect(dbMock.dbWrite.homeBlock.delete).not.toHaveBeenCalled();
  });

  it("lets a moderator delete another user's block", async () => {
    await expect(deleteAs(MOD)).resolves.toMatchObject({ id: BLOCK_ID });
  });
});

describe("the block editor's list (withCoreData)", () => {
  const listFor = async (user: { id: number }) => {
    dbMock.dbRead.homeBlock.findMany.mockResolvedValue([
      {
        id: BLOCK_ID,
        type: HomeBlockType.Collection,
        userId: block.userId,
        sourceId: null,
        index: 0,
        metadata: { collection: { id: COLLECTION_ID } },
      },
    ] as never);
    return (
      await getHomeBlocksHandler({
        ctx: ctxFor(user),
        input: { withCoreData: true, ownedOnly: true },
      })
    ).map((b) => ({ id: b.id, collection: 'collection' in b ? b.collection : undefined }));
  };

  // Saving the editor removes any of the viewer's blocks it did not list, so every one is listed.
  it("lists the viewer's block of a collection they may no longer read, without the collection", async () => {
    seed({ read: 'Private', userId: COLLECTION_OWNER, type: 'Image' }, BLOCK_OWNER);
    expect(await listFor({ id: BLOCK_OWNER })).toEqual([{ id: BLOCK_ID, collection: undefined }]);
  });

  it("lists the viewer's block of their own Private collection with it (control)", async () => {
    seed({ read: 'Private', userId: BLOCK_OWNER, type: 'Image' }, BLOCK_OWNER);
    expect(await listFor({ id: BLOCK_OWNER })).toEqual([
      { id: BLOCK_ID, collection: expect.objectContaining({ id: COLLECTION_ID }) },
    ]);
  });

  it('lists a block that renders nothing, and one that fails to render, without their data', async () => {
    seed({ read: 'Private', userId: BLOCK_OWNER, type: 'Image' }, BLOCK_OWNER);
    const EMPTY_FEED = 8;
    const BROKEN_BLOCK = 9;
    dbMock.dbRead.homeBlock.findMany.mockResolvedValue([
      {
        id: BLOCK_ID,
        type: HomeBlockType.Collection,
        userId: BLOCK_OWNER,
        sourceId: null,
        index: 0,
        metadata: { collection: { id: COLLECTION_ID } },
      },
      // A Feed block with no feed renders null.
      {
        id: EMPTY_FEED,
        type: HomeBlockType.Feed,
        userId: BLOCK_OWNER,
        sourceId: null,
        index: 1,
        metadata: {},
      },
      // A Leaderboard block whose leaderboards fail to load throws while rendering.
      {
        id: BROKEN_BLOCK,
        type: HomeBlockType.Leaderboard,
        userId: BLOCK_OWNER,
        sourceId: null,
        index: 2,
        metadata: { leaderboards: [{ id: 'overall', index: 0 }] },
      },
    ] as never);

    const listed = await getHomeBlocksHandler({
      ctx: ctxFor({ id: BLOCK_OWNER }),
      input: { withCoreData: true, ownedOnly: true },
    });

    expect(listed.map((b) => b.id)).toEqual([BLOCK_ID, EMPTY_FEED, BROKEN_BLOCK]);
    // The readable block still carries its data (control).
    expect(listed[0]).toHaveProperty('collection');
  });
});

describe('a clone of a system block', () => {
  const SYSTEM_BLOCK_ID = 3;
  const cloneRow = (metadata: object) => ({
    id: BLOCK_ID,
    type: HomeBlockType.Collection,
    userId: BLOCK_OWNER,
    sourceId: SYSTEM_BLOCK_ID,
    metadata,
  });

  it('shows the collection its system block chose, as the system block does', async () => {
    seed({ read: 'Private', userId: COLLECTION_OWNER, type: 'Model' }, BLOCK_OWNER);
    getHomeBlockRow.mockImplementation(async (_db: unknown, id: number) =>
      id === BLOCK_ID ? cloneRow({}) : undefined
    );
    dbMock.dbRead.homeBlock.findMany.mockResolvedValue([] as never);
    dbMock.dbRead.homeBlock.findFirst.mockResolvedValue({
      metadata: { collection: { id: COLLECTION_ID } },
    } as never);
    expect(await errorOf(loadAs(STRANGER))).toBeNull();
    expect(state.sharedCalls).toEqual([BLOCK_ID]);
  });

  it("is judged as its owner's block when its system block is gone", async () => {
    seed({ read: 'Private', userId: COLLECTION_OWNER, type: 'Model' }, BLOCK_OWNER);
    getHomeBlockRow.mockImplementation(async (_db: unknown, id: number) =>
      id === BLOCK_ID ? cloneRow({ collection: { id: COLLECTION_ID } }) : undefined
    );
    dbMock.dbRead.homeBlock.findMany.mockResolvedValue([] as never);
    dbMock.dbRead.homeBlock.findFirst.mockResolvedValue(null as never);
    expect(await errorOf(loadAs(STRANGER))).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe("the block editor's list of a clone", () => {
  it('lists a clone whose system block points at a collection that is gone', async () => {
    seed({ read: 'Public', userId: COLLECTION_OWNER, type: 'Image' }, BLOCK_OWNER);
    const { getCollectionById } = await import('~/server/services/collection.service');
    vi.mocked(getCollectionById).mockRejectedValueOnce(
      new TRPCError({ code: 'NOT_FOUND', message: 'Collection not found' })
    );
    dbMock.dbRead.homeBlock.findFirst.mockResolvedValue({
      metadata: { collection: { id: COLLECTION_ID } },
    } as never);
    dbMock.dbRead.homeBlock.findMany.mockResolvedValue([
      {
        id: BLOCK_ID,
        type: HomeBlockType.Collection,
        userId: BLOCK_OWNER,
        sourceId: 3,
        index: 0,
        metadata: {},
      },
    ] as never);
    const listed = await getHomeBlocksHandler({
      ctx: ctxFor({ id: BLOCK_OWNER }),
      input: { withCoreData: true, ownedOnly: true },
    });
    expect(listed.map((b) => b.id)).toEqual([BLOCK_ID]);
  });
});

describe('other audiences', () => {
  it('serves a system block of a Private collection from the shared entry', async () => {
    seed({ read: 'Private', userId: COLLECTION_OWNER, type: 'Image' }, -1);
    expect(await errorOf(loadAs())).toBeNull();
    expect(state.sharedCalls).toEqual([BLOCK_ID]);
  });

  it('answers a block whose collection is gone, or that names none, as a missing block', async () => {
    const notFound = await missing();
    seed(null);
    expect(await errorOf(loadAs({ id: BLOCK_OWNER }))).toEqual(notFound);
    seed({ read: 'Public', userId: COLLECTION_OWNER, type: 'Image' });
    getHomeBlockRow.mockImplementation(async (_db: unknown, id: number) =>
      id === BLOCK_ID
        ? { id, type: HomeBlockType.Collection, userId: BLOCK_OWNER, sourceId: null, metadata: {} }
        : undefined
    );
    expect(await errorOf(loadAs({ id: BLOCK_OWNER }))).toEqual(notFound);
  });
});
