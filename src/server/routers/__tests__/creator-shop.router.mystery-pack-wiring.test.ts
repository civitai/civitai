import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CreatorMysteryPackService from '~/server/services/creator-mystery-pack.service';

/**
 * The mystery pack procedures check all four flags and hand the service the creator's country, and
 * the service trusts what it is handed. Driven through `createCaller` so the real procedures run.
 */

const service = vi.hoisted(() => ({
  submitMysteryPack: vi.fn(async () => ({ boxId: 1, shopItemId: 1 })),
  reviseMysteryPack: vi.fn(async () => ({ boxId: 1, revisionId: 1 })),
  withdrawMysteryPackRevision: vi.fn(async () => ({ boxId: 1, archived: false })),
}));
vi.mock('~/server/services/creator-mystery-pack.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CreatorMysteryPackService>()),
  ...service,
}));

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
    await expect(calls[procedure](ALL_ON, { muted: true })).rejects.toThrow();
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
});
