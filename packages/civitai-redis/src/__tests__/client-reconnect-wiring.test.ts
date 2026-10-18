import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Wiring of the node-address-change fixes inside getBaseClient/getClient — the parts the pure
 * unit tests (cluster-reconnect.test.ts, selfheal-reconnect-bounds.test.ts) cannot see: that the
 * cluster node defaults really carry the throttled rediscover-on-error strategy bound to THIS
 * client, that REDIS_CLUSTER_ERROR_REDISCOVER_ENABLED=false really removes it, and that the sys
 * bounds (and their off switch) come from config with no explicit options.
 *
 * `redis` is mocked so no socket is ever opened; everything else in the package is real.
 */
const h = vi.hoisted(() => ({
  clusterOpts: [] as any[],
  clusters: [] as any[],
  sentinels: [] as any[],
  clusterConnect: (): Promise<unknown> => Promise.resolve(),
}));

vi.mock('redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('redis')>();
  const never = () => new Promise<never>(() => undefined);
  return {
    ...actual,
    createCluster: (opts: any) => {
      const fake: any = {
        _options: { rootNodes: opts.rootNodes },
        _slots: {
          masters: [],
          nodeByAddress: new Map(),
          rediscover: vi.fn(() => Promise.resolve()),
          nodeClient: vi.fn((n: any) => n.client),
        },
        on: () => fake,
        connect: vi.fn(() => h.clusterConnect()),
        withTypeMapping: () => fake,
        _execute: vi.fn(never),
        destroy: vi.fn(),
      };
      h.clusterOpts.push(opts);
      h.clusters.push(fake);
      return fake;
    },
    createSentinel: () => {
      const fake: any = {
        on: () => fake,
        connect: vi.fn(async () => fake),
        withTypeMapping: () => fake,
        _execute: vi.fn(never),
      };
      h.sentinels.push(fake);
      return fake;
    },
  };
});

import { ConnectionTimeoutError } from 'redis';
import { createCacheRedis, createSysRedis } from '../client';
import { resetSysInflight } from '../sys-inflight';

const SEEDS = ['redis://seed-a:6379', 'redis://seed-b:6379'];

beforeAll(() => {
  process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
  process.env.REDIS_SYS_URL ??= 'redis://127.0.0.1:6380';
});

const connErr = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

describe('cluster client wiring', () => {
  afterEach(() => vi.useRealTimers());

  it('a node connect error rediscovers on THIS client from a seed, throttled to ~1s', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    createCacheRedis({
      url: SEEDS[0],
      cluster: true,
      clusterNodes: SEEDS.join(','),
      clusterSelfHealEnabled: false,
      log: () => undefined,
    });
    const fake = h.clusters.at(-1);
    const strategy = h.clusterOpts.at(-1).defaults.socket.reconnectStrategy;

    expect(strategy(0, connErr())).toBe(0);
    expect(fake._slots.rediscover).toHaveBeenCalledTimes(1);
    expect(SEEDS).toContain(fake._slots.rediscover.mock.calls[0][0].options.url);

    vi.setSystemTime(Date.now() + 999);
    expect(strategy(1, new ConnectionTimeoutError())).toBe(100);
    expect(fake._slots.rediscover).toHaveBeenCalledTimes(1); // inside the throttle
    vi.setSystemTime(Date.now() + 1);
    strategy(2, new ConnectionTimeoutError());
    expect(fake._slots.rediscover).toHaveBeenCalledTimes(2); // 1000ms later: through again
  });

  it('REDIS_CLUSTER_ERROR_REDISCOVER_ENABLED=false: the hook never rediscovers', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    createCacheRedis({
      url: SEEDS[0],
      cluster: true,
      clusterNodes: SEEDS.join(','),
      clusterSelfHealEnabled: false,
      clusterErrorRediscoverEnabled: false,
      log: () => undefined,
    });
    const fake = h.clusters.at(-1);
    const strategy = h.clusterOpts.at(-1).defaults.socket.reconnectStrategy;
    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(Date.now() + 5000); // well clear of any throttle window
      expect(strategy(i, i % 2 ? new ConnectionTimeoutError() : connErr())).toBe(i * 100);
    }
    expect(fake._slots.rediscover).not.toHaveBeenCalled();
  });
});

describe('sys client bounds come from config', () => {
  afterEach(() => vi.useRealTimers());

  it('the in-flight cap is REDIS_SYS_COMMANDS_QUEUE_MAX_LENGTH and the backstop defaults to 30s', async () => {
    vi.useFakeTimers();
    resetSysInflight();
    const sys: any = createSysRedis({
      sysSentinels: '127.0.0.1:26379',
      sysSentinelName: 'sysmaster',
      sysCommandsQueueMaxLength: 3,
      log: () => undefined,
    });
    const fn = () => undefined;
    const outcomes: string[] = [];
    for (let i = 0; i < 4; i++) {
      sys._execute(false, fn).then(
        () => outcomes.push('ok'),
        (e: Error) => outcomes.push(e.message)
      );
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(outcomes).toEqual(['sysRedis in-flight cap reached (3); command rejected']);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(outcomes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(outcomes.slice(1)).toEqual([
      'sysRedis command timed out after 30000ms',
      'sysRedis command timed out after 30000ms',
      'sysRedis command timed out after 30000ms',
    ]);
  });

  it('REDIS_SYS_COMMAND_TIMEOUT_MS=0 disables the backstop: a parked command is never timed out', async () => {
    vi.useFakeTimers();
    resetSysInflight();
    const sys: any = createSysRedis({
      sysSentinels: '127.0.0.1:26379',
      sysSentinelName: 'sysmaster',
      sysCommandTimeoutMs: 0,
      log: () => undefined,
    });
    const outcomes: string[] = [];
    sys
      ._execute(false, () => undefined)
      .then(
        () => outcomes.push('ok'),
        (e: Error) => outcomes.push(e.message)
      );
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(outcomes).toEqual([]); // still waiting on the (never-settling) fake after 10 minutes
  });
});
