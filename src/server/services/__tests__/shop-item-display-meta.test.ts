import { describe, expect, it } from 'vitest';
import type { CosmeticShopItemMeta } from '~/server/schema/cosmetic-shop.schema';
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
  } as unknown as CosmeticShopItemMeta;

  it('returns exactly the display keys for a fully populated item', () => {
    expect(Object.keys(shopItemDisplayMeta(fullMeta)).sort()).toEqual([
      'acceptsBlueBuzz',
      'coverTiles',
      'coverUrl',
      'packMemberCount',
      'purchases',
    ]);
  });

  it('carries the display values through unchanged', () => {
    expect(shopItemDisplayMeta(fullMeta)).toEqual({
      purchases: 7,
      acceptsBlueBuzz: true,
      coverUrl: 'cover.png',
      coverTiles: ['a.png', 'b.png'],
      packMemberCount: 3,
    });
  });

  it('defaults the two always-present keys for a null meta', () => {
    expect(shopItemDisplayMeta(null)).toEqual({ purchases: 0, acceptsBlueBuzz: false });
  });
});
