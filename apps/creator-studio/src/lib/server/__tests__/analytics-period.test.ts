import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cookies } from '@sveltejs/kit';
import { parseMonthParam } from '$lib/date-range';
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
  it.each([null, '', 'garbage', '2026-13', '2026-00', '2026-1', '2026-10-05', '2026-11', '2027-01'])(
    'rejects %s (absent, malformed, or a future month)',
    (p) => expect(parseMonthParam(p)).toBeNull()
  );
});

describe('readAnalyticsPeriod', () => {
  it('without a param falls back to the last completed month vs the one before', () => {
    const { range, compare } = readAnalyticsPeriod(cookiesWith());
    expect(range).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(compare.key).toBe('2026-08');
  });
  it('a valid month param overrides the cookie, comparing against the prior month', () => {
    const { range, compare } = readAnalyticsPeriod(
      cookiesWith('2026-06-01|2026-03'),
      '2026-10'
    );
    expect(range).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(compare.key).toBe('2026-09');
  });
  it('an invalid or future month param leaves the cookie in charge', () => {
    for (const bad of ['2026-11', 'nope', '']) {
      const { range, compare } = readAnalyticsPeriod(cookiesWith('2026-06-01|2026-03'), bad);
      expect(range.from).toBe('2026-06-01');
      expect(compare.key).toBe('2026-03');
    }
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
