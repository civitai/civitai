import { describe, expect, it } from 'vitest';
import { myShopNavVisible } from '~/components/AppLayout/AppHeader/myShopNavVisibility';

describe('myShopNavVisible', () => {
  it('shows for anyone holding the creatorShop flag', () => {
    expect(myShopNavVisible({ creatorShop: true })).toBe(true);
  });

  it('hides without the flag', () => {
    expect(myShopNavVisible({ creatorShop: false })).toBe(false);
    expect(myShopNavVisible({})).toBe(false);
  });
});
