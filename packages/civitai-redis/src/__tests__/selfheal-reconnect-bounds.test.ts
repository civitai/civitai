import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forceClusterReconnect, forceSysReconnect, instrumentCommands } from '../client';
import { ClusterSelfHealWatchdog } from '../cluster-selfheal';
import { getSysInflight, resetSysInflight } from '../sys-inflight';

const never = () => new Promise<never>(() => undefined);

/**
 * Observe a promise without awaiting it, so a test that regresses to "never settles" fails on an
 * assertion naming the state ('pending'), not on the test timeout.
 */
function track(p: Promise<unknown>) {
  const s: { state: 'pending' | 'resolved' | 'rejected'; reason?: string } = { state: 'pending' };
  p.then(
    () => (s.state = 'resolved'),
    (e: unknown) => {
      s.state = 'rejected';
      s.reason = e instanceof Error ? e.message : String(e);
    }
  );
  return s;
}

/** Fake node-redis cluster client whose connect() never settles (an unreachable node). */
function hangingCluster() {
  return {
    _slots: { nodeByAddress: new Map() },
    destroy: vi.fn(),
    connect: vi.fn(never),
  };
}

describe('forceClusterReconnect — bounded (F4)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('rejects once connect() has not settled within the step timeout, instead of hanging', async () => {
    const cluster = hangingCluster();
    const s = track(forceClusterReconnect(cluster, undefined, 10_000));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(s.state).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(s).toEqual({ state: 'rejected', reason: 'connect() did not settle within 10000ms' });
    expect(cluster.destroy).toHaveBeenCalledTimes(1);
  });

  it('re-arms failover (the periodic refresh) even when connect() times out', async () => {
    const cluster = hangingCluster();
    const reSetupFailover = vi.fn(async () => undefined);
    const s = track(forceClusterReconnect(cluster, reSetupFailover, 50));
    await vi.advanceTimersByTimeAsync(50);
    expect(s.state).toBe('rejected');
    expect(reSetupFailover).toHaveBeenCalledTimes(1);
  });

  it('a hanging failover re-setup is bounded too', async () => {
    const cluster = { ...hangingCluster(), connect: vi.fn(async () => undefined) };
    const s = track(forceClusterReconnect(cluster, () => never(), 50));
    await vi.advanceTimersByTimeAsync(50);
    expect(s.state).toBe('resolved');
  });
});

describe('forceSysReconnect — bounded (F4)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('settles even if a client connect() never does, and still reconnects the next client', async () => {
    const stuck = { destroy: vi.fn(async () => undefined), connect: vi.fn(never) };
    const next = { destroy: vi.fn(async () => undefined), connect: vi.fn(async () => undefined) };
    const s = track(forceSysReconnect([stuck, next], 50));
    await vi.advanceTimersByTimeAsync(50);
    expect(s.state).toBe('resolved');
    expect(next.connect).toHaveBeenCalledTimes(1);
  });

  it('a destroy() that settles LATE: connect() runs after it, never before', async () => {
    // RedisSentinel.destroy() waits for any discovery in progress, then closes the client. A
    // connect() issued while it waits is refused, and the late destroy() then leaves the client
    // closed for good — so the reconnect must follow the destroy, not the timeout.
    let finishDestroy!: () => void;
    let destroyed = false;
    const order: string[] = [];
    const client = {
      destroy: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishDestroy = () => {
              destroyed = true;
              order.push('destroyed');
              resolve();
            };
          })
      ),
      connect: vi.fn(async () => {
        order.push(destroyed ? 'connect-after-destroy' : 'connect-before-destroy');
      }),
    };
    const s = track(forceSysReconnect([client], 50));
    await vi.advanceTimersByTimeAsync(50);
    expect(s.state).toBe('resolved'); // still bounded
    expect(client.connect).not.toHaveBeenCalled();
    finishDestroy();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['destroyed', 'connect-after-destroy']);
  });

  it('a destroy() that never settles is bounded too, and the next client is still healed', async () => {
    const stuck = { destroy: vi.fn(never), connect: vi.fn(async () => undefined) };
    const next = { destroy: vi.fn(async () => undefined), connect: vi.fn(async () => undefined) };
    const s = track(forceSysReconnect([stuck, next], 50));
    await vi.advanceTimersByTimeAsync(50);
    expect(s.state).toBe('resolved');
    expect(stuck.connect).not.toHaveBeenCalled(); // deferred until its destroy() settles
    expect(next.connect).toHaveBeenCalledTimes(1);
  });

  it('a second heal while a late teardown is still running does not stack another reconnect', async () => {
    let finishDestroy!: () => void;
    const client = {
      destroy: vi.fn(() => new Promise<void>((resolve) => (finishDestroy = resolve))),
      connect: vi.fn(async () => undefined),
    };
    const first = track(forceSysReconnect([client], 50));
    await vi.advanceTimersByTimeAsync(50);
    const second = track(forceSysReconnect([client], 50));
    await vi.advanceTimersByTimeAsync(50);
    expect([first.state, second.state]).toEqual(['resolved', 'resolved']);
    expect(client.destroy).toHaveBeenCalledTimes(1);
    finishDestroy();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.connect).toHaveBeenCalledTimes(1);

    // Once that reconnect has finished, a later heal runs normally again.
    client.destroy.mockImplementation(async () => undefined);
    const third = track(forceSysReconnect([client], 50));
    await vi.advanceTimersByTimeAsync(0);
    expect(third.state).toBe('resolved');
    expect(client.destroy).toHaveBeenCalledTimes(2);
    expect(client.connect).toHaveBeenCalledTimes(2);
  });

  it('a late teardown whose chained connect() never settles does not block later heals', async () => {
    // RedisSentinel's connect() can wait forever on its reserved-lease pool from a client's second
    // reconnect on; the skip guard must not outlive the teardown it covers.
    let finishDestroy!: () => void;
    const client = {
      destroy: vi.fn(() => new Promise<void>((resolve) => (finishDestroy = resolve))),
      connect: vi.fn(never),
    };
    track(forceSysReconnect([client], 50));
    await vi.advanceTimersByTimeAsync(50);
    finishDestroy();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.connect).toHaveBeenCalledTimes(1); // and it hangs

    client.destroy.mockImplementation(async () => undefined);
    const later = track(forceSysReconnect([client], 50));
    await vi.advanceTimersByTimeAsync(50);
    expect(later.state).toBe('resolved');
    expect(client.destroy).toHaveBeenCalledTimes(2); // not skipped
  });

  it('a destroy() that REJECTS still reconnects at once', async () => {
    const client = {
      destroy: vi.fn(async () => {
        throw new Error('destroy boom');
      }),
      connect: vi.fn(async () => undefined),
    };
    const s = track(forceSysReconnect([client], 50));
    await vi.advanceTimersByTimeAsync(0);
    expect(s.state).toBe('resolved');
    expect(client.connect).toHaveBeenCalledTimes(1);
  });
});

