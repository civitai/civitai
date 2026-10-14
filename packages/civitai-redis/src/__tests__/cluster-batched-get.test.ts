import calculateSlot from 'cluster-key-slot';
import { describe, expect, it, vi } from 'vitest';
import {
  NODE_LOCAL_GET_MAX_KEYS,
  NODE_LOCAL_GET_SCRIPT,
  NODE_LOCAL_GET_SHA,
  batchedGet,
  type BatchedGetDeps,
  type ScriptArgs,
} from '../cluster-batched-get';

/**
 * A fake 3-master cluster that enforces what a real one does to the node-local script:
 *   - the script is cached per node (NOSCRIPT until EVAL loads it),
 *   - a script whose KEYS[1] or any ARGV key is not served by the node it is routed to fails
 *     as a whole ("non local key"),
 * and counts every command so a test can assert how many round-trips a batch costs.
 */
function fakeCluster(opts: { mapOverride?: (slot: number) => string | undefined } = {}) {
  const ownerOf = (slot: number) => (slot < 5461 ? 'n1' : slot < 10923 ? 'n2' : 'n3');
  const store = new Map<string, Buffer>();
  const loaded = new Set<string>();
  const counts = { get: 0, evalSha: 0, eval: 0 };
  const scriptKeyCounts: number[] = [];
  const failNodes = new Set<string>();

  function runScript(args: ScriptArgs) {
    const node = ownerOf(calculateSlot(args.keys[0]));
    if (failNodes.has(node)) throw new Error(`ERR injected failure on ${node}`);
    const all = [args.keys[0], ...args.arguments];
    scriptKeyCounts.push(all.length);
    for (const k of all) {
      if (ownerOf(calculateSlot(k)) !== node)
        throw new Error('ERR Script attempted to access a non local key in a cluster node');
    }
    return all.map((k) => store.get(k) ?? null);
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
        throw new Error('NOSCRIPT No matching script. Please use EVAL.');
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
    onFallback: (err, keyCount) => fallbacks.push({ err, keyCount }),
  };
  return { store, counts, deps, fallbacks, failNodes, scriptKeyCounts, ownerOf };
}

const keyOf = (id: number) => `packed:caches:tag-ids-for-images:${id}`;
const ids = (n: number, from = 1) => Array.from({ length: n }, (_, i) => from + i);

// Reference: what packed.mGet did before — one GET per key.
async function perKey(keys: string[], store: Map<string, Buffer>) {
  return keys.map((k) => store.get(k) ?? null);
}

