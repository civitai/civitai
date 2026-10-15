/**
 * INTEGRATION (opt-in): `packed.mGet` on a real Redis cluster pipelines each master's GETs on the
 * node connection instead of routing one GET per key, returns the same values, accounts the batch
 * as its key count in the wedge metrics, and stays correct through slot migrations.
 *
 * Run with: REDIS_CLUSTER_IT=1 pnpm --filter @civitai/redis exec vitest run cluster-pipelined-get.integration
 * Needs docker on Linux (see ./helpers/docker-redis-cluster). Skipped otherwise.
 *
 * Two counters: `routed` counts commands through the cluster router (`_execute`, wrapped below),
 * the per-command path this change removes from a batch; `observed` counts duration samples on
 * the metrics bridge, which must stay one per key either way.
 */
import calculateSlot from 'cluster-key-slot';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCacheBuilders } from '../cached-array';
import { createCacheRedis } from '../client';
import { DockerRedisCluster, dockerAvailable } from './helpers/docker-redis-cluster';

const ENABLED = process.env.REDIS_CLUSTER_IT === '1';
if (ENABLED && !dockerAvailable()) {
  throw new Error('REDIS_CLUSTER_IT=1 but `docker info` failed — docker is required for this test');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let routed = 0;
let observed = 0;
const noop = { inc: () => undefined, dec: () => undefined, observe: () => undefined };
(globalThis as any).__civitaiRedisMetrics = new Proxy(
  {},
  {
    get: (_t, prop) =>
      prop === 'redisCommandDuration'
        ? { observe: () => void observed++ }
        : prop === 'then'
        ? undefined
        : noop,
  }
);
const countRouted = (c: any) => {
  const self = c._self ?? c;
  const original = self._execute;
  self._execute = function (this: unknown, ...args: unknown[]) {
    routed++;
    return original.apply(this, args);
  };
};
const resetCounts = () => {
  routed = 0;
  observed = 0;
};

const PREFIX = 'packed:caches:it-batched';
const keyOf = (id: number) => `${PREFIX}:${id}`;
const N = 200;
// Every 5th id is never written: a miss.
const present = (id: number) => id % 5 !== 0;
const valueOf = (id: number) => ({ imageId: id, tags: [id, id + 1], cachedAt: 'x' });

describe.skipIf(!ENABLED)('packed.mGet on a real cluster', () => {
  const cluster = new DockerRedisCluster('civitai-redis-it-batched');
  const logs: string[] = [];
  let client: any;
  let perKeyClient: any;

  async function connect(extra: Record<string, unknown>) {
    const c: any = createCacheRedis({
      url: cluster.url(0),
      cluster: true,
      clusterNodes: [0, 1, 2].map((i) => cluster.url(i)).join(','),
      clusterSelfHealEnabled: false,
      log: (msg: string) => logs.push(msg),
      ...extra,
    });
    countRouted(c);
    const end = Date.now() + 20_000;
    for (;;) {
      try {
        await c.set('it:warmup', '1');
        return c;
      } catch (err) {
        if (Date.now() > end) throw err;
        await sleep(200);
      }
    }
  }

  beforeAll(async () => {
    await cluster.start();
    process.env.REDIS_URL ??= cluster.url(0);
    process.env.REDIS_SYS_URL ??= cluster.url(0);
    client = await connect({});
    perKeyClient = await connect({ clusterBatchedGetEnabled: false });
    for (let id = 1; id <= N; id++)
      if (present(id)) await client.packed.set(keyOf(id), valueOf(id));
  }, 120_000);

  afterAll(async () => {
    for (const c of [client, perKeyClient]) {
      try {
        c?.destroy?.();
      } catch {
        // already closed
      }
    }
    cluster.teardown();
  }, 300_000);

  beforeEach(() => {
    logs.length = 0;
  });

  const ids = Array.from({ length: N }, (_, i) => i + 1);
  const expected = ids.map((id) => (present(id) ? valueOf(id) : null));

  it('positive control: with batching off, N keys are N routed commands', async () => {
    resetCounts();
    const out = await perKeyClient.packed.mGet(ids.map(keyOf));
    expect(routed).toBe(N);
    expect(observed).toBe(N);
    expect(out).toEqual(expected);
  });

  it(`${N} keys route no command per key, same values, still N duration samples`, async () => {
    resetCounts();
    const out = await client.packed.mGet(ids.map(keyOf));
    // The wedge metrics see the batch as its key count, exactly as before.
    expect(observed).toBe(N);
    expect(routed).toBe(0);
    expect(out).toEqual(expected);
    expect(logs.filter((l) => l.includes('re-read'))).toEqual([]);
  });

  it('a per-id cache behaves identically on both read paths: miss-fill, hit, bust, refresh', async () => {
    // The same cache built twice over one keyspace prefix per client, so each starts cold.
    const run = async (redis: any, prefix: string) => {
      const db = new Map(ids.map((id) => [id, { imageId: id, tags: [id * 7] }]));
      const lookups: number[][] = [];
      const { createCachedObject } = createCacheBuilders({
        redis,
        defaultTtl: 60,
        metrics: {
          hit: () => undefined,
          miss: () => undefined,
          revalidate: () => undefined,
          failOpenDegraded: () => undefined,
          failOpenOriginFetch: () => undefined,
          missWouldJoin: () => undefined,
        },
        logFailOpen: (_k, msg) => logs.push(`failopen ${msg}`),
        logRefreshError: () => undefined,
        log: () => undefined,
        clearByPattern: async () => undefined,
      });
      const cache = createCachedObject<{ imageId: number; tags: number[] }>({
        key: prefix as any,
        idKey: 'imageId',
        ttl: 60,
        // bust() back-dates the entry to `debounceTime` before it goes stale, so a read inside that
        // window is still a plain hit; 30s keeps the read below well inside it.
        debounceTime: 30,
        lookupFn: async (want) => {
          lookups.push([...want]);
          return Object.fromEntries(want.filter((id) => db.has(id)).map((id) => [id, db.get(id)!]));
        },
      });
      const want = [...ids, 100_001]; // one id the origin does not have (negative cache)
      const steps: unknown[] = [];
      steps.push(await cache.fetch(want)); // cold: every id misses and is filled
      resetCounts();
      steps.push(await cache.fetch(want)); // warm: all hits (incl. the cached not-found)
      const warmCommands = routed;
      db.set(3, { imageId: 3, tags: [999] });
      await cache.refresh(3); // write-path refill from origin
      steps.push(await cache.fetch([3, 4]));
      await cache.bust([4]); // SWR cache: invalidate() back-dates the entry
      steps.push(await cache.fetch([4]));
      return { steps, lookups: lookups.map((l) => l.length), warmCommands };
    };

    const batched = await run(client, `${PREFIX}-cache-b`);
    const perKey = await run(perKeyClient, `${PREFIX}-cache-p`);
    expect(batched.steps).toEqual(perKey.steps);
    expect(batched.lookups).toEqual(perKey.lookups);
    // The batched client really pipelined: N+1 ids in chunks of 200 → the first chunk routes
    // nothing, the 1-id chunk is one routed GET; per-key routes every id.
    expect(perKey.warmCommands).toBe(N + 1);
    expect(batched.warmCommands).toBeLessThanOrEqual(1);
    expect(logs.filter((l) => l.includes('re-read'))).toEqual([]);
    // Cold fill looked up all N+1 ids once; the warm read looked up nothing.
    expect(batched.lookups[0]).toBe(N + 1);
    expect(batched.lookups).toHaveLength(2); // cold fill + refresh(3); no lookup on the warm read
    expect((batched.steps[1] as Record<string, unknown>)['100001']).toBeUndefined();
    expect((batched.steps[2] as Record<string, any>)['3'].tags).toEqual([999]);
    expect(batched.steps[3]).toEqual({ '4': { imageId: 4, tags: [28] } });
    expect(logs.filter((l) => l.startsWith('failopen'))).toEqual([]);
  }, 60_000);

  it('a key whose slot is migrating away is still read correctly (its ASK reply is re-read)', async () => {
    // Two keys on the same master, in different slots; move the first one's slot's key away.
    const moved = keyOf(1);
    const src = cluster.ownerOf(moved);
    // One `cluster nodes` read (ownerOf per key would be two docker calls each).
    const srcRanges = cluster
      .redisCli(src, ['cluster', 'nodes'])
      .split('\n')
      .find((l) => l.includes('myself'))!
      .trim()
      .split(/\s+/)
      .slice(8)
      .map((r) => r.split('-').map(Number));
    const onSrc = (key: string) => {
      const s = calculateSlot(key);
      return srcRanges.some(([from, to = from]) => s >= from && s <= to);
    };
    const sameNode = ids.filter((id) => present(id) && id !== 1 && onSrc(keyOf(id)));
    expect(sameNode.length).toBeGreaterThan(1);
    const dst = (src + 1) % 3;
    const slot = cluster.redisCli(src, ['cluster', 'keyslot', moved]);
    const srcId = cluster.nodeId(src);
    const dstId = cluster.nodeId(dst);

    expect(cluster.redisCli(dst, ['cluster', 'setslot', slot, 'importing', srcId])).toBe('OK');
    expect(cluster.redisCli(src, ['cluster', 'setslot', slot, 'migrating', dstId])).toBe('OK');
    expect(cluster.redisCli(src, ['migrate', cluster.ips[dst], '6379', moved, '0', '5000'])).toBe(
      'OK'
    );
    try {
      const keys = [moved, ...sameNode.slice(0, 20).map(keyOf)];
      const out = await client.packed.mGet(keys);
      expect(out).toEqual([valueOf(1), ...sameNode.slice(0, 20).map(valueOf)]);
      // The source node answered ASK for the migrated key, which was re-read on its own.
      expect(logs.some((l) => l.includes('re-read 1 keys'))).toBe(true);
    } finally {
      // Finish the migration so the cluster is consistent again.
      for (const i of [0, 1, 2]) cluster.redisCli(i, ['cluster', 'setslot', slot, 'node', dstId]);
    }

    // After the move completes reads stay correct; the client's map may still be stale, in
    // which case the moved key answers MOVED and is re-read.
    const after = await client.packed.mGet(ids.map(keyOf));
    expect(after).toEqual(expected);
  }, 60_000);

  // Same-slot keys mid-migration: the migrated key answers ASK on the source and is re-read; the
  // others are still on the source and are served there. (The Lua revision of this PR returned
  // false misses here when the migrated key came first.)
  it.each([
    ['moved key first', ['a', 'b', 'c']],
    ['moved key not first', ['b', 'a', 'c']],
  ])(
    'same-slot keys mid-migration: %s',
    async (_label, order) => {
      const k = (s: string) => `${PREFIX}:{ask-tag}:${s}`;
      for (const s of ['a', 'b', 'c']) await client.packed.set(k(s), { v: s });
      const src = cluster.ownerOf(k('a'));
      const dst = (src + 1) % 3;
      const slot = cluster.redisCli(src, ['cluster', 'keyslot', k('a')]);
      const srcId = cluster.nodeId(src);
      const dstId = cluster.nodeId(dst);
      const fresh = await connect({});
      expect(cluster.redisCli(dst, ['cluster', 'setslot', slot, 'importing', srcId])).toBe('OK');
      expect(cluster.redisCli(src, ['cluster', 'setslot', slot, 'migrating', dstId])).toBe('OK');
      expect(
        cluster.redisCli(src, ['migrate', cluster.ips[dst], '6379', k('a'), '0', '5000'])
      ).toBe('OK');
      try {
        const out = await fresh.packed.mGet(order.map(k));
        expect(out).toEqual(order.map((s) => ({ v: s })));
        // The batch was pipelined and exactly the migrated key was re-read.
        expect(logs.some((l) => l.includes('re-read 1 keys'))).toBe(true);
      } finally {
        // Move whatever is left in the slot, then hand the slot over, so the cluster is whole again.
        const left = cluster.redisCli(src, ['cluster', 'getkeysinslot', slot, '1000']);
        for (const key of left.split('\n').filter(Boolean))
          cluster.redisCli(src, ['migrate', cluster.ips[dst], '6379', key, '0', '5000']);
        for (const i of [0, 1, 2]) cluster.redisCli(i, ['cluster', 'setslot', slot, 'node', dstId]);
        try {
          fresh.destroy();
        } catch {
          // already closed
        }
      }
      expect(await client.packed.mGet(['a', 'b', 'c'].map(k))).toEqual([
        { v: 'a' },
        { v: 'b' },
        { v: 'c' },
      ]);
    },
    60_000
  );

  // The slot moves away completely without this client noticing (its map still names the old
  // owner), then starts moving back with only the first key returned. The pipelined GETs go to
  // the stale owner, which is now importing the slot and answers MOVED for every key of it (no
  // ASKING is ever sent), so all three are re-read through the router. (The Lua revision of this
  // PR could return false misses here.)
  it('slot moved away and coming back while the client map is stale', async () => {
    const k = (s: string) => `${PREFIX}:{back-tag}:${s}`;
    for (const s of ['a', 'b', 'c']) await client.packed.set(k(s), { v: s });
    const home = cluster.ownerOf(k('a'));
    const away = (home + 1) % 3;
    const slot = cluster.redisCli(home, ['cluster', 'keyslot', k('a')]);
    const homeId = cluster.nodeId(home);
    const awayId = cluster.nodeId(away);
    const moveAll = (from: number, to: number, toId: string, fromId: string) => {
      expect(cluster.redisCli(to, ['cluster', 'setslot', slot, 'importing', fromId])).toBe('OK');
      expect(cluster.redisCli(from, ['cluster', 'setslot', slot, 'migrating', toId])).toBe('OK');
    };
    // Learns the map now, then never touches the slot until the read under test.
    const fresh = await connect({});
    try {
      moveAll(home, away, awayId, homeId);
      for (const s of ['a', 'b', 'c'])
        cluster.redisCli(home, ['migrate', cluster.ips[away], '6379', k(s), '0', '5000']);
      for (const i of [0, 1, 2]) cluster.redisCli(i, ['cluster', 'setslot', slot, 'node', awayId]);
      // Now start moving it back, with only `a` returned.
      moveAll(away, home, homeId, awayId);
      expect(
        cluster.redisCli(away, ['migrate', cluster.ips[home], '6379', k('a'), '0', '5000'])
      ).toBe('OK');

      logs.length = 0;
      const out = await fresh.packed.mGet(['a', 'b', 'c'].map(k));
      expect(out).toEqual([{ v: 'a' }, { v: 'b' }, { v: 'c' }]);
      expect(logs.some((l) => l.includes('re-read 3 keys'))).toBe(true);
    } finally {
      const left = cluster.redisCli(away, ['cluster', 'getkeysinslot', slot, '1000']);
      for (const key of left.split('\n').filter(Boolean))
        cluster.redisCli(away, ['migrate', cluster.ips[home], '6379', key, '0', '5000']);
      for (const i of [0, 1, 2]) cluster.redisCli(i, ['cluster', 'setslot', slot, 'node', homeId]);
      try {
        fresh.destroy();
      } catch {
        // already closed
      }
    }
  }, 60_000);
});
