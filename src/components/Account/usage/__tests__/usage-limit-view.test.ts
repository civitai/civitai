import { describe, expect, it } from 'vitest';
import {
  describeUsageLimit,
  formatWhen,
  windowCaption,
  type UsageLimitRow,
} from '~/components/Account/usage/usage-limit-view';

// 2026-11-02 21:00 UTC = 2:00 PM in Denver (MST), 6:00 AM Nov 3 in Tokyo.
const NOW = Date.parse('2026-11-02T21:00:00Z');
const DENVER = 'America/Denver';
const TOKYO = 'Asia/Tokyo';

const row = (over: Partial<UsageLimitRow>): UsageLimitRow => ({
  id: 'posts.daily',
  area: 'posts',
  label: 'Posts per day',
  limit: 300,
  used: 0,
  remaining: 300,
  windowSeconds: 86400,
  window: 'rolling',
  nextAt: null,
  resetAt: null,
  ...over,
});

describe('describeUsageLimit', () => {
  it('at the limit: full bar, the next slot and when all are free, in the viewer zone', () => {
    const full = row({
      used: 300,
      remaining: 0,
      nextAt: '2026-11-02T22:40:00Z',
      resetAt: '2026-11-03T18:05:00Z',
    });
    expect(describeUsageLimit(full, { now: NOW, timeZone: DENVER })).toEqual({
      percent: 100,
      tone: 'full',
      usedText: '300 of 300 used',
      when: '+1 at 3:40 PM',
      whenDetail: 'all free by 11:05 AM tomorrow',
    });
    // The same instant reads as Tokyo's own day: 7:40 AM today, 3:05 AM tomorrow.
    const tokyo = describeUsageLimit(full, { now: NOW, timeZone: TOKYO });
    expect(tokyo.when).toBe('+1 at 7:40 AM');
    expect(tokyo.whenDetail).toBe('all free by 3:05 AM tomorrow');
  });

  it('partly used: counts left and when all frees; warns from 70%', () => {
    const v = describeUsageLimit(
      row({ used: 212, remaining: 88, resetAt: '2026-11-03T18:05:00Z' }),
      { now: NOW, timeZone: DENVER }
    );
    expect(v).toMatchObject({
      percent: 71,
      tone: 'warn',
      usedText: '212 of 300 used · 88 left',
      when: null,
      whenDetail: 'all free by 11:05 AM tomorrow',
    });
    expect(describeUsageLimit(row({ used: 30, remaining: 270 }), { now: NOW }).tone).toBe('ok');
  });

  it('unused: no "left" suffix and no time', () => {
    expect(describeUsageLimit(row({}), { now: NOW, timeZone: DENVER })).toMatchObject({
      percent: 0,
      usedText: '0 of 300 used',
      when: null,
    });
  });

  it('a next slot already passed reads as available, not a time in the past', () => {
    const stale = row({ used: 300, remaining: 0, nextAt: '2026-11-02T20:59:00Z' });
    expect(describeUsageLimit(stale, { now: NOW, timeZone: DENVER }).when).toBe('available now');
  });

  it('a calendar month says when it resets, not a rolling next slot', () => {
    const gifts = row({
      id: 'gifts.monthly',
      area: 'gifts',
      limit: 15,
      used: 15,
      remaining: 0,
      window: 'utc-month',
      windowSeconds: null,
      nextAt: '2026-12-01T00:00:00Z',
      resetAt: '2026-12-01T00:00:00Z',
    });
    // Midnight Dec 1 UTC is still Nov 30 in Denver.
    expect(describeUsageLimit(gifts, { now: NOW, timeZone: DENVER })).toMatchObject({
      when: 'resets Nov 30',
      whenDetail: 'start of the month, UTC',
    });
    expect(describeUsageLimit(gifts, { now: NOW, timeZone: 'UTC' }).when).toBe('resets Dec 1');
  });

  it('a UTC day resets at the viewer’s local time of midnight UTC', () => {
    const v = describeUsageLimit(
      row({
        window: 'utc-day',
        used: 420,
        limit: 1200,
        remaining: 780,
        resetAt: '2026-11-03T00:00:00Z',
      }),
      { now: NOW, timeZone: DENVER }
    );
    expect(v).toMatchObject({ when: 'resets 5:00 PM', whenDetail: 'midnight UTC' });
  });

  it('a moderator’s null row reads as no limit, with no bar', () => {
    const v = describeUsageLimit(
      row({ limit: null, used: null, remaining: null, windowSeconds: null }),
      { now: NOW }
    );
    expect(v).toEqual({
      percent: null,
      tone: 'exempt',
      usedText: 'No limit',
      when: null,
      whenDetail: null,
    });
  });

  it('a limit of 0 never promises a time', () => {
    const v = describeUsageLimit(row({ limit: 0, used: 0, remaining: 0 }), { now: NOW });
    expect(v).toMatchObject({ tone: 'full', when: null });
  });
});

describe('formatWhen', () => {
  it('names a weekday within the week and a date beyond it', () => {
    expect(formatWhen(Date.parse('2026-11-05T16:00:00Z'), NOW, DENVER)).toBe('Thu 9:00 AM');
    expect(formatWhen(Date.parse('2026-11-20T16:00:00Z'), NOW, DENVER)).toBe('Nov 20');
  });
});

describe('windowCaption', () => {
  it('names one shared window, and stays vague when an area mixes them', () => {
    expect(windowCaption([row({})])).toBe('rolling 24 hours');
    expect(windowCaption([row({ windowSeconds: 3600 })])).toBe('rolling hour');
    expect(windowCaption([row({}), row({ windowSeconds: 3600 })])).toBe('rolling');
    expect(windowCaption([row({ window: 'utc-day' })])).toBe('UTC day');
    expect(windowCaption([row({}), row({ window: 'utc-month' })])).toBeNull();
  });
});
