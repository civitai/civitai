import { describe, expect, it } from 'vitest';
import { getRateLimit, retryAtText, withRetryText } from '~/utils/rate-limit';

const rateLimit = { retryAfterSeconds: 900, retryAt: '2030-02-03T16:12:00.000Z' };

describe('getRateLimit', () => {
  it('reads data.rateLimit off a client error', () => {
    expect(getRateLimit({ message: 'x', data: { code: 'TOO_MANY_REQUESTS', rateLimit } })).toEqual(
      rateLimit
    );
  });

  it('is undefined for an error without valid meta', () => {
    expect(getRateLimit(new Error('x'))).toBeUndefined();
    expect(getRateLimit({ data: { rateLimit: { retryAfterSeconds: 0 } } })).toBeUndefined();
    expect(getRateLimit(undefined)).toBeUndefined();
  });
});

describe('retryAtText', () => {
  const retryAt = new Date(rateLimit.retryAt);
  const clock = retryAt.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' });

  it('gives the local time when the retry is today', () => {
    expect(retryAtText(rateLimit, new Date(retryAt.getTime() - 60_000), 'en-US')).toBe(
      `Try again at ${clock}.`
    );
  });

  it('adds the weekday when the retry is another day', () => {
    const dayBefore = new Date(retryAt.getTime() - 26 * 60 * 60 * 1000);
    const text = retryAtText(rateLimit, dayBefore, 'en-US');
    const weekday = retryAt.toLocaleString('en-US', { weekday: 'short' });
    expect(text).toContain(weekday);
    expect(text).toContain(clock);
  });
});

describe('withRetryText', () => {
  it('adds the retry time to a message that gives none', () => {
    expect(withRetryText('Slow down.', rateLimit)).toMatch(/^Slow down\. Try again at .+\.$/);
  });

  it('leaves a message that already says when to retry, or has no meta', () => {
    expect(withRetryText('Please try again tomorrow.', rateLimit)).toBe(
      'Please try again tomorrow.'
    );
    expect(withRetryText('Too many votes — retry in 17s', rateLimit)).toBe(
      'Too many votes — retry in 17s'
    );
    expect(withRetryText('Slow down.', undefined)).toBe('Slow down.');
  });
});
