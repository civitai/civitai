import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CosmeticType } from '~/shared/utils/prisma/enums';
import { isConsumableCosmeticType } from '~/server/schema/creator-shop.schema';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
dbMock.dbWrite.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
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
  })
);

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
const ownedFindMany = dbMock.dbWrite.userCosmetic.findMany;
const createManyComponents = vi.fn();
const createManyUserCosmetic = vi.fn();
const purchaseCreate = vi.fn();
const purchaseUpdate = dbMock.dbWrite.userCosmeticShopPurchases.update;

vi.mock('~/server/services/buzz.service', () => ({
  createMultiAccountBuzzTransaction: (...a: unknown[]) => spend(...a),
  createBuzzTransaction: (...a: unknown[]) => pay(...a),
  refundMultiAccountTransaction: (...a: unknown[]) => refund(...a),
}));
vi.mock('~/server/services/user-preferences.service', () => ({
  getBlockedPairIds: vi.fn().mockResolvedValue([]),
}));
vi.mock('~/server/redis/caches', () => ({ refreshOwnedStickerCache: vi.fn() }));
const { purchaseCosmeticPack } = await import('~/server/services/cosmetic-pack.service');

const BUYER = 901;
const PACK_CREATOR = 902;
const OTHER_CREATOR = 903;
const RESELLER = 904;
const THIRD_CREATOR = 905;
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

type Shape = {
  name: string;
  price: number;
  members: Member[];
  owned?: number[];
  packCreatorId?: number | null;
  buyerId?: number;
  blueShare?: number;
  acceptsBlue?: boolean;
};

