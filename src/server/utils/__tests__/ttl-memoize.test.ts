import { describe, it, expect, vi } from 'vitest';
import { createKeyedTtlMemo, createTtlMemo } from '../ttl-memoize';

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

  it('freeze: the cached array is frozen so an accidental in-place mutation throws instead of corrupting the shared blob', async () => {
    const clock = makeClock();
    const fetcher = vi.fn(async () => [{ id: 1, name: 'tag' }]);
    const memo = createTtlMemo(fetcher, 30_000, clock.now, { freeze: true });

    const arr = await memo();
    expect(Object.isFrozen(arr)).toBe(true);
    // Array-level mutation must throw (strict mode) rather than silently mutate
    // the reference shared across the TTL window.
    expect(() => arr.push({ id: 2, name: 'other' })).toThrow();
    expect(() => ((arr as { id: number; name: string }[]).length = 0)).toThrow();

    // The SAME frozen reference is served for the rest of the TTL.
    clock.advance(5_000);
    const again = await memo();
    expect(again).toBe(arr);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not freeze by default (freeze is opt-in)', async () => {
    const clock = makeClock();
    const fetcher = vi.fn(async () => [{ id: 1 }]);
    const memo = createTtlMemo(fetcher, 30_000, clock.now);

    const arr = await memo();
    expect(Object.isFrozen(arr)).toBe(false);
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

describe('createKeyedTtlMemo', () => {
  it('memoizes per key: each distinct key hits the fetcher once within the TTL', async () => {
    const clock = makeClock();
    const fetcher = vi.fn(async (key: string) => `value-for-${key}`);
    const memo = createKeyedTtlMemo(fetcher, 30_000, clock.now);

    // First touch of each key fetches once; repeats within the TTL are cached.
    expect(await memo('all')).toBe('value-for-all');
    expect(await memo('red')).toBe('value-for-red');
    clock.advance(10_000); // still inside the 30s TTL
    expect(await memo('all')).toBe('value-for-all');
    expect(await memo('red')).toBe('value-for-red');

    // One fetch per DISTINCT key, not per call.
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledWith('all');
    expect(fetcher).toHaveBeenCalledWith('red');
  });

  it('keys are independent — expiring/refetching one key does not disturb another', async () => {
    const clock = makeClock();
    const counters: Record<string, number> = {};
    const fetcher = vi.fn(async (key: string) => {
      counters[key] = (counters[key] ?? 0) + 1;
      return `${key}-${counters[key]}`;
    });
    const memo = createKeyedTtlMemo(fetcher, 30_000, clock.now);

    expect(await memo('all')).toBe('all-1');
    expect(await memo('red')).toBe('red-1');

    clock.advance(30_001); // both keys' TTL windows expire together
    expect(await memo('all')).toBe('all-2'); // refetched independently
    expect(await memo('red')).toBe('red-2');
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('fail-open per key: a rejected fetch is not cached and the next call refetches that key', async () => {
    const clock = makeClock();
    const outcomes: Record<string, Array<() => Promise<string>>> = {
      all: [() => Promise.reject(new Error('db down')), () => Promise.resolve('recovered')],
    };
    const idx: Record<string, number> = { all: 0 };
    const fetcher = vi.fn((key: string) => outcomes[key][idx[key]++]());
    const memo = createKeyedTtlMemo(fetcher, 30_000, clock.now);

    await expect(memo('all')).rejects.toThrow('db down');
    // Immediately (within the TTL) the next call re-invokes rather than serving a
    // cached error / poisoned value — preserving the resolver's fail-open path.
    expect(await memo('all')).toBe('recovered');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('clear(key) drops just that key; clear() drops all', async () => {
    const clock = makeClock();
    const counters: Record<string, number> = {};
    const fetcher = vi.fn(async (key: string) => {
      counters[key] = (counters[key] ?? 0) + 1;
      return `${key}-${counters[key]}`;
    });
    const memo = createKeyedTtlMemo(fetcher, 30_000, clock.now);

    expect(await memo('all')).toBe('all-1');
    expect(await memo('red')).toBe('red-1');

    memo.clear('all'); // only 'all' is dropped
    expect(await memo('all')).toBe('all-2'); // refetched
    expect(await memo('red')).toBe('red-1'); // untouched, still cached

    memo.clear(); // drops everything
    expect(await memo('all')).toBe('all-3');
    expect(await memo('red')).toBe('red-2');
  });

  it('freeze option is applied per key', async () => {
    const clock = makeClock();
    const memo = createKeyedTtlMemo<{ id: number }[]>(async () => [{ id: 1 }], 30_000, clock.now, {
      freeze: true,
    });

    const arr = await memo('a');
    expect(Object.isFrozen(arr)).toBe(true);
    expect(() => arr.push({ id: 2 })).toThrow();
  });
});
