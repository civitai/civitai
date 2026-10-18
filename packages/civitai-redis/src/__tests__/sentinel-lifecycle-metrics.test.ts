import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  attachSysSentinelLifecycleListeners,
  createSysRedis,
  SYS_SENTINEL_LIFECYCLE_EVENTS,
} from '../client';

/**
 * civitai_sysredis_sentinel_ready + civitai_sysredis_sentinel_lifecycle_events_total.
 *
 * The bag below stands in for the app's prom handles and keeps their state the way prom-client
 * does: a counter series exists from its first inc() (inc(0) included), a gauge holds the last
 * set(). `src/server/prom/__tests__/redis-metrics-bridge.test.ts` covers the real registry.
 */

const sentinels: Array<{ emit: (event: string, ...args: unknown[]) => boolean }> = [];

vi.mock('redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('redis')>();
  const noConnect = <T>(client: T): T => {
    (client as { connect: () => Promise<T> }).connect = () => Promise.resolve(client);
    return client;
  };
  return {
    ...actual,
    createSentinel: (opts: Parameters<typeof actual.createSentinel>[0]) => {
      const s = noConnect(actual.createSentinel(opts));
      sentinels.push(s as unknown as (typeof sentinels)[number]);
      return s;
    },
    createClient: (opts: Parameters<typeof actual.createClient>[0]) =>
      noConnect(actual.createClient(opts)),
  };
});

type Labels = Record<string, string>;
const key = (labels: Labels) => JSON.stringify(Object.entries(labels).sort());

function makeBag() {
  const counter = new Map<string, number>();
  const gauge = new Map<string, number>();
  return {
    counter,
    gauge,
    bag: {
      sysredisSentinelLifecycleEventsCounter: {
        labels: (l: Labels) => ({
          inc: (v = 1) => void counter.set(key(l), (counter.get(key(l)) ?? 0) + v),
        }),
      },
      sysredisSentinelReadyGauge: {
        labels: (l: Labels) => ({ set: (v: number) => void gauge.set(key(l), v) }),
      },
    },
  };
}

const DEP = 'pod-under-test';
const ready = (client: string) => (m: Map<string, number>) =>
  m.get(key({ client, deployment: DEP }));
const events = (client: string) => (m: Map<string, number>) =>
  Object.fromEntries(
    SYS_SENTINEL_LIFECYCLE_EVENTS.map((event) => [
      event,
      m.get(key({ event, client, deployment: DEP })),
    ])
  );

function fakeClient() {
  const listeners: Record<string, () => void> = {};
  return {
    on(event: string, listener: () => void) {
      listeners[event] = listener;
      return this;
    },
    fire(event: string) {
      listeners[event]?.();
    },
  };
}

describe('attachSysSentinelLifecycleListeners', () => {
  function wire() {
    const m = makeBag();
    const client = fakeClient();
    attachSysSentinelLifecycleListeners(client, {
      client: 'serving',
      deployment: DEP,
      log: () => undefined,
      readyGauge: m.bag.sysredisSentinelReadyGauge,
      lifecycleCounter: m.bag.sysredisSentinelLifecycleEventsCounter,
    });
    return { ...m, client };
  }

  it('seeds every event series and the gauge at 0 before any event', () => {
    const { counter, gauge } = wire();
    expect(events('serving')(counter)).toEqual({ connect: 0, ready: 0, reconnecting: 0, end: 0 });
    expect(ready('serving')(gauge)).toBe(0);
    // Exactly those series, no others.
    expect(counter.size).toBe(4);
    expect(gauge.size).toBe(1);
  });

  it('ready → 1, reconnecting → 0, ready → 1, end → 0; connect leaves the gauge; counts each', () => {
    const { counter, gauge, client } = wire();
    const steps: Array<[string, number]> = [
      ['connect', 0],
      ['ready', 1],
      ['reconnecting', 0],
      ['ready', 1],
      ['connect', 1], // never emitted while open in practice; pins that connect does not set it
      ['end', 0],
    ];
    const seen: number[] = [];
    for (const [event] of steps) {
      client.fire(event);
      seen.push(ready('serving')(gauge) as number);
    }
    expect(seen).toEqual(steps.map(([, v]) => v));
    expect(events('serving')(counter)).toEqual({ connect: 2, ready: 2, reconnecting: 1, end: 1 });
  });

  it('a throwing metric handle does not throw into the emitter', () => {
    const client = fakeClient();
    const logged: string[] = [];
    const boom = {
      labels: () => {
        throw new Error('label mismatch');
      },
    };
    expect(() =>
      attachSysSentinelLifecycleListeners(client, {
        client: 'serving',
        deployment: DEP,
        log: (msg) => void logged.push(msg),
        readyGauge: boom,
        lifecycleCounter: boom,
      })
    ).not.toThrow();
    expect(() => client.fire('ready')).not.toThrow();
    expect(logged).toEqual([
      'Redis sentinel lifecycle metrics write failed [client=serving]',
      'Redis sentinel lifecycle metrics write failed [client=serving]',
    ]);
  });
});

function setBag(bag: unknown) {
  (globalThis as unknown as { __civitaiRedisMetrics?: unknown }).__civitaiRedisMetrics = bag;
}

describe('sys Sentinel clients built by the factory', () => {
  beforeAll(() => {
    process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
    process.env.REDIS_SYS_URL ??= 'redis://127.0.0.1:6379';
  });
  afterEach(() => {
    delete (globalThis as unknown as { __civitaiRedisMetrics?: unknown }).__civitaiRedisMetrics;
    delete process.env.HOSTNAME;
  });

  function build() {
    sentinels.length = 0;
    process.env.HOSTNAME = DEP;
    createSysRedis({
      sysSentinels: '127.0.0.1:26379',
      sysSentinelName: 'sysmaster',
      log: () => undefined,
    });
    // The serving client, then the dedicated Buffer-mode one (getClient).
    expect(sentinels.length).toBe(2);
    return { serving: sentinels[0], buffer: sentinels[1] };
  }

  it('wires both the serving and the Buffer-mode client, seeded at 0, under distinct labels', () => {
    const m = makeBag();
    setBag(m.bag);
    const { serving, buffer } = build();

    for (const c of ['serving', 'buffer']) {
      expect(events(c)(m.counter), c).toEqual({ connect: 0, ready: 0, reconnecting: 0, end: 0 });
      expect(ready(c)(m.gauge), c).toBe(0);
    }

    serving.emit('ready');
    expect(ready('serving')(m.gauge)).toBe(1);
    expect(ready('buffer')(m.gauge)).toBe(0);
    buffer.emit('ready');
    buffer.emit('reconnecting');
    expect(ready('buffer')(m.gauge)).toBe(0);
    expect(events('buffer')(m.counter)).toEqual({ connect: 0, ready: 1, reconnecting: 1, end: 0 });
    serving.emit('end');
    expect(ready('serving')(m.gauge)).toBe(0);
    expect(events('serving')(m.counter)).toEqual({ connect: 0, ready: 1, reconnecting: 0, end: 1 });
  });

  it('a bag published after the client was built gets every series on the next event', () => {
    const { serving } = build();
    const m = makeBag();
    setBag(m.bag);
    expect(m.counter.size).toBe(0);

    serving.emit('ready');
    expect(events('serving')(m.counter)).toEqual({ connect: 0, ready: 1, reconnecting: 0, end: 0 });
    expect(ready('serving')(m.gauge)).toBe(1);
  });
});
