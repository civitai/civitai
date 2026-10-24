import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { instrumentCommands, trackClusterCommands } from '../client';
import { countClusterDeadlineHits, resetClusterDeadlineHits } from '../cluster-deadline-hits';
import { getClusterInflight, resetClusterInflight } from '../cluster-inflight';
import { getSysInflight, resetSysInflight } from '../sys-inflight';

// What the per-command wrapper promises its callers, pinned at the wrapper (instrumentCommands /
// trackClusterCommands) rather than at the helpers it composes, so a change to how the wrapper is
// assembled — fewer promise layers, options built once, one gauge write per batch — must keep:
//   - what a caller gets: the value, the original error, a synchronous throw as a rejection;
//   - the routing retry: which errors retry, how often, after which backoff, what is counted;
//   - the deadline: when a command is released and with what error, including over retries;
//   - the totals the wedge signals read: in-flight gauge and local counter back to 0, one
//     duration sample and one slow-settle hit per command, whether sent alone or in a batch.

/** A prom-faithful stand-in for the app's metrics bridge: `inc`/`dec` honour their value argument
 * (default 1) exactly as prom-client's Gauge does, so a batch written as one inc(labels, n) and as
 * n inc(labels) calls read the same. */
function installBridge() {
  const gauge: Record<string, number> = { cluster: 0, sys: 0 };
  const writes = { inc: 0, dec: 0 };
  const durations: Array<{ client: string; seconds: number }> = [];
  const routing: string[] = [];
  (globalThis as any).__civitaiRedisMetrics = {
    redisCommandsInflight: {
      inc: (l: { client: string }, v = 1) => {
        writes.inc++;
        gauge[l.client] += v;
      },
      dec: (l: { client: string }, v = 1) => {
        writes.dec++;
        gauge[l.client] -= v;
      },
    },
    redisCommandDuration: {
      observe: (l: { client: string }, seconds: number) =>
        durations.push({ client: l.client, seconds }),
    },
    redisRoutingRetryCounter: { inc: (l: { result: string }) => routing.push(l.result) },
  };
  return { gauge, writes, durations, routing };
}

/** Observe a promise without awaiting it, so a regression reads as a named state. */
function track(p: Promise<unknown>) {
  const s: { state: 'pending' | 'resolved' | 'rejected'; value?: unknown; error?: unknown } = {
    state: 'pending',
  };
  p.then(
    (v) => {
      s.state = 'resolved';
      s.value = v;
    },
    (e: unknown) => {
      s.state = 'rejected';
      s.error = e;
    }
  );
  return s;
}

/** The pre-dispatch routing throw node-redis raises mid-rediscovery (retryable). */
const routingThrow = () =>
  new TypeError("Cannot read properties of undefined (reading 'replicas')");

const never = () => new Promise<never>(() => undefined);

/** A fake cluster client: `_execute` answers each call with `answer(callIndex)`. */
function fakeCluster(answer: (n: number) => Promise<unknown> | unknown) {
  const calls: Array<{ at: number; self: unknown; args: unknown[] }> = [];
  const client: any = {
    _execute(this: unknown, ...args: unknown[]) {
      calls.push({ at: Date.now(), self: this, args });
      return answer(calls.length - 1);
    },
  };
  return { client, calls };
}

const CLUSTER_OPTS = {
  deadlineMs: 1000,
  slowCommandMs: 500,
  routingRetryEnabled: true,
  routingRetryMax: 2,
  routingRetryBackoffMs: 50,
  routingRetryBackoffMaxMs: 150,
};

