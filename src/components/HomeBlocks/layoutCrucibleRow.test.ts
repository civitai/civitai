import { describe, expect, it } from 'vitest';
import { layoutCrucibleRow } from '~/components/HomeBlocks/useGridSlots';

const crucibles = [1, 2, 3, 4, 5, 6, 7];

describe('layoutCrucibleRow', () => {
  it('shows no tile without an event tag', () => {
    expect(layoutCrucibleRow(crucibles, undefined, 4)).toEqual({
      cards: crucibles,
      showTile: false,
    });
  });

  it('shows no tile when every crucible is hidden', () => {
    expect(layoutCrucibleRow([], 'halloween', 4)).toEqual({ cards: [], showTile: false });
  });

  it('trims a full row by one so the tile has a slot', () => {
    expect(layoutCrucibleRow(crucibles, 'halloween', 4)).toEqual({
      cards: [1, 2, 3],
      showTile: true,
    });
  });

  it('keeps every card when the row is not full or the grid scrolls', () => {
    expect(layoutCrucibleRow([1, 2], 'halloween', 4).cards).toEqual([1, 2]);
    expect(layoutCrucibleRow(crucibles, 'halloween', undefined).cards).toEqual(crucibles);
  });
});
