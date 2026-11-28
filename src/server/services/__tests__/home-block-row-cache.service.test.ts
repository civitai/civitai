import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks';
import type * as HotReads5 from '@civitai/db-queries/hot-reads-5';
import type * as HomeBlockAccess from '~/server/services/home-block-access';
import type * as HomeBlockCache from '~/server/services/home-block-cache.service';
import type * as CacheHelpers from '~/server/utils/cache-helpers';
import { HomeBlockType } from '~/shared/utils/prisma/enums';

/**
 * getHomeBlockById reads its row through the per-process copy while `home-block-server-cache` is
 * on, and the writers of the row forget it. The row read is counted; the gate is faked to refuse a
 * row whose metadata says `hidden`, standing in for a feature flag or event gate added by an edit.
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

vi.mock('~/server/services/home-block-access', async (importOriginal) => ({
  ...(await importOriginal<typeof HomeBlockAccess>()),
  canViewHomeBlock: vi.fn(
    async (block: { metadata?: { hidden?: boolean } }) => !block.metadata?.hidden
  ),
}));

vi.mock('~/server/services/home-block-cache.service', async (importOriginal) => ({
  ...(await importOriginal<typeof HomeBlockCache>()),
  getHomeBlockCached: vi.fn(async (block: object, _d: unknown, metadata: unknown) => ({
    ...block,
    metadata,
  })),
}));

vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  bustFetchThroughCache: vi.fn(async () => undefined),
}));

const { getHomeBlockById, upsertHomeBlock, deleteHomeBlockById } = await import(
  '~/server/services/home-block.service'
);
const { resetHomeBlockL1ForTests } = await import('~/server/services/home-block-cache.service');

const BLOCK_ID = 41;
const OWNER = 200;
const visible = {
  id: BLOCK_ID,
  type: HomeBlockType.Leaderboard,
  userId: OWNER,
  sourceId: null,
  metadata: { title: 'A' },
};
const hidden = { ...visible, metadata: { title: 'A', hidden: true } };

const get = () => getHomeBlockById({ id: BLOCK_ID, viewer: undefined });

beforeEach(() => {
  vi.clearAllMocks();
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

  it('flag on: a gate added in ANOTHER process applies here within 10s, never later', async () => {
    vi.useFakeTimers();
    resetHomeBlockL1ForTests(() => true);
    expect(await get()).not.toBeNull();
    // The edit lands elsewhere: nothing here forgets the row.
    state.row = hidden;
    vi.advanceTimersByTime(9_999);
    expect(await get()).not.toBeNull();
    vi.advanceTimersByTime(2);
    expect(await get()).toBeNull();
  });

  it('flag on: an edit through upsertHomeBlock in THIS process applies on the next call', async () => {
    resetHomeBlockL1ForTests(() => true);
    await get();
    state.row = hidden;
    dbMock.dbRead.homeBlock.findUnique.mockResolvedValue({ userId: OWNER } as never);
    dbMock.dbWrite.homeBlock.update.mockResolvedValue({
      id: BLOCK_ID,
      type: HomeBlockType.Leaderboard,
      metadata: hidden.metadata,
      userId: OWNER,
    } as never);
    await upsertHomeBlock({
      input: {
        id: BLOCK_ID,
        userId: OWNER,
        type: HomeBlockType.Leaderboard,
        metadata: hidden.metadata,
      } as never,
    });
    expect(await get()).toBeNull();
    expect(state.rowReads).toBe(2);
  });

  it('flag on: a delete through deleteHomeBlockById in THIS process applies on the next call', async () => {
    resetHomeBlockL1ForTests(() => true);
    await get();
    state.row = undefined;
    dbMock.dbRead.homeBlock.findFirst.mockResolvedValue({ id: BLOCK_ID, userId: OWNER } as never);
    dbMock.dbWrite.homeBlock.delete.mockResolvedValue({ id: BLOCK_ID } as never);
    await deleteHomeBlockById({ input: { id: BLOCK_ID, userId: OWNER } });
    expect(await get()).toBeNull();
    expect(state.rowReads).toBe(2);
  });
});
