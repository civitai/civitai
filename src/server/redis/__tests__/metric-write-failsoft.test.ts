import { describe, it, expect, vi, beforeEach } from 'vitest';

// withMetricWriteFailSoft is FIX #3: the non-critical metric WRITE/LOCK guard. The
// metrics:lock setNX/expire and increment hIncrBy are pure analytics counters — never money/
// entitlement — so a wedged cluster client must FAIL FAST (short timeout, not the 15s cluster
// deadline) and FAIL SOFT (return the caller's fallback + count, let the user mutation
// succeed) instead of 500ing or parking. These pin: happy path unchanged; a hung command
// times out and returns the fallback + fires onFail; a redis error fails soft too; the env
// timeout is honored; <=0 falls back to the cluster deadline. env is mocked so both branches
// are deterministic (mirrors meilisearch/client.test.ts).
vi.mock('~/env/server', () => ({
  env: {
    REDIS_METRIC_WRITE_TIMEOUT_MS: 1500,
    REDIS_CLUSTER_COMMAND_TIMEOUT_MS: 15000,
  },
}));

import { withMetricWriteFailSoft } from '../metric-write-failsoft';

const never = () => new Promise<never>(() => {}); // never settles (the wedged-client case)
const resolveAfter = <T>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms));

describe('withMetricWriteFailSoft', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes the real value through on the happy path (unchanged behavior, no onFail)', async () => {
    const onFail = vi.fn();
    const result = await withMetricWriteFailSoft(() => Promise.resolve(true), false, {
      op: 'populate-lock:setNX',
      onFail,
      timeoutMs: 1500,
    });
    expect(result).toBe(true);
    expect(onFail).not.toHaveBeenCalled();
  });

  it('returns a non-boolean happy value verbatim (e.g. an increment total)', async () => {
    const result = await withMetricWriteFailSoft(() => Promise.resolve(42), 0, {
      op: 'increment:hIncrBy',
      timeoutMs: 1500,
    });
    expect(result).toBe(42);
  });

  it('fails soft on a HUNG command: times out, returns the fallback, fires onFail (the wedge case)', async () => {
    const onFail = vi.fn();
    // The calling mutation must still resolve — it gets the fallback, not a throw.
    const result = await withMetricWriteFailSoft(never, false, {
      op: 'populate-lock:setNX',
      onFail,
      timeoutMs: 20, // short so the test is fast
    });
    expect(result).toBe(false); // lock "not acquired" → caller skips this id
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onFail).toHaveBeenCalledWith('populate-lock:setNX', expect.any(Error));
    expect(onFail.mock.calls[0][1].message).toMatch(/timed out after 20ms/);
  });

  it('fails soft on a redis ERROR (not just a timeout): returns fallback + fires onFail', async () => {
    const onFail = vi.fn();
    const result = await withMetricWriteFailSoft(
      () => Promise.reject(new Error('CROSSSLOT')),
      0,
      { op: 'increment:hIncrBy', onFail, timeoutMs: 1500 }
    );
    expect(result).toBe(0);
    expect(onFail).toHaveBeenCalledWith('increment:hIncrBy', expect.any(Error));
    expect(onFail.mock.calls[0][1].message).toMatch(/CROSSSLOT/);
  });

  it('never rejects — even a hung command resolves to the fallback (the calling mutation survives)', async () => {
    // If this leaked a rejection, the test runner would surface it.
    await expect(
      withMetricWriteFailSoft(never, 'fallback', { op: 'x', timeoutMs: 10 })
    ).resolves.toBe('fallback');
  });

  it('honors an explicit short timeoutMs (does NOT inherit the 15s cluster deadline)', async () => {
    const onFail = vi.fn();
    const start = Date.now();
    await withMetricWriteFailSoft(never, false, { op: 'populate-lock:expire', onFail, timeoutMs: 30 });
    const elapsed = Date.now() - start;
    // Bounded by the explicit 30ms, nowhere near 15s.
    expect(elapsed).toBeLessThan(2000);
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  it('defaults to REDIS_METRIC_WRITE_TIMEOUT_MS when timeoutMs is omitted', async () => {
    // The mocked default is 1500ms; a 5ms command resolves well within it (no fallback).
    const onFail = vi.fn();
    const result = await withMetricWriteFailSoft(() => resolveAfter(5, 'ok'), 'fb', {
      op: 'increment:hIncrBy',
      onFail,
    });
    expect(result).toBe('ok');
    expect(onFail).not.toHaveBeenCalled();
  });

  it('clears the timer on the happy path (no dangling timer keeps the loop alive)', async () => {
    const clearSpy = vi.spyOn(global, 'clearTimeout');
    await withMetricWriteFailSoft(() => Promise.resolve(1), 0, { op: 'x', timeoutMs: 1000 });
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
