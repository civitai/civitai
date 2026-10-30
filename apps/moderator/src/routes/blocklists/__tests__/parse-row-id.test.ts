import { describe, expect, it } from 'vitest';
import { parseRowId } from '../form';

/**
 * `id` is a hidden form field, so every value here is something a client can actually post.
 *
 * The three outcomes are distinct and none may collapse into another: `undefined` means "no row was
 * named, act on the type", a number means "act on that row", and `null` means "refuse" — which is
 * the one the old `raw ? Number(raw) : undefined` had no way to express.
 */
describe('parseRowId', () => {
  it('reads a normal row id', () => {
    expect(parseRowId('42')).toBe(42);
  });

  it('treats an absent or empty field as no row named', () => {
    expect(parseRowId(null)).toBeUndefined();
    expect(parseRowId('')).toBeUndefined();
  });

  it('refuses a non-numeric id instead of letting NaN reach the query', () => {
    // 🔴 The regression this exists for. `Number('abc')` is NaN, and NaN is neither falsy-as-a-form
    // -value nor `undefined`, so the old coercion sent it to `where('id','=',NaN)`. `pg` serialises
    // that as the text `NaN`, Postgres answers `invalid input syntax for type integer`, and the
    // error escapes the BlocklistRowMismatchError catch as a 500.
    expect(parseRowId('abc')).toBeNull();
  });

  it('refuses values that survive Number() but are not row ids', () => {
    expect(parseRowId('1e999'), 'Infinity').toBeNull();
    expect(parseRowId('1.5'), 'non-integer').toBeNull();
    expect(parseRowId('-1'), 'negative').toBeNull();
    expect(parseRowId('0'), 'no row has id 0, and 0 used to mean "insert"').toBeNull();
  });
});
