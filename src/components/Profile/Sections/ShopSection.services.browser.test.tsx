import React from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as ServiceUtil from '~/components/CreatorShop/Services/creator-service.util';
import { ShopSection } from './ShopSection';

const state = vi.hoisted(() => ({
  shop: null as any,
  offerings: [] as any[],
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ creatorShop: true, creatorServices: true }),
}));
vi.mock('~/components/IntersectionObserver/IntersectionObserverProvider', () => ({
  useInViewDynamic: () => [() => undefined, true],
}));
vi.mock('~/components/CreatorShop/creator-shop.util', () => ({
  useQueryCreatorShop: () => ({ shop: state.shop, isLoading: false }),
}));
vi.mock('~/components/CreatorShop/Services/creator-service.util', async (importOriginal) => ({
  ...(await importOriginal<typeof ServiceUtil>()),
  useQueryShopServices: () => ({ offerings: state.offerings, isLoading: false }),
}));
vi.mock('~/components/Shop/ShopItem', () => ({
  ShopItem: ({ item }: { item: { id: number } }) => <div data-testid="card">item {item.id}</div>,
}));
vi.mock('~/components/CreatorShop/Storefront/storefront.util', () => ({
  useOwnedCosmeticIds: () => new Set<number>(),
}));
vi.mock('~/components/CosmeticShop/cosmetic-shop.util', () => ({
  useQueryWishlistedShopItems: () => ({ wishlistedIds: new Set<number>() }),
}));

const user = { id: 7, username: 'mira' } as any;
const shop = (over: Record<string, unknown> = {}) => ({
  settings: { enabled: true, sections: null, ...over },
  featured: [],
  cosmetics: [],
});
const offering = { id: 1, title: 'Custom portrait', deliveryDays: 5, revisionsIncluded: 2 };

const renderSection = async () => {
  renderWithProviders(<ShopSection user={user} />);
  await new Promise((r) => setTimeout(r, 100));
  return document.body.textContent ?? '';
};

describe('ShopSection services', () => {
  beforeEach(() => {
    state.shop = shop();
    state.offerings = [];
  });

  test('a services-only shop with an Active service shows the section, linking to the storefront services', async () => {
    state.offerings = [offering];
    const text = await renderSection();
    expect(text).toContain('Custom portrait');
    expect(document.querySelectorAll('[data-testid="card"]')).toHaveLength(0);
    expect(document.querySelector('a[href="/user/mira/shop#shop-services"]')).not.toBeNull();
  });

  test('a seller whose only service is a Draft sees nothing (the shop query returns Active only)', async () => {
    const text = await renderSection();
    expect(text.trim()).toBe('');
  });

  test('cosmetics still show alongside services', async () => {
    state.shop = { ...shop(), cosmetics: [{ id: 3, createdAt: new Date() }] };
    state.offerings = [offering];
    await renderSection();
    expect(document.querySelectorAll('[data-testid="card"]').length).toBeGreaterThan(0);
    expect(document.body.textContent).toContain('Custom portrait');
  });
});
