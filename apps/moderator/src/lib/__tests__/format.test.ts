import { describe, expect, it } from 'vitest';
import { dateTime, plural } from '../format';

/**
 * These call `Intl` for real rather than asserting a rendered string: the defect they cover is a
 * TypeError thrown at call time, and every locale/zone renders the output differently.
 *
 * ECMA-402 rejects `dateStyle`/`timeStyle` combined with any individual component, so pairing either
 * with `timeZoneName` throws `TypeError: Invalid option : option` on every single call. TypeScript's
 * `Intl.DateTimeFormatOptions` allows the combination, so nothing but a runtime call catches it —
 * and `dateTime` has ~60 callers, which is a blank moderator page each.
 */
describe('dateTime', () => {
  it.each([
    ['an ISO string', '2026-08-27T19:36:00Z'],
    ['a Date', new Date('2026-08-27T19:36:00Z')],
    ['a ClickHouse-shaped string', '2026-08-27 19:36:00'],
  ])('formats %s without throwing', (_label, value) => {
    const result = dateTime(value as Date | string);
    expect(result).toBeTypeOf('string');
    expect(result).not.toBe('—');
  });

  it('names the zone it rendered in', () => {
    // The point of the format: a bare "1:36 PM" is what two moderators read as different times.
    expect(dateTime('2026-08-27T19:36:00Z')).toMatch(/\d/);
    expect(dateTime('2026-08-27T19:36:00Z').replace(/[\d\s:,]/g, '')).not.toBe('');
  });

  it('renders an em dash for a missing value', () => {
    expect(dateTime(null)).toBe('—');
  });
});

/**
 * The three failures this replaces, all of which this app has shipped by hand-rolling the ternary:
 * `1 items`, a four-figure count printed as raw digits beside a `1,000` from `num` on the same
 * screen, and a noun a bare `s` gets wrong.
 */
describe('plural', () => {
  it.each([
    [0, '0 findings'],
    [1, '1 finding'],
    [2, '2 findings'],
  ])('agrees with %i', (count, expected) => {
    expect(plural(count, 'finding')).toBe(expected);
  });

  it('takes an irregular plural where -s is wrong', () => {
    expect(plural(3, 'entry', 'entries')).toBe('3 entries');
  });

  it('carries a verb as readily as a noun', () => {
    // `${n} ${n === 1 ? 'is' : 'are'}` is the other shape written by hand here.
    expect(plural(1, 'is')).toBe('1 is');
    expect(plural(2, 'is', 'are')).toBe('2 are');
  });

  it('formats the count rather than printing raw digits', () => {
    // Asserted as "not the raw number", not as a literal: `num` is locale-aware, so a literal
    // `12,345` would pin this suite to one machine's locale. Restating `toLocaleString()` in the
    // expectation would be worse — it derives the answer from the implementation and then passes
    // whatever that implementation does.
    const out = plural(12345, 'finding');
    expect(out).not.toBe('12345 findings');
    expect(out.endsWith(' findings')).toBe(true);
    expect(out).toMatch(/^\d[\d\s,.  ]*\d findings$/);
  });
});
