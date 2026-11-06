import { describe, expect, it, vi } from 'vitest';
import type { LegRow, PurchaseRow } from '$lib/server/shop-purchases.service';

vi.mock('$lib/server/db', () => ({ dbRead: {} }));
vi.mock('$lib/server/clickhouse', () => ({ getClickhouse: () => ({}) }));
vi.mock('$lib/server/users.service', () => ({
  isInt4Id: (n: number) => Number.isInteger(n) && n > 0 && n <= 2147483647,
  usersByIds: async () => new Map(),
}));

const { summarizeShopPurchases } = await import('$lib/server/shop-purchases.service');

const BUYER = 5;
const OTHER_BUYER = 6;
const ITEM = 700;
const UUID = '3f1c9a54-8a43-4e6b-9d55-0c7f1e2ab001';

const itemCharge = (key: string, userId = BUYER) => `cosmetic-purchase-v2-${userId}-${ITEM}-${key}`;
const boxCharge = (key: string) => `item-purchase-v1-${BUYER}-${ITEM}-${key}`;
const packCharge = (key: string) => `cosmetic-pack-v2-${BUYER}-${ITEM}-${key}`;
const topUp = (cosmeticId: number, uuid = UUID, userId = BUYER) =>
  `sticker-topup-${userId}-${cosmeticId}-${uuid}`;

const purchase = (buzzTransactionId: string, over: Partial<PurchaseRow> = {}): PurchaseRow => ({
  userId: BUYER,
  shopItemId: ITEM,
  title: 'Item',
  cosmeticType: 'Sticker',
  unitAmount: 100,
  purchasedAt: new Date('2026-11-01T00:00:00Z'),
  refunded: false,
  buzzTransactionId,
  ...over,
});

const leg = (externalTransactionId: string, over: Partial<LegRow> = {}): LegRow => ({
  externalTransactionId,
  fromAccountId: String(BUYER),
  toAccountId: '0',
  fromAccountType: 'yellow',
  type: 'purchase',
  amount: '100',
  description: 'Shop',
  inWindow: 1,
  ...over,
});

const summarize = (purchases: PurchaseRow[], legs: LegRow[], kind?: 'box' | 'Sticker' | 'Badge') =>
  summarizeShopPurchases([BUYER], purchases, legs, new Map(), 30, kind).accounts[0];

describe('shop_purchases paid-from matching', () => {
  it('adds up a charge that split across two account types', () => {
    const { items } = summarize(
      [purchase(itemCharge('k'))],
      [
        leg(`${itemCharge('k')}-User`, { fromAccountType: 'yellow', amount: '60' }),
        leg(`${itemCharge('k')}-Generation`, { fromAccountType: 'blue', amount: '40' }),
      ]
    );
    expect(items[0].paidFrom).toEqual({ yellow: 60, blue: 40 });
    expect(items[0].noChargeFound).toBe(0);
  });

  it('does not credit a client key with the legs of a longer key that starts with it', () => {
    const { items } = summarize(
      [purchase(itemCharge('k'))],
      [leg(`${itemCharge('k2')}-User`, { amount: '100' })]
    );
    expect(items[0].paidFrom).toEqual({});
    expect(items[0].noChargeFound).toBe(1);
  });

  it('ignores a seller payout and a refund on the same prefix', () => {
    const charge = itemCharge('k');
    const { items } = summarize(
      [purchase(charge)],
      [
        leg(`${charge}-User`, { amount: '100' }),
        leg(`${charge}:sell:9-User`, {
          fromAccountId: String(BUYER),
          toAccountId: '9',
          amount: '70',
        }),
        leg(`${charge}-User`, { toAccountId: '9', amount: '100', type: 'refund' }),
        leg(`${charge}-User`, { fromAccountId: '0', toAccountId: String(BUYER), amount: '100' }),
      ]
    );
    expect(items[0].paidFrom).toEqual({ yellow: 100 });
  });

  it('does not count a debit of another type or a non-user account on the charge', () => {
    const charge = itemCharge('k');
    const { items } = summarize(
      [purchase(charge)],
      [
        leg(`${charge}-User`, { type: 'tip', amount: '11' }),
        leg(`${charge}-User`, { fromAccountType: 'creatorProgramBank', amount: '22' }),
      ]
    );
    expect(items[0].paidFrom).toEqual({});
    expect(items[0].noChargeFound).toBe(1);
  });

  it('keeps each buyer to their own legs', () => {
    const mine = itemCharge('k');
    const theirs = itemCharge('k', OTHER_BUYER);
    const { accounts } = summarizeShopPurchases(
      [BUYER, OTHER_BUYER],
      [purchase(mine), purchase(theirs, { userId: OTHER_BUYER })],
      [
        leg(`${mine}-User`, { amount: '100' }),
        leg(`${theirs}-Green`, {
          fromAccountId: String(OTHER_BUYER),
          fromAccountType: 'green',
          amount: '100',
        }),
      ],
      new Map(),
      30
    );
    expect(accounts[0].items[0].paidFrom).toEqual({ yellow: 100 });
    expect(accounts[1].items[0].paidFrom).toEqual({ green: 100 });
  });
});

