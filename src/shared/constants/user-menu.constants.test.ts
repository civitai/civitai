import { describe, expect, it } from 'vitest';
import { DEFAULT_USER_MENU_PINS, parseUserMenuDefaultPins } from './user-menu.constants';

/** The row is edited by hand in SQL, so whatever it holds must still give the menu usable pins. */
describe('parseUserMenuDefaultPins', () => {
  it('keeps the known ids in order and drops a typo or a retired id', () => {
    expect(parseUserMenuDefaultPins(['vault', 'colections', 'vault', 'downloads'])).toEqual([
      'vault',
      'downloads',
    ]);
  });

  it('falls back when the row is missing, not an array, or holds no usable id', () => {
    expect(parseUserMenuDefaultPins(undefined)).toEqual(DEFAULT_USER_MENU_PINS);
    expect(parseUserMenuDefaultPins({ pins: ['vault'] })).toEqual(DEFAULT_USER_MENU_PINS);
    expect(parseUserMenuDefaultPins(['colections'])).toEqual(DEFAULT_USER_MENU_PINS);
  });

  it('honors an empty list as no default pins', () => {
    expect(parseUserMenuDefaultPins([])).toEqual([]);
  });
});
