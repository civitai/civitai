import { describe, expect, it } from 'vitest';
import { myShopNavVisible } from '~/components/AppLayout/AppHeader/myShopNavVisibility';

describe('myShopNavVisible', () => {
  it('shows for a creatorShop-flag user without the CreatorProgram bit', () => {
    expect(myShopNavVisible({ creatorShop: true })).toBe(true);
    expect(myShopNavVisible({ creatorShop: true })).toBe(true);
  });

  it('shows for a flag user who is also in the Creator Program', () => {
    expect(myShopNavVisible({ creatorShop: true })).toBe(true);
  });

  it('hides without the flag, even with the CreatorProgram bit', () => {
    expect(myShopNavVisible({ creatorShop: false })).toBe(false);
    expect(myShopNavVisible({})).toBe(false);
  });
});
