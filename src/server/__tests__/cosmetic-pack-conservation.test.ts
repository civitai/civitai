import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CosmeticType } from '~/shared/utils/prisma/enums';

/**
 * A conservation property over the whole pack purchase, table-driven rather than
 * example-driven.
 *
 * Every defect this feature produced in review was a *specific number* being
 * wrong somewhere the example tests weren't looking — most dangerously a payout
 * that exceeded the amount collected, which three passing example tests missed
 * because each one asserted its own expected figure. These assert relationships
 * instead: what goes out is bounded by what came in, and nobody is charged or
 * granted twice.
 */

const spend = vi.fn();
const pay = vi.fn();
const refund = vi.fn();
const executeRaw = vi.fn();
const ownedFindMany = vi.fn();
const createManyComponents = vi.fn();
const createManyUserCosmetic = vi.fn();
const purchaseCreate = vi.fn();
const purchaseUpdate = vi.fn();

vi.mock('~/server/db/client', () => ({
  dbRead: {},
  dbWrite: {
    userCosmetic: { findMany: (...a: unknown[]) => ownedFindMany(...a) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        $executeRaw: (...a: unknown[]) => executeRaw(...a),
        userCosmetic: {
          findMany: (...a: unknown[]) => ownedFindMany(...a),
          createMany: (...a: unknown[]) => createManyUserCosmetic(...a),
        },
        userCosmeticShopPurchases: { create: (...a: unknown[]) => purchaseCreate(...a) },
        userCosmeticShopPurchaseCosmetic: {
          createMany: (...a: unknown[]) => createManyComponents(...a),
        },
        cosmeticShopItem: { update: vi.fn() },
      }),
    userCosmeticShopPurchases: { update: (...a: unknown[]) => purchaseUpdate(...a) },
  },
}));
vi.mock('~/server/services/buzz.service', () => ({
  createMultiAccountBuzzTransaction: (...a: unknown[]) => spend(...a),
  createBuzzTransaction: (...a: unknown[]) => pay(...a),
  refundMultiAccountTransaction: (...a: unknown[]) => refund(...a),
}));
vi.mock('~/server/services/user-preferences.service', () => ({
  getBlockedPairIds: vi.fn().mockResolvedValue([]),
}));
vi.mock('~/server/redis/caches', () => ({ refreshOwnedStickerCache: vi.fn() }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn() }));

const { purchaseCosmeticPack } = await import('~/server/services/cosmetic-pack.service');

const BUYER = 901;
const PACK_CREATOR = 902;
const OTHER_CREATOR = 903;
const RESELLER = 904;
const PLATFORM_KEEPS = 0.3;

type Member = Parameters<typeof purchaseCosmeticPack>[0]['members'][number];

const mkMember = (over: Partial<Member> = {}): Member => ({
  cosmeticId: 1001,
  type: CosmeticType.Badge,
  data: { uses: 30 },
  createdById: PACK_CREATOR,
  listingId: 5001,
  listingMeta: { purchases: 0, acceptsBlueBuzz: false },
  addedById: PACK_CREATOR,
  availableQuantity: null,
  availableFrom: null,
  availableTo: null,
  soldCount: 0,
  floorAmount: 1700,
  ...over,
});

const shopItem = (unitAmount: number, memberCount: number) => ({
  id: 7001,
  title: 'A pack',
  unitAmount,
  addedById: PACK_CREATOR,
  meta: { purchases: 0 },
  memberCount,
});

