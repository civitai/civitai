import { TRPCError } from '@trpc/server';
import type { NextApiRequest } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The rate limiter when its store (the cluster cache) is unavailable.
 *
 * A read that rejects, or one that was sent and never answered, must neither fail the request nor
 * switch the limit off: the limiter counts attempts in this process instead, so a caller is still
 * refused past the limit — per pod, until the store answers again — and the request is decided
 * within the cache-read deadline, not the client's 15s backstop.
 *
 * `~/env/other` is mocked production-like: the limiter exempts dev/test/preview, so without it the
 * body under test never runs.
 */

vi.mock('~/env/other', () => ({ isDev: false, isProd: true, isTest: false, isPreview: false }));
vi.mock('~/server/redis/atomic', () => ({ hSetWithTTL: vi.fn() }));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));

import { hSetWithTTL } from '~/server/redis/atomic';
import {
  __localRateLimitBucketCountForTests,
  __resetLocalRateLimitBucketsForTests,
  claimRateLimitAttempt,
  readRateLimitAttempts,
  rateLimitBucket,
} from '~/server/utils/rate-limit-bucket';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const hGet = redisMock.redis.packed.hGet;
const HUNG = Symbol('hung');
const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<typeof HUNG>((r) => setTimeout(() => r(HUNG), ms))]);

let ipCounter = 0;
/** A distinct client address per test, so one test's local attempts never reach another's bucket. */
const freshReq = () =>
  ({
    headers: { 'cf-connecting-ip': `203.0.113.${++ipCounter}` },
    socket: { remoteAddress: '10.0.0.1' },
  } as unknown as NextApiRequest);

const RULES = [{ limit: 3, period: 60 }];

async function attempt(req: NextApiRequest, keyName = 'store-down:test') {
  const record = await claimRateLimitAttempt({ rules: RULES, keyName, user: undefined, req });
  await record();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  __resetLocalRateLimitBucketsForTests();
  vi.mocked(hSetWithTTL).mockResolvedValue(undefined as never);
});

describe('claimRateLimitAttempt with the store unavailable', () => {
  it('a rejecting store admits callers up to the limit, then refuses with TOO_MANY_REQUESTS', async () => {
    hGet.mockRejectedValue(new Error('cluster down'));
    const req = freshReq();

    for (let i = 0; i < 3; i++) await expect(attempt(req)).resolves.toBeUndefined();

    const refused = await attempt(req).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(TRPCError);
    expect((refused as TRPCError).code).toBe('TOO_MANY_REQUESTS');
  });

  it('a store that never answers decides each attempt within 750ms and still refuses past the limit', async () => {
    hGet.mockImplementation(() => new Promise(() => undefined));
    const req = freshReq();

    for (let i = 0; i < 3; i++) {
      const started = Date.now();
      const outcome = await within(attempt(req), 2000);
      expect(outcome).not.toBe(HUNG);
      expect(Date.now() - started).toBeLessThan(750);
    }

    const refused = await within(
      attempt(req).catch((e: unknown) => e),
      2000
    );
    expect(refused).toBeInstanceOf(TRPCError);
    expect((refused as TRPCError).code).toBe('TOO_MANY_REQUESTS');
  });

  it('counts each caller separately: another address is still admitted', async () => {
    hGet.mockRejectedValue(new Error('cluster down'));
    const a = freshReq();
    const b = freshReq();

    for (let i = 0; i < 3; i++) await attempt(a);
    await expect(attempt(a)).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    await expect(attempt(b)).resolves.toBeUndefined();
  });

  it("drops a bucket's local count once the store answers for THAT bucket", async () => {
    const req = freshReq();
    hGet.mockRejectedValue(new Error('cluster down'));
    for (let i = 0; i < 3; i++) await attempt(req);
    await expect(attempt(req)).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });

    hGet.mockResolvedValue([]); // the store is back, and answers for this bucket
    await attempt(req);

    hGet.mockRejectedValue(new Error('cluster down again'));
    await expect(attempt(req)).resolves.toBeUndefined();
  });

  it("partial outage: another bucket's successful reads do not reset a failing bucket's count", async () => {
    // Bucket A's reads keep failing (its shard is down); bucket B's are answered.
    hGet.mockImplementation(async (cacheKey: string) => {
      if (String(cacheKey).endsWith(':shard-down')) throw new Error('shard down');
      return [];
    });
    const a = freshReq();
    const b = freshReq();

    for (let i = 0; i < 3; i++) {
      await expect(attempt(a, 'store-down:shard-down')).resolves.toBeUndefined();
      await expect(attempt(b, 'store-down:shard-up')).resolves.toBeUndefined();
    }
    await expect(attempt(b, 'store-down:shard-up')).resolves.toBeUndefined();

    await expect(attempt(a, 'store-down:shard-down')).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
  });
});

describe('the local fallback count holds bounded memory', () => {
  it('past the bucket cap the least recently written bucket is dropped, and only that one', async () => {
    __resetLocalRateLimitBucketsForTests({ maxBuckets: 3 });
    hGet.mockRejectedValue(new Error('cluster down'));
    const one = [{ limit: 1, period: 60 }];
    const once = async (req: NextApiRequest) =>
      (await claimRateLimitAttempt({ rules: one, keyName: 'cap:test', user: undefined, req }))();
    const [r1, r2, r3, r4] = [freshReq(), freshReq(), freshReq(), freshReq()];

    for (const r of [r1, r2, r3]) await once(r);
    expect(__localRateLimitBucketCountForTests()).toBe(3);
    await once(r4); // a fourth bucket: r1's, the oldest, goes

    expect(__localRateLimitBucketCountForTests()).toBe(3);
    await expect(once(r2)).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    await expect(once(r1)).resolves.toBeUndefined();
  });

  it("a bucket ages out once its newest attempt is older than the bucket's window", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = new Date('2026-01-01T00:00:00Z').getTime();
    vi.setSystemTime(t0);
    hGet.mockRejectedValue(new Error('cluster down'));

    await attempt(freshReq()); // window 60s
    expect(__localRateLimitBucketCountForTests()).toBe(1);

    // Past the window and the sweep interval, the next local write sweeps the expired bucket.
    vi.setSystemTime(t0 + 61_000 + 60_000);
    await attempt(freshReq());
    expect(__localRateLimitBucketCountForTests()).toBe(1);
  });
});

describe('readRateLimitAttempts (the usage report) with the store unavailable', () => {
  const bucket = () => rateLimitBucket('peek:test', undefined, freshReq());

  it("a rejecting read rejects with the store's own error", async () => {
    const cause = new Error('cluster down');
    hGet.mockRejectedValue(cause);
    await expect(readRateLimitAttempts(bucket())).rejects.toBe(cause);
  });

  it('a read that never answers rejects within 750ms', async () => {
    hGet.mockImplementation(() => new Promise(() => undefined));
    const started = Date.now();
    const outcome = await within(
      readRateLimitAttempts(bucket()).then(
        () => 'resolved',
        (e: unknown) => e
      ),
      2000
    );
    expect(outcome).not.toBe(HUNG);
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).not.toBe('resolved');
    expect(Date.now() - started).toBeLessThan(750);
  });
});
