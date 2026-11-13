import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The mystery box kill switch and region block enter the purchase here: the router reads the
 * `mysteryBox` flag and the buyer's country, and the service trusts what it is handed. Driven
 * through `createCaller` so the real procedure builds the arguments.
 */

const { mockPurchase } = vi.hoisted(() => ({
  mockPurchase: vi.fn(async () => ({ kind: 'box' })),
}));

vi.mock('~/server/services/cosmetic-shop.service', () => ({
  getShopItemById: vi.fn(),
  getSectionById: vi.fn(),
  getPaginatedCosmeticShopItems: vi.fn(),
  getShopSections: vi.fn(),
  getShopSectionsWithItems: vi.fn(),
  getUserPreviewImagesForCosmetics: vi.fn(),
  getWishlistedShopItemIds: vi.fn(),
  purchaseCosmeticShopItem: mockPurchase,
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
import { getAllowedAccountTypes } from '~/server/utils/buzz-helpers';

const buyer = {
  id: 2,
  // A moderator, so a hard-coded `isModerator: false` in the router is visible.
  isModerator: true,
  tier: 'free',
  username: 'buyer',
  onboarding: 0x1f,
  email: 'buyer@example.com',
  emailVerified: new Date(),
};

const ctx = (features: Record<string, boolean>, headers: Record<string, string>) => ({
  acceptableOrigin: true,
  user: buyer,
  apiKeyId: null,
  tokenScope: TokenScope.Full,
  req: { headers } as never,
  res: { setHeader: () => undefined } as never,
  cache: { edgeTTL: 0 },
  features: features as never,
  track: undefined,
});

const purchase = (features: Record<string, boolean>, headers: Record<string, string> = {}) =>
  cosmeticShopRouter
    .createCaller(ctx(features, headers) as never)
    .purchaseShopItem({ shopItemId: 42, expectedVersion: 3 });

describe('purchaseShopItem hands the service the mystery box flag and the buyer country', () => {
  beforeEach(() => mockPurchase.mockClear());

  it('passes the mysteryBox flag through, on and off', async () => {
    await purchase({ mysteryBox: true });
    await purchase({ mysteryBox: false });
    expect(
      mockPurchase.mock.calls.map(
        ([arg]) => (arg as { mysteryBoxEnabled?: boolean }).mysteryBoxEnabled
      )
    ).toEqual([true, false]);
  });

  it('charges the domain currency: green on the green domain, yellow elsewhere', async () => {
    await purchase({ mysteryBox: true, isGreen: true });
    await purchase({ mysteryBox: true, isGreen: false });
    expect(mockPurchase.mock.calls.map(([arg]) => (arg as { buzzType?: string }).buzzType)).toEqual(
      ['green', 'yellow']
    );
  });

  it('passes the country from the request', async () => {
    await purchase({ mysteryBox: true }, { 'cf-ipcountry': 'BE' });
    expect(mockPurchase).toHaveBeenCalledWith(
      expect.objectContaining({
        countryCode: 'BE',
        expectedVersion: 3,
        userId: buyer.id,
        isModerator: true,
        // The Buzz account a box is charged from on this domain.
        buzzType: getAllowedAccountTypes({ mysteryBox: true } as never)[0],
      })
    );
  });
});