describe('batchedGet', () => {
  it('reads 200 keys with one script call per master (a full cachedArray chunk)', async () => {
    const c = fakeCluster();
    const keys = ids(200).map(keyOf);
    for (const k of keys) c.store.set(k, Buffer.from(k));

    // First call on a cold node: EVALSHA → NOSCRIPT → EVAL, once per master.
    await batchedGet(keys, c.deps);
    expect(c.counts).toEqual({ get: 0, evalSha: 3, eval: 3 });

    // Warm: exactly one EVALSHA per master, no GETs — vs 200 GETs before.
    c.counts.evalSha = c.counts.eval = 0;
    const out = await batchedGet(keys, c.deps);
    expect(c.counts).toEqual({ get: 0, evalSha: 3, eval: 0 });
    expect(out).toEqual(await perKey(keys, c.store));
    expect(c.fallbacks).toEqual([]);
  });

  it('returns exactly what per-key GETs return: order, misses as null, duplicates', async () => {
    const c = fakeCluster();
    const keys = [...ids(60).map(keyOf), keyOf(7), keyOf(7), keyOf(999_999)];
    // Every third key is a miss.
    ids(60).forEach((id) => id % 3 !== 0 && c.store.set(keyOf(id), Buffer.from(`v${id}`)));

    const out = await batchedGet(keys, c.deps);
    expect(out).toEqual(await perKey(keys, c.store));
    expect(out.filter((x) => x === null)).toHaveLength(20 + 1);
    expect(out[60]?.toString()).toBe('v7');
    expect(out[61]?.toString()).toBe('v7');
  });

  it('one master failing falls back to per-key GETs for THAT group only; data is unchanged', async () => {
    const c = fakeCluster();
    const keys = ids(90).map(keyOf);
    for (const k of keys) c.store.set(k, Buffer.from(k));
    c.failNodes.add('n2');

    const out = await batchedGet(keys, c.deps);
    expect(out).toEqual(await perKey(keys, c.store));
    const n2Keys = keys.filter((k) => c.ownerOf(calculateSlot(k)) === 'n2').length;
    expect(n2Keys).toBeGreaterThan(1);
    expect(c.counts.get).toBe(n2Keys);
    expect(c.fallbacks).toHaveLength(1);
    expect(c.fallbacks[0].keyCount).toBe(n2Keys);
  });

  it('a stale slot map (keys grouped onto the wrong master) never yields a false miss', async () => {
    // The client believes n1 owns everything; the real owner differs for ~2/3 of the keys, so
    // the script fails "non local key" and those groups are re-read with GET.
    const c = fakeCluster({ mapOverride: () => 'n1' });
    const keys = ids(50).map(keyOf);
    for (const k of keys) c.store.set(k, Buffer.from(k));

    const out = await batchedGet(keys, c.deps);
    expect(out).toEqual(await perKey(keys, c.store));
    expect(out.every((x) => x !== null)).toBe(true);
    expect(c.counts.get).toBe(50);
  });

  it('rejects when the per-key fallback also fails (the caller fails open, as before)', async () => {
    const c = fakeCluster();
    c.failNodes.add('n1');
    const boom = new Error('connection lost');
    c.deps.get = vi.fn().mockRejectedValue(boom);
    const keys = ids(30).map(keyOf);
    await expect(batchedGet(keys, c.deps)).rejects.toBe(boom);
  });

  it.each([
    ['too few entries', (n: number) => new Array(n - 1).fill(null)],
    ['string elements', (n: number) => new Array(n).fill('not-a-buffer')],
    ['a non-array reply', () => 'OK'],
  ])('a reply with %s is never mapped onto keys — the group is re-read', async (_, reply) => {
    const c = fakeCluster();
    const keys = ids(40).map(keyOf);
    for (const k of keys) c.store.set(k, Buffer.from(k));
    c.deps.evalSha = async (_sha, args) => reply(args.keys.length + args.arguments.length);

    const out = await batchedGet(keys, c.deps);
    expect(out).toEqual(await perKey(keys, c.store));
    expect(c.counts.get).toBe(40);
    expect(c.fallbacks).toHaveLength(3);
  });

  it('bounds each script call to NODE_LOCAL_GET_MAX_KEYS keys', async () => {
    const c = fakeCluster({ mapOverride: () => 'n1' });
    // 250 keys that really all live on n1.
    const keys: string[] = [];
    for (let id = 1; keys.length < 250; id++)
      if (c.ownerOf(calculateSlot(keyOf(id))) === 'n1') keys.push(keyOf(id));
    for (const k of keys) c.store.set(k, Buffer.from(k));

    const out = await batchedGet(keys, c.deps);
    expect(out).toEqual(await perKey(keys, c.store));
    expect(Math.max(...c.scriptKeyCounts)).toBe(NODE_LOCAL_GET_MAX_KEYS);
    expect(c.scriptKeyCounts.reduce((a, b) => a + b, 0)).toBe(250);
    expect(c.counts.get).toBe(0);
  });

  it('keys whose slot owner is unknown, and single-key groups, use a plain GET', async () => {
    const c = fakeCluster({ mapOverride: () => undefined });
    const keys = ids(10).map(keyOf);
    for (const k of keys) c.store.set(k, Buffer.from(k));
    expect(await batchedGet(keys, c.deps)).toEqual(await perKey(keys, c.store));
    expect(c.counts).toEqual({ get: 10, evalSha: 0, eval: 0 });

    const one = fakeCluster();
    one.store.set(keyOf(1), Buffer.from('x'));
    expect(await batchedGet([keyOf(1)], one.deps)).toEqual([Buffer.from('x')]);
    expect(await batchedGet([], one.deps)).toEqual([]);
    expect(one.counts).toEqual({ get: 1, evalSha: 0, eval: 0 });
  });

  it('script declares the cross-slot flag and only KEYS[1]', () => {
    expect(NODE_LOCAL_GET_SCRIPT.split('\n')[0]).toBe(
      '#!lua flags=no-writes,allow-cross-slot-keys'
    );
    expect(NODE_LOCAL_GET_SHA).toMatch(/^[0-9a-f]{40}$/);
  });
});
