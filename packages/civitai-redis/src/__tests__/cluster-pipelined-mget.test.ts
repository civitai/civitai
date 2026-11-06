import calculateSlot from 'cluster-key-slot';
import { ErrorReply } from 'redis';
import { describe, expect, it } from 'vitest';
import {
  createClusterPipelinedGet,
  createPipelinedGet,
  type PipelinedGetDeps,
} from '../cluster-pipelined-get';

/**
 * The slot-coalescing read (`{ coalesceSlots: true }`): keys that share a hash slot are read with
 * one MGET per slot, still one pipelined write per master, with the per-key GET batch's safety —
 * anything a node cannot answer authoritatively (MOVED, ASK, TRYAGAIN mid-migration, a reply of the
 * wrong shape) is re-read key by key through the routed GET; anything else rejects.
 */

const ownerOf = (slot: number) => (slot < 5461 ? 'n1' : slot < 10923 ? 'n2' : 'n3');

// Eight tags whose slots spread over the three masters; ids pick a tag round-robin.
const TAGS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const tagged = (id: number) => `packed:caches:test:{${TAGS[id % TAGS.length]}}:${id}`;
const plain = (id: number) => `packed:caches:test:${id}`;
const ids = (n: number, from = 1) => Array.from({ length: n }, (_, i) => from + i);

/**
 * Answers like a node that receives the command directly (no ASKING): MOVED if it does not own the
 * slot; for a key that has migrated away, ASK (GET) or TRYAGAIN (an MGET whose keys are now split);
 * otherwise the value(s) or nil.
 */
function fakeCluster(opts: { mapOverride?: (slot: number) => string | undefined } = {}) {
  const store = new Map<string, { node?: string; value: Buffer }>();
  const counts = { routed: 0, writes: 0, gets: 0, mgets: 0, mgetKeys: 0 };
  const tracked: number[] = [];
  const rereads: { keyCount: number; err: unknown }[] = [];
  const failures = new Map<string, unknown>(); // node → error every command there gets
  const shapeBroken = new Set<string>(); // node → MGET replies with the wrong length

  const migrated = (key: string) => {
    const e = store.get(key);
    return e?.node !== undefined && e.node !== ownerOf(calculateSlot(key));
  };
  const answer = (node: string, cmd: string[]): Promise<unknown> => {
    const failure = failures.get(node);
    if (failure) return Promise.reject(failure);
    const keys = cmd.slice(1);
    const slot = calculateSlot(keys[0]);
    if (keys.some((k) => calculateSlot(k) !== slot))
      return Promise.reject(
        new ErrorReply('CROSSSLOT Keys in request do not hash to the same slot')
      );
    if (ownerOf(slot) !== node)
      return Promise.reject(new ErrorReply(`MOVED ${slot} ${ownerOf(slot)}`));
    if (cmd[0] === 'GET') {
      if (migrated(keys[0])) return Promise.reject(new ErrorReply(`ASK ${slot} elsewhere`));
      return Promise.resolve(store.get(keys[0])?.value ?? null);
    }
    if (keys.some(migrated))
      return Promise.reject(
        new ErrorReply('TRYAGAIN Multiple keys request during rehashing of slot')
      );
    const values = keys.map((k) => store.get(k)?.value ?? null);
    return Promise.resolve(shapeBroken.has(node) ? values.slice(1) : values);
  };

  const deps: PipelinedGetDeps<Buffer> = {
    get: async (key) => {
      counts.routed++;
      return store.get(key)?.value ?? null;
    },
    nodeOf: opts.mapOverride ?? ownerOf,
    pipelineGet: async (node, keys) => {
      counts.writes++;
      counts.gets += keys.length;
      return Promise.allSettled(keys.map((k) => answer(node, ['GET', k])));
    },
    pipelineCommands: async (node, cmds) => {
      counts.writes++;
      for (const c of cmds) {
        if (c[0] === 'MGET') {
          counts.mgets++;
          counts.mgetKeys += c.length - 1;
        } else counts.gets++;
      }
      return Promise.allSettled(cmds.map((c) => answer(node, c)));
    },
    track: (count, run) => {
      tracked.push(count);
      return run();
    },
    isValue: (v): v is Buffer => Buffer.isBuffer(v),
    isRedirect: (err) => err instanceof ErrorReply && /^(MOVED|ASK) /.test(err.message),
    isMultiKeyRetryable: (err) => err instanceof ErrorReply && /^TRYAGAIN\b/.test(err.message),
    onReread: (keyCount, err) => rereads.push({ keyCount, err }),
  };
  const put = (key: string, node?: string) =>
    store.set(key, { node, value: Buffer.from(`value-of-${key}`) });
  return {
    store,
    counts,
    deps,
    get: createPipelinedGet(deps),
    put,
    tracked,
    rereads,
    failures,
    shapeBroken,
  };
}

