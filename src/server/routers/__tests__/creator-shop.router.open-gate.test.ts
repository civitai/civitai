import { describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { creatorShopRouter } from '../creator-shop.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * Opening a Creator Shop needs the Blaze Creator Score; anyone who already has a shop keeps it.
 * Each call passes an empty input: the gate runs before input validation, so a refusal is UNAUTHORIZED and an
 * allowed caller gets as far as the zod BAD_REQUEST.
 */

const creator = {
  id: 2,
  isModerator: false,
  tier: 'free',
  username: 'creator',
  onboarding: 0x1f,
  email: 'creator@example.com',
  emailVerified: new Date(),
  muted: false,
};

const ALL_ON = {
  trpcFlagGuardPerRequest: true,
  creatorShop: true,
  cosmeticPacks: true,
  mysteryBox: true,
  creatorMysteryPacks: true,
  stickers: true,
};

const caller = (user: Partial<typeof creator> = {}) =>
  creatorShopRouter.createCaller({
    acceptableOrigin: true,
    user: { ...creator, ...user },
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: ALL_ON as never,
    track: undefined,
  } as never);

const doors = {
  submitItem: (user?: Partial<typeof creator>) => caller(user).submitItem({} as never),
  submitPack: (user?: Partial<typeof creator>) => caller(user).submitPack({} as never),
  submitMysteryPack: (user?: Partial<typeof creator>) =>
    caller(user).submitMysteryPack({} as never),
  addResoldItem: (user?: Partial<typeof creator>) => caller(user).addResoldItem({} as never),
};
const doorNames = Object.keys(doors) as (keyof typeof doors)[];

const withScore = (total: number) =>
  dbMock.dbRead.user.findUnique.mockResolvedValue({ meta: { scores: { total } } } as never);
const withOwnShopItem = () =>
  dbMock.dbRead.cosmeticShopItem.findFirst.mockResolvedValue({ id: 1 } as never);
const withResoldItem = () =>
  dbMock.dbRead.userCosmeticShopItemResale.findFirst.mockResolvedValue({ shopItemId: 1 } as never);

describe('opening a Creator Shop', () => {
  it.each(doorNames)('%s refuses a new seller below 10,000, naming the score', async (door) => {
    withScore(9_999);
    await expect(doors[door]()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: expect.stringMatching(/Creator Score of 10,000/),
    });
  });

  it.each(doorNames)('%s lets a new seller at exactly 10,000 through', async (door) => {
    withScore(10_000);
    await expect(doors[door]()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it.each(doorNames)('%s lets an existing shop owner below 10,000 through', async (door) => {
    withScore(50);
    withOwnShopItem();
    await expect(doors[door]()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('lets an existing reseller below 10,000 through', async () => {
    withScore(50);
    withResoldItem();
    await expect(doors.addResoldItem()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('lets a moderator through whatever their score', async () => {
    withScore(0);
    await expect(doors.submitItem({ isModerator: true })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });
});
