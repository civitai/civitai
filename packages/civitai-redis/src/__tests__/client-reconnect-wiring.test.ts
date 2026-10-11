import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Wiring of the node-address-change fixes inside getBaseClient/getClient — the parts the pure
 * unit tests (cluster-reconnect.test.ts, selfheal-reconnect-bounds.test.ts) cannot see: that the
 * cluster node defaults really carry the throttled, give-up-capable strategy bound to THIS client,
 * that the lazy reopen is installed, that a rejected initial connect() still starts the watchdog,
 * and that the sys bounds come from config with no explicit options.
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
import { __getClusterSelfHealWatchdog, createCacheRedis, createSysRedis } from '../client';
import { resetSysInflight } from '../sys-inflight';

const SEEDS = ['redis://seed-a:6379', 'redis://seed-b:6379'];

beforeAll(() => {
  process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
  process.env.REDIS_SYS_URL ??= 'redis://127.0.0.1:6380';
});

describe('cluster client wiring', () => {
  let fake: any;
  let strategy: (retries: number, cause: unknown) => number | Error;

  beforeAll(() => {
    // The initial connect() REJECTS — what the give-up makes possible when a node is down at boot.
    h.clusterConnect = () => Promise.reject(new Error('RootNodesUnavailableError'));
    createCacheRedis({
      url: SEEDS[0],
      cluster: true,
      clusterNodes: SEEDS.join(','),
      clusterSelfHealEnabled: true,
      log: () => undefined,
    });
    fake = h.clusters[0];
    strategy = h.clusterOpts[0].defaults.socket.reconnectStrategy;
  });

  it('a rejected initial connect() still starts the self-heal watchdog', async () => {
    await vi.waitFor(() => expect(__getClusterSelfHealWatchdog()).toBeDefined());
  });

  it('installs the lazy node-client reopen on THIS client', () => {
    expect(fake._slots.__lazyReopenInstalled).toBe(true);
  });

  it('a node connect error rediscovers on this client from a seed, throttled to one a second', () => {
    expect(strategy(0, Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(0);
    expect(fake._slots.rediscover).toHaveBeenCalledTimes(1);
    const startWith = fake._slots.rediscover.mock.calls[0][0];
    expect(SEEDS).toContain(startWith.options.url);
    strategy(1, new ConnectionTimeoutError());
    expect(fake._slots.rediscover).toHaveBeenCalledTimes(1); // inside the 1s throttle
  });

  it('gives up on the 5th failed attempt and then drops the closed client', async () => {
    const closed = { address: 'gone:6379', client: { isOpen: false } };
    fake._slots.nodeByAddress.set('gone:6379', closed);
    expect(strategy(3, new ConnectionTimeoutError())).toBe(300);
    expect(strategy(4, new ConnectionTimeoutError())).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(closed.client).toBeUndefined());
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
});