const truth = (c: ReturnType<typeof fakeCluster>, keys: string[]) =>
  keys.map((k) => c.store.get(k)?.value ?? null);
const distinctSlots = (keys: string[]) => new Set(keys.map((k) => calculateSlot(k))).size;

describe('createPipelinedGet { coalesceSlots }', () => {
  it('reads tagged keys with one MGET per slot, one write per master, nothing routed', async () => {
    const c = fakeCluster();
    const keys = ids(200).map(tagged);
    keys.filter((_, i) => i % 3 !== 0).forEach((k) => c.put(k)); // a third are misses
    const out = await c.get(keys, { coalesceSlots: true });
    expect(out).toEqual(truth(c, keys));
    expect(c.counts.mgets).toBe(distinctSlots(keys));
    expect(c.counts.mgets).toBe(TAGS.length);
    expect(c.counts.mgetKeys).toBe(200);
    expect(c.counts.gets).toBe(0);
    expect(c.counts.routed).toBe(0);
    expect(c.counts.writes).toBe(new Set(keys.map((k) => ownerOf(calculateSlot(k)))).size);
    // Accounted as keys, as the per-key batch is, so the wedge signals read the same.
    expect(c.tracked.reduce((a, b) => a + b, 0)).toBe(200);
  });

  it('sends a slot holding one key as a GET', async () => {
    const c = fakeCluster();
    const keys = [...ids(10).map(plain)];
    keys.forEach((k) => c.put(k));
    const out = await c.get(keys, { coalesceSlots: true });
    expect(out).toEqual(truth(c, keys));
    expect(c.counts.mgets).toBe(0);
    expect(c.counts.gets + c.counts.routed).toBe(10);
  });

  it('without the option, reads exactly as before: one GET per key, no MGET', async () => {
    const c = fakeCluster();
    const keys = ids(200).map(tagged);
    keys.forEach((k) => c.put(k));
    const out = await c.get(keys);
    expect(out).toEqual(truth(c, keys));
    expect(c.counts.mgets).toBe(0);
    expect(c.counts.gets).toBe(200);
  });

  it('keeps order and duplicates', async () => {
    const c = fakeCluster();
    const keys = [tagged(1), tagged(9), tagged(1), tagged(2), tagged(17), tagged(9)];
    keys.forEach((k) => c.put(k));
    expect(await c.get(keys, { coalesceSlots: true })).toEqual(truth(c, keys));
  });

  it('re-reads every key of an MGET answered MOVED (a stale slot map)', async () => {
    // The map sends everything to n1; only n1's own slots are answered there.
    const c = fakeCluster({ mapOverride: () => 'n1' });
    const keys = ids(80).map(tagged);
    keys.forEach((k) => c.put(k));
    const out = await c.get(keys, { coalesceSlots: true });
    expect(out).toEqual(truth(c, keys));
    const notOnN1 = keys.filter((k) => ownerOf(calculateSlot(k)) !== 'n1');
    expect(notOnN1.length).toBeGreaterThan(0);
    expect(c.counts.routed).toBe(notOnN1.length);
    expect(c.rereads).toHaveLength(1);
    expect(String(c.rereads[0].err)).toMatch(/MOVED/);
  });

  it('re-reads every key of an MGET answered TRYAGAIN (a slot mid-migration)', async () => {
    const c = fakeCluster();
    const keys = ids(40).map(tagged);
    keys.forEach((k) => c.put(k));
    const moving = keys[5];
    c.put(moving, 'elsewhere');
    const sameSlot = keys.filter((k) => calculateSlot(k) === calculateSlot(moving));
    const out = await c.get(keys, { coalesceSlots: true });
    expect(out).toEqual(truth(c, keys));
    expect(c.counts.routed).toBe(sameSlot.length);
    expect(String(c.rereads[0].err)).toMatch(/TRYAGAIN/);
  });

  it('re-reads an MGET whose reply has the wrong shape rather than guess', async () => {
    const c = fakeCluster();
    const keys = ids(40).map(tagged);
    keys.forEach((k) => c.put(k));
    c.shapeBroken.add('n2');
    const out = await c.get(keys, { coalesceSlots: true });
    expect(out).toEqual(truth(c, keys));
    expect(c.counts.routed).toBe(keys.filter((k) => ownerOf(calculateSlot(k)) === 'n2').length);
  });

  it('rejects on any other error, as the per-key batch does, without re-reading', async () => {
    const c = fakeCluster();
    const keys = ids(40).map(tagged);
    keys.forEach((k) => c.put(k));
    c.failures.set('n3', new ErrorReply('LOADING Redis is loading the dataset in memory'));
    await expect(c.get(keys, { coalesceSlots: true })).rejects.toThrow(/LOADING/);
    expect(c.counts.routed).toBe(0);
  });

  it('a TRYAGAIN on a single-key GET is not re-read (it is not a multi-key reply)', async () => {
    // Every key mapped to n1 and n1 answering TRYAGAIN: four single-key GETs, none re-read.
    const c = fakeCluster({ mapOverride: () => 'n1' });
    const keys = [plain(1), plain(2), plain(3), plain(4)];
    keys.forEach((k) => c.put(k));
    c.failures.set('n1', new ErrorReply('TRYAGAIN x'));
    await expect(c.get(keys, { coalesceSlots: true })).rejects.toThrow(/TRYAGAIN/);
  });

  it('without pipelineCommands the option falls back to the per-key batch', async () => {
    const c = fakeCluster();
    const get = createPipelinedGet({ ...c.deps, pipelineCommands: undefined });
    const keys = ids(30).map(tagged);
    keys.forEach((k) => c.put(k));
    expect(await get(keys, { coalesceSlots: true })).toEqual(truth(c, keys));
    expect(c.counts.mgets).toBe(0);
    expect(c.counts.gets).toBe(30);
  });
});

