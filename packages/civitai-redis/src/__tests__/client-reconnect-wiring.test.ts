import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Wiring inside getBaseClient/getClient — the parts the pure unit tests (cluster-reconnect.test.ts,
 * selfheal-reconnect-bounds.test.ts, sentinel-reconnect.test.ts) cannot see:
 *   - the cluster node defaults carry the throttled rediscover-on-error strategy bound to THIS
 *     client, and REDIS_CLUSTER_ERROR_REDISCOVER_ENABLED=false removes it;
 *   - the sys bounds (and their off switch) come from config with no explicit options;
 *   - the sys Sentinel's master connections give up once the Sentinel names another master, and
 *     not while this client has a master connection up (the master-loss fix);
 *   - a sys client whose connect() fails is destroyed.
 *
 * `redis` is mocked so no socket is ever opened; everything else in the package is real.
 */
const h = vi.hoisted(() => ({
  clusterOpts: [] as any[],
  clusters: [] as any[],
  sentinels: [] as any[],
  sentinelOpts: [] as any[],
  clusterConnect: (): Promise<unknown> => Promise.resolve(),
  /** What a Sentinel answers to GET-MASTER-ADDR-BY-NAME; undefined = use the real createClient. */
  sentinelAnswer: undefined as [string, string] | undefined,
  /** Every command the Sentinel query's short-lived clients send, with the password they used. */
  queryCalls: [] as { cmd: string; password: string | undefined }[],
  /** When set, every fake Sentinel's connect() rejects with it. */
  sentinelConnectError: undefined as Error | undefined,
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
    createClient: (opts: any) => {
      if (!h.sentinelAnswer) return actual.createClient(opts);
      const fake: any = {
        isOpen: false,
        on: () => fake,
        connect: async () => {
          fake.isOpen = true;
          return fake;
        },
        // A Sentinel answers with the named master; that node answers ROLE as a master.
        sendCommand: async (args: string[]) => {
          h.queryCalls.push({ cmd: args[0], password: opts?.password });
          return args[0] === 'ROLE' ? ['master'] : h.sentinelAnswer;
        },
        destroy: () => {
          fake.isOpen = false;
        },
      };
      return fake;
    },
    createSentinel: (opts: any) => {
      h.sentinelOpts.push(opts);
      const fake: any = {
        listeners: {} as Record<string, ((e: any) => void)[]>,
        on: (event: string, listener: (e: any) => void) => {
          (fake.listeners[event] ??= []).push(listener);
          return fake;
        },
        // As RedisSentinel 5.8.3: connect() marks it open at once and leaves it open when it
        // rejects; only destroy() closes it.
        isOpen: false,
        connect: vi.fn(async () => {
          if (fake.isOpen) throw new Error('already attempting to open');
          fake.isOpen = true;
          if (h.sentinelConnectError) throw h.sentinelConnectError;
          return fake;
        }),
        destroy: vi.fn(async () => {
          fake.isOpen = false;
        }),
        /** This client's ready master connection, if any (RedisSentinel getMasterNode()). */
        masterNode: undefined as { host: string; port: number } | undefined,
        getMasterNode: () => fake.masterNode,
        withTypeMapping: () => fake,
        _execute: vi.fn(never),
      };
      h.sentinels.push(fake);
      return fake;
    },
  };
});

import { ConnectionTimeoutError } from 'redis';
import { connectOrDestroy, createCacheRedis, createSysRedis } from '../client';
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

