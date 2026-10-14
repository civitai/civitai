import calculateSlot from 'cluster-key-slot';
import { ErrorReply } from 'redis';
import { describe, expect, it, vi } from 'vitest';
import {
  NODE_LOCAL_GET_SCRIPT,
  NODE_LOCAL_GET_SHA,
  createBatchedGet,
  createClusterBufferGet,
  type BatchedGetDeps,
  type ScriptArgs,
} from '../cluster-batched-get';
import { redisEnvSchema } from '../env';

/** Stands in for an error REPLY from Redis (node-redis raises those as ErrorReply). */
class FakeReplyError extends Error {}

const ownerOf = (slot: number) => (slot < 5461 ? 'n1' : slot < 10923 ? 'n2' : 'n3');

/**
 * A fake 3-master cluster that enforces what a real one does to the node-local script:
 *   - the script is cached per node (NOSCRIPT until EVAL loads it),
 *   - a script whose KEYS[1] or any ARGV key is not served by the node it is routed to fails
 *     as a whole ("non local key"),
 *   - the reply ends with the id of the node the script ran on,
 * and counts every command so a test can assert how many round-trips a batch costs.
 *
 * `askTo` simulates an ASK-redirected script: it runs on that node with ASKING, which serves
 * every key of the importing slot from THAT node's data — so keys it does not hold come back nil.
 */
function fakeCluster(
  opts: {
    mapOverride?: (slot: number) => string | undefined;
    askTo?: { node: string; slot: number; holds: Map<string, Buffer> };
  } = {}
) {
  const store = new Map<string, Buffer>();
  const loaded = new Set<string>();
  const counts = { get: 0, evalSha: 0, eval: 0 };
  const scriptKeyCounts: number[] = [];
  const failNodes = new Set<string>();

  function runScript(args: ScriptArgs) {
    const node = ownerOf(calculateSlot(args.keys[0]));
    if (failNodes.has(node)) throw new FakeReplyError(`ERR injected failure on ${node}`);
    const all = [args.keys[0], ...args.arguments];
    scriptKeyCounts.push(all.length);
    const ask = opts.askTo;
    if (ask && calculateSlot(args.keys[0]) === ask.slot) {
      // Redirected: every key of the importing slot is "local" under ASKING.
      return [...all.map((k) => ask.holds.get(k) ?? null), Buffer.from(ask.node)];
    }
    for (const k of all) {
      if (ownerOf(calculateSlot(k)) !== node)
        throw new FakeReplyError(
          'ERR Script attempted to access a non local key in a cluster node'
        );
    }
    return [...all.map((k) => store.get(k) ?? null), Buffer.from(node)];
  }

  const fallbacks: { err: unknown; keyCount: number }[] = [];
  const deps: BatchedGetDeps<Buffer> = {
    get: async (key) => {
      counts.get++;
      return store.get(key) ?? null;
    },
    evalSha: async (sha, args) => {
      counts.evalSha++;
      const node = ownerOf(calculateSlot(args.keys[0]));
      if (sha !== NODE_LOCAL_GET_SHA || !loaded.has(node))
        throw new FakeReplyError('NOSCRIPT No matching script. Please use EVAL.');
      return runScript(args);
    },
    eval: async (script, args) => {
      counts.eval++;
      expect(script).toBe(NODE_LOCAL_GET_SCRIPT);
      loaded.add(ownerOf(calculateSlot(args.keys[0])));
      return runScript(args);
    },
    nodeOf: opts.mapOverride ?? ownerOf,
    isValue: (v): v is Buffer => Buffer.isBuffer(v),
    isServerError: (err) => err instanceof FakeReplyError,
    onFallback: (err, keyCount) => fallbacks.push({ err, keyCount }),
  };
  // A fixed clock unless a test moves it, so the fallback cooldown is deterministic.
  const clock = { t: 1_000_000 };
  const get = createBatchedGet(deps, { cooldownMs: 10_000, now: () => clock.t });
  return { store, counts, deps, get, clock, fallbacks, failNodes, scriptKeyCounts };
}

const keyOf = (id: number) => `packed:caches:tag-ids-for-images:${id}`;
const ids = (n: number, from = 1) => Array.from({ length: n }, (_, i) => from + i);
const seed = (c: { store: Map<string, Buffer> }, keys: string[]) =>
  keys.forEach((k) => c.store.set(k, Buffer.from(`value-of-${k}`)));

// Reference: what packed.mGet did before — one GET per key.
const perKey = (keys: string[], store: Map<string, Buffer>) =>
  keys.map((k) => store.get(k) ?? null);

