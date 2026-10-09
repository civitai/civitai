import { describe, expect, it } from 'vitest';
import {
  getEventDecorationClearLeft,
  getHatLayout,
} from '~/components/Cosmetics/EventDecoration/event-decoration-placement';
import type { HatPlacement } from '~/components/Cosmetics/EventDecoration/event-decoration-placement';
import { ITEM_BLEED } from '~/components/MasonryColumns/masonry.constants';
import type { EventDecorationFit } from '~/shared/constants/event-decoration.constants';

// Real shapes from the art exploration (384px square canvases, alpha bounds measured), plus the
// default convention. Wide, tall and squat art must all land the same distance past the edge.
const SHAPES: Record<string, EventDecorationFit | undefined> = {
  default: undefined,
  tallCone: { canvas: [384, 384], bounds: [58, 1, 326, 383] },
  wideCrown: { canvas: [384, 384], bounds: [1, 53, 383, 383] },
  squatSombrero: { canvas: [384, 384], bounds: [1, 144, 383, 383] },
  leaningLeft: { canvas: [384, 384], bounds: [2, 40, 382, 382], tilt: -40, size: 40 },
};

// Feed grids clip whatever a card paints more than ITEM_BLEED outside itself (virtual masonry's
// paint containment; home blocks' overflow:hidden with a -8px margin). A hat that reaches further
// is cropped in the feed, which is the one thing it must not be.
describe.each(Object.entries(SHAPES))('hat placement for %s art', (_, fit) => {
  it('corner: reaches exactly the bleed above and left of the card, no further', () => {
    const { reach } = getHatLayout('corner', fit);
    expect(reach.top).toBeCloseTo(-ITEM_BLEED, 6);
    expect(reach.left).toBeCloseTo(-ITEM_BLEED, 6);
  });

  it('top: reaches exactly the bleed above the card', () => {
    expect(getHatLayout('top', fit).reach.top).toBeCloseTo(-ITEM_BLEED, 6);
  });

  // Carousels clip at the slide's own edge, with no bleed to spend.
  it('inside: never leaves the card', () => {
    const { reach } = getHatLayout('inside', fit);
    expect(reach.top).toBeGreaterThanOrEqual(0);
    expect(reach.left).toBeGreaterThanOrEqual(0);
  });

  it.each<HatPlacement>(['corner', 'inside'])(
    '%s: corner chips step clear of the whole hat',
    (placement) => {
      const clear = getEventDecorationClearLeft({ type: 'hat', fit }, placement);
      expect(clear).toBeGreaterThan(getHatLayout(placement, fit).reach.right);
    }
  );
});

describe('getEventDecorationClearLeft', () => {
  it('is zero where nothing sits on the corner', () => {
    expect(getEventDecorationClearLeft({ type: 'hat' }, 'top')).toBe(0);
    expect(getEventDecorationClearLeft({ type: 'scarf' }, 'corner')).toBe(0);
  });
});

describe('fit data that does not describe real art', () => {
  it('falls back to the default convention instead of producing NaN', () => {
    const broken = { bounds: [10, 10, 5, 5], canvas: ['a', 2], size: -3 } as never;
    expect(getHatLayout('corner', broken)).toEqual(getHatLayout('corner'));
  });
});
