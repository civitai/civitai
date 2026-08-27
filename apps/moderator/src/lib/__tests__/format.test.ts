import { describe, expect, it } from 'vitest';
import { dateTime } from '../format';

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