describe('watchdog: `reconnecting` always clears with a hanging connect (F4, end to end)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires, then re-arms within the step timeout', async () => {
    let now = 0;
    const cluster = hangingCluster();
    const watchdog = new ClusterSelfHealWatchdog(
      {
        enabled: true,
        inflightThreshold: 1,
        sustainedMs: 0,
        cooldownMs: 0,
        deadlineHitThreshold: 0,
        deadlineHitWindowMs: 0,
        reconnectJitterMs: 0,
      },
      {
        getInflight: () => 5,
        now: () => now,
        reconnect: () => forceClusterReconnect(cluster, undefined, 10_000),
        log: () => undefined,
        onReconnect: () => undefined,
      }
    );
    watchdog.tick(); // starts the breach timer
    expect(watchdog.tick()).toBe(true);
    expect(watchdog.getState().reconnecting).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(watchdog.getState().reconnecting).toBe(false);
    now = 1;
    watchdog.tick();
    expect(watchdog.tick()).toBe(true); // it can fire again
  });
});

describe('watchdog log prefix', () => {
  it('uses the configured label (the sys watchdog no longer logs as "Cluster")', () => {
    const lines: string[] = [];
    const watchdog = new ClusterSelfHealWatchdog(
      {
        enabled: true,
        inflightThreshold: 1,
        sustainedMs: 0,
        cooldownMs: 0,
        deadlineHitThreshold: 0,
        deadlineHitWindowMs: 0,
        reconnectJitterMs: 0,
        label: 'Sys',
      },
      {
        getInflight: () => 5,
        now: () => 0,
        reconnect: async () => undefined,
        log: (m) => lines.push(m),
        onReconnect: () => undefined,
      }
    );
    watchdog.tick();
    watchdog.tick();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.startsWith('Sys self-heal:'))).toBe(true);
  });
});

describe('sys client command bounds (F5)', () => {
  beforeEach(() => {
    resetSysInflight();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  /** Sentinel-shaped fake: node-redis's RedisSentinel exposes `_execute`. */
  const fakeSentinel = () => {
    const calls: unknown[] = [];
    return { calls, _execute: vi.fn((...args: unknown[]) => (calls.push(args), never())) };
  };

  it('rejects new commands once the in-flight cap is reached, without calling through', async () => {
    const client = fakeSentinel();
    instrumentCommands(client, 'sys', { sysInflightCap: 3, sysDeadlineMs: 0 });
    for (let i = 0; i < 3; i++)
      void (client as any)._execute(false, () => undefined).catch(() => undefined);
    expect(getSysInflight()).toBe(3);
    const s = track((client as any)._execute(false, () => undefined));
    await vi.advanceTimersByTimeAsync(0);
    expect(s).toEqual({
      state: 'rejected',
      reason: 'sysRedis in-flight cap reached (3); command rejected',
    });
    expect(client.calls).toHaveLength(3);
  });

  it('a never-settling command is rejected at the deadline and leaves the in-flight count', async () => {
    const client = fakeSentinel();
    instrumentCommands(client, 'sys', { sysInflightCap: 0, sysDeadlineMs: 30_000 });
    const s = track((client as any)._execute(false, () => undefined));
    expect(getSysInflight()).toBe(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(s.state).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(s).toEqual({ state: 'rejected', reason: 'sysRedis command timed out after 30000ms' });
    expect(getSysInflight()).toBe(0);
  });

  it('both bounds off (0) leave the sys path unbounded, as before (invariant guard)', async () => {
    const client = fakeSentinel();
    instrumentCommands(client, 'sys', { sysInflightCap: 0, sysDeadlineMs: 0 });
    for (let i = 0; i < 20; i++) void (client as any)._execute(false, () => undefined);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(getSysInflight()).toBe(20);
  });
});
