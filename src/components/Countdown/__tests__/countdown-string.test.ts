import { describe, expect, it } from 'vitest';
import { getCountdownString } from '~/components/Countdown/Countdown';
import dayjs from '~/shared/utils/dayjs';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ms = (value: number) => dayjs.duration(value, 'milliseconds');

describe('getCountdownString past a month', () => {
  it('counts every day to an event five weeks out, not the days left over after a month', () => {
    // The birthday event page on Oct 9 read "Opens to everyone in 2 days" for a Nov 11 start.
    const duration = ms(dayjs('2026-11-11T00:00:00Z').diff(dayjs('2026-10-09T00:00:00Z')));
    expect(getCountdownString(duration, 'long')).toBe('33 days');
    expect(getCountdownString(duration, 'short')).toBe('33d');
  });

  it('keeps hours and minutes exact past a month', () => {
    expect(getCountdownString(ms(33 * DAY + 5 * HOUR + 7 * MINUTE), 'short')).toBe('33d 5h 7m');
  });

  it('counts the first day past a 30.4-day month', () => {
    // The first whole day where the old getters and the total disagree.
    expect(getCountdownString(ms(31 * DAY), 'long')).toBe('31 days');
  });

  it('counts past a year in days', () => {
    expect(getCountdownString(ms(400 * DAY + 1 * HOUR), 'short')).toBe('400d 1h');
  });
});

describe('getCountdownString under a month', () => {
  // The per-unit getters this replaced, which are exact while no whole month has passed.
  const legacy = (value: number) => {
    const d = ms(value);
    return [`${d.days()}d`, `${d.hours()}h`, `${d.minutes()}m`, `${d.seconds()}s`]
      .filter((part) => !part.startsWith('0'))
      .join(' ');
  };

  it.each([
    45 * 1000,
    59 * MINUTE + 59 * 1000,
    3 * HOUR + 1 * MINUTE,
    2 * DAY + 3 * HOUR + 4 * MINUTE + 5 * 1000,
    29 * DAY + 23 * HOUR + 59 * MINUTE + 59 * 1000,
    30 * DAY + 9 * HOUR,
  ])('reads %i ms as it did before', (value) => {
    expect(getCountdownString(ms(value), 'short', true)).toBe(legacy(value));
  });

  it('reads the long format as before', () => {
    // Singular units and the list join, which the short rows above never reach.
    expect(getCountdownString(ms(1 * DAY + 1 * HOUR + 2 * MINUTE), 'long')).toBe(
      '1 day, 1 hour, and 2 minutes'
    );
  });

  it('reads a past end as Ended', () => {
    expect(getCountdownString(ms(-5 * MINUTE), 'long', true)).toBe('Ended');
  });
});
