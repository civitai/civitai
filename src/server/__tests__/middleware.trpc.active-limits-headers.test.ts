import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest } from 'next';

/**
 * What `rateLimit()` leaves behind for the account page and for API clients:
 *  - an abuse refusal marks the user's "temporarily limited" hash, read back as a coarse area;
 *  - a product limit (admit or refusal) yields X-RateLimit-* headers on a single-call response.
 * Harness as in `middleware.trpc.rate-limit-key.test.ts`: `~/env/other` mocked to production, or
 * `claimRateLimitAttempt` exempts the call and every assertion here is vacuous.
 */

const { mockHSetWithTTL, capturedHandler } = vi.hoisted(() => ({
  mockHSetWithTTL: vi.fn(),
  capturedHandler: { handler: null as ((arg: unknown) => Promise<unknown>) | null },
}));

vi.mock('~/server/redis/atomic', () => ({ hSetWithTTL: mockHSetWithTTL }));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/trpc', () => ({
  middleware: (fn: (arg: unknown) => Promise<unknown>) => {
    capturedHandler.handler = fn;
    return fn;
  },
}));
vi.mock('~/server/services/user-preferences.service', () => ({
  getAllHiddenForUser: vi.fn(async () => ({})),
}));
vi.mock('~/server/cloudflare/client', () => ({ purgeCache: vi.fn(async () => undefined) }));
vi.mock('~/server/utils/server-domain', () => ({
  getRequestDomainColor: vi.fn(() => 'blue'),
  getRequestBoardDomainColor: vi.fn(() => 'blue'),
}));
vi.mock('~/server/utils/otel-helpers', () => ({
  withSpan: (_name: string, fn: () => unknown) => fn(),
}));
vi.mock('~/env/other', () => ({ isDev: false, isProd: true, isTest: false, isPreview: false }));
vi.mock('~/env/client', () => ({
  env: {
    NEXT_PUBLIC_BASE_URL: 'http://localhost:3000',
    NEXT_PUBLIC_CIVITAI_LINK: 'http://localhost:3000',
  },
}));

import { rateLimit } from '../middleware.trpc';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { rateLimitHeaders, setRateLimitHeaders } from '~/server/trpc/rate-limit-headers';
import { getActiveLimits } from '~/server/utils/active-rate-limits';
import type { RateLimit } from '~/server/utils/rate-limit-window';

const NOW = Date.parse('2026-11-08T12:00:00Z');
const USER = { id: 42, isModerator: false };
const ACTIVE_KEY = 'trpc:limit:active:42';

const abuse: RateLimit = { limit: 3, period: 60 };
const product: RateLimit = { id: 'posts.daily', kind: 'product', limit: 5, period: 86400 };

/** `n` attempts spread over the last `n` seconds. */
const attempts = (n: number) => Array.from({ length: n }, (_, i) => NOW - (n - i) * 1000);

async function run({
  rules,
  recorded,
  user = USER as unknown,
  path = 'reaction.toggle',
}: {
  rules: RateLimit[];
  recorded: number[];
  user?: unknown;
  path?: string;
}) {
  redisMock.redis.packed.hGet.mockResolvedValueOnce(recorded);
  rateLimit(rules);
  const handler = capturedHandler.handler;
  if (!handler) throw new Error('harness broken: no middleware handler');
  const req = { headers: {}, socket: { remoteAddress: '10.0.0.1' } } as unknown as NextApiRequest;
  const next = vi.fn(async () => ({ ok: true }));
  const error = await handler({ ctx: { user, req, ip: '10.0.0.1' }, input: undefined, path, next })
    .then(() => undefined)
    .catch((e: unknown) => e);
  return { req, next, error };
}

/** What `responseMeta` adds for a response of `calls` calls carrying `req`. */
const headersFor = (req: object, calls = 1) =>
  rateLimitHeaders({ ctx: { req }, info: { calls: Array.from({ length: calls }) } });

