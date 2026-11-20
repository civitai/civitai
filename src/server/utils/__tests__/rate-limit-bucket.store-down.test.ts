import { TRPCError } from '@trpc/server';
import type { NextApiRequest } from 'next';
import { unpack } from 'msgpackr';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

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
  FAIL_CLOSED_RATE_LIMIT_SCOPES,
  mergeAttempts,
  readRateLimitAttempts,
  rateLimitBucket,
} from '~/server/utils/rate-limit-bucket';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const hGet = redisMock.redis.packed.hGet;
const HUNG = Symbol('hung');
/** Under fake timers: what `p` settled to within `ms` of clock time, or HUNG. */
const within = async <T>(p: Promise<T>, ms: number): Promise<T | unknown> => {
  let outcome: T | unknown = HUNG;
  p.then(
    (v) => (outcome = v),
    (e: unknown) => (outcome = e)
  );
  await vi.advanceTimersByTimeAsync(ms);
  return outcome;
};

let ipCounter = 0;
/** A distinct client address per test, so one test's local attempts never reach another's bucket. */
const freshReq = () =>
  ({
    headers: { 'cf-connecting-ip': `203.0.113.${++ipCounter}` },
    socket: { remoteAddress: '10.0.0.1' },
  } as unknown as NextApiRequest);

const RULES = [{ limit: 3, period: 60 }];

async function attempt(req: NextApiRequest, keyName = 'store-down:test', rules = RULES) {
  const record = await claimRateLimitAttempt({ rules, keyName, user: undefined, req });
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
    vi.useFakeTimers();
    hGet.mockImplementation(() => new Promise(() => undefined));
    const req = freshReq();

    for (let i = 0; i < 3; i++) {
      expect(await within(attempt(req), 750)).toBeUndefined();
    }

    const refused = await within(attempt(req), 750);
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

  it('once the store answers, the attempts counted locally are carried into its write', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = new Date('2026-01-01T00:00:00Z').getTime();
    const req = freshReq();
    hGet.mockRejectedValue(new Error('cluster down'));
    vi.setSystemTime(t0 + 1_000);
    await attempt(req);
    vi.setSystemTime(t0 + 2_000);
    await attempt(req);

    hGet.mockResolvedValue([t0 - 5_000]); // the store is back with one attempt it did see
    vi.setSystemTime(t0 + 3_000);
    await attempt(req, undefined, [{ limit: 5, period: 60 }]);

    expect(hSetWithTTL).toHaveBeenCalledTimes(1);
    const written = unpack(vi.mocked(hSetWithTTL).mock.calls[0][3] as Buffer);
    expect(written).toEqual([t0 - 5_000, t0 + 1_000, t0 + 2_000, t0 + 3_000]);
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

  /**
   * A store that keeps what it is written (packed, like the real one), whose reads for this bucket
   * alternate between answered and failed. Timestamps are 1s apart so no two attempts collide.
   */
  function alternatingStore(firstRead: 'answered' | 'failed') {
    const stored = new Map<string, number[]>();
    vi.mocked(hSetWithTTL).mockImplementation(async (_c, key, field, value) => {
      stored.set(`${key}|${field}`, unpack(value as Buffer) as number[]);
    });
    let reads = 0;
    hGet.mockImplementation(async (key: string, field: string) => {
      const answered = reads++ % 2 === (firstRead === 'answered' ? 0 : 1);
      if (!answered) throw new Error('read timed out');
      return stored.get(`${key}|${field}`) ?? null;
    });
  }

  it.each(['answered', 'failed'] as const)(
    'reads alternating answered/failed (first %s): every attempt past the limit is refused',
    async (firstRead) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const t0 = new Date('2026-01-01T00:00:00Z').getTime();
      alternatingStore(firstRead);
      const req = freshReq();

      const outcomes: string[] = [];
      for (let i = 0; i < 9; i++) {
        vi.setSystemTime(t0 + (i + 1) * 1_000);
        outcomes.push(
          await attempt(req).then(
            () => 'admitted',
            (e: TRPCError) => e.code
          )
        );
      }
      expect(outcomes).toEqual([
        ...Array(3).fill('admitted'),
        ...Array(6).fill('TOO_MANY_REQUESTS'),
      ]);
    }
  );

  it('a failed-read attempt recorded while an answered claim is in flight survives its write', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = new Date('2026-01-01T00:00:00Z').getTime();
    const req = freshReq();
    const claim = () =>
      claimRateLimitAttempt({ rules: RULES, keyName: 'store-down:test', user: undefined, req });

    hGet.mockRejectedValue(new Error('read timed out'));
    vi.setSystemTime(t0 + 1_000);
    await attempt(req); // 1, counted locally

    hGet.mockResolvedValue([]);
    vi.setSystemTime(t0 + 2_000);
    const recordAnswered = await claim(); // 2: read answered, write not yet done

    hGet.mockRejectedValue(new Error('read timed out'));
    vi.setSystemTime(t0 + 3_000);
    await attempt(req); // 3, counted locally meanwhile

    vi.setSystemTime(t0 + 4_000);
    await recordAnswered(); // 2's write lands

    vi.setSystemTime(t0 + 5_000);
    await expect(attempt(req)).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });

  it('an attempt both in the store and counted locally counts once', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = new Date('2026-01-01T00:00:00Z').getTime();
    const req = freshReq();
    hGet.mockRejectedValue(new Error('cluster down'));
    vi.setSystemTime(t0 + 2_000);
    await attempt(req); // counted locally at t0+2s

    // The store answers holding that same attempt (it reached the store) plus one other: 2 of 3.
    hGet.mockResolvedValue([t0 + 1_000, t0 + 2_000]);
    vi.setSystemTime(t0 + 3_000);
    await expect(attempt(req)).resolves.toBeUndefined();
    const written = unpack(vi.mocked(hSetWithTTL).mock.calls[0][3] as Buffer);
    expect(written).toEqual([t0 + 1_000, t0 + 2_000, t0 + 3_000]);
  });
});

