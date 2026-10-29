import { afterEach, describe, expect, it } from 'vitest';
import { feedSecret } from './runtime';

afterEach(() => {
  delete process.env.FEED_TOKEN_SECRET;
  delete process.env.JOBS_TOKEN;
});

describe('feedSecret', () => {
  it('returns the configured key', () => {
    process.env.FEED_TOKEN_SECRET = 'key';
    expect(feedSecret()).toBe('key');
  });

  it.each([undefined, '', '  '])(
    'fails closed when the key is %j, whatever else is set',
    (value) => {
      if (value !== undefined) process.env.FEED_TOKEN_SECRET = value;
      process.env.JOBS_TOKEN = 'a-different-secret';
      expect(() => feedSecret()).toThrow(/FEED_TOKEN_SECRET/);
    }
  );
});
