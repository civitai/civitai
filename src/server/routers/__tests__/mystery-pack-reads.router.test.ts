import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The viewer-flag gate on every read a creator pack can be seen through, through `createCaller` so
 * the real procedures run: the service is told `enabled: false` unless the viewer has all four flags,
 * and the creator-only reads are refused outright.
 */

const read = vi.hoisted(() => ({
  getMysteryPackCandidates: vi.fn(async () => []),
  getMyMysteryPacks: vi.fn(async () => []),
  getCreatorMysteryPacks: vi.fn(async () => []),
  getMysteryPackViewsForSeller: vi.fn(async () => []),
}));
vi.mock('~/server/services/creator-mystery-pack-read.service', () => read);
const odds = vi.hoisted(() => ({ getMysteryBoxOddsPage: vi.fn(async () => null) }));
vi.mock('~/server/services/mystery-box-odds-page.service', () => odds);

import { creatorShopRouter } from '../creator-shop.router';
import { mysteryBoxRouter } from '../mystery-box.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const user = {
  id: 2,
  isModerator: false,
  tier: 'free',
  username: 'viewer',
  onboarding: 0x1f,
  email: 'viewer@example.com',
  emailVerified: new Date(),
  muted: false,
};
const FLAGS = ['creatorShop', 'cosmeticPacks', 'mysteryBox', 'creatorMysteryPacks'] as const;
const ALL_ON = {
  creatorShop: true,
  cosmeticPacks: true,
  mysteryBox: true,
  creatorMysteryPacks: true,
  stickers: false,
  trpcFlagGuardPerRequest: true,
};

const ctx = (features: Record<string, boolean>, overrides: Partial<typeof user> = {}) =>
  ({
    acceptableOrigin: true,
    user: { ...user, ...overrides },
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: { 'cf-ipcountry': 'US' } } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: features as never,
    track: undefined,
  } as never);
const shop = (features: Record<string, boolean>, overrides?: Partial<typeof user>) =>
  creatorShopRouter.createCaller(ctx(features, overrides));
const box = (features: Record<string, boolean>, overrides?: Partial<typeof user>) =>
  mysteryBoxRouter.createCaller(ctx(features, overrides));

beforeEach(() => {
  for (const fn of [...Object.values(read), ...Object.values(odds)]) fn.mockClear();
});

describe('creator-only pack reads', () => {
  const calls = {
    candidates: (f: Record<string, boolean>) => shop(f).getMysteryPackCandidates(),
    mine: (f: Record<string, boolean>) => shop(f).getMyMysteryPacks({}),
  };
  it.each(Object.keys(calls).flatMap((name) => FLAGS.map((flag) => [name, flag] as const)))(
    '%s is refused with %s off, before the service',
    async (name, flag) => {
      await expect(
        calls[name as keyof typeof calls]({ ...ALL_ON, [flag]: false })
      ).rejects.toMatchObject({
        code: expect.stringMatching(/UNAUTHORIZED|FORBIDDEN/),
      });
      expect(read.getMysteryPackCandidates).not.toHaveBeenCalled();
      expect(read.getMyMysteryPacks).not.toHaveBeenCalled();
    }
  );

  it("names the viewer to the service, so it can refuse another creator's packs", async () => {
    await shop(ALL_ON).getMyMysteryPacks({ userId: 9 });
    expect(read.getMyMysteryPacks).toHaveBeenCalledWith({
      ownerId: 9,
      viewer: { id: user.id, isModerator: false },
    });
    await shop(ALL_ON, { isModerator: true }).getMyMysteryPacks({});
    expect(read.getMyMysteryPacks).toHaveBeenLastCalledWith({
      ownerId: user.id,
      viewer: { id: user.id, isModerator: true },
    });
  });
});

describe('public pack reads', () => {
  const reads = {
    getForCreator: (f: Record<string, boolean>) => box(f).getForCreator({}),
    getForSeller: (f: Record<string, boolean>) => box(f).getForSeller({ sellerId: 7 }),
  };
  const serviceOf = {
    getForCreator: read.getCreatorMysteryPacks,
    getForSeller: read.getMysteryPackViewsForSeller,
  };
  it.each(Object.keys(reads).flatMap((name) => FLAGS.map((flag) => [name, flag] as const)))(
    '%s asks the service for nothing (enabled: false) with %s off',
    async (name, flag) => {
      await reads[name as keyof typeof reads]({ ...ALL_ON, [flag]: false });
      expect(serviceOf[name as keyof typeof reads]).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false })
      );
    }
  );

  it.each(Object.keys(reads))('%s is enabled with all four flags', async (name) => {
    await reads[name as keyof typeof reads](ALL_ON);
    expect(serviceOf[name as keyof typeof reads]).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true })
    );
  });

  it.each(FLAGS)('the odds page is told creator packs are off with %s off', async (flag) => {
    await box({ ...ALL_ON, [flag]: false }).getOddsPage({ boxDefinitionId: 3 });
    expect(odds.getMysteryBoxOddsPage).toHaveBeenCalledWith(
      expect.objectContaining({ creatorPacksEnabled: false })
    );
  });
});
