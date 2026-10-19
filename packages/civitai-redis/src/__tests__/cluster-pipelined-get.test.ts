import calculateSlot from 'cluster-key-slot';
import { ErrorReply } from 'redis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { instrumentCommands, trackClusterCommands } from '../client';
import { countClusterDeadlineHits, resetClusterDeadlineHits } from '../cluster-deadline-hits';
import { getClusterInflight, resetClusterInflight } from '../cluster-inflight';
import {
  createClusterPipelinedGet,
  createPipelinedGet,
  type PipelinedGetDeps,
} from '../cluster-pipelined-get';
import { redisEnvSchema } from '../env';

const ownerOf = (slot: number) => (slot < 5461 ? 'n1' : slot < 10923 ? 'n2' : 'n3');

/**
 * A fake 3-master cluster with Redis' answers to a plain GET sent straight to one node (no
 * ASKING): the value or nil if the node owns the slot and holds (or lacks) the key, ASK if it owns
 * the slot but the key has already migrated elsewhere, MOVED if it does not own the slot. The
 * routed `get` (the normal client path) always finds the truth. Counts both paths.
 */
function fakeCluster(opts: { mapOverride?: (slot: number) => string | undefined } = {}) {
  // key → where it physically lives and its value
  const store = new Map<string, { node: string; value: Buffer }>();
  const counts = { routed: 0, batches: 0, pipelined: 0 };
  const tracked: number[] = [];
  const rereads: { keyCount: number; err: unknown }[] = [];
  const brokenNodes = new Map<string, unknown>();

  const directGet = (node: string, key: string): Promise<Buffer | null> => {
    const owner = ownerOf(calculateSlot(key));
    if (node !== owner)
      return Promise.reject(new ErrorReply(`MOVED ${calculateSlot(key)} ${owner}`));
    const entry = store.get(key);
    if (entry && entry.node !== node)
      return Promise.reject(new ErrorReply(`ASK ${calculateSlot(key)} ${entry.node}`));
    return Promise.resolve(entry ? entry.value : null);
  };

  const deps: PipelinedGetDeps<Buffer> = {
    get: async (key) => {
      counts.routed++;
      return store.get(key)?.value ?? null;
    },
    nodeOf: opts.mapOverride ?? ownerOf,
    pipelineGet: async (node, keys) => {
      counts.batches++;
      counts.pipelined += keys.length;
      const broken = brokenNodes.get(node);
      return Promise.allSettled(
        keys.map((k) => (broken ? Promise.reject(broken) : directGet(node, k)))
      );
    },
    track: (count, run) => {
      tracked.push(count);
      return run();
    },
    isValue: (v): v is Buffer => Buffer.isBuffer(v),
    isRedirect: (err) => err instanceof ErrorReply && /^(MOVED|ASK) /.test(err.message),
    onReread: (keyCount, err) => rereads.push({ keyCount, err }),
  };
  const put = (key: string, value = Buffer.from(`value-of-${key}`), node?: string) =>
    store.set(key, { node: node ?? ownerOf(calculateSlot(key)), value });
  return { store, counts, deps, get: createPipelinedGet(deps), put, tracked, rereads, brokenNodes };
}

const keyOf = (id: number) => `packed:caches:tag-ids-for-images:${id}`;
const ids = (n: number, from = 1) => Array.from({ length: n }, (_, i) => from + i);
const truth = (c: ReturnType<typeof fakeCluster>, keys: string[]) =>
  keys.map((k) => c.store.get(k)?.value ?? null);

