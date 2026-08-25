import { describe, expect, it } from 'vitest';
import { wholeRows } from '~/components/StickerBook/sticker-book.util';

/**
 * The tab's whole-rows trim, tested as arithmetic.
 *
 * Deliberately NOT a component test. The column count reaches the grid from a
 * ResizeObserver behind a 100ms debounce, and component tests load no
 * stylesheet — so "at this viewport, expect N cards" would measure an unstyled
 * width and assert a lie. The contract has no width in it.
 */
describe('wholeRows', () => {
  it('drops the part-filled last row', () => {
    // 14 and 4, NOT 8 and 4: at 8 the floor-arithmetic and a naive
    // `slice(0, columnCount * 2)` agree, so a two-row fixture cannot tell a
    // correct implementation from one that only ever draws two rows.
    expect(wholeRows([...Array(14).keys()], 4)).toEqual([...Array(12).keys()]);
  });

  it('keeps an exact multiple whole', () => {
    expect(wholeRows([...Array(14).keys()], 7)).toHaveLength(14);
  });

  it('keeps everything when there are FEWER items than columns', () => {
    // Without this guard the result is `[]`, and an empty grid renders
    // "Everything here is from creators you have hidden." to a viewer who has
    // hidden nobody — a wrong and alarming message on any small section.
    expect(wholeRows([1, 2, 3], 4)).toEqual([1, 2, 3]);
  });

  it('passes everything through before the container has measured', () => {
    // `columnCount` is 0 until the resize observer fires. Unguarded,
    // `Math.floor(n / 0) * 0` is NaN and `slice(0, NaN)` is `[]` — the same
    // wrong message, on every first paint.
    expect(wholeRows([1, 2, 3, 4, 5], 0)).toEqual([1, 2, 3, 4, 5]);
  });

  it('draws every complete row, not just the first', () => {
    expect(wholeRows([...Array(14).keys()], 3)).toHaveLength(12);
  });
});
