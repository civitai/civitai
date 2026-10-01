import { describe, expect, test } from 'vitest';
import { compactRelativeTime } from '~/components/Apps/reviewRelativeTime';

/**
 * The review queue's compact relative-age ladder.
 *
 * Every rung is asserted at its OWN boundary and at the boundary one tick below the next
 * rung, because an off-by-one in a `<` is the whole failure mode here and it is invisible
 * anywhere in the middle of a band.
 */

const NOW = new Date('2026-06-15T12:00:00.000Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** `ago` ms before NOW. Negative means the FUTURE. */
function at(ago: number): Date {
  return new Date(NOW.getTime() - ago);
}

/**
 * 🔴 EVERY `ago` IS DISTINCT AND SO IS EVERY ROW, and the `expected` values are chosen so
 * no single constant could satisfy the table — a formatter hardcoded to any one of these
 * strings fails on at least ten rows.
 */
const LADDER: { name: string; ago: number; expected: string }[] = [
  { name: 'this instant', ago: 0, expected: 'now' },
  { name: '59 seconds — the last second below a minute', ago: 59 * SECOND, expected: 'now' },
  { name: 'exactly 1 minute', ago: MINUTE, expected: '1m' },
  { name: '59 minutes — the last minute below an hour', ago: 59 * MINUTE, expected: '59m' },
  { name: 'exactly 1 hour', ago: HOUR, expected: '1h' },
  { name: '23 hours — the last hour below a day', ago: 23 * HOUR, expected: '23h' },
  { name: 'exactly 1 day', ago: DAY, expected: '1d' },
  { name: '6 days — the last day below a week', ago: 6 * DAY, expected: '6d' },
  { name: 'exactly 7 days', ago: 7 * DAY, expected: '1w' },
  { name: '29 days — the last day the week rung covers', ago: 29 * DAY, expected: '4w' },
  { name: 'exactly 30 days', ago: 30 * DAY, expected: '1mo' },
  { name: '340 days', ago: 340 * DAY, expected: '11mo' },
  {
    // The clamp: `floor(364/30)` is 12, and `12mo` is the one label a reader has to convert.
    name: '364 days — the last day below a year, which floor() would call 12mo',
    ago: 364 * DAY,
    expected: '11mo',
  },
  { name: 'exactly 365 days', ago: 365 * DAY, expected: '1y' },
  { name: '800 days', ago: 800 * DAY, expected: '2y' },
  // A submission time comes from the database and `now` from the browser, so a few
  // seconds of skew between them is ordinary.
  { name: 'five minutes in the FUTURE (clock skew)', ago: -5 * MINUTE, expected: 'now' },
];

describe('compactRelativeTime — every rung at its boundary', () => {
  test.each(LADDER)('$name → $expected', ({ ago, expected }) => {
    expect(compactRelativeTime(at(ago), NOW)).toBe(expected);
  });

  test('the ladder table is not vacuous — distinct rows, many distinct outputs', () => {
    // A table with duplicate rows inflates the count without adding coverage, and a table
    // whose rows all expect one string is satisfied by a constant.
    expect(new Set(LADDER.map((r) => r.ago)).size).toBe(LADDER.length);
    expect(new Set(LADDER.map((r) => r.expected)).size).toBeGreaterThanOrEqual(10);
  });

  test('the age STRICTLY depends on `now`, not only on the date', () => {
    // The positive control for the injected clock: the same date read a year later must
    // not produce the same label. A formatter that ignored `now` would pass every row
    // above if its fixtures all shared one instant.
    const date = at(2 * HOUR);
    expect(compactRelativeTime(date, NOW)).toBe('2h');
    expect(compactRelativeTime(date, new Date(NOW.getTime() + 400 * DAY))).toBe('1y');
  });
});

describe('compactRelativeTime — an unreadable timestamp', () => {
  test('an invalid DATE reads as unknown, never as `now`', () => {
    // `now` would be a confident lie about a row whose timestamp did not parse.
    expect(compactRelativeTime(new Date('not-a-date'), NOW)).toBe('—');
  });

  test('an invalid NOW reads as unknown too', () => {
    expect(compactRelativeTime(at(HOUR), new Date('not-a-date'))).toBe('—');
  });
});