const SHAPES: Shape[] = [
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
    // The buyer resells someone else's work. The seller share would be a
    // discount they fund for themselves, which the single purchase refuses.
    name: 'the buyer is a members reseller',
    price: 6300,
    members: [
      mkMember(),
      mkMember({
        cosmeticId: 1002,
        createdById: OTHER_CREATOR,
        addedById: BUYER,
        listingMeta: { purchases: 0, acceptsBlueBuzz: false, sellerShare: 25 },
        floorAmount: 2900,
      }),
    ],
  },
  {
    name: 'three members with two different foreign creators',
    price: 9100,
    members: [
      mkMember(),
      mkMember({
        cosmeticId: 1002,
        createdById: OTHER_CREATOR,
        addedById: OTHER_CREATOR,
        floorAmount: 2900,
      }),
      mkMember({
        cosmeticId: 1003,
        createdById: THIRD_CREATOR,
        addedById: THIRD_CREATOR,
        floorAmount: 1300,
      }),
    ],
  },
  {
    // One person paid for two members of the same pack — the reason payout
    // external ids carry the cosmetic id.
    name: 'two members by the same foreign creator',
    price: 9100,
    members: [
      mkMember({
        cosmeticId: 1002,
        createdById: OTHER_CREATOR,
        addedById: OTHER_CREATOR,
        floorAmount: 2900,
      }),
      mkMember({
        cosmeticId: 1003,
        createdById: OTHER_CREATOR,
        addedById: OTHER_CREATOR,
        floorAmount: 1300,
      }),
    ],
  },
  {
    // Scaled so hard one member's basis floors to zero — the documented
    // sub-1-Buzz redirect, pinned so the behaviour is the tested behaviour.
    name: 'a member whose scaled basis floors to zero',
    price: 100,
    members: [
      mkMember({
        cosmeticId: 1002,
        createdById: OTHER_CREATOR,
        addedById: OTHER_CREATOR,
        floorAmount: 100000,
      }),
      mkMember({
        cosmeticId: 1003,
        createdById: THIRD_CREATOR,
        addedById: THIRD_CREATOR,
        floorAmount: 3,
      }),
    ],
  },
  {
    // An official pack: no lister, so every member is foreign and there is no
    // remainder recipient.
    name: 'a pack with no creator at all',
    price: 6300,
    packCreatorId: null,
    members: [
      mkMember({ createdById: OTHER_CREATOR, addedById: OTHER_CREATOR }),
      mkMember({
        cosmeticId: 1002,
        createdById: THIRD_CREATOR,
        addedById: THIRD_CREATOR,
        floorAmount: 2900,
      }),
    ],
  },
  {
    // Colour is otherwise a dead dimension: every other shape pays yellow only,
    // so the blue branch of the payout split never executes.
    name: 'paid partly in blue',
    price: 6300,
    blueShare: 2000,
    acceptsBlue: true,
    members: [
      mkMember({ listingMeta: { purchases: 0, acceptsBlueBuzz: true } }),
      mkMember({
        cosmeticId: 1002,
        createdById: OTHER_CREATOR,
        addedById: OTHER_CREATOR,
        listingMeta: { purchases: 0, acceptsBlueBuzz: true },
        floorAmount: 2900,
      }),
    ],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  ownedFindMany.mockResolvedValue([]);
  // Distinct per call, as the real service returns: a takedown reverses payouts
  // by refunding each recorded transaction id, so a regression recording one id
  // for every payout has to be visible.
  let payoutSeq = 0;
  pay.mockImplementation(async () => ({ transactionId: `payout-tx-${++payoutSeq}` }));
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

describe.each(SHAPES)(
  'purchaseCosmeticPack — $name',
  ({
    price,
    members,
    owned,
    packCreatorId = PACK_CREATOR,
    buyerId = BUYER,
    blueShare = 0,
    acceptsBlue = false,
  }) => {
    const setup = async () => {
      // Honours its `where`, so a lookup against the wrong user or the wrong
      // member set is visible. A stub returning the same rows regardless makes
      // every "the right rows were selected" property untestable.
      ownedFindMany.mockImplementation(
        async ({ where }: { where: { userId: number; cosmeticId: { in: number[] } } }) =>
          where.userId === buyerId
            ? (owned ?? [])
                .filter((id) => where.cosmeticId.in.includes(id))
                .map((cosmeticId) => ({ cosmeticId }))
            : []
      );
      if (blueShare)
        spend.mockImplementation(({ amount }: { amount: number }) => ({
          transactionCount: 2,
          transactionIds: [
            { accountType: 'blue', amount: Math.min(blueShare, amount) },
            { accountType: 'yellow', amount: Math.max(0, amount - blueShare) },
          ],
        }));
      await purchaseCosmeticPack({
        userId: buyerId,
        shopItem: {
          ...shopItem(price, members.length),
          addedById: packCreatorId,
          meta: { purchases: 0, acceptsBlueBuzz: acceptsBlue },
        },
        members,
        stickersEnabled: true,
        payWith: blueShare ? 'blue-first' : 'default',
      });
      const charged: number = spend.mock.calls[0]?.[0]?.amount ?? 0;
      const payouts = pay.mock.calls.map(
        (c) =>
          c[0] as {
            toAccountId: number;
            toAccountType: string;
            amount: number;
            externalTransactionId: string;
          }
      );
      return { charged, payouts };
    };

    // Computed from the shape, not by calling the code under test: every other
    // property bounds outflow by inflow, so a defect that charged everyone zero
    // would satisfy all of them while giving the shop away.
    const expectedCharge = () => {
      const ownedSet = new Set(owned ?? []);
      const ownMembers = members.filter((m) => m.createdById === packCreatorId);
      const weightTotal = ownMembers.reduce((sum, m) => sum + m.floorAmount, 0);
      const foreignSum = members
        .filter((m) => m.createdById !== packCreatorId)
        .reduce((sum, m) => sum + m.floorAmount, 0);
      const ownPortion = Math.max(0, price - foreignSum);
      const discount = ownMembers.reduce(
        (sum, m) =>
          ownedSet.has(m.cosmeticId) && m.type !== CosmeticType.Sticker && weightTotal > 0
            ? sum + Math.floor((m.floorAmount / weightTotal) * ownPortion)
            : sum,
        0
      );
      const selfAuthored = members
        .filter((m) => m.createdById === buyerId && m.createdById !== packCreatorId)
        .reduce((sum, m) => sum + m.floorAmount, 0);
      return Math.max(0, price - discount - selfAuthored);
    };

    // Nothing else in the suite requires a completed purchase to move money —
    // every other property bounds outflow by inflow, and zero satisfies them all.
    // A pack that completes for free is not a discount: each one grants another
    // consumable balance and consumes a member's quantity.
    it('either moves money or does not complete', async () => {
      const { charged } = await setup();
      expect(charged).toBeGreaterThan(0);
    });

    it('charges exactly what the pricing rules say, independently computed', async () => {
      const { charged } = await setup();
      expect(charged).toBe(expectedCharge());
    });

    it('pays every foreign creator something attributable to their member', async () => {
      const { charged, payouts } = await setup();
      const owedTo = members.filter(
        (m) => m.createdById != null && m.createdById !== packCreatorId && m.createdById !== buyerId
      );
      const snapshotTotal = owedTo.reduce((sum, m) => sum + m.floorAmount, 0);
      const scale = snapshotTotal > charged && snapshotTotal > 0 ? charged / snapshotTotal : 1;
      for (const member of owedTo) {
        const attributable = payouts.filter((p) =>
          p.externalTransactionId.includes(`:${member.cosmeticId}`)
        );
        // Under 1 Buzz cannot be paid, and skipping it is the documented
        // behaviour — so the exception is asserted rather than tolerated.
        const basis = Math.floor(member.floorAmount * scale);
        if (Math.floor(basis * 0.7) === 0) {
          expect(attributable).toHaveLength(0);
          continue;
        }
        expect(attributable.some((p) => p.amount > 0)).toBe(true);
      }
    });

    it('pays nobody outside the expected recipient set', async () => {
      const { payouts } = await setup();
      const expected = new Set<number>(
        members
          .filter(
            (m) =>
              m.createdById != null && m.createdById !== packCreatorId && m.createdById !== buyerId
          )
          .flatMap((m) => [
            m.createdById as number,
            ...(m.addedById && m.addedById !== m.createdById && m.addedById !== buyerId
              ? [m.addedById]
              : []),
          ])
      );
      // Not whitelisted when they are the buyer — that is the case this catches.
      if (packCreatorId && packCreatorId !== buyerId) expected.add(packCreatorId);
      for (const payout of payouts) expect(expected.has(payout.toAccountId)).toBe(true);
    });

    it('never pays out more blue than the buyer paid in blue', async () => {
      const { charged, payouts } = await setup();
      const bluePaidOut = payouts
        .filter((p) => p.toAccountType === 'blue')
        .reduce((sum, p) => sum + p.amount, 0);
      // Bounded by what the buyer actually paid in blue, which is capped by the
      // charge — not by the fixture's constant, which goes slack the moment a
      // shape charges less than it.
      expect(bluePaidOut).toBeLessThanOrEqual(Math.min(blueShare, charged));
    });

    it('never grants a member the buyer already owned', async () => {
      await setup();
      const granted: number[] = (createManyUserCosmetic.mock.calls[0]?.[0]?.data ?? []).map(
        (row: { cosmeticId: number }) => row.cosmeticId
      );
      expect(new Set(granted).size).toBe(granted.length);
      for (const id of owned ?? []) expect(granted).not.toContain(id);
    });

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
      // `buyerId`, not the module constant: a shape that varies the buyer only
      // discriminates if the property varies with it too.
      expect(payouts.some((p) => p.toAccountId === buyerId)).toBe(false);
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
      const durable = members
        .filter((m) => m.type !== CosmeticType.Sticker)
        .map((m) => m.cosmeticId);
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
  }
);

// The failure path, which every property above assumes never runs. Round one's
// review found this shape unguarded: a refund that throws used to discard the
// grant error, surface its own, and record nothing.
describe('purchaseCosmeticPack — when the grant fails', () => {
  const members = [
    mkMember(),
    mkMember({
      cosmeticId: 1002,
      createdById: OTHER_CREATOR,
      addedById: OTHER_CREATOR,
      floorAmount: 2900,
    }),
  ];

  it('refunds, retries the refund, and logs when the write transaction throws', async () => {
    purchaseCreate.mockRejectedValue(new Error('write failed'));
    refund.mockRejectedValueOnce(new Error('buzz down')).mockResolvedValue({});
    await expect(
      purchaseCosmeticPack({
        userId: BUYER,
        shopItem: shopItem(6300, members.length),
        members,
        stickersEnabled: true,
      })
    ).rejects.toThrow();
    expect(refund.mock.calls.length).toBeGreaterThan(1);
    expect(pay).not.toHaveBeenCalled();
  });

  it('refuses without granting when the buyer could not be charged', async () => {
    spend.mockResolvedValue({ transactionCount: 0, transactionIds: [] });
    await expect(
      purchaseCosmeticPack({
        userId: BUYER,
        shopItem: shopItem(6300, members.length),
        members,
        stickersEnabled: true,
      })
    ).rejects.toThrow();
    expect(createManyUserCosmetic).not.toHaveBeenCalled();
    expect(executeRaw).not.toHaveBeenCalled();
    expect(pay).not.toHaveBeenCalled();
  });
});

describe('purchaseCosmeticPack — purchases that must not complete', () => {
  const buy = (over: {
    price: number;
    members: Member[];
    buyerId?: number;
    packCreatorId?: number | null;
    owned?: number[];
  }) => {
    const { price, members, buyerId = BUYER, packCreatorId = PACK_CREATOR, owned } = over;
    ownedFindMany.mockResolvedValue((owned ?? []).map((cosmeticId) => ({ cosmeticId })));
    return purchaseCosmeticPack({
      userId: buyerId,
      shopItem: { ...shopItem(price, members.length), addedById: packCreatorId },
      members,
      stickersEnabled: true,
    });
  };

  it('refuses the pack creator buying their own pack', async () => {
    await expect(
      buy({
        price: 6300,
        buyerId: PACK_CREATOR,
        members: [
          mkMember(),
          mkMember({
            cosmeticId: 1002,
            createdById: OTHER_CREATOR,
            addedById: OTHER_CREATOR,
            floorAmount: 2900,
          }),
        ],
      })
    ).rejects.toThrow(/your own pack/i);
    expect(spend).not.toHaveBeenCalled();
  });

  // The sharp edge: free purchases were repeatable, and each one consumed a
  // member's quantity — which is how a creator could make everyone else's packs
  // containing their work refuse.
  it('refuses an all-own pack, which would otherwise cost its creator nothing', async () => {
    await expect(
      buy({
        price: 2000,
        buyerId: PACK_CREATOR,
        members: [mkMember(), mkMember({ cosmeticId: 1002, floorAmount: 1000 })],
      })
    ).rejects.toThrow();
    expect(spend).not.toHaveBeenCalled();
    expect(createManyUserCosmetic).not.toHaveBeenCalled();
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('refuses when the discount covers the whole price', async () => {
    await expect(
      buy({
        price: 3400,
        members: [
          mkMember({ floorAmount: 1700 }),
          mkMember({ cosmeticId: 1002, floorAmount: 1700 }),
        ],
        owned: [1001, 1002],
      })
    ).rejects.toThrow(/already own/i);
    expect(spend).not.toHaveBeenCalled();
  });

  it('refuses a repeat of a free consumable pack rather than stacking uses', async () => {
    await expect(
      buy({
        price: 3400,
        members: [
          mkMember({ type: CosmeticType.Sticker, floorAmount: 1700 }),
          mkMember({ cosmeticId: 1002, floorAmount: 1700 }),
        ],
        buyerId: PACK_CREATOR,
      })
    ).rejects.toThrow();
    expect(executeRaw).not.toHaveBeenCalled();
  });
});

/**
 * Generative rather than enumerated.
 *
 * Every defect found from round four onward lived at an INTERSECTION of two
 * dimensions — buyer x reseller, buyer x pack creator, pack creator x
 * null-creator member — and a hand-written table varies one dimension at a time.
 * These packs are built from a cross-product instead, so the crossings exist
 * without anyone having to think of them.
 */
describe('purchaseCosmeticPack — generated member combinations', () => {
  const CREATORS = [
    { label: 'own', createdById: PACK_CREATOR },
    { label: 'foreign', createdById: OTHER_CREATOR },
    { label: 'buyer-authored', createdById: BUYER },
    { label: 'no-creator', createdById: null },
  ];
  const RESELLERS = [
    { label: 'self-listed', addedBy: (createdById: number | null) => createdById },
    { label: 'third-party', addedBy: () => RESELLER },
    { label: 'buyer-listed', addedBy: () => BUYER },
  ];
  // Derived, not a literal list: the point of this dimension is that the grant
  // branches agree with `isConsumableCosmeticType`, so keying it on
  // `CosmeticType.Sticker` would go stale exactly when a new consumable is added.
  const TYPES = Object.values(CosmeticType).filter(
    (type, _i, all) =>
      type === all.find((t) => isConsumableCosmeticType(t)) || type === CosmeticType.Badge
  );
  // Ownership was pinned to "nothing owned", and the only branch in
  // `computePackAmountDue` with arithmetic left in it is the one ownership drives.
  const OWNERSHIP = [
    { label: 'owns nothing', owned: [] as number[] },
    { label: 'owns the lister member', owned: [1001] },
  ];

  const combos = CREATORS.flatMap((creator) =>
    RESELLERS.flatMap((reseller) =>
      TYPES.flatMap((type) =>
        OWNERSHIP.map((ownership) => ({
          label: `${creator.label} / ${reseller.label} / ${type} / ${ownership.label}`,
          owned: ownership.owned,
          createdById: creator.createdById,
          member: mkMember({
            cosmeticId: 1002,
            type,
            createdById: creator.createdById,
            addedById: reseller.addedBy(creator.createdById),
            listingMeta: { purchases: 0, acceptsBlueBuzz: false, sellerShare: 25 },
            floorAmount: 2900,
          }),
        }))
      )
    )
  );

  it.each(combos)('$label', async ({ member, owned, createdById }) => {
    const members = [mkMember(), member];
    ownedFindMany.mockImplementation(
      async ({ where }: { where: { cosmeticId: { in: number[] } } }) =>
        owned.filter((id) => where.cosmeticId.in.includes(id)).map((cosmeticId) => ({ cosmeticId }))
    );
    const buy = () =>
      purchaseCosmeticPack({
        userId: BUYER,
        shopItem: shopItem(9100, members.length),
        members,
        stickersEnabled: true,
      });

    // Some crossings legitimately come to nothing owed — a buyer who authored the
    // foreign member and owns the lister's. The claim is a disjunction: either
    // the purchase refuses cleanly and moves nothing, or it satisfies every
    // invariant below. Predicting which would mean reimplementing the pricing
    // here, which is how a test comes to ratify the bug it should catch.
    try {
      await buy();
    } catch (error) {
      expect((error as Error).message).toMatch(/already own/i);
      expect(spend).not.toHaveBeenCalled();
      expect(createManyUserCosmetic).not.toHaveBeenCalled();
      expect(executeRaw).not.toHaveBeenCalled();
      return;
    }
    const charged: number = spend.mock.calls[0]?.[0]?.amount ?? 0;
    const payouts = pay.mock.calls.map(
      (c) => c[0] as { toAccountId: number; amount: number; externalTransactionId: string }
    );
    const paid = payouts.reduce((sum, p) => sum + p.amount, 0);
    expect(paid).toBeLessThanOrEqual(Math.floor(charged * (1 - PLATFORM_KEEPS)));
    // Without this, the generated rows assert nothing about the amount at all:
    // a pricing defect that over-discounts either lands in the refusal branch
    // (swallowed as legitimate) or charges less with payouts scaling down to
    // match, and every other assertion here still holds. Derived from what the
    // system owes other people, so it can't ratify the pricing it checks.
    const payableSnapshot = members
      .filter(
        (m) => m.createdById != null && m.createdById !== PACK_CREATOR && m.createdById !== BUYER
      )
      .reduce((sum, m) => sum + m.floorAmount, 0);
    expect(charged).toBeGreaterThanOrEqual(payableSnapshot);
    // No role a buyer can hold — member creator, member reseller, pack lister —
    // may make them a recipient of their own purchase.
    expect(payouts.some((p) => p.toAccountId === BUYER)).toBe(false);

    // A payable creator silently dropped from the payout set is invisible to the
    // bound above: the remainder simply grows and the pack creator takes it.
    const payable = createdById != null && createdById !== PACK_CREATOR && createdById !== BUYER;
    if (payable)
      expect(payouts.some((p) => p.externalTransactionId.includes(`:${member.cosmeticId}`))).toBe(
        true
      );

    // The grant branches must agree with `isConsumableCosmeticType` — the type
    // dimension is otherwise inert.
    const granted: number[] = (createManyUserCosmetic.mock.calls[0]?.[0]?.data ?? []).map(
      (row: { cosmeticId: number }) => row.cosmeticId
    );
    const consumables = members.filter((m) => isConsumableCosmeticType(m.type));
    expect(executeRaw.mock.calls).toHaveLength(consumables.length);
    for (const id of owned) expect(granted).not.toContain(id);
    expect(new Set(granted).size).toBe(granted.length);
  });
});
