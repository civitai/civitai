import { describe, expect, test } from 'vitest';
import { profileSongColumnWidth } from '~/components/Music/song-card.constants';

const across = (width: number) => {
  const column = profileSongColumnWidth(width);
  return { column, count: Math.floor((width + 16) / (column + 16)) };
};

describe('the profile Music tab columns', () => {
  test('four across at 1440, filling the body edge to edge (Pencil `CaAoU`)', () => {
    // 1440 minus the 320 sidebar, the layout's 12px sides and the tab's own 12px sides.
    expect(across(1072)).toEqual({ column: 256, count: 4 });
  });

  test('still four across when a scrollbar takes some of the width', () => {
    const { column, count } = across(1057);
    expect(count).toBe(4);
    expect(4 * column + 3 * 16).toBeLessThanOrEqual(1057);
  });

  test('one column as wide as a phone allows', () => {
    expect(across(342)).toEqual({ column: 342, count: 1 });
  });
});