describe('shop_purchases missing charges', () => {
  it('does not report a free row as missing its charge', () => {
    const { items } = summarize([purchase(itemCharge('k'), { unitAmount: 0 })], []);
    expect(items[0].noChargeFound).toBe(0);
  });

  it('says nothing about misses when the ledger read was cut short', () => {
    const fill = Array.from({ length: 5000 }, (_, i) => leg(`${itemCharge(`x${i}`)}-User`));
    const account = summarize([purchase(itemCharge('k'))], fill);
    expect(account.items[0].noChargeFound).toBeNull();
    expect(account.truncated).toBe(true);
  });
});

describe('shop_purchases item summary', () => {
  it('names packs and boxes from the charge, and the rest from the cosmetic type', () => {
    const { items } = summarize(
      [
        purchase(boxCharge('a'), { shopItemId: 1, cosmeticType: null }),
        purchase(packCharge('b'), { shopItemId: 2, cosmeticType: null }),
        purchase(itemCharge('c'), { shopItemId: 3, cosmeticType: 'Badge' }),
      ],
      []
    );
    expect(Object.fromEntries(items.map((i) => [i.shopItemId, i.kind]))).toEqual({
      1: 'box',
      2: 'pack',
      3: 'Badge',
    });
  });

  it('counts, sums and dates repeat purchases of one item, refunds included', () => {
    const { items } = summarize(
      [
        purchase(itemCharge('a'), { purchasedAt: new Date('2026-11-01T00:00:00Z') }),
        purchase(itemCharge('b'), {
          purchasedAt: new Date('2026-11-03T00:00:00Z'),
          refunded: true,
        }),
        purchase(itemCharge('c'), { purchasedAt: new Date('2026-11-02T00:00:00Z') }),
      ],
      []
    );
    expect(items[0]).toMatchObject({
      count: 3,
      buzz: 300,
      refunded: 1,
      firstAt: new Date('2026-11-01T00:00:00Z'),
      lastAt: new Date('2026-11-03T00:00:00Z'),
    });
  });

  it('lists the top 25 items by Buzz and rolls the rest into other', () => {
    const rows = Array.from({ length: 27 }, (_, i) =>
      purchase(itemCharge(`k${i}`), { shopItemId: i + 1, unitAmount: (i + 1) * 10 })
    );
    const { items, other } = summarize(rows, []);
    expect(items).toHaveLength(25);
    expect(items[0].shopItemId).toBe(27);
    expect(other).toMatchObject({ items: 2, count: 2, buzz: 30 });
  });

  it('filters to one kind, and keeps top-ups only for stickers', () => {
    const rows = [
      purchase(boxCharge('a'), { shopItemId: 1 }),
      purchase(itemCharge('b'), { shopItemId: 2, cosmeticType: 'Badge' }),
    ];
    const legs = [leg(`${topUp(44)}-User`, { description: 'Sticker uses - Wave' })];
    const box = summarize(rows, legs, 'box');
    expect(box.items.map((i) => i.shopItemId)).toEqual([1]);
    expect(box.topUps).toEqual([]);
    expect(summarize(rows, legs, 'Sticker').topUps).toHaveLength(1);
  });
});

describe('shop_purchases sticker top-ups', () => {
  it('counts a split charge once and reports its Buzz by account type', () => {
    const { topUps } = summarize(
      [],
      [
        leg(`${topUp(44)}-Generation`, {
          fromAccountType: 'blue',
          amount: '30',
          description: 'Sticker uses - Wave',
        }),
        leg(`${topUp(44)}-User`, {
          fromAccountType: 'yellow',
          amount: '20',
          description: 'Sticker uses - Wave',
        }),
        leg(`${topUp(44, '3f1c9a54-8a43-4e6b-9d55-0c7f1e2ab002')}-User`, {
          fromAccountType: 'yellow',
          amount: '50',
          description: 'Sticker uses - Wave',
        }),
      ]
    );
    expect(topUps).toEqual([
      {
        cosmeticId: 44,
        name: 'Wave',
        charges: 2,
        paidFrom: { blue: 30, yellow: 70 },
        usesBought: 'not recorded',
      },
    ]);
  });

  it('leaves out a top-up from the extra day read before the window', () => {
    const { topUps } = summarize([], [leg(`${topUp(44)}-User`, { inWindow: 0 })]);
    expect(topUps).toEqual([]);
  });

  it('does not treat a purchase charge as a top-up', () => {
    const { topUps } = summarize([purchase(itemCharge('k'))], [leg(`${itemCharge('k')}-User`)]);
    expect(topUps).toEqual([]);
  });
});