describe('createPipelinedGet', () => {
  it('reads 200 keys as one pipelined batch per master, routing none of them', async () => {
    const c = fakeCluster();
    const keys = ids(200).map(keyOf);
    keys.forEach((k) => c.put(k));
    const out = await c.get(keys);
    expect(out).toEqual(truth(c, keys));
    expect(c.counts).toEqual({ routed: 0, batches: 3, pipelined: 200 });
    expect(c.tracked.reduce((a, b) => a + b, 0)).toBe(200);
    expect(c.rereads).toEqual([]);
  });

  it('returns exactly what per-key GETs return: order, misses as null, duplicates', async () => {
    const c = fakeCluster();
    const keys = [...ids(60).map(keyOf), keyOf(7), keyOf(7), keyOf(999_999)];
    ids(60).forEach((id) => id % 3 !== 0 && c.put(keyOf(id), Buffer.from(`v${id}`)));
    const out = await c.get(keys);
    expect(out).toEqual(truth(c, keys));
    expect(out.filter((x) => x === null)).toHaveLength(20 + 1);
    expect(out[60]?.toString()).toBe('v7');
    expect(out[61]?.toString()).toBe('v7');
  });

  it('a stale slot map: exactly the misrouted keys answer MOVED and are re-read on their own', async () => {
    // The client believes n1 owns everything.
    const c = fakeCluster({ mapOverride: () => 'n1' });
    const keys = ids(60).map(keyOf);
    keys.forEach((k) => c.put(k));
    const misrouted = keys.filter((k) => ownerOf(calculateSlot(k)) !== 'n1').length;
    expect(misrouted).toBeGreaterThan(1);
    const out = await c.get(keys);
    expect(out).toEqual(truth(c, keys));
    expect(out.every((x) => x !== null)).toBe(true);
    expect(c.counts.routed).toBe(misrouted);
    expect(c.rereads).toHaveLength(1);
    expect(c.rereads[0].keyCount).toBe(misrouted);
    expect(String((c.rereads[0].err as Error).message)).toMatch(/^MOVED/);
  });

  it('a key already migrated off its slot owner answers ASK and is re-read; never a false miss', async () => {
    const c = fakeCluster();
    const k = (s: string) => `packed:caches:x:{t}${s}`;
    const owner = ownerOf(calculateSlot(k('a')));
    const other = owner === 'n1' ? 'n2' : 'n1';
    c.put(k('a'), Buffer.from('A'), other); // moved
    c.put(k('b'), Buffer.from('B'));
    c.put(k('c'), Buffer.from('C'));
    const out = await c.get([k('a'), k('b'), k('c')]);
    expect(out).toEqual([Buffer.from('A'), Buffer.from('B'), Buffer.from('C')]);
    expect(c.counts.routed).toBe(1);
    expect(String((c.rereads[0].err as Error).message)).toMatch(/^ASK/);
  });

  it('a transport failure on a batch rejects, without re-sending its keys one by one', async () => {
    const c = fakeCluster();
    const keys = ids(60).map(keyOf);
    keys.forEach((k) => c.put(k));
    const closed = new Error('Socket closed unexpectedly');
    c.brokenNodes.set('n2', closed);
    await expect(c.get(keys)).rejects.toBe(closed);
    expect(c.counts.routed).toBe(0);
  });

  it.each([
    'LOADING Redis is loading the dataset in memory',
    'CLUSTERDOWN The cluster is down',
    'TRYAGAIN Multiple keys request during rehashing of slot',
    'OOM command not allowed',
  ])(
    'a node answering "%s" to every key: the call rejects and issues zero extra GETs',
    async (message) => {
      const c = fakeCluster();
      const keys = ids(60).map(keyOf);
      keys.forEach((k) => c.put(k));
      const refused = new ErrorReply(message);
      c.brokenNodes.set('n2', refused);
      await expect(c.get(keys)).rejects.toBe(refused);
      expect(c.counts.routed).toBe(0);
      expect(c.counts.pipelined).toBe(60); // only the batch itself was sent
      expect(c.rereads).toEqual([]);
    }
  );

  it('a node that cannot be reached at all rejects the call', async () => {
    const c = fakeCluster();
    const keys = ids(30).map(keyOf);
    const boom = new Error('connect ECONNREFUSED');
    c.deps.pipelineGet = () => Promise.reject(boom);
    await expect(createPipelinedGet(c.deps)(keys)).rejects.toBe(boom);
    expect(c.counts.routed).toBe(0);
  });

  it('a reply that is not a usable value is re-read rather than decoded', async () => {
    const c = fakeCluster();
    const keys = ids(30).map(keyOf);
    keys.forEach((k) => c.put(k));
    c.deps.pipelineGet = async (_node, ks) =>
      ks.map(() => ({ status: 'fulfilled' as const, value: 'a-string' }));
    const out = await createPipelinedGet(c.deps)(keys);
    expect(out).toEqual(truth(c, keys));
    expect(c.counts.routed).toBe(30);
  });

  it('a batch answering the wrong number of replies is never mapped onto keys', async () => {
    const c = fakeCluster();
    const keys = ids(30).map(keyOf);
    keys.forEach((k) => c.put(k));
    c.deps.pipelineGet = async (_node, ks) =>
      ks.slice(1).map(() => ({ status: 'fulfilled' as const, value: null }));
    await expect(createPipelinedGet(c.deps)(keys)).rejects.toThrow(/replies for/);
  });

  it('a master with only one key of the batch gets a routed GET; the others are pipelined', async () => {
    const c = fakeCluster();
    const on = (n: string) =>
      ids(500)
        .map(keyOf)
        .filter((k) => ownerOf(calculateSlot(k)) === n);
    const keys = [...on('n1').slice(0, 2), on('n2')[0]];
    keys.forEach((k) => c.put(k));
    expect(await c.get(keys)).toEqual(truth(c, keys));
    expect(c.counts).toEqual({ routed: 1, batches: 1, pipelined: 2 });
  });

  it('keys whose slot owner is unknown, and single-key groups, use a routed GET', async () => {
    const c = fakeCluster({ mapOverride: () => undefined });
    const keys = ids(10).map(keyOf);
    keys.forEach((k) => c.put(k));
    expect(await c.get(keys)).toEqual(truth(c, keys));
    expect(c.counts).toEqual({ routed: 10, batches: 0, pipelined: 0 });

    const one = fakeCluster();
    one.put(keyOf(1), Buffer.from('x'));
    expect(await one.get([keyOf(1)])).toEqual([Buffer.from('x')]);
    expect(await one.get([])).toEqual([]);
    expect(one.counts).toEqual({ routed: 1, batches: 0, pipelined: 0 });
  });
});

