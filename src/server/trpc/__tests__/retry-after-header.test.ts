import { describe, expect, it } from 'vitest';
import { TRPCError } from '@trpc/server';
import { retryAfterHeader } from '~/server/trpc/retry-after-header';

const rateLimit = { retryAfterSeconds: 900, retryAt: '2030-02-03T04:20:06.000Z' };
const limited = new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'x', cause: { rateLimit } });
const one = { calls: [{}] };

describe('retryAfterHeader', () => {
  it('is the retry seconds for a single rate-limited call', () => {
    expect(retryAfterHeader({ errors: [limited], info: one })).toBe('900');
    expect(retryAfterHeader({ errors: [limited], paths: ['post.create'] })).toBe('900');
  });

  it('is absent for a batch, an unknown call count, a 429 without meta, or another error', () => {
    expect(retryAfterHeader({ errors: [limited], info: { calls: [{}, {}] } })).toBeUndefined();
    expect(retryAfterHeader({ errors: [limited] })).toBeUndefined();
    const bare = new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'x' });
    expect(retryAfterHeader({ errors: [bare], info: one })).toBeUndefined();
    const other = new TRPCError({ code: 'BAD_REQUEST', message: 'x' });
    expect(retryAfterHeader({ errors: [other], info: one })).toBeUndefined();
    expect(retryAfterHeader({ errors: [], info: one })).toBeUndefined();
  });
});
