import { describe, expect, it } from 'vitest';
import { parseRateLimitMeta } from '~/shared/utils/rate-limit-meta';

const base = { retryAfterSeconds: 900, retryAt: '2030-02-03T04:20:06.000Z' };

describe('parseRateLimitMeta', () => {
  it('passes the product fields through', () => {
    const meta = {
      ...base,
      id: 'posts.daily',
      kind: 'product',
      limit: 300,
      used: 301,
      remaining: 0,
      windowSeconds: 86400,
      resetAt: '2030-02-04T04:00:00.000Z',
    };
    expect(parseRateLimitMeta(meta)).toStrictEqual(meta);
  });

  it('drops a malformed optional field on its own and strips unknown keys', () => {
    expect(
      parseRateLimitMeta({
        ...base,
        id: '',
        kind: 'premium',
        limit: -1,
        used: 1.5,
        remaining: '3',
        resetAt: 'soon',
        bucketKey: 'user:1',
      })
    ).toStrictEqual(base);
  });

  it('still rejects the whole meta when a required field is malformed', () => {
    expect(
      parseRateLimitMeta({ ...base, retryAfterSeconds: 0, id: 'posts.daily' })
    ).toBeUndefined();
    expect(parseRateLimitMeta({ ...base, retryAt: 'later' })).toBeUndefined();
  });
});