describe('wedge accounting: a batch counts as its key count', () => {
  afterEach(() => {
    resetClusterInflight();
    resetClusterDeadlineHits();
  });

  it('trackClusterCommands: inflight +N while running, N duration samples and slow settles', async () => {
    const observed: number[] = [];
    let inflightGauge = 0;
    (globalThis as any).__civitaiRedisMetrics = {
      redisCommandsInflight: { inc: () => inflightGauge++, dec: () => inflightGauge-- },
      redisCommandDuration: { observe: (_l: unknown, v: number) => observed.push(v) },
    };
    try {
      let release!: () => void;
      const p = trackClusterCommands(37, () => new Promise<void>((r) => (release = r)), {
        deadlineMs: 0,
        slowCommandMs: 1,
      });
      expect(getClusterInflight()).toBe(37);
      expect(inflightGauge).toBe(37);
      await new Promise((r) => setTimeout(r, 5));
      release();
      await p;
      expect(getClusterInflight()).toBe(0);
      expect(inflightGauge).toBe(0);
      expect(observed).toHaveLength(37);
      expect(countClusterDeadlineHits(60_000)).toBe(37);
    } finally {
      delete (globalThis as any).__civitaiRedisMetrics;
    }
  });

  it.each(['cluster', 'sys'] as const)(
    'a routed %s command is still one gauge inc/dec and one duration sample (shared accounting)',
    async (label) => {
      const seen: string[] = [];
      (globalThis as any).__civitaiRedisMetrics = {
        redisCommandsInflight: {
          inc: (l: { client: string }) => seen.push(`inc:${l.client}`),
          dec: (l: { client: string }) => seen.push(`dec:${l.client}`),
        },
        redisCommandDuration: {
          observe: (l: { client: string }) => seen.push(`observe:${l.client}`),
        },
      };
      try {
        const fake: any = { _execute: async () => 'ok', sendCommand: async () => 'ok' };
        if (label === 'sys') delete fake._execute;
        instrumentCommands(fake, label, {
          deadlineMs: 0,
          slowCommandMs: 0,
          routingRetryEnabled: false,
        });
        await (label === 'cluster' ? fake._execute('GET', 'k') : fake.sendCommand(['GET', 'k']));
        expect(seen).toEqual([`inc:${label}`, `dec:${label}`, `observe:${label}`]);
      } finally {
        delete (globalThis as any).__civitaiRedisMetrics;
      }
    }
  );

  it('trackClusterCommands: a synchronous throw still settles the accounting', async () => {
    await expect(
      trackClusterCommands(
        5,
        () => {
          throw new Error('no node');
        },
        { deadlineMs: 0, slowCommandMs: 0 }
      )
    ).rejects.toThrow('no node');
    expect(getClusterInflight()).toBe(0);
  });

  it('a stuck 200-key read moves inflight by 200 and, at the deadline, the slow-settle count by 200', async () => {
    const c = fakeCluster();
    const keys = ids(200).map(keyOf);
    c.deps.pipelineGet = () => new Promise(() => undefined); // never answers
    c.deps.track = (count, run) =>
      trackClusterCommands(count, run, { deadlineMs: 30, slowCommandMs: 20 });
    const p = createPipelinedGet(c.deps)(keys);
    expect(getClusterInflight()).toBe(200);
    await expect(p).rejects.toThrow(/timed out/);
    // Each master's batch reaches its own deadline; the call rejects at the first of them.
    await vi.waitFor(() => expect(getClusterInflight()).toBe(0));
    expect(countClusterDeadlineHits(60_000)).toBe(200);
    expect(c.counts.routed).toBe(0); // a stuck node is not re-asked key by key
  });
});

