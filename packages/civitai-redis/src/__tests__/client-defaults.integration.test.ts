/**
 * INTEGRATION (opt-in): the behaviour this package relies on, checked against a real server with
 * the installed node-redis (6.x), for every client kind the package builds.
 *
 * Run with: REDIS_CLUSTER_IT=1 pnpm --filter @civitai/redis exec vitest run client-defaults
 * Needs docker on Linux (the test dials the containers' bridge addresses). Skipped otherwise, so
 * CI reports it as skipped rather than running it — see the package README.
 *
 * node-redis 6 changed defaults the package pins back (client.ts REDIS_RESP_VERSION,
 * REDIS_NO_COMMAND_TIMEOUT, REDIS_KEEPALIVE_INITIAL_DELAY_MS), and moved internals the package
 * hooks. Each case asserts what a server or socket actually sees, not the option literal, and
 * each pin has a control that builds a client WITHOUT it and shows the 6.x default, so a green
 * case cannot be a probe that would pass either way:
 *   - RESP: every connection negotiates RESP2 (CLIENT INFO / CLIENT LIST `resp=2`).
 *   - keepalive: every socket is created with a 5000 ms initial keepalive delay.
 *   - command timeout: 6.x rejects a command that waits more than 5000 ms to be WRITTEN (it clears
 *     the timer once the command is on the socket: client/commands-queue.js), e.g. one queued while
 *     its node reconnects. Ours wait for our own deadline instead.
 *   - instrumentation: a routed cluster command still passes through instrumentCommands' wrapper
 *     of `_execute` (metrics move, the cluster deadline fires).
 *   - cluster internals: triggerTopologyRediscovery re-reads the slot map, and the routing-retry
 *     classifier recognises the errors 6.x node selection throws on an empty slot map.
 */
import net from 'node:net';
import calculateSlot from 'cluster-key-slot';
import { createClient, createCluster, createSentinel } from 'redis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCacheRedis, createSysRedis, triggerTopologyRediscovery } from '../client';
import { isTransientClusterRoutingError } from '../cluster-routing-retry';
import { DockerRedisCluster, dockerAvailable } from './helpers/docker-redis-cluster';
import { DockerRedisSentinel } from './helpers/docker-redis-sentinel';

const ENABLED = process.env.REDIS_CLUSTER_IT === '1';
if (ENABLED && !dockerAvailable()) {
  throw new Error('REDIS_CLUSTER_IT=1 but `docker info` failed — docker is required for this test');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const itLog = (msg: string, ...rest: unknown[]) => {
  if (process.env.REDIS_CLUSTER_IT_LOG !== '1') return;
  const extra = rest.map((r) => (r instanceof Error ? r.message : String(r))).join(' ');
  process.stdout.write(`${Date.now()} ${msg} ${extra}\n`);
};

/** Metric samples from the bridge, by metric: the client label of each, in order. */
const samples = {
  duration: [] as string[],
  inflightInc: [] as string[],
  routingRetry: [] as string[],
};
const noopMetric = { inc: () => undefined, dec: () => undefined, observe: () => undefined };
(globalThis as any).__civitaiRedisMetrics = new Proxy(
  {},
  {
    get: (_t, prop) => {
      if (prop === 'then') return undefined;
      if (prop === 'redisCommandDuration')
        return { observe: (l: { client: string }) => void samples.duration.push(l.client) };
      if (prop === 'redisCommandsInflight')
        return {
          inc: (l: { client: string }) => void samples.inflightInc.push(l.client),
          dec: () => undefined,
        };
      if (prop === 'redisRoutingRetryCounter')
        return { inc: (l: { result: string }) => void samples.routingRetry.push(l.result) };
      return { ...noopMetric, labels: () => noopMetric };
    },
  }
);

/** Every TCP socket node-redis opens, with the options it opened it with. */
const dials: { host: string; port: number; keepAliveInitialDelay?: number }[] = [];
function recordDials(): void {
  const real = net.createConnection;
  vi.spyOn(net, 'createConnection').mockImplementation(((...args: any[]) => {
    const o = args[0];
    if (o && typeof o === 'object')
      dials.push({ host: o.host, port: o.port, keepAliveInitialDelay: o.keepAliveInitialDelay });
    return (real as any).apply(net, args);
  }) as any);
}

/** `resp=` of a raw CLIENT INFO reply. */
const respOf = (info: unknown) => /(?:^| )resp=(\d)/.exec(String(info))?.[1];

async function until<T>(op: () => Promise<T>, timeoutMs = 20_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await op();
    } catch (err) {
      if (Date.now() > end) throw err;
      await sleep(200);
    }
  }
}

