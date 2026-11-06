import { describe, expect, it } from 'vitest';
import {
  cosmeticShopSectionMeta,
  setShopItemEventTagsInput,
} from '~/server/schema/cosmetic-shop.schema';

// A section matches items by exact tag, so both sides must normalise the same way: a section saved
// as "Halloween " has to match an item tagged "halloween".
describe('event tags on shop sections and items', () => {
  it('normalises a section’s tag, and treats a blank one as none', () => {
    expect(cosmeticShopSectionMeta.parse({ eventTag: ' Halloween ' }).eventTag).toBe('halloween');
    expect(cosmeticShopSectionMeta.parse({ eventTag: '' }).eventTag).toBeUndefined();
    expect(cosmeticShopSectionMeta.safeParse({ eventTag: 'spooky season' }).success).toBe(false);
  });

  it('normalises and de-duplicates an item’s tags', () => {
    expect(
      setShopItemEventTagsInput.parse({ shopItemId: 1, eventTags: ['Halloween', 'halloween '] })
        .eventTags
    ).toEqual(['halloween']);
  });
});
