import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CosmeticType } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const getBlockedPairIds = vi.fn();
const executeRaw = vi.fn();
const findOwnedMany = vi.fn();
const createManyUserCosmetic = vi.fn();

vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: vi.fn(),
  createMultiAccountBuzzTransaction: vi.fn(),
  refundMultiAccountTransaction: vi.fn(),
}));
vi.mock('~/server/services/user-preferences.service', () => ({
  getBlockedPairIds: (...args: unknown[]) => getBlockedPairIds(...args),
}));
vi.mock('~/server/redis/caches', () => ({ refreshOwnedStickerCache: vi.fn() }));
const { assertPackPurchasable, computePackPayouts, grantPackMembers, packBlueBuzzVeto } =
  await import('~/server/services/cosmetic-pack.service');

// No two quantities here are equal unless a test is about them being equal. The
// buyer, the pack creator and each member's creator are distinct ids; prices are
// distinct and none sits on a floor, so an assertion can't pass by reading the
// wrong field and landing on the right number by luck.
const BUYER = 501;
const PACK_CREATOR = 502;
const FOREIGN_CREATOR = 503;
const RESELLER = 504;
const MODERATOR = 505;

const member = (
  over: Partial<Parameters<typeof computePackPayouts>[0]['members'][number]> = {}
) => ({
  cosmeticId: 61,
  type: CosmeticType.Badge,
  data: { uses: 40 },
  createdById: PACK_CREATOR,
  listingId: 900,
  listingMeta: { purchases: 0, acceptsBlueBuzz: true },
  addedById: PACK_CREATOR,
  availableQuantity: null,
  availableFrom: null,
  availableTo: null,
  soldCount: 0,
  floorAmount: 1300,
  ...over,
});

const PAST = new Date('2020-01-01');
const FUTURE = new Date('2099-01-01');

const foreign = (over = {}) =>
  member({
    cosmeticId: 62,
    createdById: FOREIGN_CREATOR,
    addedById: FOREIGN_CREATOR,
    floorAmount: 2100,
    ...over,
  });

beforeEach(() => {
  vi.clearAllMocks();
  getBlockedPairIds.mockResolvedValue([]);
});

describe('assertPackPurchasable', () => {
  const call = (
    members: ReturnType<typeof member>[],
    over: { memberCount?: number; stickersEnabled?: boolean } = {}
  ) =>
    assertPackPurchasable({
      userId: BUYER,
      members,
      memberCount: over.memberCount ?? members.length,
      stickersEnabled: over.stickersEnabled ?? true,
    });

  it('passes a pack whose members are all sellable', async () => {
    await expect(call([member(), foreign()])).resolves.toBeUndefined();
  });

  // Event items (team hats) are checked per buyer at the single purchase: event
  // window, team colour, paid Buzz. A pack grants members past all of that.
  it('refuses a pack containing an event-gated member', async () => {
    const hat = foreign({
      type: CosmeticType.ContentDecoration,
      data: { type: 'hat', event: 'any-event', team: 'any-team' },
    });
    await expect(call([member(), hat])).rejects.toThrow(/This pack is not available/);
  });

  it('refuses when a member resolved to no published listing', async () => {
    // getPackMembers drops those, so the count is how the caller finds out.
    await expect(call([member()], { memberCount: 2 })).rejects.toThrow(/no longer available/i);
  });

  it('refuses a member that is sold out on its own listing', async () => {
    await expect(call([member(), foreign({ availableQuantity: 7, soldCount: 7 })])).rejects.toThrow(
      /sold out/i
    );
  });

  it('allows a member with stock left', async () => {
    await expect(
      call([member(), foreign({ availableQuantity: 7, soldCount: 6 })])
    ).resolves.toBeUndefined();
  });

  it('refuses when the buyer has blocked any member creator, not just the first', async () => {
    getBlockedPairIds.mockResolvedValue([FOREIGN_CREATOR]);
    await expect(call([member(), foreign()])).rejects.toThrow(/not available/i);
  });

  it('refuses a member whose availability window has not opened', async () => {
    await expect(call([member(), foreign({ availableFrom: FUTURE })])).rejects.toThrow(
      /not available yet/i
    );
  });

  it('refuses a member whose availability window has closed', async () => {
    await expect(call([member(), foreign({ availableTo: PAST })])).rejects.toThrow(
      /no longer available/i
    );
  });

  it('allows a member whose window is open on both sides', async () => {
    await expect(
      call([member(), foreign({ availableFrom: PAST, availableTo: FUTURE })])
    ).resolves.toBeUndefined();
  });

  it('refuses a pack containing a sticker while the flag is off', async () => {
    await expect(
      call([member(), foreign({ type: CosmeticType.Sticker })], { stickersEnabled: false })
    ).rejects.toThrow(/not available/i);
  });

  it('allows a sticker member when the flag is on', async () => {
    await expect(
      call([member(), foreign({ type: CosmeticType.Sticker })], { stickersEnabled: true })
    ).resolves.toBeUndefined();
  });
});