describe('sys Sentinel master connections give up on an address the Sentinel stopped naming', () => {
  // Regression: they retried an address forever, so a discovery that dialled a master gone for
  // good never finished and the client timed out every command until the process restarted
  // (behaviour proven against a real Sentinel in sentinel-master-loss.integration.test.ts).
  afterEach(() => {
    h.sentinelAnswer = undefined;
  });
  // A Sentinel set per test: the "which master?" answer is shared per set, process-wide.
  let port = 26400;
  const sentinel = () => ({ sysSentinels: `127.0.0.1:${port++}`, sysSentinelName: 'sysmaster' });
  /** The last-built sys base client: its node strategy, and its MASTER_CHANGE event. */
  const lastSentinel = () => {
    const strategy = h.sentinelOpts.at(-1).nodeClientOptions.socket.reconnectStrategy;
    const fake = h.sentinels.at(-1);
    const masterChange = (host: string) =>
      fake.listeners['topology-change'].forEach((l: (e: any) => void) =>
        l({ type: 'MASTER_CHANGE', node: { host, port: 6379 } })
      );
    return { strategy, masterChange };
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('asks the Sentinel with the Sentinel password, and the named node with the node password', async () => {
    h.sentinelAnswer = ['10.0.0.2', '6379'];
    h.queryCalls.length = 0;
    createSysRedis({
      ...sentinel(),
      sysUrl: 'redis://:node-pw@127.0.0.1:6380',
      sysSentinelPassword: 'sentinel-pw',
      sysSelfHealEnabled: false,
      log: () => undefined,
    });
    const { strategy, masterChange } = lastSentinel();
    masterChange('10.0.0.1');
    strategy(0, connErr());
    await settle();
    // This query's SENTINEL→ROLE pair runs on microtasks inside settle(), so it is always the
    // first two entries; another test's polling source could only append after them.
    expect(h.queryCalls.slice(0, 2)).toEqual([
      { cmd: 'SENTINEL', password: 'sentinel-pw' },
      { cmd: 'ROLE', password: 'node-pw' },
    ]);
  });

  it('gives up on the dialled master once the Sentinel names another one', async () => {
    h.sentinelAnswer = ['10.0.0.2', '6379'];
    createSysRedis({ ...sentinel(), sysSelfHealEnabled: false, log: () => undefined });
    const { strategy, masterChange } = lastSentinel();
    masterChange('10.0.0.1');
    expect(strategy(0, connErr())).toBe(0); // starts the Sentinel query
    await settle();
    expect(strategy(1, new ConnectionTimeoutError())).toBeInstanceOf(Error);
  });

  it("keeps retrying while this client's RedisSentinel has a master connection up", async () => {
    h.sentinelAnswer = ['10.0.0.2', '6379'];
    createSysRedis({ ...sentinel(), sysSelfHealEnabled: false, log: () => undefined });
    const { strategy, masterChange } = lastSentinel();
    const [serving, buffer] = h.sentinels.slice(-2);
    masterChange('10.0.0.1');
    // Negative control: the OTHER sys client's connection being up does not count for this one.
    serving.masterNode = { host: '10.0.0.1', port: 6379 };
    strategy(0, connErr());
    await settle();
    expect(strategy(1, connErr())).toBeInstanceOf(Error);
    buffer.masterNode = { host: '10.0.0.1', port: 6379 };
    expect(strategy(2, connErr())).toBe(200);
  });

  it('REDIS_SYS_SENTINEL_STALE_MASTER_GIVEUP_ENABLED=false: never gives up', async () => {
    h.sentinelAnswer = ['10.0.0.2', '6379'];
    createSysRedis({
      ...sentinel(),
      sysSentinelStaleMasterGiveUpEnabled: false,
      sysSelfHealEnabled: false,
      log: () => undefined,
    });
    const { strategy, masterChange } = lastSentinel();
    masterChange('10.0.0.1');
    strategy(0, connErr());
    await settle();
    expect(strategy(1000, connErr())).toBe(3000);
  });
});

describe('a sys client whose connect() fails is destroyed', () => {
  // A RedisSentinel whose connect() gave up keeps the closed master connections of its last
  // discovery and is never ready; commands then spin on microtasks. destroy() empties that list.
  afterEach(() => {
    h.sentinelConnectError = undefined;
  });

  it('both sys base clients are destroyed when their first connect() rejects', async () => {
    h.sentinelConnectError = new Error('None of the sentinels are available');
    const before = h.sentinels.length;
    createSysRedis({
      sysSentinels: '127.0.0.1:26500',
      sysSentinelName: 'sysmaster',
      sysSelfHealEnabled: false,
      log: () => undefined,
    });
    await new Promise((r) => setTimeout(r, 0));
    const built = h.sentinels.slice(before);
    expect(built).toHaveLength(2); // serving + Buffer-mode
    for (const fake of built) expect(fake.destroy).toHaveBeenCalledTimes(1);
  });

  it('connectOrDestroy leaves a client that was already open alone', async () => {
    const refused = new Error('already attempting to open');
    const client = {
      isOpen: true,
      connect: vi.fn(async () => Promise.reject(refused)),
      destroy: vi.fn(),
    };
    await expect(connectOrDestroy(client)).rejects.toBe(refused);
    expect(client.destroy).not.toHaveBeenCalled();
  });

  it('connectOrDestroy does not destroy on success, and survives a destroy() that throws', async () => {
    const ok = { isOpen: false, connect: vi.fn(async () => 'up'), destroy: vi.fn() };
    await expect(connectOrDestroy(ok)).resolves.toBe('up');
    expect(ok.destroy).not.toHaveBeenCalled();

    const failed = new Error('gave up');
    const closed = {
      isOpen: false,
      connect: vi.fn(async () => Promise.reject(failed)),
      destroy: vi.fn(() => {
        throw new Error('The client is closed');
      }),
    };
    await expect(connectOrDestroy(closed)).rejects.toBe(failed);
    expect(closed.destroy).toHaveBeenCalledTimes(1);
  });
});

describe('a failing stale-master query is logged', () => {
  it('warns, rate-limited, when the Sentinel cannot be asked (otherwise the guard is silently off)', async () => {
    const lines: string[] = [];
    // No fake Sentinel answer: the query's client is the real one, dialling a port nobody listens on.
    createSysRedis({
      sysSentinels: '127.0.0.1:1',
      sysSentinelName: 'sysmaster',
      sysSelfHealEnabled: false,
      timeout: 500,
      log: (m: string) => lines.push(m),
    });
    const fake = h.sentinels.at(-1);
    const strategy = h.sentinelOpts.at(-1).nodeClientOptions.socket.reconnectStrategy;
    fake.listeners['topology-change'].forEach((l: (e: any) => void) =>
      l({ type: 'MASTER_CHANGE', node: { host: '10.0.0.1', port: 6379 } })
    );
    strategy(0, connErr());
    const failed = () =>
      lines.filter((m) => m.startsWith('Redis Sentinel stale-master query failed: '));
    for (let i = 0; i < 100 && failed().length === 0; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(failed()).toHaveLength(1);
    expect(failed()[0]).toMatch(/SENTINEL 127\.0\.0\.1:1: /);
  });
});
