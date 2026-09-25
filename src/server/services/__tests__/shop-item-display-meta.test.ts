import { describe, expect, it } from 'vitest';
import type { CosmeticShopItemMeta } from '~/server/schema/cosmetic-shop.schema';
import { cosmeticShopItemMeta } from '~/server/schema/cosmetic-shop.schema';
import { shopItemDisplayMeta } from '../creator-shop.data';

/**
 * `shopItemDisplayMeta` decides which parts of a shop item's meta reach a
 * client. Every shop surface publishes through it, so the list is deliberately
 * an allow-list: a key the cards don't render is a key that doesn't go out.
 *
 * If you are here to add a field, add it because a card renders it.
 */
describe('shopItemDisplayMeta publishes the card fields and nothing else', () => {
  const fullMeta = {
    purchases: 7,
    acceptsBlueBuzz: true,
    coverUrl: 'cover.png',
    coverTiles: ['a.png', 'b.png'],
    packMemberCount: 3,
    paidToUserIds: [1, 2],
    creatorId: 99,
    submissionTxId: 'tx-1',
    submissionFee: 500,
    lastApprovedAmount: 1200,
    autoChecks: [{ key: 'k', label: 'l', passed: false, detail: 'd' }],
    imageHash: 'deadbeef',
    sellerShare: 40,
    sellableByOthers: true,
    history: [{ action: 'reject', userId: 4, at: new Date().toISOString() }],
    imageMeta: { width: 512, height: 512, hasTransparency: true },
    rightsAffirmation: { userId: 5, affirmedAt: '2026-01-01', version: 1, statement: 's' },
    takedown: { reason: 'r', moderatorId: 6, at: '2026-01-02' },
  } as unknown as CosmeticShopItemMeta;

  // The key-set assertions below only see what this fixture carries, so it has
  // to carry every key the column can hold. A new schema field fails here first.
  it('fixture carries every key the meta schema declares', () => {
    expect(Object.keys(fullMeta).sort()).toEqual(Object.keys(cosmeticShopItemMeta.shape).sort());
  });

  it('returns exactly the display keys for a fully populated item', () => {
    expect(Object.keys(shopItemDisplayMeta(fullMeta, 7)).sort()).toEqual([
      'acceptsBlueBuzz',
      'coverTiles',
      'coverUrl',
      'packMemberCount',
      'purchases',
    ]);
  });

  // The fixture's stored counter is 7; the sold count passed in is 11. The
  // published number must be the one passed in.
  it('carries the display values through, with the sold count as purchases', () => {
    expect(shopItemDisplayMeta(fullMeta, 11)).toEqual({
      purchases: 11,
      acceptsBlueBuzz: true,
      coverUrl: 'cover.png',
      coverTiles: ['a.png', 'b.png'],
      packMemberCount: 3,
    });
  });

  it('defaults acceptsBlueBuzz for a null meta and still carries the sold count', () => {
    expect(shopItemDisplayMeta(null, 3)).toEqual({ purchases: 3, acceptsBlueBuzz: false });
  });
});
