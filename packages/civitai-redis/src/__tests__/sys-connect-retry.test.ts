import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A sys client's connect() that gives up and leaves the client closed is retried until one
 * succeeds (connectSysClient). node-redis 6's RedisSentinel.connect() gives up after its
 * rediscovery passes fail and destroys the client, and nothing reopens it: without the retry a
 * startup or self-heal connect() overlapping a master outage left sysRedis down until the process
 * restarted. Covered here: the retry itself, and its three call sites (initial connect, self-heal
 * reconnect, late-teardown reconnect).
 */
const h = vi.hoisted(() => ({
  sentinels: [] as any[],
  /** connect() rejects this many times (leaving the fake closed), then succeeds. */
  failConnects: 0,
}));

/** A fake client with RedisSentinel 6's connect() semantics: a failed connect() leaves it closed. */
function fakeClient(failures: number) {
  const c: any = {
    isOpen: false,
    calls: 0,
    connect: vi.fn(async () => {
      c.calls++;
      if (c.isOpen) throw new Error('already attempting to open');
      if (c.calls <= failures) throw new Error(`gave up ${c.calls}`);
      c.isOpen = true;
      return c;
    }),
    destroy: vi.fn(async () => {
      c.isOpen = false;
    }),
  };
  return c;
}

vi.mock('redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('redis')>();
  return {
    ...actual,
    createSentinel: () => {
      const c = fakeClient(h.failConnects);
      Object.assign(c, { on: () => c, withTypeMapping: () => c, _execute: vi.fn() });
      h.sentinels.push(c);
      return c;
    },
  };
});

import { connectSysClient, createSysRedis, forceSysReconnect } from '../client';

const noDelay = () => 0;
/** Let every pending timer and microtask run (retries are scheduled with setTimeout). */
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

describe('connectSysClient', () => {
  it('retries a connect() that leaves the client closed until one succeeds', async () => {
    const c = fakeClient(3);
    await expect(connectSysClient(c, noDelay)).rejects.toThrow('gave up 1'); // the first attempt's
    await drain();
    expect(c.connect).toHaveBeenCalledTimes(4);
    expect(c.isOpen).toBe(true);
  });

  it('waits the backoff before each retry', async () => {
    const c = fakeClient(2);
    const delays: number[] = [];
    void connectSysClient(c, (n) => (delays.push(n), n * 1000)).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(999);
    expect(c.connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(c.connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.connect).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([1, 2]);
  });

  it('does not retry when the client is still open (someone else opened it)', async () => {
    const c = fakeClient(0);
    c.isOpen = true;
    await expect(connectSysClient(c, noDelay)).rejects.toThrow('already attempting to open');
    await drain();
    expect(c.connect).toHaveBeenCalledTimes(1);
  });

  it('stops retrying once the client was opened in the meantime', async () => {
    const c = fakeClient(1);
    void connectSysClient(c, () => 1000).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    c.isOpen = true; // e.g. a self-heal connected it
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.connect).toHaveBeenCalledTimes(1);
  });

  it('keeps one retry pending per client', async () => {
    const c = fakeClient(2);
    void connectSysClient(c, () => 1000).catch(() => undefined);
    void connectSysClient(c, () => 1000).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(c.connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.connect).toHaveBeenCalledTimes(3); // one retry, not two
  });
});

describe('the sys call sites retry a connect() that gave up', () => {
  it("the sys Sentinel's initial connect()", async () => {
    h.failConnects = 2;
    h.sentinels.length = 0;
    createSysRedis({
      sysSentinels: '127.0.0.1:26379',
      sysSentinelName: 'sysmaster',
      sysSelfHealEnabled: false,
      log: () => undefined,
    });
    expect(h.sentinels).toHaveLength(2); // serving + Buffer-mode
    await vi.advanceTimersByTimeAsync(10_000); // reconnectDelayMs: 100 ms, then 200 ms
    for (const s of h.sentinels) {
      expect(s.connect).toHaveBeenCalledTimes(3);
      expect(s.isOpen).toBe(true);
    }
  });

  it("a self-heal's reconnect", async () => {
    const c = fakeClient(0);
    c.isOpen = true;
    c.connect.mockImplementationOnce(async () => {
      c.calls++;
      throw new Error('gave up'); // RedisSentinel 6: the client is closed (destroy() ran)
    });
    await forceSysReconnect([c], 1000);
    expect(c.destroy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(c.connect).toHaveBeenCalledTimes(2);
    expect(c.isOpen).toBe(true);
  });

  it("a late teardown's reconnect", async () => {
    const c = fakeClient(0);
    c.isOpen = true;
    let finishDestroy!: () => void;
    c.destroy.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishDestroy = () => {
            c.isOpen = false;
            resolve();
          };
        })
    );
    c.connect.mockImplementationOnce(async () => {
      c.calls++;
      throw new Error('gave up');
    });
    const heal = forceSysReconnect([c], 50);
    await vi.advanceTimersByTimeAsync(50); // the teardown outlives the step: reconnect deferred
    await heal;
    finishDestroy();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(c.connect).toHaveBeenCalledTimes(2);
    expect(c.isOpen).toBe(true);
  });
});