describe('packBlueBuzzVeto', () => {
  it('names every member that does not accept blue', () => {
    const veto = packBlueBuzzVeto([
      member(),
      foreign({ listingMeta: { purchases: 0, acceptsBlueBuzz: false } }),
    ]);
    expect(veto.map((m) => m.cosmeticId)).toEqual([62]);
  });

  it('is empty only when every member accepts', () => {
    expect(packBlueBuzzVeto([member(), foreign()])).toHaveLength(0);
  });
});

describe('computePackPayouts', () => {
  const PACK_PRICE = 6200;

  it('pays a foreign creator on the snapshot, not the pack price', () => {
    const { components } = computePackPayouts({
      packPrice: PACK_PRICE,
      packCreatorId: PACK_CREATOR,
      members: [member(), foreign()],
    });
    const paid = components.find((c) => c.userId === FOREIGN_CREATOR);
    expect(paid?.amount).toBe(Math.floor(2100 * 0.7));
  });

  it('pays the pack creator on the remainder, not on their own members list price', () => {
    const { packCreatorAmount, remainder } = computePackPayouts({
      packPrice: PACK_PRICE,
      packCreatorId: PACK_CREATOR,
      members: [member(), foreign()],
    });
    expect(remainder).toBe(PACK_PRICE - 2100);
    expect(packCreatorAmount).toBe(Math.floor(remainder * 0.7));
  });

  it('never pays out more than the platform share leaves — a pack cannot mint Buzz', () => {
    const { components, packCreatorAmount } = computePackPayouts({
      packPrice: PACK_PRICE,
      packCreatorId: PACK_CREATOR,
      members: [member(), foreign(), foreign({ cosmeticId: 63, floorAmount: 900 })],
    });
    const total = components.reduce((sum, c) => sum + c.amount, 0) + packCreatorAmount;
    expect(total).toBeLessThanOrEqual(Math.floor(PACK_PRICE * 0.7));
  });

  it('pays the pack creator a seller share out of a foreign member they resell', () => {
    const { components } = computePackPayouts({
      packPrice: PACK_PRICE,
      packCreatorId: PACK_CREATOR,
      members: [foreign()],
      // The pack creator resells cosmetic 62 at a snapshotted 20%.
      resaleShareByCosmeticId: new Map([[62, 20]]),
    });
    const seller = components.find((c) => c.userId === PACK_CREATOR);
    const creator = components.find((c) => c.userId === FOREIGN_CREATOR);
    expect(seller?.amount).toBe(Math.floor(2100 * 0.2));
    expect(creator?.amount).toBe(Math.floor(2100 * 0.7) - Math.floor(2100 * 0.2));
  });

  it('reads the seller share from the resale snapshot, not the members current listing', () => {
    const { components } = computePackPayouts({
      packPrice: PACK_PRICE,
      packCreatorId: PACK_CREATOR,
      // Current listing offers 50%; the pack creator listed it for resale at 20%.
      members: [foreign({ listingMeta: { purchases: 0, acceptsBlueBuzz: true, sellerShare: 50 } })],
      resaleShareByCosmeticId: new Map([[62, 20]]),
    });
    const seller = components.find((c) => c.userId === PACK_CREATOR);
    expect(seller?.amount).toBe(Math.floor(2100 * 0.2));
  });

  it('pays the foreign creator the whole pool when the pack creator does not resell it', () => {
    const { components } = computePackPayouts({
      packPrice: PACK_PRICE,
      packCreatorId: PACK_CREATOR,
      // A listing added by someone other than its creator is NOT a reseller —
      // resale is by reference, so only a resale row grants a share.
      members: [
        foreign({
          addedById: RESELLER,
          listingMeta: { purchases: 0, acceptsBlueBuzz: true, sellerShare: 20 },
        }),
      ],
    });
    expect(components.map((c) => c.userId)).toEqual([FOREIGN_CREATOR]);
    expect(components[0]?.amount).toBe(Math.floor(2100 * 0.7));
  });

  it('does not pay the pack creator twice for their own members', () => {
    const { components } = computePackPayouts({
      packPrice: PACK_PRICE,
      packCreatorId: PACK_CREATOR,
      members: [member(), member({ cosmeticId: 64, floorAmount: 800 })],
    });
    expect(components).toHaveLength(0);
  });

  it('does not pay the buyer for a member they created themselves', () => {
    const { components, foreignTotal } = computePackPayouts({
      packPrice: PACK_PRICE,
      packCreatorId: PACK_CREATOR,
      members: [member(), foreign()],
      buyerId: FOREIGN_CREATOR,
    });
    expect(components).toHaveLength(0);
    // Excluded from the covered total too, so the pack creator doesn't absorb
    // the cost of a member nobody was paid for.
    expect(foreignTotal).toBe(0);
  });

  it('still pays a foreign creator when someone else is buying', () => {
    const { components } = computePackPayouts({
      packPrice: PACK_PRICE,
      packCreatorId: PACK_CREATOR,
      members: [member(), foreign()],
      buyerId: BUYER,
    });
    expect(components.map((c) => c.userId)).toEqual([FOREIGN_CREATOR]);
  });

  // The floor is checked against LIVE list prices; payouts run off SNAPSHOTS.
  // A member re-priced down lets the pack be re-priced down with it while the
  // snapshot still says the old number — so the cap has to hold here, not be
  // inferred from the floor having passed at some point in the past.
  it('never pays out more than 70% of what was collected, even on a stale snapshot', () => {
    const { components, packCreatorAmount } = computePackPayouts({
      packPrice: 1100,
      packCreatorId: PACK_CREATOR,
      members: [foreign({ floorAmount: 10000 }), member({ floorAmount: 1000 })],
    });
    const total = components.reduce((sum, c) => sum + c.amount, 0) + packCreatorAmount;
    expect(total).toBeLessThanOrEqual(Math.floor(1100 * 0.7));
    // And specifically NOT the snapshot's 7000, which is what minted Buzz.
    expect(total).toBeLessThan(7000);
  });

  it('scales several stale members proportionally rather than paying the first in full', () => {
    const { components } = computePackPayouts({
      packPrice: 1000,
      packCreatorId: PACK_CREATOR,
      members: [
        foreign({ cosmeticId: 71, floorAmount: 6000 }),
        foreign({ cosmeticId: 72, createdById: RESELLER, addedById: RESELLER, floorAmount: 2000 }),
      ],
    });
    const [big, small] = [71, 72].map(
      (id) => components.find((c) => c.cosmeticId === id)?.amount ?? 0
    );
    expect(big).toBeGreaterThan(small);
    expect(components.reduce((sum, c) => sum + c.amount, 0)).toBeLessThanOrEqual(700);
  });

  it('leaves payouts untouched when the snapshots still fit inside the price', () => {
    const { components } = computePackPayouts({
      packPrice: 6200,
      packCreatorId: PACK_CREATOR,
      members: [foreign()],
    });
    expect(components[0]?.amount).toBe(Math.floor(2100 * 0.7));
  });

  it('floors the remainder at zero when a member re-priced above the pack', () => {
    const { remainder, packCreatorAmount } = computePackPayouts({
      packPrice: 1000,
      packCreatorId: PACK_CREATOR,
      members: [foreign({ floorAmount: 4000 })],
    });
    expect(remainder).toBe(0);
    expect(packCreatorAmount).toBe(0);
  });

  // What each member is recorded as having sold for. Gross-sales milestones sum
  // these rows, so the snapshot is the wrong number whenever the sale scaled.
  describe('attributed', () => {
    const sum = (m: Map<number, number>) => [...m.values()].reduce((a, b) => a + b, 0);

    it('spreads the remainder over the pack creator own members by snapshot weight', () => {
      const { attributed } = computePackPayouts({
        packPrice: PACK_PRICE,
        packCreatorId: PACK_CREATOR,
        members: [
          member(),
          member({ cosmeticId: 64, floorAmount: 800 }),
          foreign(),
          member({ cosmeticId: 81, createdById: null, addedById: RESELLER, floorAmount: 1700 }),
        ],
        buyerId: BUYER,
      });
      // Remainder 6200 - 2100 - 1700 = 2400, split 1300:800.
      expect([...attributed.entries()].sort(([a], [b]) => a - b)).toEqual([
        [61, Math.floor((1300 / 2100) * 2400)],
        [62, 2100],
        [64, Math.floor((800 / 2100) * 2400)],
        [81, 1700],
      ]);
    });

    it('records the scaled basis, zero included, rather than the snapshot', () => {
      const { attributed } = computePackPayouts({
        packPrice: 100,
        packCreatorId: PACK_CREATOR,
        members: [
          foreign({ floorAmount: 100000 }),
          foreign({ cosmeticId: 63, createdById: RESELLER, addedById: RESELLER, floorAmount: 3 }),
        ],
        buyerId: BUYER,
      });
      expect(attributed.get(62)).toBe(99);
      expect(attributed.get(63)).toBe(0);
    });

    it('caps rounded-up official shares at what the price has left', () => {
      // Scale 0.5: ceil(2.5) + ceil(7.5) = 11 on a price of 10.
      const { attributed, remainder } = computePackPayouts({
        packPrice: 10,
        packCreatorId: PACK_CREATOR,
        members: [
          member({ cosmeticId: 81, createdById: null, addedById: RESELLER, floorAmount: 5 }),
          member({ cosmeticId: 82, createdById: null, addedById: RESELLER, floorAmount: 15 }),
        ],
        buyerId: BUYER,
      });
      expect([attributed.get(81), attributed.get(82)]).toEqual([3, 7]);
      expect(remainder).toBe(0);
    });

    it('attributes a platform-listed pack official members their share of the price', () => {
      // No lister, so these are the lister's own: they take the remainder, which
      // is what keeps them from falling back to a zero row.
      const { attributed } = computePackPayouts({
        packPrice: 900,
        packCreatorId: null,
        members: [
          member({ cosmeticId: 81, createdById: null, addedById: null, floorAmount: 100 }),
          member({ cosmeticId: 82, createdById: null, addedById: null, floorAmount: 300 }),
        ],
        buyerId: BUYER,
      });
      expect([attributed.get(81), attributed.get(82)]).toEqual([225, 675]);
    });

    it('leaves out a member the buyer authored', () => {
      const { attributed } = computePackPayouts({
        packPrice: PACK_PRICE,
        packCreatorId: PACK_CREATOR,
        members: [member(), foreign()],
        buyerId: FOREIGN_CREATOR,
      });
      expect([...attributed.keys()]).toEqual([61]);
    });

    it('never sums past the price, or pays out past 70% of it, over many generated packs', () => {
      // Deterministic, so a failure reproduces and prints the pack that broke it.
      let seed = 7;
      const rand = (n: number) => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed % n;
      };
      const owners = [PACK_CREATOR, FOREIGN_CREATOR, RESELLER, BUYER, null];
      for (let i = 0; i < 500; i++) {
        const members = Array.from({ length: 1 + rand(5) }, (_, j) =>
          member({
            cosmeticId: 100 + j,
            createdById: owners[rand(owners.length)],
            floorAmount: 1 + rand(5000),
          })
        );
        const packPrice = 1 + rand(8000);
        const packCreatorId = rand(6) === 0 ? null : PACK_CREATOR;
        const { attributed, components, packCreatorAmount } = computePackPayouts({
          packPrice,
          packCreatorId,
          members,
          buyerId: BUYER,
          resaleShareByCosmeticId: rand(2) ? new Map([[100, 30]]) : undefined,
        });
        const label = JSON.stringify({
          packPrice,
          packCreatorId,
          members: members.map((m) => [m.createdById, m.floorAmount]),
        });
        expect(sum(attributed), label).toBeLessThanOrEqual(packPrice);
        for (const v of attributed.values()) expect(v, label).toBeGreaterThanOrEqual(0);
        const paid = components.reduce((s, c) => s + c.amount, 0) + packCreatorAmount;
        expect(paid, label).toBeLessThanOrEqual(Math.floor(packPrice * 0.7));
      }
    });
  });

  // Justin, 2026-10-07: "Official item sales should go to the bank." A platform
  // cosmetic has no creator to pay, and its value is NOT the pack creator's — if
  // you are about to fold official members back into the remainder, that is the
  // bug this block exists to stop.
  describe('official (platform) members', () => {
    const official = (over = {}) =>
      // A real official listing has a lister. With `addedById` null here too, a
      // rule keyed on the lister instead of the creator would pass every case.
      member({
        cosmeticId: 81,
        createdById: null,
        addedById: MODERATOR,
        floorAmount: 1700,
        ...over,
      });

    it('keeps an official member share with the bank instead of paying the pack creator', () => {
      const { components, officialTotal, remainder, packCreatorAmount } = computePackPayouts({
        packPrice: PACK_PRICE,
        packCreatorId: PACK_CREATOR,
        members: [member(), official()],
        buyerId: BUYER,
      });
      // 3150, where paying the pack creator on the whole price gave 4340.
      expect(packCreatorAmount).toBe(Math.floor((PACK_PRICE - 1700) * 0.7));
      expect(remainder).toBe(PACK_PRICE - 1700);
      expect(officialTotal).toBe(1700);
      expect(components).toEqual([]);
    });

    it('still pays a foreign creator in full and takes the official value out of the remainder only', () => {
      const { components, packCreatorAmount } = computePackPayouts({
        packPrice: PACK_PRICE,
        packCreatorId: PACK_CREATOR,
        members: [member(), foreign(), official()],
        buyerId: BUYER,
      });
      expect(components.map((c) => [c.userId, c.amount])).toEqual([
        [FOREIGN_CREATOR, Math.floor(2100 * 0.7)],
      ]);
      expect(packCreatorAmount).toBe(Math.floor((PACK_PRICE - 2100 - 1700) * 0.7));
    });

    it('pays the pack creator nothing when official members alone exceed the price', () => {
      const { components, remainder, packCreatorAmount, scaled } = computePackPayouts({
        packPrice: 1000,
        packCreatorId: PACK_CREATOR,
        members: [member({ floorAmount: 300 }), official({ floorAmount: 3000 })],
        buyerId: BUYER,
      });
      expect(packCreatorAmount).toBe(0);
      expect(remainder).toBe(0);
      expect(components).toEqual([]);
      expect(scaled).toBe(true);
    });

    it('scales foreign members against official ones and stays inside 70% of the price', () => {
      const { components, officialTotal, remainder, packCreatorAmount } = computePackPayouts({
        packPrice: 1000,
        packCreatorId: PACK_CREATOR,
        members: [foreign({ floorAmount: 1000 }), official({ floorAmount: 3001 })],
        buyerId: BUYER,
      });
      const total = components.reduce((sum, c) => sum + c.amount, 0) + packCreatorAmount;
      expect(packCreatorAmount).toBe(0);
      // 750.06 rounded UP: the scaling crumb is the bank's, never the pack creator's.
      expect(officialTotal).toBe(751);
      expect(remainder).toBe(0);
      // Scaled to 1000/4001 of its snapshot: basis 249, not the 1000 it would be
      // if the official member were left out of the scale.
      expect(components.map((c) => c.amount)).toEqual([Math.floor(249 * 0.7)]);
      expect(total).toBeLessThanOrEqual(700);
    });

    it('leaves a pack listed by the platform itself as it was', () => {
      // No pack creator: the official members are the lister's own, so they do
      // not compete with foreign members for the price.
      const { components } = computePackPayouts({
        packPrice: 3000,
        packCreatorId: null,
        members: [official({ floorAmount: 5000 }), foreign()],
        buyerId: BUYER,
      });
      expect(components.map((c) => c.amount)).toEqual([Math.floor(2100 * 0.7)]);
    });
  });
});

