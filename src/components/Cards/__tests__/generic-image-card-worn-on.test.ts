import { describe, expect, it } from 'vitest';
import { getGenericCardWornOn } from '~/components/Cards/GenericImageCard';

/**
 * Deliberate: a profile Showcase card for a Model or Article wears THAT entity's hat, as its feed
 * card does, and its popover asks about that entity. getEntityCoverImage sends the entity's hat to
 * match. If you are about to point this back at the cover image, change both or the popover asks
 * about content the hat is not on.
 */
describe('getGenericCardWornOn', () => {
  it('names the showcased model, not its cover image', () => {
    expect(getGenericCardWornOn(50, 'Model', 2)).toEqual({ entityType: 'Model', entityId: 2 });
  });

  it('names the showcased article', () => {
    expect(getGenericCardWornOn(50, 'Article', 3)).toEqual({ entityType: 'Article', entityId: 3 });
  });

  it('names a showcased image as itself', () => {
    expect(getGenericCardWornOn(11, 'Image', 11)).toEqual({ entityType: 'Image', entityId: 11 });
  });

  it('falls back to the cover image for content that cannot wear a hat', () => {
    expect(getGenericCardWornOn(50, 'Collection', 9)).toEqual({
      entityType: 'Image',
      entityId: 50,
    });
    expect(getGenericCardWornOn(50)).toEqual({ entityType: 'Image', entityId: 50 });
  });
});
