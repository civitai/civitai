import { describe, expect, it } from 'vitest';
import {
  addDays,
  dayLabel,
  daysBetween,
  dayStart,
  isoWeekStart,
  nextDayStart,
  utcDay,
} from './days';

describe('days', () => {
  it('names the UTC day of an instant, whatever the host timezone', () => {
    expect(utcDay(new Date('2026-12-15T23:59:59Z'))).toBe('2026-12-15');
    expect(utcDay(new Date('2026-12-16T00:00:00Z'))).toBe('2026-12-16');
  });

  it('adds and counts days across month and year ends', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysBetween('2026-12-30', '2027-01-02')).toBe(3);
    expect(daysBetween('2026-12-15', '2026-12-15')).toBe(0);
  });

  it('starts an ISO week on Monday', () => {
    expect(isoWeekStart('2026-12-14')).toBe('2026-12-14'); // Monday
    expect(isoWeekStart('2026-12-20')).toBe('2026-12-14'); // Sunday
    expect(isoWeekStart('2026-12-21')).toBe('2026-12-21');
    expect(isoWeekStart('2027-01-01')).toBe('2026-12-28'); // a week that spans the year end
  });

  it('gives the instants a day starts and ends at', () => {
    expect(dayStart('2026-12-15').toISOString()).toBe('2026-12-15T00:00:00.000Z');
    expect(nextDayStart('2026-12-15').toISOString()).toBe('2026-12-16T00:00:00.000Z');
  });

  it('labels the previous day "yesterday" and an earlier one by date', () => {
    expect(dayLabel('2026-12-14', '2026-12-15')).toBe('yesterday');
    expect(dayLabel('2026-10-26', '2026-12-15')).toBe('on Oct 26');
  });
});
