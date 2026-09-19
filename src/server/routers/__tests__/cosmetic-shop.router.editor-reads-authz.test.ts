import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

/**
 * The two editor reads hand back a shop item the way the upsert form
 * round-trips it — the whole record, because the form writes it back wholesale.
 * They share the rung and token scope of the list views beside them, and the
 * client hooks that call them render only for moderators.
 *
 * Driven through `createCaller` so the middleware decides, not a source string.
 *
 * A narrower payload is NOT an alternative to the gate: the editor needs the
 * record it saves, so the rung and scope are the control.
 */

const { mockGetShopItemById, mockGetSectionById } = vi.hoisted(() => ({
  mockGetShopItemById: vi.fn(async () => ({ id: 1 })),
  mockGetSectionById: vi.fn(async () => ({ id: 2 })),
}));

vi.mock('~/server/services/cosmetic-shop.service', () => ({
  getShopItemById: mockGetShopItemById,
  getSectionById: mockGetSectionById,
  getPaginatedCosmeticShopItems: vi.fn(),
  getShopSections: vi.fn(),
  getShopSectionsWithItems: vi.fn(),
  getUserPreviewImagesForCosmetics: vi.fn(),
  getWishlistedShopItemIds: vi.fn(),
  purchaseCosmeticShopItem: vi.fn(),
  reorderCosmeticShopSections: vi.fn(),
  toggleWishlistShopItem: vi.fn(),
  upsertCosmetic: vi.fn(),
  upsertCosmeticShopItem: vi.fn(),
  upsertCosmeticShopSection: vi.fn(),
  deleteCosmeticShopItem: vi.fn(),
  deleteCosmeticShopSection: vi.fn(),
}));
vi.mock('~/server/utils/server-domain', () => ({ isHostForColor: () => false }));

import { cosmeticShopRouter } from '../cosmetic-shop.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

function fakeCtx(user: unknown, tokenScope: number = TokenScope.Full) {
  return {
    acceptableOrigin: true,
    user,
    apiKeyId: null,
    tokenScope,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: undefined,
  };
}

const mod = { id: 1, isModerator: true, tier: 'free', username: 'mod', onboarding: 0x1f };
const member = { id: 2, isModerator: false, tier: 'free', username: 'member', onboarding: 0x1f };

const READS = [
  {
    name: 'getShopItemById',
    mock: mockGetShopItemById,
    call: (c: ReturnType<typeof cosmeticShopRouter.createCaller>) => c.getShopItemById({ id: 1 }),
  },
  {
    name: 'getSectionById',
    mock: mockGetSectionById,
    call: (c: ReturnType<typeof cosmeticShopRouter.createCaller>) => c.getSectionById({ id: 2 }),
  },
];

describe('the cosmetic shop editor reads are moderator-only', () => {
  beforeEach(() => vi.clearAllMocks());

  for (const read of READS) {
    it(`${read.name} refuses a signed-in non-moderator`, async () => {
      const caller = cosmeticShopRouter.createCaller(fakeCtx(member) as never);

      await expect(read.call(caller)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(read.mock, 'the service must not run for a non-moderator').not.toHaveBeenCalled();
    });

    it(`${read.name} refuses a moderator's collections-read token`, async () => {
      const caller = cosmeticShopRouter.createCaller(
        fakeCtx(mod, TokenScope.CollectionsRead) as never
      );

      await expect(read.call(caller)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(read.mock, 'a scoped token must not reach the editor record').not.toHaveBeenCalled();
    });

    it(`${read.name} refuses an anonymous caller`, async () => {
      const caller = cosmeticShopRouter.createCaller(fakeCtx(undefined) as never);

      await expect(read.call(caller)).rejects.toBeInstanceOf(TRPCError);
      expect(read.mock).not.toHaveBeenCalled();
    });

    it(`${read.name} still serves a moderator`, async () => {
      const caller = cosmeticShopRouter.createCaller(fakeCtx(mod) as never);

      await expect(read.call(caller)).resolves.toBeTruthy();
      expect(read.mock).toHaveBeenCalledTimes(1);
    });
  }
});
