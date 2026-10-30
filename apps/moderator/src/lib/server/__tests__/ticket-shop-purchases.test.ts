import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));

const { shopSectionFor } = await import('../tickets/shop-purchases');

const purchases = vi.fn();
const reads = { purchases: (...a: unknown[]) => purchases(...a) } as never;

const purchase = (n: number, over: Record<string, unknown> = {}) => ({
  buzzTransactionId: `tx-${n}`,
  cosmeticId: n,
  title: `Item ${n}`,
  unitAmount: 500,
  purchasedAt: new Date('2026-10-01T00:00:00Z'),
  refunded: false,
  ...over,
});

beforeEach(() => {
  purchases.mockReset().mockResolvedValue({ items: [purchase(1)], truncated: false });
});

describe('shopSectionFor', () => {
  it('lists the recent purchases with title, amount, date and refunded flag', async () => {
    purchases.mockResolvedValue({
      items: [purchase(1), purchase(2, { refunded: true })],
      truncated: false,
    });
    const res = await shopSectionFor({ userId: 7 }, reads);
    expect(purchases).toHaveBeenCalledWith(7, 10);
    expect(res).toEqual({
      status: 'ok',
      userId: 7,
      truncated: false,
      purchases: [
        {
          id: 'tx-1',
          title: 'Item 1',
          amount: 500,
          at: '2026-10-01T00:00:00.000Z',
          refunded: false,
        },
        {
          id: 'tx-2',
          title: 'Item 2',
          amount: 500,
          at: '2026-10-01T00:00:00.000Z',
          refunded: true,
        },
      ],
    });
  });

  it('says when the list was cut', async () => {
    purchases.mockResolvedValue({ items: [purchase(1)], truncated: true });
    expect(await shopSectionFor({ userId: 7 }, reads)).toMatchObject({ truncated: true });
  });

  it('turns a failing read into unavailable', async () => {
    purchases.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await shopSectionFor({ userId: 7 }, reads)).toEqual({
      status: 'unavailable',
      userId: 7,
    });
  });
});