/** Settle `p`, returning how long it took and its outcome. */
async function timed(p: Promise<unknown>) {
  const start = Date.now();
  const out = await p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error: error as Error })
  );
  return { ...out, ms: Date.now() - start };
}

/** Our cluster deadline in these tests: above node-redis 6's 5 s default, below the socket timeout. */
const DEADLINE_MS = 8000;

describe.skipIf(!ENABLED)('cache cluster client on node-redis 6', () => {
  const cluster = new DockerRedisCluster('civitai-redis-it-defaults');
  let client: any;
  let self: any;
  const controls: any[] = [];
  /** The sockets our client opened while connecting (before any control client exists). */
  let ourDials: typeof dials = [];

  beforeAll(async () => {
    await cluster.start();
    recordDials();
    process.env.REDIS_URL ??= cluster.url(0);
    process.env.REDIS_SYS_URL ??= cluster.url(0);
    client = createCacheRedis({
      url: cluster.url(0),
      cluster: true,
      clusterNodes: [0, 1, 2].map((i) => cluster.url(i)).join(','),
      clusterSelfHealEnabled: false,
      clusterCommandTimeoutMs: DEADLINE_MS,
      clusterSelfHealSlowCommandMs: DEADLINE_MS - 2000,
      log: itLog,
    });
    self = client._self ?? client;
    await until(() => client.set('it:warmup', '1'));
    ourDials = dials.filter((d) => cluster.ips.includes(d.host));
  }, 120_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    for (const c of [client, ...controls]) {
      try {
        c?.destroy?.();
      } catch {
        // already closed
      }
    }
    cluster.teardown();
  }, 300_000);

  /** A raw node-redis 6 cluster client with none of our pins (the control). */
  async function rawCluster(options: Record<string, unknown> = {}) {
    const c: any = createCluster({
      rootNodes: [0, 1, 2].map((i) => ({ url: cluster.url(i) })),
      ...options,
    });
    c.on('error', () => undefined);
    controls.push(c);
    await c.connect();
    return c;
  }

  it('every node connection negotiates RESP2', async () => {
    const masters = self.masters as { address: string }[];
    expect(masters).toHaveLength(3);
    const resps = await Promise.all(
      masters.map(async (m) =>
        respOf(await (await self.nodeClient(m)).sendCommand(['CLIENT', 'INFO']))
      )
    );
    expect(resps).toEqual(['2', '2', '2']);
    // Routed through the cluster (a typed command, keyless: any node).
    expect((await client.clientInfo()).resp).toBe(2);

    // Control: the same probe sees RESP3 on a node-redis 6 client that does not pin it.
    const raw = await rawCluster();
    const rawMaster = await raw.nodeClient(raw.masters[0]);
    expect(respOf(await rawMaster.sendCommand(['CLIENT', 'INFO']))).toBe('3');
  });

  it('every socket to the cluster is opened with a 5000 ms keepalive delay', async () => {
    const ours = ourDials;
    expect(ours.length).toBeGreaterThanOrEqual(3); // one per master at least
    const before = dials.length;
    await rawCluster(); // control: node-redis 6's own default
    const raw = dials.slice(before).filter((d) => cluster.ips.includes(d.host));
    expect(raw.length).toBeGreaterThan(0);
    expect(new Set(raw.map((d) => d.keepAliveInitialDelay))).toEqual(new Set([30000]));
    expect(new Set(ours.map((d) => d.keepAliveInitialDelay))).toEqual(new Set([5000]));
  });

  it('a routed GET passes through the instrumentation wrapper', async () => {
    samples.duration.length = 0;
    samples.inflightInc.length = 0;
    await client.get('it:instrumented');
    await client.set('it:instrumented', 'x');
    expect(samples.inflightInc).toEqual(['cluster', 'cluster']);
    expect(samples.duration).toEqual(['cluster', 'cluster']);
    // Why it holds: the wrapper is an own property of the cluster's _self, so node-redis 6's
    // command path (`this._execute` inside _executeWithPolicies, `this` = _self) finds it.
    expect(Object.prototype.hasOwnProperty.call(self, '_execute')).toBe(true);
  });

  it('the cluster deadline rejects a command still running after it', async () => {
    // BLPOP blocks on the server for 9 s. With the wrapper in place our deadline rejects it at
    // DEADLINE_MS; without it, nothing would (the command is already written, see the header).
    const r = await timed(client.blPop('it:never-pushed', 9));
    expect(r.ok, `settled ok=${r.ok} after ${r.ms}ms`).toBe(false);
    expect(!r.ok && r.error.message).toBe(`redis cluster command timed out after ${DEADLINE_MS}ms`);
    expect(r.ms).toBeGreaterThanOrEqual(DEADLINE_MS - 200);
    expect(r.ms).toBeLessThan(9000);
    await sleep(1500); // let the orphaned BLPOP finish on the server
  }, 30_000);

  it('a command queued while its node is down is not cut off at 5 s by node-redis', async () => {
    const key = 'it:queued-while-down';
    const node = cluster.ownerOf(key);
    const raw = await rawCluster({ RESP: 2 }); // control: our RESP, node-redis 6's command timeout
    await until(() => client.get(key));
    await until(() => raw.get(key));
    cluster.stop(node);
    try {
      await sleep(500); // both clients see the socket close and start reconnecting
      const [ours, control] = await Promise.all([timed(client.get(key)), timed(raw.get(key))]);
      itLog(`queued-while-down ours=${JSON.stringify(ours)} control=${JSON.stringify(control)}`);
      // Control: node-redis 6 rejects the queued command at its 5 s default.
      expect(control.ok).toBe(false);
      expect(!control.ok && control.error.constructor.name).toBe('TimeoutError');
      expect(control.ms).toBeLessThan(DEADLINE_MS - 1000);
      // Ours waits for our own deadline.
      expect(ours.ok).toBe(false);
      expect(!ours.ok && ours.error.message).toBe(
        `redis cluster command timed out after ${DEADLINE_MS}ms`
      );
    } finally {
      await cluster.restart(node);
      await until(() => client.get(key), 30_000);
    }
  }, 120_000);

  it('the per-node pipelined GET path still reads every key', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => i + 1);
    const keyOf = (id: number) => `packed:caches:it-defaults:${id}`;
    for (const id of ids) await client.packed.set(keyOf(id), { id });
    samples.duration.length = 0;
    const out = await client.packed.mGet(ids.map(keyOf));
    expect(out).toEqual(ids.map((id) => ({ id })));
    expect(samples.duration).toHaveLength(ids.length); // one sample per key, as before
  });

  it('scanIterator still visits every master (it scans on node connections)', async () => {
    const keys = ['it:scan:a', 'it:scan:b', 'it:scan:c', 'it:scan:d', 'it:scan:e'];
    for (const k of keys) await client.set(k, '1');
    expect(new Set(keys.map((k) => cluster.ownerOf(k))).size).toBeGreaterThan(1); // >1 master
    const seen = new Set<string>();
    for await (const batch of client.scanIterator({ MATCH: 'it:scan:*' }))
      for (const k of ([] as string[]).concat(batch)) seen.add(k);
    expect(seen).toEqual(new Set(keys));
  });

  it('triggerTopologyRediscovery picks up a slot moved behind the client', async () => {
    const key = 'it:moved-slot';
    const slot = calculateSlot(key);
    const from = cluster.ownerOf(key);
    const to = (from + 1) % 3;
    const addressOf = () => self._slots.slots[slot]?.master?.address;
    expect(addressOf()).toBe(`${cluster.ips[from]}:6379`);
    // An empty slot can be reassigned outright; every node is told, as redis-cli does.
    const toId = cluster.nodeId(to);
    for (const i of [to, from, (to + 1) % 3]) {
      cluster.redisCli(i, ['cluster', 'setslot', String(slot), 'node', toId]);
    }
    try {
      await sleep(1000);
      // Control: nothing told the client yet (no command hit a MOVED).
      expect(addressOf()).toBe(`${cluster.ips[from]}:6379`);
      triggerTopologyRediscovery(client, 'it');
      const end = Date.now() + 10_000;
      while (addressOf() !== `${cluster.ips[to]}:6379` && Date.now() < end) await sleep(100);
      expect(addressOf()).toBe(`${cluster.ips[to]}:6379`);
    } finally {
      const fromId = cluster.nodeId(from);
      for (const i of [from, to, (from + 1) % 3]) {
        cluster.redisCli(i, ['cluster', 'setslot', String(slot), 'node', fromId]);
      }
    }
  }, 60_000);

  it('the routing-retry classifier matches node-redis 6 node-selection errors', async () => {
    const slots = self._slots;
    const errors: Error[] = [];
    const capture = async (op: () => Promise<unknown>) => {
      try {
        await op();
        errors.push(new Error('no error thrown'));
      } catch (err) {
        errors.push(err as Error);
      }
    };
    // The slot map is replaced while a rediscovery runs; these are the reads that race it.
    const savedSlots = slots.slots;
    slots.slots = new Array(16384);
    await capture(() => slots.getClientAndSlotNumber('it:k', true)); // a read: getSlotRandomNode
    await capture(() => slots.getClientAndSlotNumber('it:k', false)); // a write: the slot's master
    slots.slots = savedSlots;
    const saved = {
      masters: slots.masters,
      replicas: slots.replicas,
      it: slots._randomNodeIterator,
    };
    slots.masters = [];
    slots.replicas = [];
    slots._randomNodeIterator = undefined;
    await capture(() => slots.getClientAndSlotNumber(undefined, false)); // keyless: a random node
    slots.masters = saved.masters;
    slots.replicas = saved.replicas;
    slots._randomNodeIterator = saved.it;

    for (const err of errors) itLog(`routing error: ${err.message} | ${err.stack?.split('\n')[1]}`);
    expect(errors.map((e) => e.message)).toEqual([
      "Cannot read properties of undefined (reading 'replicas')",
      "Cannot read properties of undefined (reading 'master')",
      "Cannot read properties of undefined (reading 'connectPromise')",
    ]);
    expect(errors.map((e) => isTransientClusterRoutingError(e))).toEqual([true, true, true]);

    // End to end: a write that meets an empty slot map is retried after a rediscovery and lands.
    samples.routingRetry.length = 0;
    slots.slots = new Array(16384);
    await client.set('it:routing-retry', 'ok');
    expect(samples.routingRetry).toEqual(['recovered']);
    expect(await client.get('it:routing-retry')).toBe('ok');
  });
});