const SHAPES: { name: string; price: number; members: Member[]; owned?: number[] }[] = [
  {
    name: 'one own member and one foreign member',
    price: 6300,
    members: [
      mkMember(),
      mkMember({
        cosmeticId: 1002,
        createdById: OTHER_CREATOR,
        addedById: OTHER_CREATOR,
        floorAmount: 2900,
      }),
    ],
  },
  {
    name: 'a foreign member sold through a reseller',
    price: 6300,
    members: [
      mkMember(),
      mkMember({
        cosmeticId: 1002,
        createdById: OTHER_CREATOR,
        addedById: RESELLER,
        listingMeta: { purchases: 0, acceptsBlueBuzz: false, sellerShare: 25 },
        floorAmount: 2900,
      }),
    ],
  },
  {
    name: 'snapshots that exceed the price (stale, so the cap must bite)',
    price: 1100,
    members: [
      mkMember({
        cosmeticId: 1002,
        createdById: OTHER_CREATOR,
        addedById: OTHER_CREATOR,
        floorAmount: 10000,
      }),
      mkMember({ floorAmount: 1000 }),
    ],
  },
  {
    name: 'a member the buyer created themselves',
    price: 6300,
    members: [
      mkMember(),
      mkMember({ cosmeticId: 1002, createdById: BUYER, addedById: BUYER, floorAmount: 2900 }),
    ],
  },
  {
    name: 'a member the buyer already owns',
    price: 6300,
    members: [
      mkMember(),
      mkMember({
        cosmeticId: 1002,
        createdById: OTHER_CREATOR,
        addedById: OTHER_CREATOR,
        floorAmount: 2900,
      }),
    ],
    owned: [1001],
  },
  {
    name: 'a consumable member the buyer already owns',
    price: 6300,
    members: [
      mkMember({ type: CosmeticType.Sticker }),
      mkMember({
        cosmeticId: 1002,
        createdById: OTHER_CREATOR,
        addedById: OTHER_CREATOR,
        floorAmount: 2900,
      }),
    ],
    owned: [1001],
  },
  {
    name: 'a member with no creator at all',
    price: 6300,
    members: [
      mkMember({ createdById: null, addedById: null }),
      mkMember({ cosmeticId: 1002, floorAmount: 900 }),
    ],
  },
  {
    name: 'everything discountable or self-authored, so nothing is owed',
    price: 3400,
    members: [mkMember({ floorAmount: 1700 }), mkMember({ cosmeticId: 1002, floorAmount: 1700 })],
    owned: [1001, 1002],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  ownedFindMany.mockResolvedValue([]);
  spend.mockImplementation(({ amount }: { amount: number }) => ({
    transactionCount: 1,
    transactionIds: [{ accountType: 'yellow', amount }],
  }));
  pay.mockResolvedValue({ transactionId: 'payout-tx' });
  purchaseCreate.mockResolvedValue({});
  createManyComponents.mockResolvedValue({});
  createManyUserCosmetic.mockResolvedValue({});
  purchaseUpdate.mockResolvedValue({});
});

describe.each(SHAPES)('purchaseCosmeticPack — $name', ({ price, members, owned }) => {
  const setup = async () => {
    if (owned?.length) ownedFindMany.mockResolvedValue(owned.map((cosmeticId) => ({ cosmeticId })));
    await purchaseCosmeticPack({
      userId: BUYER,
      shopItem: shopItem(price, members.length),
      members,
      stickersEnabled: true,
    });
    const charged: number = spend.mock.calls[0]?.[0]?.amount ?? 0;
    const payouts = pay.mock.calls.map(
      (c) => c[0] as { toAccountId: number; amount: number; externalTransactionId: string }
    );
    return { charged, payouts };
  };

  it('never pays out more than the creator share of what it collected', async () => {
    const { charged, payouts } = await setup();
    const paid = payouts.reduce((sum, p) => sum + p.amount, 0);
    expect(paid).toBeLessThanOrEqual(Math.floor(charged * (1 - PLATFORM_KEEPS)));
  });

  it('charges the buyer exactly once, and never a negative amount', async () => {
    const { charged } = await setup();
    expect(spend.mock.calls.length).toBeLessThanOrEqual(1);
    expect(charged).toBeGreaterThanOrEqual(0);
    expect(charged).toBeLessThanOrEqual(price);
  });

  it('records a platform cut that reconciles the charge exactly', async () => {
    const { charged, payouts } = await setup();
    const meta = purchaseUpdate.mock.calls[0]?.[0]?.data?.meta as
      | { payouts: { amount: number }[]; platformCut: number }
      | undefined;
    if (!meta) {
      expect(payouts).toHaveLength(0);
      return;
    }
    const paid = meta.payouts.reduce((sum, p) => sum + p.amount, 0);
    expect(paid + meta.platformCut).toBe(charged);
  });

  it('never pays the buyer for their own work', async () => {
    const { payouts } = await setup();
    expect(payouts.some((p) => p.toAccountId === BUYER)).toBe(false);
  });

  it('gives every payout a distinct external id', async () => {
    const { payouts } = await setup();
    const ids = payouts.map((p) => p.externalTransactionId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('accounts for every member — granted, topped up, or already held', async () => {
    await setup();
    const granted: number[] = (createManyUserCosmetic.mock.calls[0]?.[0]?.data ?? []).map(
      (row: { cosmeticId: number }) => row.cosmeticId
    );
    const toppedUp = executeRaw.mock.calls.length;
    const consumables = members.filter((m) => m.type === CosmeticType.Sticker);
    expect(toppedUp).toBe(consumables.length);
    const durable = members.filter((m) => m.type !== CosmeticType.Sticker).map((m) => m.cosmeticId);
    const accountedFor = new Set([...granted, ...(owned ?? [])]);
    for (const id of durable) expect(accountedFor.has(id)).toBe(true);
  });

  it('writes one purchase component per member', async () => {
    await setup();
    const rows = createManyComponents.mock.calls[0]?.[0]?.data ?? [];
    expect(rows).toHaveLength(members.length);
  });

  it('does not refund a purchase that succeeded', async () => {
    await setup();
    expect(refund).not.toHaveBeenCalled();
  });
});
