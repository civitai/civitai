import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks';
import type * as HotReads5 from '@civitai/db-queries/hot-reads-5';
import type * as CollectionService from '~/server/services/collection.service';
import type * as HomeBlockAccess from '~/server/services/home-block-access';
import type * as HomeBlockCache from '~/server/services/home-block-cache.service';
import type { HomeBlockCacheTier } from '~/server/prom/home-block-get.metrics';
import { HomeBlockType } from '~/shared/utils/prisma/enums';

/**
 * `home_block_get_total`: every getHomeBlockById call is counted once, under the tier that answered
 * it, its block type and whether the viewer is signed in. Driven through the real service; the row
 * read, the gates and the shared entry are faked so each path can be reached on its own.
 */

const state = vi.hoisted(() => ({
  row: undefined as Record<string, unknown> | undefined,
  canView: true,
  audience: 'all' as 'all' | 'viewer' | 'none',
  // What the faked shared entry reports, and whether it throws instead.
  cacheTier: 'redis' as HomeBlockCacheTier,
  cacheThrows: false,
}));

vi.mock('@civitai/db-queries/hot-reads-5', async (importOriginal) => ({
  ...(await importOriginal<typeof HotReads5>()),
  getHomeBlockRow: vi.fn(async () => state.row),
}));

vi.mock('~/server/services/home-block-access', async (importOriginal) => ({
  ...(await importOriginal<typeof HomeBlockAccess>()),
  canViewHomeBlock: vi.fn(async () => state.canView),
}));

vi.mock('~/server/services/home-block-collection-access', () => ({
  getCollectionBlockAudience: vi.fn(async () => state.audience),
}));

vi.mock('~/server/services/home-block-cache.service', async (importOriginal) => ({
  ...(await importOriginal<typeof HomeBlockCache>()),
  getHomeBlockCached: vi.fn(
    async (
      block: { id: number },
      _domain: unknown,
      metadata: unknown,
      _source: unknown,
      onTier?: (tier: HomeBlockCacheTier) => void
    ) => {
      if (state.cacheThrows) throw new Error('read failed');
      onTier?.(state.cacheTier);
      return state.cacheTier === 'no_identifier' ? null : { ...block, metadata };
    }
  ),
}));

vi.mock('~/server/services/collection.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CollectionService>()),
  getCollectionById: vi.fn(async ({ input }: { input: { id: number } }) => ({ id: input.id })),
  getCollectionItemsByCollectionId: vi.fn(async () => ({ items: [], nextCursor: undefined })),
}));

const { getHomeBlockById } = await import('~/server/services/home-block.service');
const { homeBlockGetCounter } = await import('~/server/prom/home-block-get.metrics');

type Readable = {
  get(): Promise<{ values: { labels: Record<string, string>; value: number }[] }>;
};
/** Every series of the real counter, as "type/tier/viewer" -> value. */
async function series() {
  const { values } = await (homeBlockGetCounter as unknown as Readable).get();
  return Object.fromEntries(
    values.map((v) => [`${v.labels.type}/${v.labels.tier}/${v.labels.viewer}`, v.value])
  );
}
/** What one call added: the series that moved, and by how much. */
async function countedBy(call: () => Promise<unknown>) {
  const before = await series();
  await call().catch(() => undefined);
  const after = await series();
  return Object.fromEntries(
    Object.entries(after)
      .map(([k, v]) => [k, v - (before[k] ?? 0)] as const)
      .filter(([, d]) => d !== 0)
  );
}

const SIGNED_OUT = undefined;
const SIGNED_IN = { id: 300 };
const BLOCK_ID = 7;
const rowOf = (type: HomeBlockType, metadata: object = {}) => ({
  id: BLOCK_ID,
  type,
  userId: 200,
  sourceId: null,
  metadata,
});

const get = (viewer: { id: number } | undefined) => () =>
  getHomeBlockById({ id: BLOCK_ID, viewer });

beforeEach(() => {
  vi.clearAllMocks();
  state.row = rowOf(HomeBlockType.Leaderboard);
  state.canView = true;
  state.audience = 'all';
  state.cacheTier = 'redis';
  state.cacheThrows = false;
  dbMock.dbWrite.homeBlock.findUnique.mockResolvedValue(null as never);
});

describe('home_block_get_total', () => {
  it.each(['l1', 'redis', 'miss'] as const)(
    'a call the shared entry answers from %s counts once under that tier',
    async (tier) => {
      state.cacheTier = tier;
      expect(await countedBy(get(SIGNED_OUT))).toEqual({ [`Leaderboard/${tier}/anon`]: 1 });
      expect(await countedBy(get(SIGNED_IN))).toEqual({ [`Leaderboard/${tier}/authed`]: 1 });
    }
  );

  it('a row with no cache identifier counts as no_identifier', async () => {
    state.row = rowOf(HomeBlockType.CosmeticShop);
    state.cacheTier = 'no_identifier';
    expect(await countedBy(get(SIGNED_OUT))).toEqual({ 'CosmeticShop/no_identifier/anon': 1 });
  });

  it('a missing row counts as not_found, with type none', async () => {
    state.row = undefined;
    expect(await countedBy(get(SIGNED_IN))).toEqual({ 'none/not_found/authed': 1 });
  });

  it('a gated row the viewer may not see counts as denied', async () => {
    state.row = rowOf(HomeBlockType.Event);
    state.canView = false;
    expect(await countedBy(get(SIGNED_OUT))).toEqual({ 'Event/denied/anon': 1 });
  });

  it('a collection the viewer may not read counts as denied', async () => {
    state.row = rowOf(HomeBlockType.Collection, { collection: { id: 70 } });
    state.audience = 'none';
    expect(await countedBy(get(SIGNED_IN))).toEqual({ 'Collection/denied/authed': 1 });
  });

  it('a collection shown to this viewer only counts as uncached, never as a cache tier', async () => {
    state.row = rowOf(HomeBlockType.Collection, { collection: { id: 70 } });
    state.audience = 'viewer';
    expect(await countedBy(get(SIGNED_IN))).toEqual({ 'Collection/uncached/authed': 1 });
  });

  it('a call that throws counts as error', async () => {
    state.row = rowOf(HomeBlockType.Feed);
    state.cacheThrows = true;
    expect(await countedBy(get(SIGNED_OUT))).toEqual({ 'Feed/error/anon': 1 });
  });

  it('a type outside HomeBlockType is labelled other, never its raw value', async () => {
    state.row = { ...rowOf(HomeBlockType.Leaderboard), type: 'SomethingNew' };
    expect(await countedBy(get(SIGNED_OUT))).toEqual({ 'other/redis/anon': 1 });
  });

  it('a moderator flag without an id is still anon (the label keys on a signed-in id)', async () => {
    expect(
      await countedBy(() =>
        getHomeBlockById({ id: BLOCK_ID, viewer: { isModerator: true } as never })
      )
    ).toEqual({ 'Leaderboard/redis/anon': 1 });
  });
});
