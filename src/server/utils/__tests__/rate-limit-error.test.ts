import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

import {
  rateLimitMetaOf,
  throwRateLimited,
  throwSharedRateLimited,
} from '~/server/utils/rate-limit-error';

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

describe('throwRateLimited', () => {
  const productMeta = {
    retryAfterSeconds: 900,
    retryAt: '2030-02-03T04:20:06.000Z',
    id: 'posts.daily',
    kind: 'product' as const,
    limit: 300,
    used: 301,
    remaining: 0,
    windowSeconds: 86400,
    resetAt: '2030-02-04T04:00:00.000Z',
  };

  it('keeps the message and forwards every meta field, dropping unknown ones', () => {
    const err = thrown(() =>
      throwRateLimited({ ...productMeta, bucketKey: 'user:1' } as typeof productMeta, 'Too many')
    );

    expect((err as TRPCError).code).toBe('TOO_MANY_REQUESTS');
    expect((err as TRPCError).message).toBe('Too many');
    expect(rateLimitMetaOf(err)).toStrictEqual(productMeta);
  });

  it('drops counts from a meta that is not a product limit', () => {
    const { kind: _kind, ...withoutKind } = productMeta;
    const err = thrown(() => throwRateLimited(withoutKind, 'slow'));
    expect(rateLimitMetaOf(err)).toStrictEqual({
      retryAfterSeconds: productMeta.retryAfterSeconds,
      retryAt: productMeta.retryAt,
      id: productMeta.id,
    });
  });

  it('adds no count fields to an abuse refusal', () => {
    const err = thrown(() =>
      throwRateLimited({ retryAfterSeconds: 5, retryAt: productMeta.retryAt, id: 'x' }, 'slow')
    );
    expect(rateLimitMetaOf(err)).toStrictEqual({
      retryAfterSeconds: 5,
      retryAt: productMeta.retryAt,
      id: 'x',
    });
  });
});
