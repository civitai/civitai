import { describe, expect, it } from 'vitest';
import type { ShopBrowseItem } from '~/components/Shop/shop-browse';
import {
  browseShopItems,
  shopBrowseKey,
  shopItemMatchesSearch,
} from '~/components/Shop/shop-browse';
import { CosmeticShopSort } from '~/server/common/enums';
import { CosmeticType } from '~/shared/utils/prisma/enums';
import { stickerSlugSearchTerm } from '~/shared/utils/sticker-token';

const item = (overrides: Partial<ShopBrowseItem> = {}): ShopBrowseItem => ({
  id: 1,
  cosmeticId: 1,
  title: 'Golden Frame',
  description: null,
  unitAmount: 100,
  cosmetic: { type: CosmeticType.ProfileDecoration, name: 'Frame of Gold', data: {} },
  ...overrides,
});

const sticker = (slug: string, name = 'Happy Cat', overrides: Partial<ShopBrowseItem> = {}) =>
  item({
    title: name,
    cosmetic: { type: CosmeticType.Sticker, name, data: { slug } },
    ...overrides,
  });

describe('stickerSlugSearchTerm', () => {
  it('strips the surrounding colons and lowercases', () => {
    expect(stickerSlugSearchTerm(' :Wave_Hi: ')).toBe('wave_hi');
  });

  it('is undefined for a search no slug could contain', () => {
    expect(stickerSlugSearchTerm('happy cat')).toBeUndefined();
    expect(stickerSlugSearchTerm('::')).toBeUndefined();
  });
});

describe('shopItemMatchesSearch', () => {
  it('matches everything on an empty or blank search', () => {
    expect(shopItemMatchesSearch(item(), undefined)).toBe(true);
    expect(shopItemMatchesSearch(item(), '   ')).toBe(true);
  });

  it('matches the title and the cosmetic name, case-insensitively', () => {
    expect(shopItemMatchesSearch(item(), 'golden')).toBe(true);
    expect(shopItemMatchesSearch(item(), 'OF GOLD')).toBe(true);
    expect(shopItemMatchesSearch(item(), 'silver')).toBe(false);
  });

  it('matches description text but not its HTML tags', () => {
    const described = item({ description: '<p>A <strong>shiny</strong> border</p>' });
    expect(shopItemMatchesSearch(described, 'shiny')).toBe(true);
    expect(shopItemMatchesSearch(described, 'strong')).toBe(false);
  });

  it('matches a sticker slug, with or without the colons', () => {
    expect(shopItemMatchesSearch(sticker('cat_wave'), 'cat_wave')).toBe(true);
    expect(shopItemMatchesSearch(sticker('cat_wave'), ':cat_wave:')).toBe(true);
    expect(shopItemMatchesSearch(sticker('cat_wave'), 'wave')).toBe(true);
    expect(shopItemMatchesSearch(sticker('cat_wave'), 'dog')).toBe(false);
  });

  it('ignores a slug on cosmetics that are not stickers', () => {
    const badge = item({
      cosmetic: { type: CosmeticType.Badge, name: 'Badge', data: { slug: 'secret' } },
    });
    expect(shopItemMatchesSearch(badge, 'secret')).toBe(false);
  });

  it('matches packs, which have no cosmetic, on title', () => {
    const pack = item({ cosmeticId: null, cosmetic: null, title: 'Starter Pack' });
    expect(shopItemMatchesSearch(pack, 'starter')).toBe(true);
    expect(shopItemMatchesSearch(pack, 'frame')).toBe(false);
  });
});

describe('browseShopItems search', () => {
  it('combines the search with the type filter', () => {
    const entries = [
      sticker('cat_wave', 'Happy Cat', { id: 1 }),
      item({ id: 2, title: 'Cat Frame' }),
      sticker('dog_bark', 'Dog', { id: 3 }),
    ];
    const result = browseShopItems({
      entries,
      shopItemOf: (entry) => entry,
      filters: { cosmeticTypes: [CosmeticType.Sticker], search: 'cat' },
      sort: CosmeticShopSort.Newest,
      ownedCosmeticIds: new Set(),
      wishlistedIds: new Set(),
    });
    expect(result.map((entry) => entry.id)).toEqual([1]);
  });
});

describe('shopBrowseKey', () => {
  // The paged grids reset to page 1 when this key changes.
  const key = (search?: string) => shopBrowseKey({ search }, CosmeticShopSort.Newest, 60);

  it('changes with the search', () => {
    expect(key('cat')).not.toBe(key(''));
    expect(key('cat')).not.toBe(key(undefined));
  });

  it('ignores surrounding whitespace in the search', () => {
    expect(key(' cat ')).toBe(key('cat'));
  });
});