describe('instrumentCommands (cluster): what a caller gets', () => {
  let m: ReturnType<typeof installBridge>;
  beforeEach(() => {
    resetClusterInflight();
    resetClusterDeadlineHits();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    m = installBridge();
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as any).__civitaiRedisMetrics;
  });

  it('success: resolves with the reply, calls through once with the same this/args, accounts one command', async () => {
    const { client, calls } = fakeCluster(
      () => new Promise((r) => setTimeout(() => r('reply'), 7))
    );
    instrumentCommands(client, 'cluster', CLUSTER_OPTS);
    const s = track(client._execute('GET', 'k'));
    expect(getClusterInflight()).toBe(1);
    expect(m.gauge.cluster).toBe(1);
    await vi.advanceTimersByTimeAsync(7);
    expect(s).toEqual({ state: 'resolved', value: 'reply' });
    expect(calls).toHaveLength(1);
    expect(calls[0].self).toBe(client);
    expect(calls[0].args).toEqual(['GET', 'k']);
    expect(getClusterInflight()).toBe(0);
    expect(m.gauge.cluster).toBe(0);
    expect(m.durations).toEqual([{ client: 'cluster', seconds: 0.007 }]);
    expect(m.routing).toEqual([]);
    expect(countClusterDeadlineHits(60_000)).toBe(0); // 7ms < the 500ms slow threshold
  });

  it('a synchronous throw from _execute comes back as a rejection, not a throw, and settles the accounting', async () => {
    const boom = new Error('sync boom');
    const { client } = fakeCluster(() => {
      throw boom;
    });
    instrumentCommands(client, 'cluster', { ...CLUSTER_OPTS, routingRetryEnabled: false });
    let p: Promise<unknown> | undefined;
    expect(() => (p = client._execute('GET', 'k'))).not.toThrow();
    const s = track(p!);
    await vi.advanceTimersByTimeAsync(0);
    expect(s).toEqual({ state: 'rejected', error: boom });
    expect(getClusterInflight()).toBe(0);
    expect(m.gauge.cluster).toBe(0);
    expect(m.durations).toHaveLength(1);
  });

  it('a non-retryable error rejects with the SAME error object, is never retried and is not counted as a routing retry', async () => {
    const wrongType = new Error(
      'WRONGTYPE Operation against a key holding the wrong kind of value'
    );
    const { client, calls } = fakeCluster(() => Promise.reject(wrongType));
    instrumentCommands(client, 'cluster', CLUSTER_OPTS);
    const s = track(client._execute('GET', 'k'));
    await vi.advanceTimersByTimeAsync(500);
    expect(s).toEqual({ state: 'rejected', error: wrongType });
    expect(calls).toHaveLength(1);
    expect(m.routing).toEqual([]);
    expect(m.gauge.cluster).toBe(0);
  });

  it('a retryable routing error is retried after the first backoff and recovers: one command, counted "recovered"', async () => {
    const { client, calls } = fakeCluster((n) =>
      n === 0 ? Promise.reject(routingThrow()) : Promise.resolve('ok')
    );
    instrumentCommands(client, 'cluster', CLUSTER_OPTS);
    const s = track(client._execute('GET', 'k'));
    await vi.advanceTimersByTimeAsync(49);
    expect(calls).toHaveLength(1); // still inside the 50ms backoff
    expect(s.state).toBe('pending');
    expect(getClusterInflight()).toBe(1); // the retry is the same in-flight unit
    expect(m.gauge.cluster).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(s).toEqual({ state: 'resolved', value: 'ok' });
    expect(calls.map((c) => c.at - 1_000_000)).toEqual([0, 50]);
    expect(calls[1].args).toEqual(['GET', 'k']);
    expect(m.routing).toEqual(['recovered']);
    expect(getClusterInflight()).toBe(0);
    expect(m.gauge.cluster).toBe(0);
    expect(m.durations).toEqual([{ client: 'cluster', seconds: 0.05 }]);
  });

  it('retries exhausted: 1 + max attempts at the configured backoffs, rejects with the last attempt\'s error, counted "exhausted"', async () => {
    const errors: TypeError[] = [];
    const { client, calls } = fakeCluster(() => {
      const e = routingThrow();
      errors.push(e);
      return Promise.reject(e);
    });
    instrumentCommands(client, 'cluster', CLUSTER_OPTS);
    const s = track(client._execute('GET', 'k'));
    await vi.advanceTimersByTimeAsync(300);
    expect(calls.map((c) => c.at - 1_000_000)).toEqual([0, 50, 200]); // 50, then 150
    expect(s).toEqual({ state: 'rejected', error: errors[2] });
    expect(m.routing).toEqual(['exhausted']);
    expect(getClusterInflight()).toBe(0);
    expect(m.durations).toHaveLength(1);
  });

  it('routing retry off: a retryable error is rejected at once, with no retry and nothing counted', async () => {
    const err = routingThrow();
    const { client, calls } = fakeCluster(() => Promise.reject(err));
    instrumentCommands(client, 'cluster', { ...CLUSTER_OPTS, routingRetryEnabled: false });
    const s = track(client._execute('GET', 'k'));
    await vi.advanceTimersByTimeAsync(500);
    expect(s).toEqual({ state: 'rejected', error: err });
    expect(calls).toHaveLength(1);
    expect(m.routing).toEqual([]);
  });

  it('deadline exceeded: released exactly at the deadline with the timeout error; accounted once, as slow', async () => {
    const { client } = fakeCluster(never);
    instrumentCommands(client, 'cluster', CLUSTER_OPTS);
    const s = track(client._execute('GET', 'k'));
    await vi.advanceTimersByTimeAsync(999);
    expect(s.state).toBe('pending');
    expect(getClusterInflight()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.state).toBe('rejected');
    expect((s.error as Error).message).toBe('redis cluster command timed out after 1000ms');
    expect(getClusterInflight()).toBe(0);
    expect(m.gauge.cluster).toBe(0);
    expect(m.durations).toEqual([{ client: 'cluster', seconds: 1 }]);
    expect(countClusterDeadlineHits(60_000)).toBe(1); // 1000ms >= the 500ms slow threshold
  });

  it('the deadline bounds the whole retried sequence, not each attempt', async () => {
    const { client, calls } = fakeCluster(() => Promise.reject(routingThrow()));
    instrumentCommands(client, 'cluster', { ...CLUSTER_OPTS, deadlineMs: 120 });
    const s = track(client._execute('GET', 'k'));
    await vi.advanceTimersByTimeAsync(119);
    expect(s.state).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(s.state).toBe('rejected');
    expect((s.error as Error).message).toBe('redis cluster command timed out after 120ms');
    expect(calls).toHaveLength(2); // the third attempt (at 200ms) had not run when it was released
    expect(getClusterInflight()).toBe(0);
  });

  it('a reply that lands after the deadline neither changes what the caller got nor accounts the command twice', async () => {
    const { client } = fakeCluster(() => new Promise((r) => setTimeout(() => r('late'), 1500)));
    instrumentCommands(client, 'cluster', CLUSTER_OPTS);
    const s = track(client._execute('GET', 'k'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.state).toBe('rejected');
    expect(getClusterInflight()).toBe(0);
    expect(m.gauge.cluster).toBe(0);
    expect(m.durations).toHaveLength(1);
    expect(countClusterDeadlineHits(60_000)).toBe(1);
  });
});

