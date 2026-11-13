import { describe, expect, it } from 'vitest';
import { shopPublishBlockedReason } from '~/components/CreatorShop/Manage/publish-blocked';

const base = {
  loading: false,
  cosmeticCount: 0,
  servicesCount: true,
  activeServiceCount: 0,
  hiddenServiceCount: 0,
};

describe('what can fill a shop so it may be published', () => {
  it('lets a services-only seller publish: an Active service fills the shop', () => {
    expect(shopPublishBlockedReason({ ...base, activeServiceCount: 1 })).toBeUndefined();
  });

  it('lets cosmetics alone fill it, with or without services counted', () => {
    expect(shopPublishBlockedReason({ ...base, cosmeticCount: 2 })).toBeUndefined();
    expect(
      shopPublishBlockedReason({ ...base, cosmeticCount: 2, servicesCount: false })
    ).toBeUndefined();
  });

  it('blocks an empty shop, and says to add an item or a service when services count', () => {
    expect(shopPublishBlockedReason(base)).toMatch(/item or publish a service/);
  });

  it('does not count services for a viewer they cannot fill the shop for', () => {
    // A moderator publishing for a seller, or an owner without the flag: the server counts cosmetics only.
    expect(shopPublishBlockedReason({ ...base, servicesCount: false, activeServiceCount: 3 })).toBe(
      'Add at least one item before publishing your shop.'
    );
  });

  it('leaves the button enabled when offerings this domain hides might be Active; the server answers', () => {
    expect(shopPublishBlockedReason({ ...base, hiddenServiceCount: 2 })).toBeUndefined();
  });

  it('does not let hidden services fill the shop for a viewer whose services do not count', () => {
    expect(shopPublishBlockedReason({ ...base, servicesCount: false, hiddenServiceCount: 2 })).toBe(
      'Add at least one item before publishing your shop.'
    );
  });

  it('blocks nothing while the lists are still loading', () => {
    expect(shopPublishBlockedReason({ ...base, loading: true })).toBeUndefined();
  });
});