describe('createClusterPipelinedGet (the wiring client.ts uses)', () => {
  // A stand-in for node-redis' cluster: `slots[slot].master`, `nodeClient(master)` → a node
  // connection whose `sendCommand` answers like a real node (see fakeCluster above).
  function wired(
    slots: unknown = undefined,
    reply?: (node: string, key: string) => Promise<unknown>
  ) {
    const values = new Map(ids(40).map((id) => [keyOf(id), Buffer.from(`v${id}`)]));
    const calls = { routed: 0, sent: 0 };
    const typeMappings: unknown[] = [];
    const sendOptions: Record<string, unknown>[] = [];
    const nodes = new Map(
      ['n1', 'n2', 'n3'].map((n) => [
        n,
        {
          address: `${n}:6379`,
          client: {
            sendCommand: async (args: string[], o?: { typeMapping?: unknown }) => {
              calls.sent++;
              typeMappings.push(o?.typeMapping);
              sendOptions.push({ ...o });
              expect(args[0]).toBe('GET');
              if (reply) return reply(n, args[1]);
              if (ownerOf(calculateSlot(args[1])) !== n) throw new ErrorReply('MOVED');
              return values.get(args[1]) ?? null;
            },
          },
        },
      ])
    );
    const map =
      slots ?? Array.from({ length: 16384 }, (_, s) => ({ master: nodes.get(ownerOf(s)) }));
    const logs: string[] = [];
    const typeMapping = { marker: 'buffer-mapping' } as any;
    const get = createClusterPipelinedGet({
      get: async (k) => (calls.routed++, values.get(k) ?? null),
      cluster: { slots: map, nodeClient: (m: any) => m.client },
      typeMapping,
      track: (_n, run) => run(),
      log: (m) => logs.push(m),
    });
    const keys = ids(40).map(keyOf);
    return {
      get,
      keys,
      calls,
      logs,
      typeMappings,
      sendOptions,
      typeMapping,
      expected: keys.map((k) => values.get(k)!),
    };
  }

  it('sends each key once to its master, with the Buffer type mapping, and routes none', async () => {
    const w = wired();
    expect(await w.get(w.keys)).toEqual(w.expected);
    expect(w.calls).toEqual({ routed: 0, sent: 40 });
    expect(w.typeMappings.every((t) => t === w.typeMapping)).toBe(true);
    // node-redis 6 node connections default to a 5 s command timeout; every GET opts out of it
    // (the batch deadline is `track`'s).
    expect(w.sendOptions.length).toBeGreaterThan(0);
    expect(w.sendOptions.every((o) => 'timeout' in o && o.timeout === undefined)).toBe(true);
  });

  it('a string reply (no Buffer mapping) is re-read, never decoded', async () => {
    const w = wired(undefined, async () => 'a-string');
    expect(await w.get(w.keys)).toEqual(w.expected);
    expect(w.calls.routed).toBe(40);
  });

  it('a MOVED/ASK reply is re-read; any other error reply or failure rejects', async () => {
    const moved = wired(undefined, async () => {
      throw new ErrorReply('MOVED 1 elsewhere');
    });
    expect(await moved.get(moved.keys)).toEqual(moved.expected);
    expect(moved.logs.some((l) => l.includes('re-read 40 keys'))).toBe(true);

    const ask = wired(undefined, async () => {
      throw new ErrorReply('ASK 1 elsewhere');
    });
    expect(await ask.get(ask.keys)).toEqual(ask.expected);

    const loading = wired(undefined, async () => {
      throw new ErrorReply('LOADING Redis is loading the dataset in memory');
    });
    await expect(loading.get(loading.keys)).rejects.toThrow('LOADING');
    expect(loading.calls.routed).toBe(0);

    const transport = wired(undefined, async () => {
      throw new Error('Socket closed unexpectedly');
    });
    await expect(transport.get(transport.keys)).rejects.toThrow('Socket closed');
    expect(transport.calls.routed).toBe(0);
  });

  it('no readable slot map: routed GETs, logged once', async () => {
    const w = wired('not-an-array');
    expect(await w.get(w.keys)).toEqual(w.expected);
    expect(await w.get(w.keys)).toEqual(w.expected);
    expect(w.calls).toEqual({ routed: 80, sent: 0 });
    expect(w.logs.filter((l) => l.includes('no readable slot map'))).toHaveLength(1);
  });
});

describe('REDIS_CLUSTER_BATCHED_GET_ENABLED', () => {
  const base = { REDIS_URL: 'redis://a:6379', REDIS_SYS_URL: 'redis://b:6379' };
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
