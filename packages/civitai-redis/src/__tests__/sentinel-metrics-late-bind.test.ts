import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSysRedis } from '../client';

/**
 * The sysRedis Sentinel counters must be resolved from `globalThis.__civitaiRedisMetrics` at EVENT
 * time, not captured once when the client is built.
 *
 * The app now builds ONE sys client per process (memoized on globalThis), shared by every bundler
 * runtime. Whichever runtime builds it first is not necessarily the one whose registry
 * `/api/metrics` scrapes — and the metrics bag on the global can be republished after the client
 * exists. A counter captured at build time would then increment a registry nobody scrapes, and
 * `civitai_sysredis_sentinel_topology_changes_total` / `..._client_errors_total` would silently
 * vanish. Every other Redis metric re-reads the bag per call; these two must as well.
 */

const sentinels: Array<{ emit: (event: string, payload: unknown) => boolean }> = [];

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

type Inc = { counter: string; labels: Record<string, string> };

function makeBag(name: string, sink: Inc[]) {
  const counter = (counterName: string) => ({
    labels: (labels: Record<string, string>) => ({
      inc: () => sink.push({ counter: `${name}:${counterName}`, labels }),
    }),
  });
  return {
    sysredisSentinelTopologyChangesCounter: counter('topology'),
    sysredisSentinelClientErrorsCounter: counter('errors'),
  };
}

function setBag(bag: unknown) {
  (globalThis as unknown as { __civitaiRedisMetrics?: unknown }).__civitaiRedisMetrics = bag;
}

describe('sysRedis Sentinel counters — resolved at event time', () => {
  beforeAll(() => {
    process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
    process.env.REDIS_SYS_URL ??= 'redis://127.0.0.1:6379';
  });

  afterEach(() => {
    delete (globalThis as unknown as { __civitaiRedisMetrics?: unknown }).__civitaiRedisMetrics;
  });

  it('counts into the metrics bag present when the event fires, not the one present at build', () => {
    const incsA: Inc[] = [];
    const incsB: Inc[] = [];
    setBag(makeBag('A', incsA));

    sentinels.length = 0;
    createSysRedis({
      sysSentinels: '127.0.0.1:26379',
      sysSentinelName: 'sysmaster',
      log: () => undefined,
    });
    expect(sentinels.length).toBeGreaterThanOrEqual(1);

    // Another runtime republishes the bag after the shared client exists.
    setBag(makeBag('B', incsB));

    const serving = sentinels[0];
    serving.emit('topology-change', { type: 'MASTER_CHANGE', node: { host: 'h-topo', port: 1 } });
    serving.emit('client-error', {
      type: 'MASTER',
      node: { host: 'h-err', port: 2 },
      error: new Error('boom'),
    });

    expect(incsA).toEqual([]);
    expect(incsB).toEqual([
      {
        counter: 'B:topology',
        labels: expect.objectContaining({ type: 'MASTER_CHANGE', host: 'h-topo' }),
      },
      {
        counter: 'B:errors',
        labels: expect.objectContaining({ type: 'MASTER', host: 'h-err' }),
      },
    ]);
  });

  it('counts once the bag is published even if the client was built before any bag existed', () => {
    const incs: Inc[] = [];
    sentinels.length = 0;
    createSysRedis({
      sysSentinels: '127.0.0.1:26379',
      sysSentinelName: 'sysmaster',
      log: () => undefined,
    });
    // No bag at build time (prom bridge not loaded yet) — an event now is a silent noop...
    sentinels[0].emit('topology-change', { type: 'X', node: { host: 'h0', port: 0 } });
    expect(incs).toEqual([]);

    // ...and once the bridge publishes, later events are counted.
    setBag(makeBag('late', incs));
    sentinels[0].emit('topology-change', { type: 'Y', node: { host: 'h1', port: 1 } });
    expect(incs).toEqual([
      { counter: 'late:topology', labels: expect.objectContaining({ type: 'Y', host: 'h1' }) },
    ]);
  });
});