describe('mergeAttempts', () => {
  it('is the multiset union: shared timestamps once, each side’s own ones kept, sorted', () => {
    expect(mergeAttempts([30, 10, 10], [10, 20, 30, 30])).toEqual([10, 10, 20, 30, 30]);
    expect(mergeAttempts([], [5, 5])).toEqual([5, 5]);
    expect(mergeAttempts([7], [])).toEqual([7]);
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

  it('an answered read also sweeps expired buckets, so they do not outlive the outage', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = new Date('2026-01-01T00:00:00Z').getTime();
    vi.setSystemTime(t0);
    hGet.mockRejectedValue(new Error('cluster down'));
    await attempt(freshReq());
    expect(__localRateLimitBucketCountForTests()).toBe(1);

    // The store is back; past the window and the sweep interval, another bucket's answered read
    // is the only traffic — and it sweeps the expired bucket.
    hGet.mockResolvedValue([]);
    vi.setSystemTime(t0 + 61_000 + 60_000);
    await attempt(freshReq());
    expect(__localRateLimitBucketCountForTests()).toBe(0);
  });

  it("an answered read keeps a bucket's mirror only until one window after its last failed read", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = new Date('2026-01-01T00:00:00Z').getTime();
    const req = freshReq();
    const tenSeconds = [{ limit: 3, period: 10 }]; // a window well inside the sweep interval
    vi.setSystemTime(t0);
    hGet.mockRejectedValue(new Error('cluster down'));
    await attempt(req, undefined, tenSeconds); // also runs the sweep, so the next is 60s away

    hGet.mockResolvedValue([]);
    vi.setSystemTime(t0 + 5_000); // inside the window: the entry now mirrors the merged history
    await attempt(req, undefined, tenSeconds);
    expect(__localRateLimitBucketCountForTests()).toBe(1);

    vi.setSystemTime(t0 + 11_000); // past it, with no sweep due: dropped, not refreshed
    await attempt(req, undefined, tenSeconds);
    expect(__localRateLimitBucketCountForTests()).toBe(0);
  });
});

describe('claimRateLimitAttempt when the claim script does not answer', () => {
  it('decides on the local count within 750ms, and a refund releases the slot without hanging', async () => {
    vi.useFakeTimers();
    hGet.mockResolvedValue([]);
    redisMock.redis.eval.mockImplementation(() => new Promise(() => undefined));
    onTestFinished(() => {
      redisMock.redis.eval.mockReset();
    });
    const req = freshReq();
    const claimOnce = () =>
      claimRateLimitAttempt({
        rules: [{ limit: 1, period: 60 }],
        keyName: 'script-hung:test',
        user: undefined,
        req,
      });

    const first = await within(claimOnce(), 750);
    expect(first).not.toBe(HUNG);

    // The hung claim counts locally: the next call is refused.
    const refused = await within(claimOnce(), 750);
    expect((refused as TRPCError).code).toBe('TOO_MANY_REQUESTS');

    expect(await within((first as Awaited<ReturnType<typeof claimOnce>>).refund(), 2000)).not.toBe(
      HUNG
    );
    await expect(within(claimOnce(), 2000)).resolves.not.toBe(HUNG);
  });
});

