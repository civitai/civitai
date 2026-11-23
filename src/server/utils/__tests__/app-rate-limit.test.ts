import { TRPCError } from '@trpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APP_RATE_LIMITS,
  appRateLimitBody,
  appRateLimitMeta,
  rateLimitedTrpcError,
  rateLimitMetaOfServiceError,
  retryAfterSecondsOf,
  sendAppRateLimited,
  throwAppRateLimited,
  utcDayReset,
} from '~/server/utils/app-rate-limit';
import { rateLimitMetaOf } from '~/server/utils/rate-limit-error';
import { parseRateLimitMeta } from '~/shared/utils/rate-limit-meta';

const NOW = new Date('2026-03-04T05:06:07.000Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('appRateLimitMeta', () => {
  it('an abuse limit names itself and the wait, and never its numbers', () => {
    expect(
      appRateLimitMeta('apps.catalog', 9, { limit: 150, used: 151, windowSeconds: 10 })
    ).toEqual({
      retryAfterSeconds: 9,
      retryAt: '2026-03-04T05:06:16.000Z',
      id: 'apps.catalog',
      kind: 'abuse',
    });
  });

  it('a product limit carries its counts', () => {
    expect(
      appRateLimitMeta('apps.fork-starts-hourly', 120, {
        limit: 5,
        used: 6,
        windowSeconds: 3600,
        resetAt: new Date('2026-03-04T05:08:07.000Z'),
      })
    ).toEqual({
      retryAfterSeconds: 120,
      retryAt: '2026-03-04T05:08:07.000Z',
      id: 'apps.fork-starts-hourly',
      kind: 'product',
      limit: 5,
      used: 6,
      remaining: 0,
      windowSeconds: 3600,
      resetAt: '2026-03-04T05:08:07.000Z',
    });
  });

  it('a standing product limit carries no window', () => {
    expect(appRateLimitMeta('apps.offsite-pending', 3600, { limit: 10, used: 10 })).toEqual({
      retryAfterSeconds: 3600,
      retryAt: '2026-03-04T06:06:07.000Z',
      id: 'apps.offsite-pending',
      kind: 'product',
      limit: 10,
      used: 10,
      remaining: 0,
    });
  });

  it('every meta it builds parses as a client reads it (whole retry of at least 1 s)', () => {
    for (const raw of [0, -5, 0.2, 1.5, Number.NaN]) {
      const meta = appRateLimitMeta('apps.catalog', raw);
      expect(parseRateLimitMeta(meta), String(raw)).toEqual(meta);
      expect(meta.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    }
    const product = appRateLimitMeta('apps.tip-daily', 30, { limit: 10, used: Number.NaN });
    expect(parseRateLimitMeta(product)).toEqual(product);
  });
});

