import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { takeClusterWindowCount } from '~/server/utils/cluster-window-count';

/**
 * `takeClusterWindowCount` against a cache cluster stand-in with TTLs: a key missing from `ttls`
 * has none and never expires.
 */

const KEY = 'system:blocks:agent-review-autostart-reserved:2026-11-18';
const store = new Map<string, number>();
const ttls = new Map<string, number>();

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  ttls.clear();
  redisMock.redis.multi.mockImplementation(() => {
    const ops: Array<() => unknown> = [];
    const add = (key: string, by: number) => {
      const next = (store.get(key) ?? 0) + by;
      store.set(key, next);
      return next;
    };
    const chain = {
      set: vi.fn((key: string, value: string, opts: { NX?: boolean; EX?: number }) => {
        ops.push(() => {
          if (opts.NX && store.has(key)) return null;
          store.set(key, Number(value));
          if (opts.EX) ttls.set(key, opts.EX);
          return 'OK';
        });
        return chain;
      }),
      incr: vi.fn((key: string) => {
        ops.push(() => add(key, 1));
        return chain;
      }),
      incrBy: vi.fn((key: string, by: number) => {
        ops.push(() => add(key, by));
        return chain;
      }),
      exec: vi.fn(async () => ops.map((op) => op())),
    };
    return chain;
  });
  // `INCRBY` outside a MULTI: adds to the value and leaves the TTL as it was.
  redisMock.redis.incrBy.mockImplementation(async (key: string, by: number) => {
    const next = (store.get(key) ?? 0) + by;
    store.set(key, next);
    return next;
  });
});

describe('takeClusterWindowCount', () => {
  it('a release on an evicted key ends at zero, with the window TTL', async () => {
    expect(await takeClusterWindowCount('release', KEY, 3600, { by: -5 })).toBe(0);

    expect(store.get(KEY)).toBe(0);
    expect(ttls.get(KEY)).toBe(3600);
  });

  it('a release on a live key subtracts and keeps the TTL', async () => {
    await takeClusterWindowCount('reserve', KEY, 3600, { by: 8 });

    expect(await takeClusterWindowCount('release', KEY, 3600, { by: -5 })).toBe(3);
    expect(store.get(KEY)).toBe(3);
    expect(ttls.get(KEY)).toBe(3600);
    expect(redisMock.redis.incrBy).not.toHaveBeenCalled();
  });

  it('a take that lands between an evicted-key release and its clamp is kept', async () => {
    const clamp = redisMock.redis.incrBy.getMockImplementation()!;
    redisMock.redis.incrBy.mockImplementationOnce(async (key: string, by: number) => {
      store.set(key, (store.get(key) ?? 0) + 4); // a concurrent reserve of 4
      return clamp(key, by);
    });

    expect(await takeClusterWindowCount('release', KEY, 3600, { by: -5 })).toBe(4);
    expect(store.get(KEY)).toBe(4);
    expect(ttls.get(KEY)).toBe(3600);
  });

  it('a count with no increment creates the key with its TTL and answers 1, then 2', async () => {
    expect(await takeClusterWindowCount('take', KEY, 60)).toBe(1);
    expect(await takeClusterWindowCount('take', KEY, 60)).toBe(2);
    expect(ttls.get(KEY)).toBe(60);
  });
});