describe('instrumentCommands (sys, single-node client): what a caller gets', () => {
  let m: ReturnType<typeof installBridge>;
  beforeEach(() => {
    resetSysInflight();
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    m = installBridge();
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as any).__civitaiRedisMetrics;
  });

  it('success through sendCommand: the reply, one sys command accounted, nothing on the cluster side', async () => {
    const underlying = vi.fn(
      (_cmd: string[]) => new Promise((r) => setTimeout(() => r('PONG'), 3))
    );
    const client: any = { sendCommand: underlying };
    instrumentCommands(client, 'sys', { sysDeadlineMs: 30_000, sysInflightCap: 0 });
    const s = track(client.sendCommand(['PING']));
    expect(getSysInflight()).toBe(1);
    await vi.advanceTimersByTimeAsync(3);
    expect(s).toEqual({ state: 'resolved', value: 'PONG' });
    expect(underlying).toHaveBeenCalledTimes(1);
    expect(underlying).toHaveBeenCalledWith(['PING']);
    expect(getSysInflight()).toBe(0);
    expect(m.gauge).toEqual({ cluster: 0, sys: 0 });
    expect(m.durations).toEqual([{ client: 'sys', seconds: 0.003 }]);
  });

  it('an error reply rejects with the same error object and settles the accounting', async () => {
    const err = new Error('ERR unknown command');
    const client: any = { sendCommand: () => Promise.reject(err) };
    instrumentCommands(client, 'sys', { sysDeadlineMs: 30_000, sysInflightCap: 0 });
    const s = track(client.sendCommand(['NOPE']));
    await vi.advanceTimersByTimeAsync(0);
    expect(s).toEqual({ state: 'rejected', error: err });
    expect(getSysInflight()).toBe(0);
    expect(m.gauge.sys).toBe(0);
  });
});

