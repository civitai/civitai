import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CosmeticType } from '~/shared/utils/prisma/enums';

const getBlockedPairIds = vi.fn();
const executeRaw = vi.fn();
const findOwnedMany = vi.fn();
const createManyUserCosmetic = vi.fn();

vi.mock('~/server/db/client', () => ({
  dbRead: {},
  dbWrite: {},
}));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: vi.fn(),
  createMultiAccountBuzzTransaction: vi.fn(),
  refundMultiAccountTransaction: vi.fn(),
}));
vi.mock('~/server/services/user-preferences.service', () => ({
  getBlockedPairIds: (...args: unknown[]) => getBlockedPairIds(...args),
}));
vi.mock('~/server/redis/caches', () => ({ refreshOwnedStickerCache: vi.fn() }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn() }));

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

  it('splits a foreign members pool with its own reseller rather than the pack creator', () => {
    const { components } = computePackPayouts({
      packPrice: PACK_PRICE,
      packCreatorId: PACK_CREATOR,
      members: [
        foreign({
          addedById: RESELLER,
          listingMeta: { purchases: 0, acceptsBlueBuzz: true, sellerShare: 20 },
        }),
      ],
    });
    const seller = components.find((c) => c.userId === RESELLER);
    const creator = components.find((c) => c.userId === FOREIGN_CREATOR);
    expect(seller?.amount).toBe(Math.floor(2100 * 0.2));
    expect(creator?.amount).toBe(Math.floor(2100 * 0.7) - Math.floor(2100 * 0.2));
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

  it('floors the remainder at zero when a member re-priced above the pack', () => {
    const { remainder, packCreatorAmount } = computePackPayouts({
      packPrice: 1000,
      packCreatorId: PACK_CREATOR,
      members: [foreign({ floorAmount: 4000 })],
    });
    expect(remainder).toBe(0);
    expect(packCreatorAmount).toBe(0);
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
      data: [{ userId: BUYER, cosmeticId: 62, claimKey: 'pack-tx' }],
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
