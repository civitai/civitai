import { describe, expect, it } from 'vitest';
import {
  isSectionAvailable,
  storefrontSectionKeys,
  withMissingSections,
} from '~/components/CreatorShop/section-meta';
import { isStorefrontEmpty } from '~/components/CreatorShop/Storefront/storefront.util';
import type { FeatureAccess } from '~/server/services/feature-flags.service';

const flags = (creatorServices: boolean) => ({ creatorServices } as FeatureAccess);

// What StorefrontSections renders, for a shop saved before Services existed.
const renderedOrder = (creatorServices: boolean) =>
  withMissingSections([
    { key: 'featured', visible: true },
    { key: 'cosmetics', visible: true },
    { key: 'resold', visible: false },
    { key: 'merch', visible: true },
    { key: 'models', visible: true },
  ])
    .filter((s) => s.visible && isSectionAvailable(s.key, flags(creatorServices)))
    .map((s) => s.key);

describe('services-only storefront', () => {
  it('shows the empty state with no cosmetics while creatorServices is off, even with an Active offering', () => {
    expect(
      isStorefrontEmpty({ cosmeticCount: 0, activeServiceCount: 1, servicesEnabled: false })
    ).toBe(true);
    expect(renderedOrder(false)).not.toContain('services');
  });

  it('renders Services with creatorServices on and one Active offering', () => {
    expect(
      isStorefrontEmpty({ cosmeticCount: 0, activeServiceCount: 1, servicesEnabled: true })
    ).toBe(false);
    expect(renderedOrder(true)).toEqual(['featured', 'cosmetics', 'merch', 'models', 'services']);
  });

  it('is still empty with creatorServices on and no Active offering', () => {
    expect(
      isStorefrontEmpty({ cosmeticCount: 0, activeServiceCount: 0, servicesEnabled: true })
    ).toBe(true);
  });
});

// The shop header's Services link shows only where this list includes 'services'.
describe('storefront section keys', () => {
  it('leaves out a Services section the seller hid', () => {
    const hidden = [{ key: 'services' as const, visible: false }];
    expect(storefrontSectionKeys(hidden, flags(true))).not.toContain('services');
  });

  it('includes Services for a shop with no saved order, after Cosmetics', () => {
    const keys = storefrontSectionKeys(null, flags(true));
    expect(keys.indexOf('services')).toBe(keys.indexOf('cosmetics') + 2);
  });
});