const activeWrites = () => mockHSetWithTTL.mock.calls.filter(([, key]) => key === ACTIVE_KEY);

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.redis.packed.hGet.mockReset();
  redisMock.redis.hGetAll.mockReset();
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  mockHSetWithTTL.mockResolvedValue(undefined);
});

describe('active abuse limits', () => {
  it('an abuse refusal is marked, and reads back as a coarse area with its retry time', async () => {
    const { error, next } = await run({ rules: [abuse], recorded: attempts(3) });
    expect(error).toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(next).not.toHaveBeenCalled();

    const writes = activeWrites();
    expect(writes).toHaveLength(1);
    const [, , field, retryAt, ttlMs] = writes[0];
    // Oldest of 3 attempts was 3 s ago in a 60 s window: free again in 57 s.
    expect(retryAt).toBe(NOW + 57_000);
    expect(ttlMs).toBe(57_000);

    redisMock.redis.hGetAll.mockResolvedValueOnce({ [field]: String(retryAt) });
    const active = await getActiveLimits(USER.id);
    expect(active).toEqual([{ area: 'reactions', retryAt: new Date(NOW + 57_000).toISOString() }]);
    // Coarse area only: the limiter key never reaches the caller.
    expect(JSON.stringify(active)).not.toContain('toggle');
    // Read from the caller's own hash.
    expect(redisMock.redis.hGetAll).toHaveBeenCalledWith(ACTIVE_KEY);
  });

  it('an entry past its retry time is hidden even before redis reaps it', async () => {
    redisMock.redis.hGetAll.mockResolvedValueOnce({
      'reaction:toggle': String(NOW - 1),
      'chat:send': String(NOW + 5_000),
    });
    expect(await getActiveLimits(USER.id)).toEqual([
      { area: 'chat', retryAt: new Date(NOW + 5_000).toISOString() },
    ]);
  });

  it('an unmapped limiter reads as "some actions", not its key', async () => {
    redisMock.redis.hGetAll.mockResolvedValueOnce({ 'secretThing:probe': String(NOW + 1_000) });
    expect(await getActiveLimits(USER.id)).toEqual([
      { area: 'some actions', retryAt: new Date(NOW + 1_000).toISOString() },
    ]);
  });

  it('nothing is marked on an admit', async () => {
    const { error, next } = await run({ rules: [abuse], recorded: attempts(1) });
    expect(error).toBeUndefined();
    expect(next).toHaveBeenCalled();
    expect(activeWrites()).toHaveLength(0);
  });

  it('nothing is marked on a product refusal', async () => {
    const { error } = await run({ rules: [product], recorded: attempts(5) });
    expect(error).toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(activeWrites()).toHaveLength(0);
  });

  it('an anonymous abuse refusal is still a 429, with nothing marked', async () => {
    const { error } = await run({ rules: [abuse], recorded: attempts(3), user: null });
    expect(error).toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(activeWrites()).toHaveLength(0);
  });

  it('a redis failure on the marker still refuses', async () => {
    mockHSetWithTTL.mockRejectedValueOnce(new Error('down'));
    const { error } = await run({ rules: [abuse], recorded: attempts(3) });
    expect(error).toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(mockHSetWithTTL).toHaveBeenCalledTimes(1); // the marker write did fail
  });
});

