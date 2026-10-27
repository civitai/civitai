import { describe, expect, it } from 'vitest';
import { nextPeriod, withoutMonthParam } from '../analytics-period';

describe('withoutMonthParam', () => {
  it('drops month and keeps the path and other params', () => {
    const next = withoutMonthParam(
      new URL('https://s.test/analytics/content/image/5?month=2026-10&tab=x#top')
    );
    expect(next?.toString()).toBe('https://s.test/analytics/content/image/5?tab=x#top');
  });
  it('is null when there is no month param, so the caller just reloads', () => {
    expect(withoutMonthParam(new URL('https://s.test/analytics/content/image/5?tab=x'))).toBeNull();
  });
});

describe('nextPeriod', () => {
  // On a ?month=2026-10 deep link the picker shows October, while the saved cookie still says June.
  const onDeepLink = { from: '2026-10-01', cmp: '2026-09' };

  it('picking only the comparison commits the deep-linked month, not the saved one', () => {
    expect(nextPeriod(onDeepLink, { cmp: '2026-07' })).toEqual({
      from: '2026-10-01',
      cmp: '2026-07',
    });
  });
  it('picking a month keeps the comparison', () => {
    expect(nextPeriod(onDeepLink, { month: '2026-08-01' })).toEqual({
      from: '2026-08-01',
      cmp: '2026-09',
    });
  });
});