describe('grantPackMembers', () => {
  const tx = {
    $executeRaw: (...args: unknown[]) => executeRaw(...args),
    userCosmetic: {
      findMany: (...args: unknown[]) => findOwnedMany(...args),
      createMany: (...args: unknown[]) => createManyUserCosmetic(...args),
    },
  } as never;

  it('adds uses for a consumable rather than creating a second holding', async () => {
    await grantPackMembers({
      tx,
      userId: BUYER,
      members: [member({ type: CosmeticType.Sticker, data: { uses: 40 } })],
      claimKey: 'pack-tx',
    });
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(createManyUserCosmetic).not.toHaveBeenCalled();
  });

  it('refuses a consumable with no usable uses instead of granting an unlimited balance', async () => {
    await expect(
      grantPackMembers({
        tx,
        userId: BUYER,
        members: [member({ type: CosmeticType.Sticker, data: {} })],
        claimKey: 'pack-tx',
      })
    ).rejects.toThrow(/cannot be granted/i);
  });

  it('grants only the durable members the buyer lacks', async () => {
    findOwnedMany.mockResolvedValue([{ cosmeticId: 61 }]);
    await grantPackMembers({
      tx,
      userId: BUYER,
      members: [member(), foreign()],
      claimKey: 'pack-tx',
    });
    expect(createManyUserCosmetic).toHaveBeenCalledWith({
      // `remaining` is read from the cosmetic's data rather than left NULL, so
      // the durable branch cannot grant an unlimited balance if a type is ever
      // consumable without `isConsumableCosmeticType` saying so.
      data: [{ userId: BUYER, cosmeticId: 62, claimKey: 'pack-tx', remaining: 40 }],
    });
  });

  it('writes nothing when the buyer already owns every durable member', async () => {
    findOwnedMany.mockResolvedValue([{ cosmeticId: 61 }, { cosmeticId: 62 }]);
    await grantPackMembers({
      tx,
      userId: BUYER,
      members: [member(), foreign()],
      claimKey: 'pack-tx',
    });
    expect(createManyUserCosmetic).not.toHaveBeenCalled();
  });
});
