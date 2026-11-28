import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as HotReads5 from '@civitai/db-queries/hot-reads-5';
import { HomeBlockType } from '~/shared/utils/prisma/enums';

/**
 * getHomeBlockById reads its row through the per-process copy while `home-block-server-cache` is
 * on, and the writers of the row forget it. The real service, gates and cache; only the row read
 * (counted), the database writes and Redis are faked. An Announcement row renders from its
 * metadata alone. A `featureFlag` that is no feature flag gates the row off for everyone: it
 * stands in for an edit that narrows who may see a block.
 */

const state = vi.hoisted(() => ({
  row: undefined as Record<string, unknown> | undefined,
  rowReads: 0,
}));

vi.mock('@civitai/db-queries/hot-reads-5', async (importOriginal) => ({
  ...(await importOriginal<typeof HotReads5>()),
  getHomeBlockRow: vi.fn(async () => {
    state.rowReads++;
    return state.row && { ...state.row };
  }),
}));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));

const { getHomeBlockById, upsertHomeBlock, deleteHomeBlockById, setHomeBlocksOrder } = await import(
  '~/server/services/home-block.service'
);
const { resetHomeBlockL1ForTests } = await import('~/server/services/home-block-cache.service');

const BLOCK_ID = 41;
const OWNER = 200;
const visible = {
  id: BLOCK_ID,
  type: HomeBlockType.Announcement,
  userId: OWNER,
  sourceId: null,
  metadata: { title: 'A' },
};
const gated = { ...visible, metadata: { title: 'A', featureFlag: 'not-a-feature-flag' } };

const get = () => getHomeBlockById({ id: BLOCK_ID, viewer: undefined });

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
  state.row = visible;
  state.rowReads = 0;
  dbMock.dbWrite.homeBlock.findUnique.mockResolvedValue(null as never);
  resetHomeBlockL1ForTests(() => false);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getHomeBlockById row read', () => {
  it('flag off: every call reads the row (the old path)', async () => {
    await get();
    await get();
    expect(state.rowReads).toBe(2);
  });

  it('flag on: the second call within 10s reads no row', async () => {
    resetHomeBlockL1ForTests(() => true);
    expect(await get()).toMatchObject({ id: BLOCK_ID, metadata: { title: 'A' } });
    expect(await get()).toMatchObject({ id: BLOCK_ID, metadata: { title: 'A' } });
    expect(state.rowReads).toBe(1);
  });

  it('flag on: a missing row is read again on the next call', async () => {
    resetHomeBlockL1ForTests(() => true);
    state.row = undefined;
    expect(await get()).toBeNull();
    expect(await get()).toBeNull();
    expect(state.rowReads).toBe(2);
  });

  it('flag on: a gate added in ANOTHER process applies here after 10s, not before', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    resetHomeBlockL1ForTests(() => true);
    expect(await get()).not.toBeNull();
    // The edit lands elsewhere: nothing in this process forgets the row.
    state.row = gated;
    vi.advanceTimersByTime(9_999);
    expect(await get()).not.toBeNull();
    vi.advanceTimersByTime(2);
    expect(await get()).toBeNull();
  });

  it('flag on: an edit through upsertHomeBlock in THIS process applies on the next call', async () => {
    resetHomeBlockL1ForTests(() => true);
    expect(await get()).not.toBeNull();
    state.row = gated;
    dbMock.dbRead.homeBlock.findUnique.mockResolvedValue({ userId: OWNER } as never);
    dbMock.dbWrite.homeBlock.update.mockResolvedValue({
      id: BLOCK_ID,
      type: HomeBlockType.Announcement,
      metadata: gated.metadata,
      userId: OWNER,
    } as never);
    await upsertHomeBlock({
      input: {
        id: BLOCK_ID,
        userId: OWNER,
        isModerator: true,
        type: HomeBlockType.Announcement,
        metadata: gated.metadata,
      } as never,
    });
    expect(await get()).toBeNull();
    expect(state.rowReads).toBe(2);
  });

  it('flag on: a delete through deleteHomeBlockById in THIS process applies on the next call', async () => {
    resetHomeBlockL1ForTests(() => true);
    expect(await get()).not.toBeNull();
    state.row = undefined;
    dbMock.dbRead.homeBlock.findFirst.mockResolvedValue({ id: BLOCK_ID, userId: OWNER } as never);
    dbMock.dbWrite.homeBlock.delete.mockResolvedValue({ id: BLOCK_ID } as never);
    await deleteHomeBlockById({ input: { id: BLOCK_ID, userId: OWNER } });
    expect(await get()).toBeNull();
    expect(state.rowReads).toBe(2);
  });

  it('flag on: a removal through setHomeBlocksOrder in THIS process applies on the next call', async () => {
    resetHomeBlockL1ForTests(() => true);
    expect(await get()).not.toBeNull();
    state.row = undefined;
    // The owner's block 41 is absent from the submitted list, so it is removed.
    dbMock.dbRead.homeBlock.findMany.mockResolvedValue([
      { id: BLOCK_ID, type: HomeBlockType.Announcement, metadata: { title: 'A' }, sourceId: null },
    ] as never);
    dbMock.dbWrite.$transaction.mockResolvedValue([] as never);
    await setHomeBlocksOrder({
      input: { userId: OWNER, homeBlocks: [] } as never,
      viewer: undefined,
    });
    expect(dbMock.dbWrite.homeBlock.deleteMany).toHaveBeenCalledTimes(1);
    expect(await get()).toBeNull();
    expect(state.rowReads).toBe(2);
  });
});
