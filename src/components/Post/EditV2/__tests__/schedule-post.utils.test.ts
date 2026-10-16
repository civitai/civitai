import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  formatScheduleTime,
  getDefaultScheduleDate,
  withScheduleDay,
  withScheduleTime,
} from '~/components/Post/EditV2/schedule-post.utils';
import { POST_MINIMUM_SCHEDULE_MINUTES } from '~/server/common/constants';

const at = (iso: string) => new Date(iso);

describe('getDefaultScheduleDate', () => {
  it.each([
    ['2026-10-01T12:00:00.000Z', '2026-10-01T12:15:00.000Z'],
    ['2026-10-01T12:00:00.001Z', '2026-10-01T12:20:00.000Z'],
    ['2026-10-01T12:03:30.000Z', '2026-10-01T12:20:00.000Z'],
    ['2026-10-01T12:04:59.999Z', '2026-10-01T12:20:00.000Z'],
    ['2026-10-01T23:52:00.000Z', '2026-10-02T00:10:00.000Z'],
  ])('from %s defaults to %s', (now, expected) => {
    expect(getDefaultScheduleDate(at(now)).toISOString()).toBe(expected);
  });

  // The modal's schema rejects anything under the minimum, so a default inside it is
  // an error the user sees before touching the picker.
  it('always clears the schedule minimum', () => {
    for (let second = 0; second < 10 * 60; second += 7) {
      const now = new Date(Date.UTC(2026, 9, 1, 12, 0, second, 123));
      const earliest = now.getTime() + POST_MINIMUM_SCHEDULE_MINUTES * 60 * 1000;
      expect(getDefaultScheduleDate(now).getTime()).toBeGreaterThanOrEqual(earliest);
    }
  });
});

// The modal schedules in the user's local timezone. Pin a non-UTC zone (EDT, UTC-4 in October)
// and assert in ISO, so a helper that used the UTC setters/getters fails here on a UTC host too.
let originalTz: string | undefined;
beforeAll(() => {
  originalTz = process.env.TZ;
  process.env.TZ = 'America/New_York';
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

const local = (...parts: [number, number, number, number?, number?, number?]) =>
  new Date(parts[0], parts[1], parts[2], parts[3] ?? 0, parts[4] ?? 0, parts[5] ?? 0);

describe('timezone fixture', () => {
  it('runs these tests outside UTC', () => {
    expect(local(2026, 9, 6, 21, 15).toISOString()).toBe('2026-10-07T01:15:00.000Z');
  });
});

describe('withScheduleDay', () => {
  it('moves to the picked day and keeps the chosen time', () => {
    const current = local(2026, 9, 6, 21, 15);
    expect(withScheduleDay(current, local(2026, 9, 9)).toISOString()).toBe(
      '2026-10-10T01:15:00.000Z'
    );
    expect(current.toISOString()).toBe('2026-10-07T01:15:00.000Z');
  });

  // Setting month then day separately would roll Jan 31 → Mar 3 before the day lands.
  it('moves from the 31st into a shorter month', () => {
    expect(withScheduleDay(local(2026, 0, 31, 21, 15), local(2026, 1, 15)).toISOString()).toBe(
      '2026-02-16T02:15:00.000Z'
    );
  });

  it('crosses a year', () => {
    expect(withScheduleDay(local(2026, 11, 31, 9, 0), local(2027, 0, 2)).toISOString()).toBe(
      '2027-01-02T14:00:00.000Z'
    );
  });
});

describe('withScheduleTime', () => {
  it('sets the local time from a native time input value on the same day', () => {
    expect(withScheduleTime(local(2026, 9, 6, 21, 15), '08:05').toISOString()).toBe(
      '2026-10-06T12:05:00.000Z'
    );
  });

  it('drops seconds when the input reports them', () => {
    expect(withScheduleTime(local(2026, 9, 6, 21, 15, 42), '09:30:00').toISOString()).toBe(
      '2026-10-06T13:30:00.000Z'
    );
  });

  it.each(['', '09', '09:'])('keeps the current value for an incomplete input %j', (time) => {
    const current = local(2026, 9, 6, 21, 15);
    expect(withScheduleTime(current, time)).toBe(current);
  });
});

describe('formatScheduleTime', () => {
  it('formats the local time as the 24-hour HH:mm a time input expects', () => {
    expect(formatScheduleTime(new Date('2026-10-06T11:03:00.000Z'))).toBe('07:03');
    expect(formatScheduleTime(new Date('2026-10-07T01:15:00.000Z'))).toBe('21:15');
  });
});
