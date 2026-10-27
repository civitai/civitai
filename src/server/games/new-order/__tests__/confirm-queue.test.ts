import { describe, expect, it, vi } from 'vitest';
import {
  CONFIRM_QUEUE_DEFAULTS,
  planRotation,
  runConfirmSync,
  type AgreedItem,
  type ConfirmPools,
  type ConfirmStore,
} from '~/server/games/new-order/confirm-queue';

const NOW = new Date('2026-10-30T12:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

const agreed = (id: number, over: Partial<AgreedItem> = {}): AgreedItem => ({
  id,
  imageId: id * 10,
  url: `key-${id}`,
  firstLevel: 4,
  imageLevel: 4,
  firstModId: 1,
  secondModId: 2,
  firstSetAt: daysAgo(1),
  secondAt: daysAgo(0.5),
  ...over,
});

function setup({
  items = [] as AgreedItem[],
  active = [] as { id: number; imageId: number; secondAt: Date }[],
  pooledOk = true,
} = {}) {
  const order: string[] = [];
  const store: ConfirmStore = {
    agreedUnpooled: vi.fn(async () => items),
    markPooled: vi.fn(async (item) => {
      order.push(`pooled:${item.id}`);
      return pooledOk;
    }),
    markStale: vi.fn(async () => undefined),
    pooledActive: vi.fn(async () => active),
    markExpired: vi.fn(async (ids) => {
      order.push(`expired:${ids.join(',')}`);
    }),
  };
  const pools: ConfirmPools = {
    add: vi.fn(async (ids) => {
      order.push(`add:${ids.join(',')}`);
    }),
    remove: vi.fn(async (ids) => {
      order.push(`remove:${ids.join(',')}`);
    }),
  };
  return { store, pools, order };
}

describe('planRotation', () => {
  it('expires items older than the window', () => {
    const items = [
      { id: 1, secondAt: daysAgo(15) },
      { id: 2, secondAt: daysAgo(13) },
    ];
    expect(planRotation({ items, now: NOW, ttlDays: 14, cap: 2000 })).toEqual([1]);
  });

  it('keeps only the newest items up to the cap', () => {
    const items = [1, 2, 3, 4].map((id) => ({ id, secondAt: daysAgo(5 - id) }));
    expect(planRotation({ items, now: NOW, ttlDays: 14, cap: 2 }).sort()).toEqual([1, 2]);
  });

  it('expires nothing when under both limits', () => {
    const items = [{ id: 1, secondAt: daysAgo(1) }];
    expect(planRotation({ items, now: NOW, ttlDays: 14, cap: 2000 })).toEqual([]);
  });

  it('defaults to a 2,000 item cap and 14 days', () => {
    expect(CONFIRM_QUEUE_DEFAULTS).toEqual({ poolCap: 2000, ttlDays: 14 });
  });
});

describe('runConfirmSync', () => {
  it('puts agreed images in the Acolyte pool and sanity set, then marks them pooled', async () => {
    const { store, pools, order } = setup({ items: [agreed(1), agreed(2)] });

    const result = await runConfirmSync({ store, pools, now: NOW });

    expect(pools.add).toHaveBeenCalledWith([10, 20]);
    expect(order.slice(0, 3)).toEqual(['add:10,20', 'pooled:1', 'pooled:2']);
    expect(result).toMatchObject({ pooled: 2, stale: 0, expired: 0 });
  });

  it('leaves an image alone whose level changed since the two moderators agreed', async () => {
    const { store, pools } = setup({ items: [agreed(1), agreed(2, { imageLevel: 8 })] });

    const result = await runConfirmSync({ store, pools, now: NOW });

    expect(pools.add).toHaveBeenCalledWith([10]);
    expect(store.markStale).toHaveBeenCalledWith([2], NOW);
    expect(result).toMatchObject({ pooled: 1, stale: 1 });
  });

  it('does not count an item pooled when its labels could not be recorded', async () => {
    const { store, pools } = setup({ items: [agreed(1)], pooledOk: false });

    const result = await runConfirmSync({ store, pools, now: NOW });

    expect(result).toMatchObject({ pooled: 0, failed: 1 });
  });

  it('marks nothing pooled when the pools could not be written', async () => {
    const { store, pools } = setup({ items: [agreed(1)] });
    vi.mocked(pools.add).mockRejectedValue(new Error('redis down'));

    await expect(runConfirmSync({ store, pools, now: NOW })).rejects.toThrow('redis down');
    expect(store.markPooled).not.toHaveBeenCalled();
  });

  it('rotates out expired and over-cap items from both pools, then records it', async () => {
    const { store, pools, order } = setup({
      active: [
        { id: 7, imageId: 70, secondAt: daysAgo(20) },
        { id: 8, imageId: 80, secondAt: daysAgo(1) },
        { id: 9, imageId: 90, secondAt: daysAgo(2) },
      ],
    });

    const result = await runConfirmSync({
      store,
      pools,
      now: NOW,
      config: { poolCap: 1, ttlDays: 14 },
    });

    expect(pools.remove).toHaveBeenCalledWith([70, 90]);
    expect(order).toEqual(['remove:70,90', 'expired:7,9']);
    expect(result.expired).toBe(2);
  });
});
