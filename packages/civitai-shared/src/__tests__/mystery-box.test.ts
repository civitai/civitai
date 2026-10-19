import { describe, expect, it } from 'vitest';
import { modGrantSourceKey } from '../mystery-box';

describe('modGrantSourceKey', () => {
  // Granted rows will carry this shape and be found again by its prefix: changing it orphans every
  // box already granted.
  it('keeps its shape', () => {
    expect(modGrantSourceKey('g7k2', 4322372, 3)).toBe('mod-grant-g7k2-4322372-3');
  });

  // Item.sourceKey is unique: one grant to two users must not write the same key twice.
  it('gives each user of one grant their own keys', () => {
    expect(modGrantSourceKey('g7k2', 12, 1)).not.toBe(modGrantSourceKey('g7k2', 13, 1));
    expect(modGrantSourceKey('g7k2', 12, 1)).not.toBe(modGrantSourceKey('g7k2', 1, 21));
  });

  // A hyphen would let one grant's prefix match another grant's keys; `%` and `_` would widen a LIKE
  // search.
  it.each(['g-1', 'g%', 'g_1', '', 'g 1'])('refuses the grant id %j', (grantId) => {
    expect(() => modGrantSourceKey(grantId, 1, 1)).toThrow('Not a grant id');
  });

  it.each([
    [0, 1, 'Not a user id'],
    [-1, 1, 'Not a user id'],
    [2 ** 60, 1, 'Not a user id'],
    [1.5, 1, 'Not a user id'],
    [1, 0, 'Not an item number'],
    [1, 1.5, 'Not an item number'],
  ])('refuses user %d, item %d', (userId, n, message) => {
    expect(() => modGrantSourceKey('g1', userId, n)).toThrow(message);
  });
});
