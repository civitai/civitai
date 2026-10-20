import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CreatorMysteryPackService from '~/server/services/creator-mystery-pack.service';
import type * as CreatorShopService from '~/server/services/creator-shop.service';

/** Gate and argument wiring of the mystery pack procedures, through `createCaller` so the real procedures run. */

const service = vi.hoisted(() => ({
  submitMysteryPack: vi.fn(async () => ({ boxId: 1, shopItemId: 1 })),
  reviseMysteryPack: vi.fn(async () => ({ boxId: 1, revisionId: 1 })),
  withdrawMysteryPackRevision: vi.fn(async () => ({ boxId: 1, archived: false })),
  lowerMysteryPackPrice: vi.fn(async () => ({ boxId: 1, price: 500 })),
}));
vi.mock('~/server/services/creator-mystery-pack.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CreatorMysteryPackService>()),
  ...service,
}));
const shop = vi.hoisted(() => ({ reviewCreatorShopItem: vi.fn(async () => ({ id: 1 })) }));
vi.mock('~/server/services/creator-shop.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CreatorShopService>()),
  ...shop,
}));

const review = vi.hoisted(() => ({ getMysteryPackReview: vi.fn(async () => ({ boxId: 1 })) }));
vi.mock('~/server/services/creator-mystery-pack-review.service', () => review);

import { creatorShopRouter } from '../creator-shop.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

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
  creatorShop: true,
  cosmeticPacks: true,
  mysteryBox: true,
  creatorMysteryPacks: true,
  stickers: false,
};

const caller = (features: Record<string, boolean>, user: Partial<typeof creator> = {}) =>
  creatorShopRouter.createCaller({
    acceptableOrigin: true,
    user: { ...creator, ...user },
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: { 'cf-ipcountry': 'BE' } } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: features as never,
    track: undefined,
  } as never);

const proposal = {
  steepness: 'standard' as const,
  tiers: [
    [1, 2, 3, 4],
    [5, 6],
  ],
  price: 500,
};

const calls = {
  submit: (features: Record<string, boolean>, user?: Partial<typeof creator>) =>
    caller(features, user).submitMysteryPack({ ...proposal, name: 'Pack', quotedFee: 1000 }),
  revise: (features: Record<string, boolean>, user?: Partial<typeof creator>) =>
    caller(features, user).reviseMysteryPack({ ...proposal, boxId: 7 }),
  withdraw: (features: Record<string, boolean>, user?: Partial<typeof creator>) =>
    caller(features, user).withdrawMysteryPackRevision({ boxId: 7 }),
  lowerPrice: (features: Record<string, boolean>, user?: Partial<typeof creator>) =>
    caller(features, user).lowerMysteryPackPrice({ boxId: 7, price: 600 }),
};

beforeEach(() => {
  for (const fn of Object.values(service)) fn.mockClear();
});

describe('creator mystery pack procedures', () => {
  const procedures = Object.keys(calls) as (keyof typeof calls)[];
  const flags = ['creatorShop', 'cosmeticPacks', 'mysteryBox', 'creatorMysteryPacks'] as const;

  it.each(procedures.flatMap((procedure) => flags.map((flag) => [procedure, flag] as const)))(
    '%s is refused with %s off, before the service',
    async (procedure, flag) => {
      await expect(calls[procedure]({ ...ALL_ON, [flag]: false })).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
      for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
    }
  );

  it.each(procedures)('%s is refused for a muted creator', async (procedure) => {
    await expect(calls[procedure](ALL_ON, { muted: true })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('restricted'),
    });
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });

  it("hands submit and revise the creator's country and the stickers flag", async () => {
    await calls.submit({ ...ALL_ON, stickers: true });
    await calls.revise(ALL_ON);
    expect(service.submitMysteryPack).toHaveBeenCalledWith(
      expect.objectContaining({ userId: creator.id, countryCode: 'BE', stickersEnabled: true })
    );
    expect(service.reviseMysteryPack).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: creator.id,
        boxId: 7,
        countryCode: 'BE',
        stickersEnabled: false,
      })
    );
  });

  it('hands the price cut the caller as the creator', async () => {
    await calls.lowerPrice(ALL_ON);
    expect(service.lowerMysteryPackPrice).toHaveBeenCalledWith({
      boxId: 7,
      price: 600,
      userId: creator.id,
    });
  });

  // A pack's approval re-runs the content checks, stickers included.
  it("hands a moderator's verdict the stickers flag", async () => {
    for (const stickers of [true, false]) {
      shop.reviewCreatorShopItem.mockClear();
      await caller({ ...ALL_ON, stickers }, { isModerator: true }).reviewItem({
        id: 3,
        action: 'approve',
        boxRevisionId: 9,
      });
      expect(shop.reviewCreatorShopItem).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 3,
          reviewerId: creator.id,
          boxRevisionId: 9,
          stickersEnabled: stickers,
        })
      );
    }
  });

  it("refuses the review pane's read to a non-moderator, and hands a moderator's the stickers flag", async () => {
    // The moderator gate's own refusal: the creatorShop flag also answers FORBIDDEN for a member.
    await expect(caller(ALL_ON).getMysteryPackReview({ id: 3 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'You do not have permission to perform this action',
    });
    expect(review.getMysteryPackReview).not.toHaveBeenCalled();

    for (const stickers of [true, false]) {
      review.getMysteryPackReview.mockClear();
      await caller({ ...ALL_ON, stickers }, { isModerator: true }).getMysteryPackReview({ id: 3 });
      expect(review.getMysteryPackReview).toHaveBeenCalledTimes(1);
      expect(review.getMysteryPackReview).toHaveBeenCalledWith({
        listingId: 3,
        stickersEnabled: stickers,
      });
    }
  });

  // The service loads every item it is handed, so the cap holds before it is called.
  it.each([
    [
      'across tiers',
      [Array.from({ length: 40 }, (_, i) => i + 1), [41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51]],
    ],
    ['in one tier', [Array.from({ length: 51 }, (_, i) => i + 1), [52]]],
  ])('refuses more than 50 items %s, before the service', async (_label, tiers) => {
    await expect(
      caller(ALL_ON).submitMysteryPack({ ...proposal, tiers, name: 'Pack', quotedFee: 1000 })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller(ALL_ON).submitMysteryPack({
        ...proposal,
        tiers: [tiers[0].slice(0, 40), [41, 42, 43, 44, 45, 46, 47, 48, 49, 50]],
        name: 'Pack',
        quotedFee: 1000,
      })
    ).resolves.toBeDefined();
    expect(service.submitMysteryPack).toHaveBeenCalledTimes(1);
  });
});