describe.skipIf(!ENABLED)('sys client on node-redis 6 (single node)', () => {
  // A cluster node serves as the single sys node; every key below is one it owns.
  const cluster = new DockerRedisCluster('civitai-redis-it-defaults-single');
  let sys: any;
  let node = -1;
  const key = 'it:sys-single';

  beforeAll(async () => {
    await cluster.start();
    node = cluster.ownerOf(key);
    process.env.REDIS_URL ??= cluster.url(0);
    process.env.REDIS_SYS_URL ??= cluster.url(0);
    sys = createSysRedis({ sysUrl: cluster.url(node), sysSelfHealEnabled: false, log: itLog });
    await until(() => sys.get(key));
  }, 120_000);

  afterAll(async () => {
    try {
      sys?.destroy?.();
    } catch {
      // already closed
    }
    cluster.teardown();
  }, 300_000);

  it('negotiates RESP2', async () => {
    expect(respOf(await sys.sendCommand(['CLIENT', 'INFO']))).toBe('2');
    // Control: an unpinned node-redis 6 client on the same node negotiates RESP3.
    const raw = createClient({ url: cluster.url(node) });
    raw.on('error', () => undefined);
    await raw.connect();
    try {
      expect(respOf(await raw.sendCommand(['CLIENT', 'INFO']))).toBe('3');
    } finally {
      raw.destroy();
    }
  });

  it('carries no node-redis command timeout', async () => {
    // Option-level only. A single sys client rejects commands while it is not ready
    // (disableOfflineQueue), so the queued case checked on the cluster client cannot occur here.
    // RedisClient keeps its defaults in `_commandOptions` (6.3.0 has no `commandOptions` getter).
    expect(sys._commandOptions).toEqual({ timeout: undefined });
    expect('timeout' in sys._commandOptions).toBe(true);
    const raw: any = createClient({ url: cluster.url(node) });
    expect(raw._commandOptions).toEqual({ timeout: 5000 }); // control: node-redis 6's default
  });
});

