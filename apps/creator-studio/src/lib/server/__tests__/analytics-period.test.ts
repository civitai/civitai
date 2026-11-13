import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cookies } from '@sveltejs/kit';
import { formatRange, parseMonthParam } from '$lib/date-range';
import { honorsMonthParam, readAnalyticsPeriod } from '../analytics-period';

const cookiesWith = (value?: string) => ({ get: () => value }) as unknown as Cookies;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-26T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('parseMonthParam', () => {
  it('accepts the current and earlier months as full calendar months', () => {
    expect(parseMonthParam('2026-10')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(parseMonthParam('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });
  it.each([
    null,
    '',
    'garbage',
    '2026-13',
    '2026-00',
    '2026-1',
    '2026-10-05',
    '2026-11',
    '2027-01',
  ])('rejects %s (absent, malformed, or a future month)', (p) =>
    expect(parseMonthParam(p)).toBeNull()
  );
});

describe('readAnalyticsPeriod', () => {
  const at = (iso: string) => new Date(`${iso}T12:00:00Z`);

  it('without a cookie opens on the current month, compared with the same days of the month before', () => {
    const { range, compare } = readAnalyticsPeriod(cookiesWith(), null, at('2026-10-30'));
    expect(range).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(compare.key).toBe('2026-09');
    expect(compare.range).toEqual({ from: '2026-09-01', to: '2026-09-30' });
  });
  it.each([
    ['2026-10-01', '2026-09-01', '2026-09-01'],
    ['2026-10-15', '2026-09-01', '2026-09-15'],
    ['2026-10-31', '2026-09-01', '2026-09-30'],
    ['2027-03-31', '2027-02-01', '2027-02-28'],
    ['2028-03-31', '2028-02-01', '2028-02-29'],
    ['2027-01-01', '2026-12-01', '2026-12-01'],
  ])('on %s the comparison runs %s – %s (never past its own month end)', (today, from, to) => {
    const { compare } = readAnalyticsPeriod(cookiesWith(), null, at(today));
    expect(compare.range).toEqual({ from, to });
  });
  it('a saved past month wins and stays full month against full month', () => {
    const { range, compare } = readAnalyticsPeriod(
      cookiesWith('2026-08-01|2026-07'),
      null,
      at('2026-10-30')
    );
    expect(range).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    expect(compare.range).toEqual({ from: '2026-07-01', to: '2026-07-31' });
  });
  it('a saved current month, and ?month= for the current month, clip the comparison too', () => {
    const saved = readAnalyticsPeriod(cookiesWith('2026-10-01|2026-09'), null, at('2026-10-30'));
    expect(saved.compare.range).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    const deep = readAnalyticsPeriod(
      cookiesWith('2026-06-01|2026-03'),
      '2026-10',
      at('2026-10-12')
    );
    expect(deep.compare.range).toEqual({ from: '2026-09-01', to: '2026-09-12' });
    expect(deep.compare).toMatchObject({ key: '2026-09', label: 'Sep 2026' });
  });
  it('reads the day in UTC, not the machine zone', () => {
    const late = readAnalyticsPeriod(cookiesWith(), null, new Date('2026-10-15T23:30:00Z'));
    expect(late.compare.range.to).toBe('2026-09-15');
    const early = readAnalyticsPeriod(cookiesWith(), null, new Date('2026-10-16T00:30:00Z'));
    expect(early.compare.range.to).toBe('2026-09-16');
  });
  it('?month= for a past month is full against full', () => {
    const { range, compare } = readAnalyticsPeriod(cookiesWith(), '2026-09', at('2026-10-12'));
    expect(range).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(compare.range).toEqual({ from: '2026-08-01', to: '2026-08-31' });
  });
  it('an explicitly chosen older comparison month is clipped to the same day count', () => {
    const jul = readAnalyticsPeriod(cookiesWith('2026-10-01|2026-07'), null, at('2026-10-30'));
    expect(jul.compare.range).toEqual({ from: '2026-07-01', to: '2026-07-30' });
    const feb = readAnalyticsPeriod(cookiesWith('2027-03-01|2027-02'), null, at('2027-03-30'));
    expect(feb.compare.range).toEqual({ from: '2027-02-01', to: '2027-02-28' });
  });
  it('an invalid or future month param leaves the cookie in charge', () => {
    for (const bad of ['2026-11', 'nope', '']) {
      const { range, compare } = readAnalyticsPeriod(cookiesWith('2026-06-01|2026-03'), bad);
      expect(range.from).toBe('2026-06-01');
      expect(compare.key).toBe('2026-03');
    }
  });
});

describe('formatRange', () => {
  it('a part month reads through today, a finished month through its last day', () => {
    expect(
      formatRange({ from: '2026-10-01', to: '2026-10-31' }, new Date('2026-10-30T12:00:00Z'))
    ).toBe('Oct 1, 2026 – Oct 30, 2026');
    expect(
      formatRange({ from: '2026-09-01', to: '2026-09-30' }, new Date('2026-10-30T12:00:00Z'))
    ).toBe('Sep 1, 2026 – Sep 30, 2026');
  });
});

describe('honorsMonthParam', () => {
  it.each([
    '/(app)/analytics/content/image/[imageId]',
    '/(app)/analytics/content/article/[articleId]',
    '/(app)/analytics/content/comic/[projectId]',
  ])('is on for %s', (id) => expect(honorsMonthParam(id)).toBe(true));
  it.each([
    null,
    '/(app)/analytics',
    '/(app)/analytics/content',
    '/(app)/earnings',
    '/(app)/analytics/models/[modelId]',
    '/(app)/analytics/content/image/[imageId]/reactors',
  ])('is off for %s', (id) => expect(honorsMonthParam(id)).toBe(false));
});
