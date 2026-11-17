import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSentinel, ErrorReply } from 'redis';
import { instrumentCommands } from '../client';
import { resetSysInflight } from '../sys-inflight';

// A write sent to a primary that a failover has just demoted fails with READONLY. These cases drive
// the real sys command wrapper (instrumentCommands) against Sentinel- and single-node-shaped fakes.

const readonly = () => new ErrorReply("READONLY You can't write against a read only replica.");

type Step = 'readonly' | 'ok' | Error;

/** Sentinel-shaped fake (RedisSentinel routes every command through `_execute`). */
function fakeSentinel(steps: Step[]) {
  const callTimes: number[] = [];
  const client = {
    callTimes,
    _execute: async (..._args: unknown[]) => {
      callTimes.push(Date.now());
      const step = steps[Math.min(callTimes.length - 1, steps.length - 1)];
      if (step === 'ok') return 'OK';
      throw step === 'readonly' ? readonly() : step;
    },
    // As RedisSentinel does: the pipeline is one `_execute` call.
    _executePipeline(this: any, isReadonly: boolean) {
      return this._execute(isReadonly, () => undefined);
    },
  };
  return client;
}

function settle(p: Promise<unknown>) {
  const s: { state: string; value?: unknown; reason?: unknown } = { state: 'pending' };
  p.then(
    (value) => Object.assign(s, { state: 'fulfilled', value }),
    (reason) => Object.assign(s, { state: 'rejected', reason })
  );
  return s;
}

const deltas = (times: number[]) => times.slice(1).map((t, i) => t - times[i]);

beforeEach(() => {
  vi.useFakeTimers();
  resetSysInflight();
});
afterEach(() => {
  vi.useRealTimers();
});

const NO_BOUNDS = { sysInflightCap: 0, sysDeadlineMs: 0 };

describe('sys READONLY retry', () => {
  it('retries a write rejected with READONLY with growing delays until it succeeds', async () => {
    const client = fakeSentinel(['readonly', 'readonly', 'readonly', 'ok']);
    instrumentCommands(client, 'sys', NO_BOUNDS);

    const s = settle((client as any)._execute(false, () => undefined));
    await vi.advanceTimersByTimeAsync(1000);

    expect(s).toEqual({ state: 'fulfilled', value: 'OK' });
    expect(client.callTimes).toHaveLength(4);
    expect(deltas(client.callTimes)).toEqual([50, 100, 200]);
  });

  it('gives up after the last backoff step and throws the original READONLY error', async () => {
    const client = fakeSentinel(['readonly']);
    instrumentCommands(client, 'sys', { ...NO_BOUNDS, sysReadonlyRetryBackoffMs: [30, 70, 110] });

    const s = settle((client as any)._execute(false, () => undefined));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(s.state).toBe('rejected');
    expect(s.reason).toBeInstanceOf(ErrorReply);
    expect((s.reason as Error).message).toMatch(/^READONLY /);
    expect(deltas(client.callTimes)).toEqual([30, 70, 110]);
  });

  it('total extra wait with the default schedule stays under a second', async () => {
    const client = fakeSentinel(['readonly']);
    instrumentCommands(client, 'sys', NO_BOUNDS);

    const s = settle((client as any)._execute(false, () => undefined));
    await vi.advanceTimersByTimeAsync(999);

    expect(s.state).toBe('rejected');
    expect(client.callTimes.length).toBeGreaterThan(1);
    expect(client.callTimes.at(-1)! - client.callTimes[0]).toBeLessThan(1000);
  });

  it('does not retry any other error', async () => {
    const other = new ErrorReply(
      'WRONGTYPE Operation against a key holding the wrong kind of value'
    );
    const client = fakeSentinel([other, 'ok']);
    instrumentCommands(client, 'sys', NO_BOUNDS);

    const s = settle((client as any)._execute(false, () => undefined));
    await vi.advanceTimersByTimeAsync(1000);

    expect(s).toEqual({ state: 'rejected', reason: other });
    expect(client.callTimes).toHaveLength(1);
  });

  it('does not retry a pipeline, whose earlier writes may already have been applied', async () => {
    const client = fakeSentinel(['readonly', 'ok']);
    instrumentCommands(client, 'sys', NO_BOUNDS);

    const s = settle((client as any)._executePipeline(false));
    await vi.advanceTimersByTimeAsync(1000);

    expect(s.state).toBe('rejected');
    expect(client.callTimes).toHaveLength(1);
  });

  it('still retries a single command started after a pipeline', async () => {
    // Call 1 is the pipeline; the command after it gets READONLY (call 2) then OK (call 3), so it
    // can only succeed by being retried.
    const client = fakeSentinel(['readonly', 'readonly', 'ok']);
    instrumentCommands(client, 'sys', NO_BOUNDS);

    const pipeline = settle((client as any)._executePipeline(false));
    await vi.advanceTimersByTimeAsync(1000);
    expect(pipeline.state).toBe('rejected');
    expect(client.callTimes).toHaveLength(1);

    const after = settle((client as any)._execute(false, () => undefined));
    await vi.advanceTimersByTimeAsync(1000);
    expect(after).toEqual({ state: 'fulfilled', value: 'OK' });
    expect(client.callTimes).toHaveLength(3);
  });

  it('does not retry on the single-node client, which has no master to re-resolve', async () => {
    let n = 0;
    const client = {
      sendCommand: async (..._args: unknown[]) => {
        if (n++ < 2) throw readonly();
        return 'OK';
      },
    };
    instrumentCommands(client, 'sys', NO_BOUNDS);

    const s = settle((client as any).sendCommand(['SET', 'k', 'v']));
    await vi.advanceTimersByTimeAsync(1000);

    expect(s.state).toBe('rejected');
    expect((s.reason as Error).message).toMatch(/^READONLY /);
    expect(n).toBe(1);
  });

  it('is off when disabled', async () => {
    const client = fakeSentinel(['readonly', 'ok']);
    instrumentCommands(client, 'sys', { ...NO_BOUNDS, sysReadonlyRetryEnabled: false });

    const s = settle((client as any)._execute(false, () => undefined));
    await vi.advanceTimersByTimeAsync(1000);

    expect(s.state).toBe('rejected');
    expect(client.callTimes).toHaveLength(1);
  });
});

