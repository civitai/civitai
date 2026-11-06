import { describe, expect, it } from 'vitest';
import {
  bindingRefusal,
  evaluateRateLimitWindow,
  rateLimitMetaForRefusal,
  type RateLimit,
} from '~/server/utils/rate-limit-window';

const HOUR_MS = 60 * 60 * 1000;
const DAY_S = 24 * 60 * 60;
const NOW = Date.parse('2026-11-02T09:45:00.000Z');
const OLDEST = Date.parse('2026-11-01T10:00:00.000Z');
const NEWEST = Date.parse('2026-11-02T09:30:00.000Z');

const daily: RateLimit = { id: 'posts.daily', kind: 'product', limit: 300, period: DAY_S };

/** `count` attempts: OLDEST, NEWEST, and the rest between them, shuffled. */
function windowOf(count: number) {
  const middle = Array.from({ length: count - 2 }, (_, i) => OLDEST + HOUR_MS + i * 1000);
  return [NEWEST, ...middle.reverse(), OLDEST];
}

describe('evaluateRateLimitWindow + rateLimitMetaForRefusal', () => {
  it('a full product window: retry when the oldest ages out, reset when the newest does', () => {
    const usages = evaluateRateLimitWindow([daily], windowOf(300), NOW);
    expect(rateLimitMetaForRefusal(usages, NOW)).toEqual({
      retryAfterSeconds: 900,
      retryAt: '2026-11-02T10:00:00.000Z',
      id: 'posts.daily',
      kind: 'product',
      limit: 300,
      used: 300,
      remaining: 0,
      windowSeconds: DAY_S,
      resetAt: '2026-11-03T09:30:00.000Z',
    });
  });

  it('admits the limit-th attempt: a window holding limit - 1 passes', () => {
    const [usage] = evaluateRateLimitWindow([daily], windowOf(299), NOW);
    expect(usage).toMatchObject({ used: 299, remaining: 1, refused: false });
    expect(rateLimitMetaForRefusal([usage], NOW)).toBeUndefined();
  });

  it('after a race past the check, retry waits until enough attempts age out', () => {
    // 301 in the window: the two oldest must age out before used < 300 again.
    const attempts = windowOf(301);
    const secondOldest = [...attempts].sort((a, b) => a - b)[1];
    const meta = rateLimitMetaForRefusal(evaluateRateLimitWindow([daily], attempts, NOW), NOW);
    expect(meta?.retryAt).toBe(new Date(secondOldest + DAY_S * 1000).toISOString());
    expect(meta?.used).toBe(301);
  });

  it('an attempt exactly one window old has aged out', () => {
    const [usage] = evaluateRateLimitWindow([daily], [NOW - DAY_S * 1000, NEWEST], NOW);
    expect(usage.used).toBe(1);
  });

  it('ignores attempts older than the window', () => {
    const stale = OLDEST - DAY_S * 1000;
    const [usage] = evaluateRateLimitWindow([daily], [stale, NEWEST], NOW);
    expect(usage).toMatchObject({ used: 1, remaining: 299, nextAt: NEWEST + DAY_S * 1000 });
  });

  it('with several rules refusing, the one with the longest wait decides the whole meta', () => {
    const hourly: RateLimit = { id: 'posts.hourly', kind: 'product', limit: 3, period: 3600 };
    const attempts = [NOW - 50 * 60 * 1000, NOW - 40 * 60 * 1000, NOW - 30 * 60 * 1000];
    const tightDaily: RateLimit = { ...daily, limit: 3 };
    const usages = evaluateRateLimitWindow([hourly, tightDaily], attempts, NOW);
    // The hourly rule alone would retry in 10 minutes; the daily one holds it for a day.
    expect(bindingRefusal(usages)?.rule).toBe(tightDaily);
    expect(rateLimitMetaForRefusal(usages, NOW)).toMatchObject({
      id: 'posts.daily',
      limit: 3,
      windowSeconds: DAY_S,
      retryAt: new Date(attempts[0] + DAY_S * 1000).toISOString(),
      resetAt: new Date(attempts[2] + DAY_S * 1000).toISOString(),
    });
  });

  it('of equal waits, the first rule decides', () => {
    const a: RateLimit = { id: 'a', limit: 1, period: 60 };
    const b: RateLimit = { id: 'b', limit: 1, period: 60 };
    const usages = evaluateRateLimitWindow([a, b], [NOW - 1000], NOW);
    expect(bindingRefusal(usages)?.rule).toBe(a);
  });

  it('a limit-0 rule refuses with no retry time, even beside a rule that has one', () => {
    const gate: RateLimit = { limit: 0, period: 3600, errorMessage: 'Members only.' };
    const usages = evaluateRateLimitWindow([daily, gate], windowOf(300), NOW);
    expect(bindingRefusal(usages)?.rule).toBe(gate);
    expect(rateLimitMetaForRefusal(usages, NOW)).toBeUndefined();
  });

  it('an abuse rule (no kind) sends only id and the retry time', () => {
    const abuse: RateLimit = { id: 'planner', limit: 2, period: 600 };
    const meta = rateLimitMetaForRefusal(
      evaluateRateLimitWindow([abuse], [NOW - 120_000, NOW - 60_000], NOW),
      NOW
    );
    expect(meta).toEqual({
      retryAfterSeconds: 480,
      retryAt: new Date(NOW + 480_000).toISOString(),
      id: 'planner',
    });
  });

  it('a rule with no id sends no id', () => {
    const meta = rateLimitMetaForRefusal(
      evaluateRateLimitWindow([{ limit: 1, period: 60 }], [NOW - 1000], NOW),
      NOW
    );
    expect(meta).toEqual({ retryAfterSeconds: 59, retryAt: new Date(NOW + 59_000).toISOString() });
  });

  it('never sends a retry under one second', () => {
    const rule: RateLimit = { limit: 1, period: 60 };
    const usages = evaluateRateLimitWindow([rule], [NOW - 59_999], NOW);
    expect(rateLimitMetaForRefusal(usages, NOW)).toMatchObject({ retryAfterSeconds: 1 });
  });
});