describe('createBatchedGet', () => {
  it('reads 200 keys with one script call per master (a full cachedArray chunk)', async () => {
    const c = fakeCluster();
    const keys = ids(200).map(keyOf);
    seed(c, keys);

    // First call on a cold node: EVALSHA → NOSCRIPT → EVAL, once per master.
    await c.get(keys);
    expect(c.counts).toEqual({ get: 0, evalSha: 3, eval: 3 });

    // Warm: exactly one EVALSHA per master, no GETs — vs 200 GETs before.
    c.counts.evalSha = c.counts.eval = 0;
    const out = await c.get(keys);
    expect(c.counts).toEqual({ get: 0, evalSha: 3, eval: 0 });
    expect(out).toEqual(perKey(keys, c.store));
    expect(c.fallbacks).toEqual([]);
  });

  it('returns exactly what per-key GETs return: order, misses as null, duplicates', async () => {
    const c = fakeCluster();
    const keys = [...ids(60).map(keyOf), keyOf(7), keyOf(7), keyOf(999_999)];
    // Every third key is a miss.
    ids(60).forEach((id) => id % 3 !== 0 && c.store.set(keyOf(id), Buffer.from(`v${id}`)));

    const out = await c.get(keys);
    expect(out).toEqual(perKey(keys, c.store));
    expect(out.filter((x) => x === null)).toHaveLength(20 + 1);
    expect(out[60]?.toString()).toBe('v7');
    expect(out[61]?.toString()).toBe('v7');
  });

  it('a master whose script errors falls back to per-key GETs for THAT group only; data unchanged', async () => {
    const c = fakeCluster();
    const keys = ids(90).map(keyOf);
    seed(c, keys);
    c.failNodes.add('n2');

    const out = await c.get(keys);
    expect(out).toEqual(perKey(keys, c.store));
    const n2Keys = keys.filter((k) => ownerOf(calculateSlot(k)) === 'n2').length;
    expect(n2Keys).toBeGreaterThan(1);
    expect(c.counts.get).toBe(n2Keys);
    expect(c.fallbacks).toHaveLength(1);
    expect(c.fallbacks[0].keyCount).toBe(n2Keys);
  });

  it('a stale slot map (keys grouped onto the wrong master) never yields a false miss', async () => {
    // The client believes n1 owns everything; the real owner differs for ~2/3 of the keys, so
    // the script fails "non local key" and that group is re-read with GET.
    const c = fakeCluster({ mapOverride: () => 'n1' });
    const keys = ids(50).map(keyOf);
    seed(c, keys);

    const out = await c.get(keys);
    expect(out).toEqual(perKey(keys, c.store));
    expect(out.every((x) => x !== null)).toBe(true);
    expect(c.counts.get).toBe(50);
  });

  it('after a fallback the script pauses for the cooldown, then resumes; one log per cooldown', async () => {
    const c = fakeCluster();
    const keys = ids(90).map(keyOf);
    seed(c, keys);
    c.failNodes.add('n1');
    c.failNodes.add('n2');
    await c.get(keys);
    expect(c.fallbacks).toHaveLength(1); // two groups failed, one log

    c.failNodes.clear();
    c.counts.get = c.counts.evalSha = c.counts.eval = 0;
    c.clock.t += 9_999;
    expect(await c.get(keys)).toEqual(perKey(keys, c.store));
    expect(c.counts).toEqual({ get: 90, evalSha: 0, eval: 0 });

    c.counts.get = 0;
    c.clock.t += 1;
    expect(await c.get(keys)).toEqual(perKey(keys, c.store));
    expect(c.counts.get).toBe(0);
    expect(c.counts.evalSha).toBe(3);
    expect(c.fallbacks).toHaveLength(1);
  });

  it('a transport failure on the script rejects without a per-key retry (as a failed GET did)', async () => {
    const c = fakeCluster();
    const keys = ids(30).map(keyOf);
    seed(c, keys);
    const timeout = new Error('command deadline exceeded');
    c.deps.evalSha = vi.fn().mockRejectedValue(timeout);
    const get = createBatchedGet(c.deps);
    await expect(get(keys)).rejects.toBe(timeout);
    expect(c.counts.get).toBe(0);
    expect(c.fallbacks).toEqual([]);
  });

  it('rejects when the per-key fallback also fails (the caller fails open, as before)', async () => {
    const c = fakeCluster();
    c.failNodes.add('n1');
    const boom = new Error('connection lost');
    c.deps.get = vi.fn().mockRejectedValue(boom);
    const get = createBatchedGet(c.deps);
    await expect(get(ids(30).map(keyOf))).rejects.toBe(boom);
  });

  // Each malformed reply would read as false misses (nulls) if it were accepted.
  const nulls = (n: number) => new Array(n).fill(null);
  it.each([
    ['too few entries', (n: number, id: Buffer) => [...nulls(n - 1), id]],
    ['too many entries', (n: number, id: Buffer) => [...nulls(n + 1), id]],
    ['an extra entry after the node id', (n: number, id: Buffer) => [...nulls(n), id, id]],
    ['string elements', (n: number, id: Buffer) => [...new Array(n).fill('not-a-buffer'), id]],
    ['a null where the node id goes', (n: number) => [...nulls(n), null]],
    ["another node's id", (n: number) => [...nulls(n), Buffer.from('n9')]],
    ['a non-array reply', () => 'OK'],
  ])('a reply with %s is never mapped onto keys — the group is re-read', async (_, reply) => {
    const c = fakeCluster();
    const keys = ids(40).map(keyOf);
    seed(c, keys);
    c.deps.evalSha = async (_sha, args) =>
      reply(
        args.keys.length + args.arguments.length,
        Buffer.from(ownerOf(calculateSlot(args.keys[0])))
      );
    const get = createBatchedGet(c.deps);

    const out = await get(keys);
    expect(out).toEqual(perKey(keys, c.store));
    expect(c.counts.get).toBe(40);
    expect(c.fallbacks).toHaveLength(1);
  });

  it('an ASK-redirected script (first key already migrated) never yields false misses', async () => {
    // Same-slot keys: {t}a has moved to the importing node, {t}b and {t}c have not.
    const k = (s: string) => `packed:caches:x:{t}${s}`;
    const slot = calculateSlot(k('a'));
    const owner = ownerOf(slot);
    const importing = owner === 'n1' ? 'n2' : 'n1';
    const c = fakeCluster({
      askTo: { node: importing, slot, holds: new Map([[k('a'), Buffer.from('A')]]) },
    });
    // Plain GETs follow ASK correctly, so the store is the truth.
    c.store.set(k('a'), Buffer.from('A'));
    c.store.set(k('b'), Buffer.from('B'));
    c.store.set(k('c'), Buffer.from('C'));
    const out = await c.get([k('a'), k('b'), k('c')]);
    expect(out).toEqual([Buffer.from('A'), Buffer.from('B'), Buffer.from('C')]);
    expect(c.fallbacks).toHaveLength(1);
    expect(String((c.fallbacks[0].err as Error).message)).toContain(`ran on ${importing}`);
  });

  it('MOVED then ASK back to the expected node: the moved slot map discards the reply', async () => {
    // The client's map says n1 owns the slot. The script is MOVED away (the client re-reads its
    // map), then ASKed back to n1 with ASKING: the reply carries n1's id but serves keys still
    // on the other node as nil.
    const k = (s: string) => `packed:caches:x:{t}${s}`;
    const slot = calculateSlot(k('a'));
    let owner = 'n1';
    const c = fakeCluster({ mapOverride: (sl) => (sl === slot ? owner : ownerOf(sl)) });
    c.store.set(k('a'), Buffer.from('A'));
    c.store.set(k('b'), Buffer.from('B'));
    c.deps.evalSha = async (_sha, args) => {
      owner = 'n2'; // the MOVED made the client rediscover
      return [Buffer.from('A'), null, Buffer.from('n1')];
    };
    const out = await c.get([k('a'), k('b')]);
    expect(out).toEqual([Buffer.from('A'), Buffer.from('B')]);
    expect(String((c.fallbacks[0].err as Error).message)).toContain('slot map moved');
  });

  it('bounds each script call to 100 keys', async () => {
    const c = fakeCluster({ mapOverride: () => 'n1' });
    // 250 keys that really all live on n1.
    const keys: string[] = [];
    for (let id = 1; keys.length < 250; id++)
      if (ownerOf(calculateSlot(keyOf(id))) === 'n1') keys.push(keyOf(id));
    seed(c, keys);

    const out = await c.get(keys);
    expect(out).toEqual(perKey(keys, c.store));
    expect(c.scriptKeyCounts).toEqual([100, 100, 50]);
    expect(c.counts.get).toBe(0);
  });

  it('keys whose slot owner is unknown, and single-key groups, use a plain GET', async () => {
    const c = fakeCluster({ mapOverride: () => undefined });
    const keys = ids(10).map(keyOf);
    seed(c, keys);
    expect(await c.get(keys)).toEqual(perKey(keys, c.store));
    expect(c.counts).toEqual({ get: 10, evalSha: 0, eval: 0 });

    const one = fakeCluster();
    one.store.set(keyOf(1), Buffer.from('x'));
    expect(await one.get([keyOf(1)])).toEqual([Buffer.from('x')]);
    expect(await one.get([])).toEqual([]);
    expect(one.counts).toEqual({ get: 1, evalSha: 0, eval: 0 });
  });

  it('script declares the cross-slot flag and only KEYS[1]', () => {
    expect(NODE_LOCAL_GET_SCRIPT.split('\n')[0]).toBe(
      '#!lua flags=no-writes,allow-cross-slot-keys'
    );
    expect(NODE_LOCAL_GET_SHA).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('createClusterBufferGet (the wiring client.ts uses)', () => {
  // A stand-in for node-redis' cluster: `slots[slot].master.id`, and a buffer client.
  function wired(reply: (keys: string[], id: Buffer) => unknown, slots: unknown = undefined) {
    const store = new Map(ids(40).map((id) => [keyOf(id), Buffer.from(`v${id}`)]));
    const calls = { get: 0, evalSha: 0 };
    const client = {
      get: async (k: string) => (calls.get++, store.get(k) ?? null),
      evalSha: async (_sha: string, a: ScriptArgs) => (
        calls.evalSha++,
        reply([...a.keys, ...a.arguments], Buffer.from(ownerOf(calculateSlot(a.keys[0]))))
      ),
      eval: async () => {
        throw new Error('unexpected EVAL');
      },
    };
    const map =
      slots ??
      Array.from({ length: 16384 }, (_, s) => ({
        master: { id: ownerOf(s), address: `${ownerOf(s)}:6379` },
      }));
    const logs: string[] = [];
    const get = createClusterBufferGet(client, { slots: map }, (m) => logs.push(m));
    const keys = ids(40).map(keyOf);
    return { get, keys, calls, logs, expected: keys.map((k) => store.get(k)!) };
  }

  it('groups by the slot map and accepts Buffer replies', async () => {
    const w = wired((keys, id) => [...keys.map((k) => Buffer.from(`v${k.split(':').pop()}`)), id]);
    expect(await w.get(w.keys)).toEqual(w.expected);
    expect(w.calls).toEqual({ get: 0, evalSha: 3 });
  });

  it('a non-Buffer element (string-mode reply) is re-read key by key, never decoded', async () => {
    const w = wired((keys, id) => [...keys.map(() => 'a-string'), id]);
    expect(await w.get(w.keys)).toEqual(w.expected);
    expect(w.calls.get).toBe(40);
  });

  it('an ErrorReply falls back; any other error rejects', async () => {
    const reply = wired(() => {
      throw new ErrorReply('ERR Script attempted to access a non local key in a cluster node');
    });
    expect(await reply.get(reply.keys)).toEqual(reply.expected);
    expect(reply.logs.some((l) => l.includes('fell back'))).toBe(true);

    const transport = wired(() => {
      throw new Error('Socket closed unexpectedly');
    });
    await expect(transport.get(transport.keys)).rejects.toThrow('Socket closed');
    expect(transport.calls.get).toBe(0);
  });

  it('no readable slot map: plain GETs, logged once', async () => {
    const w = wired(() => {
      throw new Error('script must not run');
    }, 'not-an-array');
    expect(await w.get(w.keys)).toEqual(w.expected);
    expect(await w.get(w.keys)).toEqual(w.expected);
    expect(w.calls).toEqual({ get: 80, evalSha: 0 });
    expect(w.logs.filter((l) => l.includes('no readable slot map'))).toHaveLength(1);
  });
});

describe('REDIS_CLUSTER_BATCHED_GET_ENABLED', () => {
  const base = { REDIS_URL: 'redis://a:6379', REDIS_SYS_URL: 'redis://b:6379' };
  it.each([
    ['false', false],
    [undefined, true],
  ])('reaches the client config: %s → clusterBatchedGetEnabled %s', async (value, enabled) => {
    // loadRedisEnv is memoized per module instance, so load a fresh one with this env.
    vi.resetModules();
    const saved = { ...process.env };
    try {
      Object.assign(process.env, base);
      if (value === undefined) delete process.env.REDIS_CLUSTER_BATCHED_GET_ENABLED;
      else process.env.REDIS_CLUSTER_BATCHED_GET_ENABLED = value;
      const { loadRedisEnv } = await import('../env');
      expect(loadRedisEnv().clusterBatchedGetEnabled).toBe(enabled);
    } finally {
      process.env = saved;
    }
  });
  it.each([
    [undefined, true],
    ['true', true],
    ['0', true],
    ['false', false],
  ])('%s → %s (only the literal "false" disables it)', (value, enabled) => {
    expect(
      redisEnvSchema.parse({ ...base, REDIS_CLUSTER_BATCHED_GET_ENABLED: value })
        .REDIS_CLUSTER_BATCHED_GET_ENABLED
    ).toBe(enabled);
  });
});