describe.skipIf(!ENABLED)('sys client on node-redis 6 (Sentinel)', () => {
  const redis = new DockerRedisSentinel('civitai-redis-it-defaults-sentinel', 3000);
  let sys: any;

  beforeAll(async () => {
    await redis.start();
    process.env.REDIS_URL ??= redis.masterUrl;
    process.env.REDIS_SYS_URL ??= redis.masterUrl;
    sys = createSysRedis({
      sysUrl: redis.masterUrl,
      sysSentinels: redis.sentinelAddress,
      sysSentinelName: redis.masterName,
      sysSelfHealEnabled: false,
      log: itLog,
    });
    await until(() => sys.set('it:sentinel', '1'));
    await until(() => sys.packed.get('it:sentinel-packed')); // the Buffer-mode base connects too
  }, 120_000);

  afterAll(async () => {
    try {
      await sys?.destroy?.();
    } catch {
      // already closed
    }
    redis.teardown();
  }, 300_000);

  it('every master connection of both sys base clients negotiates RESP2', async () => {
    const nodeRedis = (await sys.clientList()).filter((c: any) => c.libName === 'node-redis');
    // Two base clients (serving + Buffer-mode), masterPoolSize 2 each.
    expect(nodeRedis.length).toBeGreaterThanOrEqual(4);
    expect(new Set(nodeRedis.map((c: any) => c.resp))).toEqual(new Set([2]));
  });

  it('its Sentinel connections negotiate RESP2', async () => {
    const [host, port] = redis.sentinelAddress.split(':');
    const probe = createClient({ socket: { host, port: Number(port) }, RESP: 2 });
    probe.on('error', () => undefined);
    await probe.connect();
    try {
      const ownId = await probe.clientId();
      const others = (await probe.clientList()).filter(
        (c: any) => c.id !== ownId && c.libName === 'node-redis'
      );
      // Ours: one Sentinel connection per base client, plus its pub/sub subscription.
      expect(others.length).toBeGreaterThanOrEqual(2);
      expect(new Set(others.map((c: any) => c.resp))).toEqual(new Set([2]));
    } finally {
      probe.destroy();
    }
  });

  it('carries no node-redis command timeout', async () => {
    // Option-level only: the queued-command case that tells the two apart is checked on the cluster
    // client above.
    expect(sys.commandOptions).toEqual({ timeout: undefined });
    expect('timeout' in sys.commandOptions).toBe(true);
    const raw = createSentinel({
      name: redis.masterName,
      sentinelRootNodes: [{ host: '127.0.0.1', port: 1 }],
    });
    expect(raw.commandOptions).toEqual({ timeout: 5000 }); // control: node-redis 6's default
  });
});
