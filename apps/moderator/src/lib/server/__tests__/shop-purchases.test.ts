import { describe, expect, it, vi } from 'vitest';
import type { LegRow, PurchaseRow } from '$lib/server/shop-purchases.service';

const chQueries: {
  query: string;
  query_params: Record<string, unknown>;
  clickhouse_settings: Record<string, number>;
}[] = [];
vi.mock('$lib/server/db', () => {
  const chain: Record<string, unknown> = {
    selectFrom: () => chain,
    selectAll: () => chain,
    where: () => chain,
    execute: async () => [],
  };
  return { dbRead: chain };
});
vi.mock('$lib/server/clickhouse', () => ({
  getClickhouse: () => ({
    query: async (q: (typeof chQueries)[number]) => {
      chQueries.push(q);
      return { json: async () => [] };
    },
  }),
}));
vi.mock('$lib/server/users.service', () => ({
  isInt4Id: (n: number) => Number.isInteger(n) && n > 0 && n <= 2147483647,
  usersByIds: async () => new Map(),
}));

const { getShopPurchaseSummary, summarizeShopPurchases } = await import(
  '$lib/server/shop-purchases.service'
);
const { MAX_BUZZ_DAYS } = await import('$lib/server/buzz-flows.service');

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

  it('matches a charge whose leg landed in the extra day read before the window', () => {
    const { items } = summarize(
      [purchase(itemCharge('k'))],
      [leg(`${itemCharge('k')}-User`, { inWindow: 0 })]
    );
    expect(items[0].paidFrom).toEqual({ yellow: 100 });
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
        leg(`${charge}:sell:9:yellow`, { type: 'sell', toAccountId: '9', amount: '70' }),
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

describe('shop_purchases legs that are not the buyer paying', () => {
  const charge = itemCharge('k');
  const paidFromWith = (over: Partial<LegRow>) =>
    summarize([purchase(charge)], [leg(`${charge}-User`, over)]).items[0].paidFrom;

  it('counts the plain debit, so the cases below each turn on their one difference', () => {
    expect(paidFromWith({})).toEqual({ yellow: 100 });
  });

  it('ignores a leg paid to someone other than the platform', () => {
    expect(paidFromWith({ toAccountId: '9' })).toEqual({});
  });

  it('ignores a leg paid by an account that was not asked about', () => {
    expect(paidFromWith({ fromAccountId: '9' })).toEqual({});
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
    expect(account.ledgerCapped).toBe(true);
    expect(account.truncated).toBe(true);
  });

  it('does not call an account capped just under the limit', () => {
    const fill = Array.from({ length: 4999 }, (_, i) => leg(`${itemCharge(`x${i}`)}-User`));
    const account = summarize([purchase(itemCharge('k'))], fill);
    expect(account.ledgerCapped).toBe(false);
    expect(account.items[0].noChargeFound).toBe(1);
  });
});

describe('shop_purchases ledger read', () => {
  it('always bounds the read by a window and a time limit, with the values bound', async () => {
    chQueries.length = 0;
    await getShopPurchaseSummary([BUYER], 100_000);
    expect(chQueries).toHaveLength(1);
    const [q] = chQueries;
    expect(q.query).toContain('date >= now() - toIntervalDay({readDays:UInt32})');
    expect(q.query_params).toMatchObject({
      ids: [BUYER],
      days: MAX_BUZZ_DAYS,
      readDays: MAX_BUZZ_DAYS + 1,
      limit: 5000,
    });
    expect(q.query).toContain('LIMIT {limit:UInt32} BY fromAccountId');
    // The client's own request timeout is 300s.
    expect(q.clickhouse_settings.max_execution_time).toBeLessThan(300);
  });

  it('reads nothing when no id is valid', async () => {
    chQueries.length = 0;
    const result = await getShopPurchaseSummary([0, -1]);
    expect(chQueries).toHaveLength(0);
    expect(result.accounts).toEqual([]);
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

  it('carries paid-from, refunds, dates and misses into other', () => {
    const top = Array.from({ length: 25 }, (_, i) =>
      purchase(itemCharge(`k${i}`), { shopItemId: i + 100, unitAmount: 1000 })
    );
    // The rollup starts from its largest item, so the earliest and latest dates sit on the others.
    const tail = [
      purchase(itemCharge('a'), {
        shopItemId: 1,
        unitAmount: 10,
        purchasedAt: new Date('2026-11-01T00:00:00Z'),
      }),
      purchase(itemCharge('b'), {
        shopItemId: 2,
        unitAmount: 30,
        purchasedAt: new Date('2026-11-02T00:00:00Z'),
      }),
      purchase(itemCharge('c'), {
        shopItemId: 3,
        unitAmount: 20,
        refunded: true,
        purchasedAt: new Date('2026-11-03T00:00:00Z'),
      }),
    ];
    const legs = [
      leg(`${itemCharge('a')}-User`, { fromAccountType: 'blue', amount: '10' }),
      leg(`${itemCharge('b')}-User`, { fromAccountType: 'yellow', amount: '30' }),
    ];
    const { other } = summarize([...top, ...tail], legs);
    expect(other).toEqual({
      items: 3,
      count: 3,
      buzz: 60,
      refunded: 1,
      firstAt: new Date('2026-11-01T00:00:00Z'),
      lastAt: new Date('2026-11-03T00:00:00Z'),
      paidFrom: { blue: 10, yellow: 30 },
      noChargeFound: 1,
    });
  });

  it('says nothing about misses in other when the ledger read was cut short', () => {
    const rows = Array.from({ length: 27 }, (_, i) =>
      purchase(itemCharge(`k${i}`), { shopItemId: i + 1 })
    );
    const fill = Array.from({ length: 5000 }, (_, i) => leg(`${itemCharge(`x${i}`)}-User`));
    expect(summarize(rows, fill).other?.noChargeFound).toBeNull();
  });

  it('marks an account truncated when its purchase rows hit the cap', () => {
    const rows = (n: number) =>
      Array.from({ length: n }, (_, i) => purchase(itemCharge(`k${i}`), { unitAmount: 0 }));
    expect(summarize(rows(1000), []).truncated).toBe(true);
    expect(summarize(rows(999), []).truncated).toBe(false);
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

  it('keeps each account to its own top-ups', () => {
    const { accounts } = summarizeShopPurchases(
      [BUYER, OTHER_BUYER],
      [],
      [
        leg(`${topUp(44)}-User`),
        leg(`${topUp(55, UUID, OTHER_BUYER)}-User`, { fromAccountId: String(OTHER_BUYER) }),
      ],
      new Map(),
      30
    );
    expect(accounts[0].topUps.map((t) => t.cosmeticId)).toEqual([44]);
    expect(accounts[1].topUps.map((t) => t.cosmeticId)).toEqual([55]);
  });

  it('leaves the seller leg out of a top-up beside its charge', () => {
    const { topUps } = summarize(
      [],
      [
        leg(`${topUp(44)}-User`, { amount: '100', description: 'Sticker uses - Wave' }),
        leg(`${topUp(44)}:sell:9:yellow`, { type: 'sell', toAccountId: '9', amount: '70' }),
      ]
    );
    expect(topUps).toHaveLength(1);
    expect(topUps[0]).toMatchObject({ charges: 1, paidFrom: { yellow: 100 } });
  });

  it('does not treat a purchase charge as a top-up', () => {
    const { topUps } = summarize([purchase(itemCharge('k'))], [leg(`${itemCharge('k')}-User`)]);
    expect(topUps).toEqual([]);
  });
});
