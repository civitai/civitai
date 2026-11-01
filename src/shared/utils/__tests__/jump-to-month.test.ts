import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  jumpToEmptyMessage,
  jumpToMonthBounds,
  jumpToMonthParam,
  jumpToMonthSchema,
  jumpToPatch,
  monthToPickerDate,
  periodPatch,
  pickerDateToMonth,
} from '~/shared/utils/jump-to-month';

afterEach(() => vi.unstubAllEnvs());

describe('jumpToMonthBounds', () => {
  it('is the UTC month, rolling December into the next year', () => {
    expect(jumpToMonthBounds('2025-12')).toEqual({
      startMs: Date.UTC(2025, 11, 1),
      endMs: Date.UTC(2026, 0, 1),
    });
  });
});

describe('jumpToMonthSchema', () => {
  it.each(['2025-13', '2025-00', '2025-3', '25-03', '2025-03-01'])('refuses %s', (month) => {
    expect(jumpToMonthSchema.safeParse(month).success).toBe(false);
  });

  it('reads junk in the URL as no jump rather than failing the parse', () => {
    expect(jumpToMonthParam.parse('garbage')).toBeUndefined();
    expect(jumpToMonthParam.parse('2025-03')).toBe('2025-03');
  });
});

// The picker hands back local midnight on the 1st. Read in UTC, that is the previous month for
// every viewer east of Greenwich.
describe.each(['Asia/Tokyo', 'America/Los_Angeles'])('picker month in %s', (tz) => {
  it('is the calendar month the viewer picked, both ways', () => {
    vi.stubEnv('TZ', tz);
    const picked = new Date(2025, 1, 1);
    expect(pickerDateToMonth(picked)).toBe('2025-02');
    expect(monthToPickerDate('2025-02')).toEqual(picked);
  });
});

// Strict: the patch merges over pending filters, so an absent key keeps the old value.
describe('jumpToPatch / periodPatch', () => {
  it('drops the relative period when a month is picked, and keeps it when the month is cleared', () => {
    expect(jumpToPatch('2025-03', 'AllTime')).toStrictEqual({
      jumpTo: '2025-03',
      period: 'AllTime',
    });
    expect(jumpToPatch(undefined, 'AllTime')).toStrictEqual({ jumpTo: undefined });
  });

  it('drops the month when a relative period is picked, and keeps it for All time', () => {
    expect(periodPatch('Week')).toStrictEqual({ period: 'Week', jumpTo: undefined });
    expect(periodPatch('AllTime')).toStrictEqual({ period: 'AllTime' });
  });
});

describe('jumpToEmptyMessage', () => {
  it('names the side of the month the feed scrolls toward', () => {
    expect(jumpToEmptyMessage('2025-03', 'Newest')).toBe('Nothing from March 2025 or earlier');
    expect(jumpToEmptyMessage('2025-03', 'Oldest')).toBe('Nothing from March 2025 or later');
  });

  it('says nothing when the jump does not apply', () => {
    expect(jumpToEmptyMessage('2025-03', 'Most Reactions')).toBeUndefined();
    expect(jumpToEmptyMessage(undefined, 'Newest')).toBeUndefined();
  });
});
