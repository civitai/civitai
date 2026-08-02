import { describe, expect, it } from 'vitest';
import { countStickerPlacements, netNewStickerPlacements } from '~/shared/utils/sticker-token';

const span = (id: number) => `<span data-type="sticker" data-id="${id}"></span>`;

describe('countStickerPlacements', () => {
  it('counts a use per placement, not per message', () => {
    expect(countStickerPlacements(':sticker:1: :sticker:2: :sticker:3:')).toEqual(
      new Map([
        [1, 1],
        [2, 1],
        [3, 1],
      ])
    );
  });

  it('counts the same sticker twice as two uses', () => {
    expect(countStickerPlacements(':sticker:1: hey :sticker:1:')).toEqual(new Map([[1, 2]]));
  });

  it('counts comment spans as well as chat tokens', () => {
    expect(countStickerPlacements(`<p>${span(4)}${span(4)}${span(5)}</p>`)).toEqual(
      new Map([
        [4, 2],
        [5, 1],
      ])
    );
  });

  it('counts legacy :emoji: placements too', () => {
    expect(countStickerPlacements(':emoji:7: :sticker:7:')).toEqual(new Map([[7, 2]]));
  });

  it('returns nothing for content without stickers', () => {
    expect(countStickerPlacements('<p>just words</p>').size).toBe(0);
  });
});

describe('netNewStickerPlacements', () => {
  it('charges everything on create', () => {
    expect(netNewStickerPlacements(`<p>${span(1)}${span(1)}</p>`)).toEqual(new Map([[1, 2]]));
  });

  it('charges only what an edit added — the empty-then-edit bypass', () => {
    expect(netNewStickerPlacements(`<p>${span(1)}${span(1)}</p>`, '<p></p>')).toEqual(
      new Map([[1, 2]])
    );
  });

  it('charges nothing when an edit changes only text', () => {
    expect(
      netNewStickerPlacements(`<p>after ${span(1)}</p>`, `<p>before ${span(1)}</p>`).size
    ).toBe(0);
  });

  it('charges the difference when an edit adds one more of the same sticker', () => {
    expect(netNewStickerPlacements(`<p>${span(1)}${span(1)}</p>`, `<p>${span(1)}</p>`)).toEqual(
      new Map([[1, 1]])
    );
  });

  it('refunds nothing when an edit removes a sticker', () => {
    expect(netNewStickerPlacements(`<p>${span(1)}</p>`, `<p>${span(1)}${span(1)}</p>`).size).toBe(
      0
    );
  });

  it('handles a swap: charges the new one, refunds nothing for the old', () => {
    expect(netNewStickerPlacements(`<p>${span(2)}</p>`, `<p>${span(1)}</p>`)).toEqual(
      new Map([[2, 1]])
    );
  });
});
