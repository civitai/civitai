import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/component-setup';
import { ShopRow } from './ShopSection';

vi.mock('~/components/Shop/ShopItem', () => ({
  ShopItem: ({ item }: { item: { id: number } }) => (
    <div data-testid="card" style={{ height: 200, background: '#5c7cfa', color: '#fff' }}>
      item {item.id}
    </div>
  ),
}));
vi.mock('~/components/CreatorShop/Storefront/storefront.util', () => ({
  useOwnedCosmeticIds: () => new Set<number>(),
}));
vi.mock('~/components/CosmeticShop/cosmetic-shop.util', () => ({
  useQueryWishlistedShopItems: () => ({ wishlistedIds: new Set<number>() }),
}));

const cosmetics = [1, 2, 3, 4, 5, 6, 7, 8].map((id) => ({ id, createdAt: new Date() })) as any[];
const featured = [8, 6, 4, 2, 1, 3].map((id) => cosmetics.find((c) => c.id === id));

const renderAt = async (width: number, featuredItems: any[]) => {
  renderWithProviders(
    <div data-testid="frame" style={{ width }}>
      <ShopRow featured={featuredItems} cosmetics={cosmetics} />
    </div>
  );
  // useResizeObserver delivers on a frame; wait for the layout to settle.
  await new Promise((r) => setTimeout(r, 300));
  return [...document.querySelectorAll<HTMLElement>('[data-testid="card"]')];
};

// 4477px is the width the tester reported leaving 2 empty slots after 6 featured cards.
describe.each([
  { width: 1280, expected: 4 },
  { width: 1920, expected: 6 },
  { width: 3840, expected: 8 },
  { width: 4477, expected: 8 },
])('ShopRow at $width px', ({ width, expected }) => {
  test('fills exactly one row, featured first', async () => {
    const cards = await renderAt(width, featured);
    expect(cards).toHaveLength(expected);
    expect(new Set(cards.map((c) => Math.round(c.getBoundingClientRect().top))).size).toBe(1);
    expect(cards.slice(0, 4).map((c) => c.textContent)).toEqual([
      'item 8',
      'item 6',
      'item 4',
      'item 2',
    ]);
  });

  test('with nothing featured, shows the first cosmetics', async () => {
    const cards = await renderAt(width, []);
    expect(cards).toHaveLength(expected);
    expect(cards[0].textContent).toBe('item 1');
  });
});