describe('createClusterPipelinedGet { coalesceSlots } (the wiring client.ts uses)', () => {
  it('writes MGET per slot to the slot master with the buffer type mapping and no timeout', async () => {
    const values = new Map(ids(60).map((id) => [tagged(id), Buffer.from(`v${id}`)]));
    const sent: { node: string; args: string[]; o?: Record<string, unknown> }[] = [];
    const typeMapping = { marker: 'buffer-mapping' } as any;
    const nodes = new Map(
      ['n1', 'n2', 'n3'].map((n) => [
        n,
        {
          address: `${n}:6379`,
          client: {
            sendCommand: async (args: string[], o?: Record<string, unknown>) => {
              sent.push({ node: n, args, o: { ...o } });
              const keys = args.slice(1);
              if (keys.some((k) => ownerOf(calculateSlot(k)) !== n)) throw new ErrorReply('MOVED');
              if (args[0] === 'MGET') return keys.map((k) => values.get(k) ?? null);
              return values.get(keys[0]) ?? null;
            },
          },
        },
      ])
    );
    let routed = 0;
    const get = createClusterPipelinedGet({
      get: async (k) => (routed++, values.get(k) ?? null),
      cluster: {
        slots: Array.from({ length: 16384 }, (_, s) => ({ master: nodes.get(ownerOf(s)) })),
        nodeClient: (m: any) => m.client,
      },
      typeMapping,
      track: (_n, run) => run(),
      log: () => undefined,
    });
    const keys = ids(60).map(tagged);
    expect(await get(keys, { coalesceSlots: true })).toEqual(keys.map((k) => values.get(k)));
    expect(routed).toBe(0);
    expect(sent.every((s) => s.args[0] === 'MGET')).toBe(true);
    expect(sent).toHaveLength(distinctSlots(keys));
    expect(sent.every((s) => s.o?.typeMapping === typeMapping && 'timeout' in (s.o ?? {}))).toBe(
      true
    );
    expect(sent.every((s) => s.o?.timeout === undefined)).toBe(true);
  });
});
