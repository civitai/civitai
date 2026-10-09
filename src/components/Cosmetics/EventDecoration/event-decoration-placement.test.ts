import { describe, expect, it } from 'vitest';
import {
  getEventDecorationClearLeft,
  getHatLayout,
} from '~/components/Cosmetics/EventDecoration/event-decoration-placement';
import { ITEM_BLEED } from '~/components/MasonryColumns/masonry.constants';

// Feed grids clip whatever a card paints more than ITEM_BLEED outside itself (virtual masonry's
// paint containment; home blocks' overflow:hidden with a -8px margin). A hat that reaches further
// is cropped in the feed, which is the one thing it must not be.
describe('hat placement stays inside the grid bleed', () => {
  it('corner: reaches exactly the bleed above and left of the card, no further', () => {
    const { reach } = getHatLayout('corner');
    expect(reach.top).toBeCloseTo(-ITEM_BLEED, 6);
    expect(reach.left).toBeCloseTo(-ITEM_BLEED, 6);
  });

  it('top: reaches exactly the bleed above the card', () => {
    expect(getHatLayout('top').reach.top).toBeCloseTo(-ITEM_BLEED, 6);
  });

  // Carousels clip at the slide's own edge, with no bleed to spend.
  it('inside: never leaves the card', () => {
    const { reach } = getHatLayout('inside');
    expect(reach.top).toBeGreaterThanOrEqual(0);
    expect(reach.left).toBeGreaterThanOrEqual(0);
  });

  it('corner: corner chips step clear of the whole hat', () => {
    const { reach } = getHatLayout('corner');
    expect(getEventDecorationClearLeft('hat', 'corner')).toBeGreaterThan(reach.right);
    expect(getEventDecorationClearLeft('hat', 'inside')).toBeGreaterThan(
      getHatLayout('inside').reach.right
    );
    expect(getEventDecorationClearLeft('hat', 'top')).toBe(0);
    expect(getEventDecorationClearLeft('scarf', 'corner')).toBe(0);
  });
});
