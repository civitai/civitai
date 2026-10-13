import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

import { rateLimitMetaOf, throwSharedRateLimited } from '~/server/utils/rate-limit-error';

// Distinct from any production window.
const NOW = Date.parse('2030-02-03T04:05:06.000Z');
const RETRY_AFTER = 17;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function thrown(call: () => never): unknown {
  try {
    call();
  } catch (e) {
    return e;
  }
  throw new Error('did not throw');
}

describe('throwSharedRateLimited', () => {
  it('throws TOO_MANY_REQUESTS with the prose message and retryAt = now + retryAfterSeconds', () => {
    const err = thrown(() =>
      throwSharedRateLimited({ retryAfterSeconds: RETRY_AFTER }, 'Too many votes — retry in 17s')
    );

    expect(err).toBeInstanceOf(TRPCError);
    const trpcError = err as TRPCError;
    expect(trpcError.code).toBe('TOO_MANY_REQUESTS');
    expect(trpcError.message).toBe('Too many votes — retry in 17s');
    expect((trpcError.cause as { rateLimit?: unknown } | undefined)?.rateLimit).toEqual({
      retryAfterSeconds: RETRY_AFTER,
      retryAt: '2030-02-03T04:05:23.000Z',
    });
  });

  it('rateLimitMetaOf forwards only retryAfterSeconds and retryAt, as a copy', () => {
    const rateLimit = {
      retryAfterSeconds: RETRY_AFTER,
      retryAt: '2030-02-03T04:05:23.000Z',
      bucketKey: 'internal:4127',
    };
    const err = new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'wait', cause: { rateLimit } });

    const meta = rateLimitMetaOf(err);

    expect(meta).toStrictEqual({
      retryAfterSeconds: RETRY_AFTER,
      retryAt: '2030-02-03T04:05:23.000Z',
    });
    expect(meta).not.toBe(rateLimit);
  });

  it('carries the hour and second for a wait over an hour (3601s)', () => {
    const err = thrown(() => throwSharedRateLimited({ retryAfterSeconds: 3601 }, 'wait'));

    expect((err as TRPCError).cause).toMatchObject({
      rateLimit: { retryAfterSeconds: 3601, retryAt: '2030-02-03T05:05:07.000Z' },
    });
  });
});
