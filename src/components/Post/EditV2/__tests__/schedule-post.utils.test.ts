import { describe, expect, it } from 'vitest';
import { getDefaultScheduleDate } from '~/components/Post/EditV2/schedule-post.utils';
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
