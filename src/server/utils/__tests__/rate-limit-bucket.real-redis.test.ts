import { randomUUID } from 'crypto';
import { TRPCError } from '@trpc/server';
import { unpack } from 'msgpackr';
import type { NextApiRequest } from 'next';
import { createClient, RESP_TYPES } from 'redis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The rate limiter against a real Redis: concurrent claims on one bucket must not admit more than
 * its limit. CI's unit job runs a Redis service and sets ROSTER_REDIS_URL; elsewhere this runs only
 * when that is set, e.g.
 *   ROSTER_REDIS_URL=redis://localhost:6379/15 pnpm exec vitest run --project 'unit*' <this file>
 * Every key it writes is under a fresh name, deleted afterwards.
 *
 * `~/env/other` is mocked production-like: the limiter exempts dev/test/preview.
 */

const url = process.env.ROSTER_REDIS_URL;
// CI must run these, not skip them: a lost variable or service would otherwise read as green.
if (process.env.CI && !url)
  throw new Error('ROSTER_REDIS_URL is not set: CI runs a Redis for this');

vi.mock('~/env/other', () => ({ isDev: false, isProd: true, isTest: false, isPreview: false }));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));

const { redisMock } = await import('~/__tests__/mocks/redis.mock');
const { claimRateLimitAttempt, rateLimitBucket, readRateLimitAttempts } = await import(
  '~/server/utils/rate-limit-bucket'
);

const RUN = randomUUID().slice(0, 8);
const keyName = (name: string) => `rate-limit-real-${RUN}:${name}`;
let ip = 0;
const freshReq = () =>
  ({
    headers: { 'cf-connecting-ip': `192.0.2.${++ip}` },
    socket: { remoteAddress: '10.0.0.1' },
  } as unknown as NextApiRequest);

describe.skipIf(!url)('rate limit claims on a real Redis', () => {
  const real = createClient({ url });
  const binary = real.withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer });
  const written = new Set<string>();

  beforeAll(async () => {
    await real.connect();
    // The limiter's store calls, served by the real server.
    redisMock.redis.packed.hGet.mockImplementation(async (key: string, field: string) => {
      written.add(key);
      const value = (await binary.hGet(key, field)) as Buffer | null;
      return value == null ? null : unpack(value);
    });
    redisMock.redis.eval.mockImplementation(((script: string, options: never) =>
      real.eval(script, options)) as never);
  });
  afterAll(async () => {
    if (written.size) await real.del([...written]);
    await real.quit();
  });

  /** One call the way the tRPC middleware makes it: claim, then record. Resolves admitted or not. */
  const call = (name: string, req: NextApiRequest, limit: number) =>
    claimRateLimitAttempt({
      rules: [{ limit, period: 3600 }],
      keyName: keyName(name),
      user: undefined,
      req,
    })
      .then((record) => record())
      .then(
        () => true,
        (e: unknown) => {
          if (e instanceof TRPCError && e.code === 'TOO_MANY_REQUESTS') return false;
          throw e;
        }
      );

  const stored = (name: string, req: NextApiRequest) =>
    readRateLimitAttempts(rateLimitBucket(keyName(name), undefined, req));

  it('50 concurrent calls on one bucket with a limit of 20 admit exactly 20', async () => {
    const req = freshReq();
    const admitted = await Promise.all(Array.from({ length: 50 }, () => call('burst', req, 20)));

    expect(admitted.filter(Boolean)).toHaveLength(20);
    expect(await stored('burst', req)).toHaveLength(20);
  });

  it('12 concurrent calls under a limit of 120 are all admitted and all recorded', async () => {
    const req = freshReq();
    const admitted = await Promise.all(Array.from({ length: 12 }, () => call('under', req, 120)));

    expect(admitted.filter(Boolean)).toHaveLength(12);
    expect(await stored('under', req)).toHaveLength(12);
  });

  it('two concurrent calls with one slot left admit exactly one', async () => {
    const req = freshReq();
    expect(await call('last-slot', req, 2)).toBe(true);

    const admitted = await Promise.all([call('last-slot', req, 2), call('last-slot', req, 2)]);

    expect(admitted.filter(Boolean)).toHaveLength(1);
    expect(await stored('last-slot', req)).toHaveLength(2);
  });
});
