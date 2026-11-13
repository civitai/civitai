import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { describe, expect, it, vi } from 'vitest';

// A draft shop answers a buyer's request "Shop not found", but a moderator can still see it. The
// storefront tells the Services section whether the shop is published; here it is a stand-in that
// shows what it was told.

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ creatorServices: true }),
}));
vi.mock('~/components/CreatorShop/Storefront/ServicesSection', () => ({
  ServicesSection: ({ shopPublished }: { shopPublished: boolean }) =>
    createElement('span', { 'data-published': String(shopPublished) }),
}));
vi.mock('~/components/CreatorShop/Storefront/CosmeticsSection', () => ({
  CosmeticsSection: () => null,
}));
vi.mock('~/components/CreatorShop/Storefront/FeaturedSection', () => ({
  FeaturedSection: () => null,
}));
vi.mock('~/components/CreatorShop/Storefront/MerchSection', () => ({ MerchSection: () => null }));
vi.mock('~/components/CreatorShop/Storefront/ModelsSection', () => ({ ModelsSection: () => null }));
vi.mock('~/components/CreatorShop/Storefront/ResoldSection', () => ({ ResoldSection: () => null }));

const { StorefrontSections } = await import(
  '~/components/CreatorShop/Storefront/StorefrontSections'
);

const render = (enabled: boolean | undefined) =>
  renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(StorefrontSections, {
        shop: { settings: { enabled, sections: [] } } as never,
        ownedCosmeticIds: new Set<number>(),
        username: 'seller',
        ownerUserId: 9,
      })
    )
  );

describe('storefront: telling the Services section whether the shop is published', () => {
  it('passes true for a published shop', () => {
    expect(render(true)).toContain('data-published="true"');
  });

  it('passes false for a draft shop, and when the setting was never saved', () => {
    expect(render(false)).toContain('data-published="false"');
    expect(render(undefined)).toContain('data-published="false"');
  });
});
