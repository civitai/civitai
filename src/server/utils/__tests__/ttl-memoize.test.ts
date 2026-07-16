import { describe, it, expect, vi } from 'vitest';
import { createTtlMemo } from '../ttl-memoize';

// A controllable clock so the tests are deterministic and never rely on
// wall-clock sleeps.
function makeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('createTtlMemo', () => {
  it('returns the cached value within the TTL and calls the fetcher only once', async () => {
    const clock = makeClock();
    const fetcher = vi.fn(async () => 'value-1');
    const memo = createTtlMemo(fetcher, 30_000, clock.now);

    expect(await memo()).toBe('value-1');
    clock.advance(10_000); // still inside the 30s TTL
    expect(await memo()).toBe('value-1');
    clock.advance(19_999); // t = 29,999 < 30,000, boundary still fresh
    expect(await memo()).toBe('value-1');

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refetches after the TTL expires', async () => {
    const clock = makeClock();
    let n = 0;
    const fetcher = vi.fn(async () => `value-${++n}`);
    const memo = createTtlMemo(fetcher, 30_000, clock.now);

    expect(await memo()).toBe('value-1');
    clock.advance(30_001); // past expiry (expiresAt = 30,000, needs > 30,000)
    expect(await memo()).toBe('value-2');
    expect(fetcher).toHaveBeenCalledTimes(2);

    // ...and the refetched value is then cached again for the next TTL window.
    clock.advance(1_000);
    expect(await memo()).toBe('value-2');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('fail-open: a rejected fetch is NOT cached and the next call refetches (no poisoned value served as fresh)', async () => {
    const clock = makeClock();
    const outcomes: Array<() => Promise<string>> = [
      () => Promise.reject(new Error('redis down')),
      () => Promise.resolve('recovered'),
    ];
    let i = 0;
    const fetcher = vi.fn(() => outcomes[i++]());
    const memo = createTtlMemo(fetcher, 30_000, clock.now);

    // First call rejects — the rejection must propagate unchanged.
    await expect(memo()).rejects.toThrow('redis down');

    // Immediately (well within the TTL) the next call must RE-INVOKE the fetcher
    // rather than serve a cached error / poisoned empty value.
    expect(await memo()).toBe('recovered');
    expect(fetcher).toHaveBeenCalledTimes(2);

    // The recovered value is now cached normally.
    clock.advance(5_000);
    expect(await memo()).toBe('recovered');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not overwrite a good cached value when a later refetch rejects', async () => {
    const clock = makeClock();
    const outcomes: Array<() => Promise<string>> = [
      () => Promise.resolve('good'),
      () => Promise.reject(new Error('transient')),
    ];
    let i = 0;
    const fetcher = vi.fn(() => outcomes[i++]());
    const memo = createTtlMemo(fetcher, 30_000, clock.now);

    expect(await memo()).toBe('good');
    clock.advance(30_001); // expire so the next call refetches
    await expect(memo()).rejects.toThrow('transient'); // rejection propagates, not cached
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('clear() drops the cached value so the next call refetches', async () => {
    const clock = makeClock();
    let n = 0;
    const fetcher = vi.fn(async () => `value-${++n}`);
    const memo = createTtlMemo(fetcher, 30_000, clock.now);

    expect(await memo()).toBe('value-1');
    memo.clear();
    expect(await memo()).toBe('value-2'); // refetched despite being inside the TTL
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('caches a legitimate null result (an unset key is a real value, not an error)', async () => {
    const clock = makeClock();
    const fetcher = vi.fn(async () => null as string | null);
    const memo = createTtlMemo(fetcher, 30_000, clock.now);

    expect(await memo()).toBeNull();
    expect(await memo()).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
