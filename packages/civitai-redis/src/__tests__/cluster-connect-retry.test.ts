import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A cluster client whose connect() fails is left CLOSED by node-redis 6 (RedisCluster resets `isOpen`
 * when discovery fails on every root node), and every command then throws "The client is closed". The
 * cache cluster client is reopened by connectWithRetry at its two connect() call sites (the initial
 * connect and a self-heal's reconnect) and by ensureClientOpen on access.
 */
const h = vi.hoisted(() => ({
  clusters: [] as any[],
  /** connect() rejects this many times (leaving the fake closed), then succeeds. */
  failConnects: 0,
}));

/** A fake with RedisCluster 6's connect() semantics: a failed connect() leaves it closed. */
function fakeCluster(failures: number) {
  const c: any = {
    isOpen: false,
    calls: 0,
    callTimes: [] as number[],
    connect: vi.fn(async () => {
      c.calls++;
      c.callTimes.push(Date.now());
      if (c.isOpen) throw new Error('Cluster already open');
      c.isOpen = true;
      await Promise.resolve();
      if (c.calls <= failures) {
        c.isOpen = false;
        throw new Error(`root nodes unavailable ${c.calls}`);
      }
      return c;
    }),
    destroy: vi.fn(() => {
      c.isOpen = false;
    }),
  };
  return c;
}

vi.mock('redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('redis')>();
  return {
    ...actual,
    createCluster: (opts: any) => {
      const c = fakeCluster(h.failConnects);
      Object.assign(c, {
        _options: { rootNodes: opts.rootNodes },
        _slots: { masters: [], nodeByAddress: new Map(), rediscover: vi.fn(async () => undefined) },
        on: () => c,
        withTypeMapping: () => c,
        _execute: vi.fn(),
      });
      h.clusters.push(c);
      return c;
    },
  };
});

import {
  __getClusterSelfHealWatchdog,
  connectWithRetry,
  createCacheRedis,
  ensureClientOpen,
  forceClusterReconnect,
  forceSysReconnect,
} from '../client';

const noDelay = () => 0;
const drain = async () => {
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(10);
};

beforeAll(() => {
  process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
  process.env.REDIS_SYS_URL ??= 'redis://127.0.0.1:6379';
});
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  h.failConnects = 0;
});

describe('the cache cluster client reopens after a connect() that left it closed', () => {
  it('its initial connect(), and then starts the self-heal watchdog', async () => {
    h.failConnects = 2;
    createCacheRedis({ cluster: true, clusterSelfHealEnabled: false, log: () => undefined });
    expect(h.clusters).toHaveLength(1);
    const [c] = h.clusters;
    await vi.advanceTimersByTimeAsync(10_000); // reconnectDelayMs: 100 ms, then 200 ms
    expect(c.connect).toHaveBeenCalledTimes(3);
    expect(c.isOpen).toBe(true);
    // The watchdog is started once connected; a first connect() that failed used to skip it for good.
    expect(__getClusterSelfHealWatchdog()).toBeDefined();
  });

  it("a self-heal's reconnect", async () => {
    const c = fakeCluster(0);
    c.isOpen = true;
    c.connect.mockImplementationOnce(async () => {
      c.calls++;
      throw new Error('root nodes unavailable'); // RedisCluster 6: isOpen reset to false
    });
    await expect(forceClusterReconnect(c, undefined, 1000)).rejects.toThrow(
      'root nodes unavailable'
    );
    expect(c.destroy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(c.connect).toHaveBeenCalledTimes(2);
    expect(c.isOpen).toBe(true);
  });
});

describe('connectWithRetry', () => {
  it('two call sites failing at once leave ONE retry chain, not one each', async () => {
    const c = fakeCluster(5);
    // Fails before opening, so both first attempts see the client closed.
    c.connect.mockImplementation(async () => {
      c.calls++;
      c.callTimes.push(Date.now());
      if (c.calls <= 5) throw new Error(`root nodes unavailable ${c.calls}`);
      c.isOpen = true;
    });
    // Different backoffs, so a second chain would retry at times the first never does.
    void connectWithRetry(c, { label: 'a', delayMs: () => 1000 }).catch(() => undefined);
    void connectWithRetry(c, { label: 'b', delayMs: () => 1500 }).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10_000);
    const t0 = c.callTimes[0];
    expect(c.callTimes.map((t: number) => t - t0)).toEqual([0, 0, 1000, 2000, 3000, 4000]);
    expect(c.isOpen).toBe(true);
  });
});

describe('ensureClientOpen', () => {
  it('reopens a closed client with ONE connect() however many callers find it closed', async () => {
    const c = fakeCluster(0);
    for (let i = 0; i < 50; i++) ensureClientOpen(c, 'cache', noDelay);
    await drain();
    expect(c.connect).toHaveBeenCalledTimes(1);
    expect(c.isOpen).toBe(true);
  });

  it('keeps one reconnect in flight while connect() keeps failing', async () => {
    const c = fakeCluster(3);
    const touch = () => {
      for (let i = 0; i < 10; i++) ensureClientOpen(c, 'cache', () => 1000);
    };
    touch();
    // Callers keep arriving between the retries (never on one); none of them starts a connect().
    for (let i = 0; i < 16; i++) {
      await vi.advanceTimersByTimeAsync(250);
      touch();
    }
    const t0 = c.callTimes[0];
    expect(c.callTimes.map((t: number) => t - t0)).toEqual([0, 1000, 2000, 3000]);
    expect(c.isOpen).toBe(true);
  });

  it('leaves a client to the self-heal still waiting on its teardown', async () => {
    const c = fakeCluster(0);
    c.isOpen = true;
    let finishDestroy!: () => void;
    c.destroy.mockImplementationOnce(() => {
      c.isOpen = false;
      return new Promise<void>((resolve) => (finishDestroy = resolve));
    });
    const heal = forceSysReconnect([c], 50);
    await vi.advanceTimersByTimeAsync(50); // the teardown outlives the step: reconnect deferred
    await heal;
    ensureClientOpen(c, 'sys', noDelay);
    await drain();
    expect(c.connect).not.toHaveBeenCalled(); // a connect() now would be closed by the late teardown
    finishDestroy();
    await drain();
    expect(c.connect).toHaveBeenCalledTimes(1);
    expect(c.isOpen).toBe(true);
  });

  it('does nothing to an open client', async () => {
    const c = fakeCluster(0);
    c.isOpen = true;
    ensureClientOpen(c, 'cache', noDelay);
    await drain();
    expect(c.connect).not.toHaveBeenCalled();
  });

  it('a client that closes AGAIN after reopening is reopened again', async () => {
    const c = fakeCluster(0);
    ensureClientOpen(c, 'cache', noDelay);
    await drain();
    c.isOpen = false;
    ensureClientOpen(c, 'cache', noDelay);
    await drain();
    expect(c.connect).toHaveBeenCalledTimes(2);
    expect(c.isOpen).toBe(true);
  });

  it('backs off 100 ms more per failed attempt, capped at 3 s', async () => {
    const c = fakeCluster(40); // overshoots the cap, reached at the 30th retry
    ensureClientOpen(c, 'cache');
    await vi.advanceTimersByTimeAsync(200_000);
    expect(c.connect).toHaveBeenCalledTimes(41);
    expect(c.isOpen).toBe(true);
    const gaps = c.callTimes.slice(1).map((t: number, i: number) => t - c.callTimes[i]);
    expect(gaps).toEqual(Array.from({ length: 40 }, (_, i) => Math.min((i + 1) * 100, 3000)));
  });
});