describe('sys READONLY retry outcome metric', () => {
  type MetricsGlobal = { __civitaiRedisMetrics?: unknown };
  const results: string[] = [];
  const noop = { inc: () => undefined, dec: () => undefined, observe: () => undefined };

  beforeEach(() => {
    results.length = 0;
    (globalThis as MetricsGlobal).__civitaiRedisMetrics = new Proxy(
      {},
      {
        get: (_t, prop) => {
          if (prop === 'then') return undefined;
          if (prop === 'redisSysReadonlyRetryCounter')
            return { inc: (l: { result: string }) => void results.push(l.result) };
          return { ...noop, labels: () => noop };
        },
      }
    );
  });
  afterEach(() => {
    delete (globalThis as MetricsGlobal).__civitaiRedisMetrics;
  });

  it('counts a recovered retry once', async () => {
    const client = fakeSentinel(['readonly', 'readonly', 'ok']);
    instrumentCommands(client, 'sys', NO_BOUNDS);

    const s = settle((client as any)._execute(false, () => undefined));
    await vi.advanceTimersByTimeAsync(1000);

    expect(s).toEqual({ state: 'fulfilled', value: 'OK' });
    expect(results).toEqual(['recovered']);
  });

  it('counts an exhausted retry once', async () => {
    const client = fakeSentinel(['readonly']);
    instrumentCommands(client, 'sys', NO_BOUNDS);

    const s = settle((client as any)._execute(false, () => undefined));
    await vi.advanceTimersByTimeAsync(1000);

    expect(s.state).toBe('rejected');
    expect(results).toEqual(['exhausted']);
  });

  it('counts nothing for a command that succeeds first time or fails with another error', async () => {
    const ok = fakeSentinel(['ok']);
    instrumentCommands(ok, 'sys', NO_BOUNDS);
    const other = fakeSentinel([new ErrorReply('WRONGTYPE wrong kind of value')]);
    instrumentCommands(other, 'sys', NO_BOUNDS);

    const a = settle((ok as any)._execute(false, () => undefined));
    const b = settle((other as any)._execute(false, () => undefined));
    await vi.advanceTimersByTimeAsync(1000);

    expect(a.state).toBe('fulfilled');
    expect(b.state).toBe('rejected');
    expect(results).toEqual([]);
  });
});

// The pipeline rule above leans on node-redis: RedisSentinel's `_executePipeline` must call
// `_execute` synchronously, before its first await, or the no-retry mark is already gone when the
// command starts. The hand fake cannot see a change there, so these cases build a REAL RedisSentinel
// from the pinned `redis` package and replace only its `_execute` (never connected, no sockets).
describe('sys READONLY retry on a real RedisSentinel', () => {
  function realSentinel(steps: Step[], reply: unknown) {
    const sentinel: any = createSentinel({
      name: 'mymaster',
      sentinelRootNodes: [{ host: '127.0.0.1', port: 1 }],
    });
    const self = sentinel._self;
    // The real methods under test must come from @redis/client, not from this file.
    expect(Object.prototype.hasOwnProperty.call(self, '_executePipeline')).toBe(false);
    expect(typeof Object.getPrototypeOf(self)._executePipeline).toBe('function');
    let calls = 0;
    self._execute = async (_isReadonly: boolean, _fn: unknown) => {
      calls++;
      const step = steps[Math.min(calls - 1, steps.length - 1)];
      if (step === 'ok') return reply;
      throw step === 'readonly' ? readonly() : step;
    };
    instrumentCommands(sentinel, 'sys', NO_BOUNDS);
    return { sentinel, calls: () => calls };
  }

  it('multi().execAsPipeline() is not retried', async () => {
    const { sentinel, calls } = realSentinel(['readonly', 'ok'], ['OK']);

    const s = settle(sentinel.multi().set('k', 'v').execAsPipeline());
    await vi.advanceTimersByTimeAsync(1000);

    expect(s.state).toBe('rejected');
    expect((s.reason as Error).message).toMatch(/^READONLY /);
    expect(calls()).toBe(1);
  });

  it('multi().exec() is retried (a MULTI aborts as a whole)', async () => {
    const { sentinel, calls } = realSentinel(['readonly', 'ok'], ['OK']);

    const s = settle(sentinel.multi().set('k', 'v').exec());
    await vi.advanceTimersByTimeAsync(1000);

    expect(s).toEqual({ state: 'fulfilled', value: ['OK'] });
    expect(calls()).toBe(2);
  });

  it('a typed command is retried', async () => {
    const { sentinel, calls } = realSentinel(['readonly', 'ok'], 'OK');

    const s = settle(sentinel.set('k', 'v'));
    await vi.advanceTimersByTimeAsync(1000);

    expect(s).toEqual({ state: 'fulfilled', value: 'OK' });
    expect(calls()).toBe(2);
  });
});
