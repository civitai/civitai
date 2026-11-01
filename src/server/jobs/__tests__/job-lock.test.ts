import { readFileSync } from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobLockRedis } from '~/server/jobs/job-lock';
import { createLuaRedis } from '~/server/utils/__tests__/redis-lua-harness';

const { acquireJobLock, jobLockKey, NOOP_LOCK } = await import('~/server/jobs/job-lock');

/**
 * The job lock the run-jobs route takes for every job, and the event points self-heal takes for the
 * hourly settle: one holder at a time, released only by its own holder, kept alive while held.
 */

// SET NX / EX, and the lock's scripts (release, refresh) run for real in the Lua harness, over the
// same keys.
function fakeRedis() {
  const strings = new Map<string, string>();
  const lua = createLuaRedis(0, { strings });
  const redis = {
    set: vi.fn(async (key: string, value: string, opts?: { NX?: boolean; EX?: number }) => {
      if (opts?.NX && strings.has(key)) return null;
      lua.setString(key, value, opts?.EX ? opts.EX * 1000 : undefined);
      return 'OK';
    }),
    eval: vi.fn((script: string, opts: { keys: string[]; arguments: string[] }) =>
      lua.eval(script, opts)
    ),
  };
  /** The key's remaining life in seconds, as Redis's TTL reads it. */
  const ttlOf = (key: string) => lua.pttl(key) / 1000;
  return { redis, strings, lua, ttlOf, typed: redis as unknown as JobLockRedis };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('acquireJobLock', () => {
  it('lets one holder in at a time, and the next in once it releases', async () => {
    const fake = fakeRedis();
    const first = await acquireJobLock('some-job', 60, fake.typed);
    expect(first).not.toBeNull();
    expect(first).not.toBe(NOOP_LOCK);
    expect(fake.strings.has(jobLockKey('some-job'))).toBe(true);
    expect(await acquireJobLock('some-job', 60, fake.typed)).toBeNull();
    await first!.release();
    expect(fake.strings.has(jobLockKey('some-job'))).toBe(false);
    const next = await acquireJobLock('some-job', 60, fake.typed);
    expect(next).not.toBeNull();
    await next!.release();
  });

  // A run whose lock lapsed must not free the run that took it after.
  it("never releases another holder's lock", async () => {
    const fake = fakeRedis();
    const stale = await acquireJobLock('some-job', 60, fake.typed);
    fake.strings.set(jobLockKey('some-job'), 'a-newer-run');
    await stale!.release();
    expect(fake.strings.get(jobLockKey('some-job'))).toBe('a-newer-run');
  });

  it('keeps a short TTL alive while held, and lets go at its expiration', async () => {
    vi.useFakeTimers();
    const fake = fakeRedis();
    const lock = await acquireJobLock('some-job', 20, fake.typed);
    expect(fake.ttlOf(jobLockKey('some-job'))).toBe(10);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(fake.redis.eval).toHaveBeenCalledTimes(1);
    expect(fake.strings.has(jobLockKey('some-job'))).toBe(true);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(fake.strings.has(jobLockKey('some-job'))).toBe(false);
    await lock!.release();
  });

  it('runs unlocked rather than skip when Redis errors on acquire', async () => {
    const fake = fakeRedis();
    fake.redis.set.mockRejectedValueOnce(new Error('down'));
    expect(await acquireJobLock('some-job', 60, fake.typed)).toBe(NOOP_LOCK);
  });

  // For a caller that can skip a run (the event points self-heal), unreachable means held.
  it('reads an acquire error as held when asked not to fail open', async () => {
    const fake = fakeRedis();
    fake.redis.set.mockRejectedValueOnce(new Error('down'));
    expect(await acquireJobLock('some-job', 60, fake.typed, { failOpen: false })).toBeNull();
  });

  it('refreshes with its own token, and stops refreshing once released', async () => {
    vi.useFakeTimers();
    const fake = fakeRedis();
    const lock = await acquireJobLock('some-job', 600, fake.typed);
    const token = fake.strings.get(jobLockKey('some-job'));
    fake.lua.setString(jobLockKey('some-job'), token!, 1000);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(fake.redis.eval).toHaveBeenLastCalledWith(expect.any(String), {
      keys: [jobLockKey('some-job')],
      arguments: [token, '10'],
    });
    expect(fake.ttlOf(jobLockKey('some-job'))).toBe(10);
    await lock!.release();
    await lock!.release();
    const calls = fake.redis.eval.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.redis.eval.mock.calls.length).toBe(calls);
    // One refresh, one release: a second release sends nothing.
    expect(calls).toBe(2);
  });
});

describe('the run-jobs route', () => {
  // A source read: the route imports every job in the application. It pins that the route still
  // gates the shared lock the way it did before the lock moved out of it.
  it('takes the shared job lock outside its own bypasses', () => {
    const source = readFileSync(
      path.resolve(__dirname, '../../../pages/api/webhooks/run-jobs/[[...run]].ts'),
      'utf8'
    );
    const fn = source.slice(source.indexOf('async function acquireLock('));
    expect(fn).toContain(
      "if (!isProd || name === 'prepare-leaderboard' || noCheck) return NOOP_LOCK;\n  return acquireJobLock(name, lockExpiration);"
    );
    expect(source).toContain(
      'const lock = await acquireLock(name, options.lockExpiration, noCheck);'
    );
  });
});
