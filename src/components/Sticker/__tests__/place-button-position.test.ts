import { describe, expect, it } from 'vitest';
import type { Box } from '~/components/Sticker/place-button-position';
import { shouldFlipPlaceButton } from '~/components/Sticker/place-button-position';

const BUTTON_HEIGHT = 36;
const GAP = 8;

/** A tray the size of the real one: full width, bottom of a 900px viewport. */
const TRAY: Box = { top: 760, bottom: 900, left: 0, right: 1400 };

const decide = (sticker: Box, tray: Box | null = TRAY) =>
  shouldFlipPlaceButton({ sticker, tray, buttonHeight: BUTTON_HEIGHT, gap: GAP });

describe('shouldFlipPlaceButton', () => {
  it('leaves the button below a sticker clear of the tray', () => {
    expect(decide({ top: 200, bottom: 400, left: 600, right: 800 })).toBe(false);
  });

  it('flips a sticker whose button would land under the tray', () => {
    // At bottom 716 the button occupies 724-760 and stops exactly where the tray
    // starts; one pixel lower is the first position that is actually covered.
    expect(decide({ top: 516, bottom: 716, left: 600, right: 800 })).toBe(false);
    expect(decide({ top: 517, bottom: 717, left: 600, right: 800 })).toBe(true);
  });

  it('does not flip when the sticker is beside the tray rather than above it', () => {
    const narrowTray: Box = { top: 760, bottom: 900, left: 500, right: 900 };
    expect(decide({ top: 550, bottom: 750, left: 100, right: 300 }, narrowTray)).toBe(false);
    expect(decide({ top: 550, bottom: 750, left: 600, right: 800 }, narrowTray)).toBe(true);
  });

  it('leaves the button alone when there is no room above the sticker', () => {
    // Overlaps the tray, but flipping would put the button off the top of the
    // viewport. A covered button beats one that is not on screen at all.
    expect(decide({ top: 30, bottom: 755, left: 600, right: 800 })).toBe(false);
    expect(decide({ top: 44, bottom: 755, left: 600, right: 800 })).toBe(true);
  });

  it('does nothing without a tray on screen', () => {
    expect(decide({ top: 517, bottom: 717, left: 600, right: 800 }, null)).toBe(false);
  });

  it('does not depend on where the button currently is, so it cannot oscillate', () => {
    // The decision is a function of the sticker box alone. Were it measured from
    // the button's live position, flipping would clear the overlap and the next
    // measurement would flip it back, once per pointer move for a whole drag.
    const sticker: Box = { top: 517, bottom: 717, left: 600, right: 800 };

    const flipped = decide(sticker);
    expect(flipped).toBe(true);
    expect(decide(sticker)).toBe(flipped);
    expect(decide(sticker)).toBe(flipped);
  });

  it('treats a zero-height button as nothing to place', () => {
    expect(
      shouldFlipPlaceButton({
        sticker: { top: 517, bottom: 717, left: 600, right: 800 },
        tray: TRAY,
        buttonHeight: 0,
        gap: GAP,
      })
    ).toBe(false);
  });
});
