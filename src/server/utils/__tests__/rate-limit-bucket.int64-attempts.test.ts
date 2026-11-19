import { TRPCError } from '@trpc/server';
import type { NextApiRequest } from 'next';
import { unpack } from 'msgpackr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A bucket whose stored attempts are msgpack int64s. msgpackr decodes int64 as bigint, and the
 * window math cannot mix bigint with number, so the readers must hand back plain numbers.
 *
 * `~/env/other` is mocked production-like: the limiter exempts dev/test/preview.
 */

vi.mock('~/env/other', () => ({ isDev: false, isProd: true, isTest: false, isPreview: false }));
vi.mock('~/server/redis/atomic', () => ({ hSetWithTTL: vi.fn() }));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));

import { hSetWithTTL } from '~/server/redis/atomic';
import {
  __resetLocalRateLimitBucketsForTests,
  claimRateLimitAttempt,
  peekRateLimit,
  readRateLimitAttempts,
  rateLimitBucket,
} from '~/server/utils/rate-limit-bucket';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const hGet = redisMock.redis.packed.hGet;

/** A msgpack array of int64 (0xd3) entries, decoded the way the store's reader decodes it. */
function storedAsInt64(values: number[]) {
  const buf = Buffer.alloc(1 + 9 * values.length);
  buf[0] = 0x90 + values.length;
  values.forEach((v, i) => {
    buf[1 + 9 * i] = 0xd3;
    buf.writeBigInt64BE(BigInt(v), 2 + 9 * i);
  });
  return unpack(buf) as unknown[];
}

let ipCounter = 0;
const freshReq = () =>
  ({
    headers: { 'cf-connecting-ip': `198.51.100.${++ipCounter}` },
    socket: { remoteAddress: '10.0.0.1' },
  } as unknown as NextApiRequest);

const RULES = [{ limit: 3, period: 60 }];
const KEY = 'int64-attempts:test';

beforeEach(() => {
  vi.clearAllMocks();
  __resetLocalRateLimitBucketsForTests();
  vi.mocked(hSetWithTTL).mockResolvedValue(undefined as never);
});

describe('stored attempts written as int64', () => {
  it('the fixture really decodes as bigint', () => {
    expect(typeof storedAsInt64([Date.now()])[0]).toBe('bigint');
  });

  it('a full bucket refuses with TOO_MANY_REQUESTS', async () => {
    const now = Date.now();
    hGet.mockResolvedValue(storedAsInt64([now - 3000, now - 2000, now - 1000]));

    const refused = await claimRateLimitAttempt({
      rules: RULES,
      keyName: KEY,
      user: undefined,
      req: freshReq(),
    }).catch((e: unknown) => e);

    expect(refused).toBeInstanceOf(TRPCError);
    expect((refused as TRPCError).code).toBe('TOO_MANY_REQUESTS');
  });

  it('an admitted attempt writes every attempt back as a number', async () => {
    const now = Date.now();
    hGet.mockResolvedValue(storedAsInt64([now - 2000, now - 1000]));

    const record = await claimRateLimitAttempt({
      rules: RULES,
      keyName: KEY,
      user: undefined,
      req: freshReq(),
    });
    await record();

    expect(hSetWithTTL).toHaveBeenCalledTimes(1);
    const written = unpack(vi.mocked(hSetWithTTL).mock.calls[0][3] as Buffer) as unknown[];
    expect(written).toHaveLength(3);
    expect(written.slice(0, 2)).toEqual([now - 2000, now - 1000]);
    for (const x of written) expect(typeof x).toBe('number');
  });

  it('peekRateLimit reports the usage', async () => {
    const now = Date.now();
    hGet.mockResolvedValue(storedAsInt64([now - 2000, now - 1000]));

    const [usage] = await peekRateLimit({
      rules: RULES,
      sharedKey: KEY,
      user: undefined,
      req: freshReq(),
      now,
    });

    expect(usage).toMatchObject({
      used: 2,
      remaining: 1,
      refused: false,
      nextAt: now - 2000 + 60_000,
    });
  });

  it('readRateLimitAttempts returns numbers', async () => {
    const now = Date.now();
    hGet.mockResolvedValue(storedAsInt64([now - 1000, now]));

    const attempts = await readRateLimitAttempts(rateLimitBucket(KEY, undefined, freshReq()));

    expect(attempts).toEqual([now - 1000, now]);
  });
});
