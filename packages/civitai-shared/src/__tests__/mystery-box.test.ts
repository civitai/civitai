import { describe, expect, it } from 'vitest';
import { MOD_GRANT_SOURCE_PREFIX, modGrantSourceKey } from '../mystery-box';

describe('modGrantSourceKey', () => {
  // Rows already written carry this shape, and the moderator app finds granted boxes by the prefix.
  it('keeps its shape', () => {
    expect(modGrantSourceKey('g7k2', 4322372, 3)).toBe('mod-grant-g7k2-4322372-3');
    expect(modGrantSourceKey('g7k2', 1, 1).startsWith(MOD_GRANT_SOURCE_PREFIX)).toBe(true);
  });

  // Item.sourceKey is unique: one grant to two users must not write the same key twice.
  it('gives each user of one grant their own keys', () => {
    expect(modGrantSourceKey('g7k2', 12, 1)).not.toBe(modGrantSourceKey('g7k2', 13, 1));
    expect(modGrantSourceKey('g7k2', 12, 1)).not.toBe(modGrantSourceKey('g7k2', 1, 21));
  });

  // A hyphen would let two grants' keys meet; `%` and `_` would widen a prefix search.
  it.each(['g-1', 'g%', 'g_1', '', 'g 1'])('refuses the grant id %j', (grantId) => {
    expect(() => modGrantSourceKey(grantId, 1, 1)).toThrow('Not a grant id');
  });

  it.each([
    [0, 1],
    [1, 0],
    [1.5, 1],
    [1, -1],
  ])('refuses user %d, item %d', (userId, n) => {
    expect(() => modGrantSourceKey('g1', userId, n)).toThrow();
  });
});
