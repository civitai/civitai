import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The node-redis 5.x behaviour every client this package builds pins back on node-redis 6 (see
 * REDIS_RESP_VERSION / REDIS_NO_COMMAND_TIMEOUT / REDIS_KEEPALIVE_INITIAL_DELAY_MS in client.ts),
 * read off the real node-redis 6 clients the factories build. Hermetic: `connect()` is neutralised.
 * What a server actually negotiates is checked by client-defaults.integration.test.ts (opt-in).
 */
const h = vi.hoisted(() => ({ sentinelOpts: [] as any[] }));

vi.mock('redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('redis')>();
  const noConnect = <T>(client: T): T => {
    (client as { connect: () => Promise<T> }).connect = () => Promise.resolve(client);
    return client;
  };
  return {
    ...actual,
    // RedisSentinel keeps its options private, so they are captured here.
    createSentinel: (opts: Parameters<typeof actual.createSentinel>[0]) => {
      h.sentinelOpts.push(opts);
      return noConnect(actual.createSentinel(opts));
    },
    createCluster: (opts: Parameters<typeof actual.createCluster>[0]) =>
      noConnect(actual.createCluster(opts)),
    createClient: (opts: Parameters<typeof actual.createClient>[0]) =>
      noConnect(actual.createClient(opts)),
  };
});

import { createCacheRedis, createSysRedis } from '../client';

beforeAll(() => {
  process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
  process.env.REDIS_SYS_URL ??= 'redis://127.0.0.1:6379';
});

const log = () => undefined;

describe('node-redis 5.x defaults pinned on every client', () => {
  it('cache cluster: RESP2 and no command timeout at cluster level, keepalive 5000 per node', () => {
    const c = createCacheRedis({
      cluster: true,
      clusterNodes: 'redis://127.0.0.1:7001',
      clusterSelfHealEnabled: false,
      log,
    }) as any;
    const options = c._self._options;
    // RedisCluster hands its own RESP to every node connection, over `defaults`.
    expect(options.RESP).toBe(2);
    expect('timeout' in c._self._commandOptions).toBe(true);
    expect(c._self._commandOptions.timeout).toBeUndefined();
    expect(options.defaults.socket.keepAliveInitialDelay).toBe(5000);
  });

  it('single client (sys without Sentinel): RESP2, no command timeout, keepalive 5000', () => {
    const c = createSysRedis({ sysSelfHealEnabled: false, log }) as any;
    expect(c.options.RESP).toBe(2);
    expect('timeout' in c._commandOptions).toBe(true);
    expect(c._commandOptions.timeout).toBeUndefined();
    expect(c.options.socket.keepAliveInitialDelay).toBe(5000);
  });

  it('sys Sentinel, both base clients: RESP2 (pub/sub too), no timeout, keepalive, passthrough', () => {
    h.sentinelOpts.length = 0;
    const c = createSysRedis({
      sysSentinels: '127.0.0.1:26379',
      sysSentinelName: 'sysmaster',
      sysSelfHealEnabled: false,
      log,
    }) as any;
    expect(h.sentinelOpts).toHaveLength(2); // serving + Buffer-mode
    for (const o of h.sentinelOpts) {
      expect(o.RESP).toBe(2);
      expect('timeout' in o.commandOptions).toBe(true);
      expect(o.commandOptions.timeout).toBeUndefined();
      // The pub/sub connection is built from nodeClientOptions alone.
      expect(o.nodeClientOptions.RESP).toBe(2);
      expect(o.nodeClientOptions.socket.keepAliveInitialDelay).toBe(5000);
      expect(o.sentinelClientOptions.socket.keepAliveInitialDelay).toBe(5000);
      // Without it RedisSentinel never surfaces its connections' errors (see the next describe).
      expect(o.passthroughClientErrorEvents).toBe(true);
    }
    // What RedisSentinel built from those options: no node-redis 6 default timeout.
    expect(c.commandOptions).toEqual({ timeout: undefined });
  });
});

describe('scans on cluster node connections carry no node-redis command timeout', () => {
  it('cluster scanIterator scans each master through a no-timeout view of its connection', async () => {
    const c = createCacheRedis({
      cluster: true,
      clusterNodes: 'redis://127.0.0.1:7001',
      clusterSelfHealEnabled: false,
      log,
    }) as any;
    // A node connection keeps node-redis 6's 5 s default; the cluster's commandOptions reach only
    // routed commands, so the scan must opt out on the node connection itself.
    const seen: Record<string, unknown>[] = [];
    const node = {
      withCommandOptions: (o: Record<string, unknown>) => {
        seen.push(o);
        return {
          scanIterator: async function* () {
            yield ['k'];
          },
        };
      },
      scanIterator: async function* () {
        yield ['unbounded'];
      },
    };
    Object.defineProperty(c, 'masters', { value: [{ address: 'a:1' }, { address: 'b:1' }] });
    c.nodeClient = async () => node;
    const keys: string[] = [];
    for await (const batch of c.scanIterator({ MATCH: '*' })) keys.push(...batch);
    expect(keys).toEqual(['k', 'k']);
    expect(seen).toHaveLength(2);
    for (const o of seen) {
      expect('timeout' in o).toBe(true);
      expect(o.timeout).toBeUndefined();
    }
  });
});

describe('the forwarded connection-error shape sentinelSubClientError parses', () => {
  // attachSysSentinelListeners counts RedisSentinel's forwarded connection errors by parsing their
  // message, so the installed @redis/client must still build it the way the parser expects. A
  // node-redis bump that rewords it would silently zero the sentinel client-error counter.
  it('the installed @redis/client builds `${Kind} Client (${host}:${port}): ${message}`', () => {
    const require = createRequire(redisEntryPath());
    const clientDir = dirname(require.resolve('@redis/client/package.json'));
    const src = readFileSync(join(clientDir, 'dist/lib/sentinel/index.js'), 'utf8');
    for (const kind of ['Master', 'Replica', 'Sentinel']) {
      expect(src, kind).toContain(
        'new Error(`' +
          kind +
          ' Client (${node.host}:${node.port}): ${err.message}`, { cause: err })'
      );
    }
  });
});

/** Resolve from this package (whose `redis` dependency brings the @redis/client in use). */
function redisEntryPath(): string {
  return createRequire(join(__dirname, '..', '..', 'package.json')).resolve('redis');
}