describe('claimRateLimitAttempt when the claim script fails on a fail-closed scope', () => {
  const claimOn = (keyName: string) =>
    claimRateLimitAttempt({
      rules: [{ limit: 5, period: 60 }],
      keyName,
      user: undefined,
      req: freshReq(),
    });
  const scriptOps = () =>
    redisMock.redis.eval.mock.calls.map((c) => (c[1] as { arguments: string[] }).arguments[0]);

  beforeEach(() => {
    hGet.mockResolvedValue([]);
    onTestFinished(() => {
      redisMock.redis.eval.mockReset();
    });
  });

  it('a script that never answers refuses with SERVICE_UNAVAILABLE and releases nothing', async () => {
    vi.useFakeTimers();
    redisMock.redis.eval.mockImplementation(() => new Promise(() => undefined));
    const outcome = await within(claimOn('buzz:script-hung'), 4000);
    expect((outcome as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
    expect(scriptOps()).toEqual(['claim']);
  });

  it('a store that refuses the call itself refuses with SERVICE_UNAVAILABLE', async () => {
    redisMock.redis.eval.mockRejectedValue(
      new Error(
        "READONLY You can't write against a read only replica. script: 3f1c0b, on @user_script:61."
      )
    );
    const outcome = await claimOn('buzz:script-readonly').catch((e: unknown) => e);
    expect((outcome as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
    expect(hSetWithTTL).not.toHaveBeenCalled();
  });

  // Every fail-closed scope, not one listed subset: the read-then-write fallback can overshoot a
  // limit under concurrency, which a Buzz-charging scope must not.
  it.each(FAIL_CLOSED_RATE_LIMIT_SCOPES)(
    '%s: a script error refuses with SERVICE_UNAVAILABLE and logs a warning with the scope',
    async (scope) => {
      redisMock.redis.eval.mockRejectedValue(
        new Error('ERR user_script:12: attempt to index a nil value')
      );
      const outcome = await claimOn(`${scope}:script-error`).catch((e: unknown) => e);
      expect((outcome as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
      expect(loggingMock.logToAxiom).toHaveBeenCalledTimes(1);
      expect(loggingMock.logToAxiom).toHaveBeenCalledWith({
        name: 'rate-limit-script-error-refused',
        type: 'warning',
        scope: `${scope}:script-error`,
        cacheKey: rateLimitBucket(`${scope}:script-error`, undefined, freshReq()).cacheKey,
      });
    }
  );

  it.each([
    ['undefined', undefined],
    ['an empty array', []],
  ])(
    'a malformed claim reply (%s) refuses with SERVICE_UNAVAILABLE and logs a warning',
    async (_, reply) => {
      redisMock.redis.eval.mockResolvedValue(reply as never);
      const outcome = await claimOn('buzz:bad-reply').catch((e: unknown) => e);
      expect((outcome as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
      expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'rate-limit-script-error-refused',
          scope: 'buzz:bad-reply',
        })
      );
    }
  );

  it('on a fallback scope a script error decides on the read-then-write path', async () => {
    redisMock.redis.eval.mockRejectedValue(
      new Error('ERR user_script:12: attempt to index a nil value')
    );
    const req = freshReq();
    const once = () =>
      claimRateLimitAttempt({
        rules: [{ limit: 1, period: 60 }],
        keyName: 'model:script-error',
        user: undefined,
        req,
      });
    const record = await once();
    await record();
    expect(hSetWithTTL).toHaveBeenCalledTimes(1);
    expect(loggingMock.logToAxiom).not.toHaveBeenCalled();

    // The read now sees the written attempt, so the pre-check refuses the next call.
    hGet.mockResolvedValue(unpack(vi.mocked(hSetWithTTL).mock.calls[0][3] as Buffer));
    const refused = await once().catch((e: unknown) => e);
    expect((refused as TRPCError).code).toBe('TOO_MANY_REQUESTS');
  });

  it('on a fallback scope a store that refuses the call counts locally, so the next call is refused', async () => {
    redisMock.redis.eval.mockRejectedValue(
      new Error(
        'OOM command not allowed when used memory > maxmemory. script: 3f1c0b, on @user_script:61.'
      )
    );
    const req = freshReq();
    const once = () =>
      claimRateLimitAttempt({
        rules: [{ limit: 1, period: 60 }],
        keyName: 'model:script-oom',
        user: undefined,
        req,
      });
    const record = await once();
    await record();
    expect(hSetWithTTL).not.toHaveBeenCalled();

    const refused = await once().catch((e: unknown) => e);
    expect((refused as TRPCError).code).toBe('TOO_MANY_REQUESTS');
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
    vi.useFakeTimers();
    hGet.mockImplementation(() => new Promise(() => undefined));
    const outcome = await within(
      readRateLimitAttempts(bucket()).then(() => 'resolved'),
      750
    );
    expect(outcome).toBeInstanceOf(Error);
  });
});