describe('a batch of N accounts exactly as N separate commands', () => {
  let m: ReturnType<typeof installBridge>;
  beforeEach(() => {
    resetClusterInflight();
    resetClusterDeadlineHits();
    vi.useFakeTimers();
    vi.setSystemTime(3_000_000);
    m = installBridge();
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as any).__civitaiRedisMetrics;
  });

  const N = 37;
  const OPTS = { deadlineMs: 1000, slowCommandMs: 10 };

  /** Settle N commands 20ms after they start, sent as N routed commands or one batch of N. */
  async function totals(mode: 'routed' | 'batch') {
    const during: number[] = [];
    if (mode === 'routed') {
      const { client } = fakeCluster(() => new Promise((r) => setTimeout(() => r('v'), 20)));
      instrumentCommands(client, 'cluster', { ...CLUSTER_OPTS, ...OPTS });
      const all = Promise.all(Array.from({ length: N }, () => client._execute('GET', 'k')));
      during.push(getClusterInflight(), m.gauge.cluster);
      await vi.advanceTimersByTimeAsync(20);
      await all;
    } else {
      const p = trackClusterCommands(
        N,
        () => new Promise((r) => setTimeout(() => r('v'), 20)),
        OPTS
      );
      during.push(getClusterInflight(), m.gauge.cluster);
      await vi.advanceTimersByTimeAsync(20);
      await expect(p).resolves.toBe('v');
    }
    return {
      during,
      after: [getClusterInflight(), m.gauge.cluster],
      durations: m.durations.map((d) => `${d.client}:${d.seconds}`),
      slowHits: countClusterDeadlineHits(60_000),
    };
  }

  it('routed: N in flight while running, 0 after, N duration samples, N slow settles', async () => {
    expect(await totals('routed')).toEqual({
      during: [N, N],
      after: [0, 0],
      durations: Array(N).fill('cluster:0.02'),
      slowHits: N,
    });
  });

  it('batch: the same totals as N routed commands', async () => {
    expect(await totals('batch')).toEqual({
      during: [N, N],
      after: [0, 0],
      durations: Array(N).fill('cluster:0.02'),
      slowHits: N,
    });
  });

  it('batch past its deadline: released at the deadline, every one of the N accounted once', async () => {
    const s = track(trackClusterCommands(N, never, OPTS));
    await vi.advanceTimersByTimeAsync(999);
    expect(s.state).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect((s.error as Error).message).toBe('redis cluster command timed out after 1000ms');
    expect([getClusterInflight(), m.gauge.cluster]).toEqual([0, 0]);
    expect(m.durations).toHaveLength(N);
    expect(countClusterDeadlineHits(60_000)).toBe(N);
  });

  it('batch cost: the in-flight gauge is written once when the batch starts and once when it settles, not N times each', async () => {
    const p = trackClusterCommands(N, () => Promise.resolve('v'), OPTS);
    expect(m.writes.inc).toBe(1);
    await p;
    expect(m.writes).toEqual({ inc: 1, dec: 1 });
    expect(m.gauge.cluster).toBe(0);
  });
});