describe('X-RateLimit headers', () => {
  it('a single product call that is admitted reports what is left after it', async () => {
    const { req, error } = await run({
      rules: [product],
      recorded: attempts(2),
      path: 'post.create',
    });
    expect(error).toBeUndefined();
    // 2 recorded + this one = 3 of 5; the oldest (2 s ago) frees in 86398 s.
    expect(headersFor(req)).toEqual({
      'X-RateLimit-Limit': '5',
      'X-RateLimit-Remaining': '2',
      'X-RateLimit-Reset': '86398',
    });
  });

  it('a product 429 reports 0 remaining and a reset equal to the retry wait', async () => {
    const { req, error } = await run({
      rules: [product],
      recorded: attempts(5),
      path: 'post.create',
    });
    expect(error).toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(headersFor(req)).toEqual({
      'X-RateLimit-Limit': '5',
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Reset': '86395',
    });
  });

  it('a batch gets none, even with one product call in it', async () => {
    const { req } = await run({ rules: [product], recorded: attempts(2), path: 'post.create' });
    expect(headersFor(req)).toBeDefined(); // positive control
    expect(headersFor(req, 2)).toBeUndefined();
  });

  it('a response is sized from paths when info is not given', async () => {
    const { req } = await run({ rules: [product], recorded: attempts(2), path: 'post.create' });
    expect(rateLimitHeaders({ ctx: { req }, paths: ['post.create'] })).toBeDefined();
    expect(
      rateLimitHeaders({ ctx: { req }, paths: ['post.create', 'user.getUsageLimits'] })
    ).toBeUndefined();
  });

  it('two product buckets noted on one request get none', async () => {
    const { req } = await run({ rules: [product], recorded: attempts(2), path: 'post.create' });
    rateLimit([{ ...product, id: 'comments.hourly', period: 3600 }]);
    redisMock.redis.packed.hGet.mockResolvedValueOnce([]);
    await capturedHandler.handler?.({
      ctx: { user: USER, req, ip: '10.0.0.1' },
      input: undefined,
      path: 'comment.create',
      next: vi.fn(async () => ({ ok: true })),
    });
    expect(headersFor(req)).toBeUndefined();
  });

  it('report the product limit with the least left', async () => {
    const hourly: RateLimit = { id: 'posts.hourly', kind: 'product', limit: 3, period: 3600 };
    const { req } = await run({
      rules: [product, hourly],
      recorded: attempts(2),
      path: 'post.create',
    });
    // 3 of 3 hourly against 3 of 5 daily: the hourly one binds.
    expect(headersFor(req)).toEqual({
      'X-RateLimit-Limit': '3',
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Reset': '3598',
    });
  });

  it('on equal remaining, report the longer wait', async () => {
    const hourly: RateLimit = { id: 'posts.hourly', kind: 'product', limit: 5, period: 3600 };
    const { req } = await run({
      rules: [hourly, product],
      recorded: attempts(2),
      path: 'post.create',
    });
    expect(headersFor(req)).toMatchObject({
      'X-RateLimit-Remaining': '2',
      'X-RateLimit-Reset': '86398',
    });
  });

  it('an abuse rule beside a product rule never shapes them', async () => {
    const { req } = await run({
      rules: [abuse, product],
      recorded: attempts(2),
      path: 'post.create',
    });
    // The abuse rule is at 3 of 3, tighter than the product's 3 of 5, and still not reported.
    expect(headersFor(req)).toEqual({
      'X-RateLimit-Limit': '5',
      'X-RateLimit-Remaining': '2',
      'X-RateLimit-Reset': '86398',
    });
  });

  it('a refusal by a gate (limit 0) gets none: no slot ever frees', async () => {
    const gate: RateLimit = { id: 'posts.hourly', kind: 'product', limit: 0, period: 3600 };
    // Attempts on record, so the daily rule beside the gate has a slot freeing to misreport.
    const { req, error } = await run({
      rules: [gate, product],
      recorded: attempts(2),
      path: 'post.create',
    });
    expect(error).toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(headersFor(req)).toBeUndefined();
  });

  it('setRateLimitHeaders writes the same three headers on a REST response', () => {
    const setHeader = vi.fn();
    setRateLimitHeaders({ setHeader }, { limit: 5, remaining: 1, resetAt: NOW + 1500 }, NOW);
    expect(Object.fromEntries(setHeader.mock.calls)).toEqual({
      'X-RateLimit-Limit': '5',
      'X-RateLimit-Remaining': '1',
      'X-RateLimit-Reset': '2',
    });
  });

  it('abuse limits never emit them, admitted or refused', async () => {
    const admitted = await run({ rules: [abuse], recorded: attempts(1) });
    const refused = await run({ rules: [abuse], recorded: attempts(3) });
    expect(headersFor(admitted.req)).toBeUndefined();
    expect(headersFor(refused.req)).toBeUndefined();
  });
});