describe('the refusals', () => {
  it('throwAppRateLimited throws TOO_MANY_REQUESTS whose meta the formatter lifts', () => {
    let thrown: unknown;
    try {
      throwAppRateLimited('apps.push-review', 61, 'Too many manifest edits');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TRPCError);
    expect((thrown as TRPCError).code).toBe('TOO_MANY_REQUESTS');
    expect((thrown as TRPCError).message).toBe('Too many manifest edits');
    expect(rateLimitMetaOf(thrown)).toEqual({
      retryAfterSeconds: 61,
      retryAt: '2026-03-04T05:07:08.000Z',
      id: 'apps.push-review',
      kind: 'abuse',
    });
  });

  it('rateLimitedTrpcError returns the same refusal for a mapper', () => {
    const meta = appRateLimitMeta('apps.store-item-writes', 30);
    const err = rateLimitedTrpcError(meta, 'Too many store item updates');
    expect(err.code).toBe('TOO_MANY_REQUESTS');
    expect(rateLimitMetaOf(err)).toEqual(meta);
  });

  it('rateLimitMetaOfServiceError reads a service error’s meta, and nothing else', () => {
    const meta = appRateLimitMeta('apps.build-retrigger', 60);
    expect(rateLimitMetaOfServiceError(Object.assign(new Error('x'), { rateLimit: meta }))).toEqual(
      meta
    );
    expect(rateLimitMetaOfServiceError(new Error('x'))).toBeUndefined();
    expect(
      rateLimitMetaOfServiceError(Object.assign(new Error('x'), { rateLimit: { nope: 1 } }))
    ).toBeUndefined();
  });

  it('sendAppRateLimited answers 429, Retry-After, no-store and the house body, keeping legacy fields', () => {
    const headers: Record<string, string> = {};
    const res = {
      statusCode: 0,
      body: undefined as unknown,
      setHeader(name: string, value: string) {
        headers[name] = value;
      },
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(body: unknown) {
        this.body = body;
        return this;
      },
    };
    const meta = appRateLimitMeta('apps.dev-token', 42);
    sendAppRateLimited(res as never, meta, 'Rate limit exceeded', {
      retryAfterSeconds: 42,
      limit: 10,
      code: 'should-not-win',
    });
    expect(res.statusCode).toBe(429);
    expect(headers).toEqual({ 'Retry-After': '42', 'Cache-Control': 'no-store, max-age=0' });
    expect(res.body).toEqual({
      retryAfterSeconds: 42,
      limit: 10,
      error: 'Rate limit exceeded',
      message: 'Rate limit exceeded',
      code: 'TOO_MANY_REQUESTS',
      rateLimit: {
        retryAfterSeconds: 42,
        retryAt: '2026-03-04T05:06:49.000Z',
        id: 'apps.dev-token',
        kind: 'abuse',
      },
    });
    expect(appRateLimitBody(meta, 'm')).toEqual({
      error: 'm',
      message: 'm',
      code: 'TOO_MANY_REQUESTS',
      rateLimit: meta,
    });
  });
});

describe('retry arithmetic', () => {
  it('retryAfterSecondsOf: a whole number of seconds, the fallback for a missing or spent TTL', () => {
    expect(retryAfterSecondsOf(7, 60)).toBe(7);
    expect(retryAfterSecondsOf(7.2, 60)).toBe(8);
    expect(retryAfterSecondsOf(-1, 60)).toBe(60);
    expect(retryAfterSecondsOf(-2, 60)).toBe(60);
    expect(retryAfterSecondsOf(undefined, 60)).toBe(60);
    expect(retryAfterSecondsOf('5', 60)).toBe(60);
    expect(retryAfterSecondsOf(undefined, 0)).toBe(1);
  });

  it('utcDayReset: to the next UTC midnight, at two points of the day', () => {
    expect(utcDayReset(Date.parse('2026-03-04T05:06:07.000Z'))).toEqual({
      retryAfterSeconds: 68_033,
      resetAt: new Date('2026-03-05T00:00:00.000Z'),
    });
    expect(utcDayReset(Date.parse('2026-12-31T23:59:59.500Z'))).toEqual({
      retryAfterSeconds: 1,
      resetAt: new Date('2027-01-01T00:00:00.000Z'),
    });
  });
});

describe('the id table', () => {
  it('pins each id’s kind: the product allowances, every other id abuse', () => {
    const product = Object.entries(APP_RATE_LIMITS)
      .filter(([, def]) => def.kind === 'product')
      .map(([id]) => id)
      .sort();
    expect(product).toEqual([
      'apps.fork-starts-daily',
      'apps.fork-starts-hourly',
      'apps.goods-daily',
      'apps.media-upload-daily-bytes',
      'apps.media-upload-daily-items',
      'apps.offsite-pending',
      'apps.store-items',
      'apps.tip-daily',
      'apps.version-submits',
    ]);
    for (const [id, def] of Object.entries(APP_RATE_LIMITS)) {
      expect(id, id).toMatch(/^apps\.[a-z0-9-]+$/);
      expect(['product', 'abuse'], id).toContain(def.kind);
    }
  });
});
