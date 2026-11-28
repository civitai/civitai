import { describe, expect, test } from 'vitest';
import {
  PROFILE_SONG_SIDE_PADDING,
  profileSongColumnWidth,
} from '~/components/Music/song-card.constants';

const across = (width: number) => {
  const column = profileSongColumnWidth(width);
  return { column, count: Math.floor((width + 16) / (column + 16)) };
};

describe('the profile Music tab columns', () => {
  test('four across at 1440, filling the body edge to edge (Pencil `CaAoU`)', () => {
    // The sidebar is 320 wide; the profile body has `px-3` sides and the tab its own padding.
    expect(across(1440 - 320 - 2 * 12 - 2 * PROFILE_SONG_SIDE_PADDING)).toEqual({
      column: 256,
      count: 4,
    });
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
