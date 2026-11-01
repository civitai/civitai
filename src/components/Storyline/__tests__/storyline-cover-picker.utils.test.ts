import { describe, expect, it } from 'vitest';
import { coverPickerTile } from '~/components/Storyline/storyline-cover-picker.utils';

describe('coverPickerTile', () => {
  it('shows the card cover as the portrait crop the card draws', () => {
    expect(coverPickerTile('cover', 35)).toEqual({
      ratio: '3/4',
      columnsClass: 'grid-cols-3 sm:grid-cols-4',
      focusY: undefined,
    });
  });

  it('shows the banner as the wide crop the page draws, at the banner position', () => {
    expect(coverPickerTile('banner', 35)).toEqual({
      ratio: '16/6',
      columnsClass: 'grid-cols-2 sm:grid-cols-3',
      focusY: 35,
    });
  });
});
