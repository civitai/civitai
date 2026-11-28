import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as HotReads5 from '@civitai/db-queries/hot-reads-5';
import { HomeBlockType } from '~/shared/utils/prisma/enums';

/**
 * `home_block_get_total`: every getHomeBlockById call is counted once, under the tier that answered
 * it, its block type and whether the viewer is signed in. Driven through the real service, gates and
 * cache; only the row read and Redis are faked. An Announcement row renders from its metadata
 * alone, so it reaches every cache tier with no other read. The collection audience paths
 * (`denied`, `uncached`) are pinned in home-block-collection-audience.test.ts.
 */

const state = vi.hoisted(() => ({
  row: undefined as Record<string, unknown> | undefined,
  rowThrows: false,
}));

vi.mock('@civitai/db-queries/hot-reads-5', async (importOriginal) => ({
  ...(await importOriginal<typeof HotReads5>()),
  getHomeBlockRow: vi.fn(async () => {
    if (state.rowThrows) throw new Error('replica down');
    return state.row && { ...state.row };
  }),
}));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));

const { getHomeBlockById } = await import('~/server/services/home-block.service');
const { resetHomeBlockL1ForTests } = await import('~/server/services/home-block-cache.service');
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
const rowOf = (type: string, metadata: object = {}) => ({
  id: BLOCK_ID,
  type,
  userId: -1,
  sourceId: null,
  metadata,
});

const get = (viewer: { id: number } | undefined) => () =>
  getHomeBlockById({ id: BLOCK_ID, viewer });

// A fake Redis: values go through a JSON round trip, as a real store's encode/decode would.
const store = new Map<string, string>();

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  redisMock.redis.packed.get.mockImplementation(async (key: string) =>
    store.has(key) ? JSON.parse(store.get(key) as string) : null
  );
  redisMock.redis.packed.set.mockImplementation(async (key: string, value: unknown) => {
    store.set(key, JSON.stringify(value));
    return 'OK';
  });
  state.row = rowOf(HomeBlockType.Announcement, { title: 'A' });
  state.rowThrows = false;
  dbMock.dbWrite.homeBlock.findUnique.mockResolvedValue(null as never);
  resetHomeBlockL1ForTests(() => false);
});

describe('home_block_get_total', () => {
  it('L1 off: a cold call is a miss, the next is a Redis hit, for either viewer', async () => {
    expect(await countedBy(get(SIGNED_OUT))).toEqual({ 'Announcement/miss/anon': 1 });
    expect(await countedBy(get(SIGNED_IN))).toEqual({ 'Announcement/redis/authed': 1 });
    expect(await countedBy(get(SIGNED_OUT))).toEqual({ 'Announcement/redis/anon': 1 });
  });

  it('L1 on: a cold call is a miss, the next ones are L1 hits', async () => {
    resetHomeBlockL1ForTests(() => true);
    expect(await countedBy(get(SIGNED_IN))).toEqual({ 'Announcement/miss/authed': 1 });
    expect(await countedBy(get(SIGNED_IN))).toEqual({ 'Announcement/l1/authed': 1 });
    expect(await countedBy(get(SIGNED_OUT))).toEqual({ 'Announcement/l1/anon': 1 });
  });

  it('a row with no cache identifier counts as no_identifier', async () => {
    state.row = rowOf(HomeBlockType.Social);
    expect(await countedBy(get(SIGNED_OUT))).toEqual({ 'Social/no_identifier/anon': 1 });
    expect(redisMock.redis.packed.get).not.toHaveBeenCalled();
  });

  it('a missing row counts as not_found, with type none', async () => {
    state.row = undefined;
    expect(await countedBy(get(SIGNED_IN))).toEqual({ 'none/not_found/authed': 1 });
  });

  it('a gated row the viewer may not see counts as denied', async () => {
    // A flag that is no feature flag gates the row off for everyone.
    state.row = rowOf(HomeBlockType.Announcement, { featureFlag: 'not-a-feature-flag' });
    expect(await countedBy(get(SIGNED_OUT))).toEqual({ 'Announcement/denied/anon': 1 });
  });

  it('a call that throws counts as error', async () => {
    state.rowThrows = true;
    dbMock.dbWrite.homeBlock.findUnique.mockRejectedValue(new Error('primary down') as never);
    await expect(get(SIGNED_OUT)()).rejects.toThrow('primary down');
    expect(await countedBy(get(SIGNED_OUT))).toEqual({ 'none/error/anon': 1 });
  });

  it('a type outside HomeBlockType is labelled other, never its raw value', async () => {
    state.row = rowOf('SomethingNew');
    expect(await countedBy(get(SIGNED_OUT))).toEqual({ 'other/no_identifier/anon': 1 });
  });

  it('a moderator flag without an id is still anon (the label keys on a signed-in id)', async () => {
    expect(
      await countedBy(() =>
        getHomeBlockById({ id: BLOCK_ID, viewer: { isModerator: true } as never })
      )
    ).toEqual({ 'Announcement/miss/anon': 1 });
  });
});
