import type { QdrantClient } from '@qdrant/js-client-rest';
import { describe, expect, test } from 'vitest';
import { Embedder, PrefixCheckUnavailableError, unitPrefix } from '@/vector-sync/embedder';
import { ModelMismatchError, VectorStore } from '@/vector-sync/qdrant';
import { fromHalf, npy, toHalf, VectorSink, type SinkPut } from '@/vector-sync/sink';

/** A deterministic 2048-d embedding for an image id. */
const wide = (id: number) => Array.from({ length: 2048 }, (_, i) => Math.sin(id * 31 + i * 0.7));

/**
 * An orchestrator that answers each step at the width it was asked for: the wide vector at 2048,
 * `direct(id)` at 256. Records the widths requested, one per workflow.
 */
function orchestrator(direct: (id: number) => number[] | null = (id) => unitPrefix(wide(id), 256)) {
  const widths: number[] = [];
  const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      steps: Array<{ name: string; input: { dimensions: number } }>;
    };
    const width = body.steps[0].input.dimensions;
    widths.push(width);
    return new Response(
      JSON.stringify({
        id: 'wf',
        status: 'succeeded',
        steps: body.steps.map((step) => {
          const id = Number(step.name.replace(/^img-/, ''));
          const embedding = width === 2048 ? wide(id) : direct(id);
          if (!embedding) return { name: step.name, status: 'failed' };
          return {
            name: step.name,
            status: 'succeeded',
            output: {
              model: 'wemm-2b',
              modelRevision: 'r1',
              profile: 'p1',
              dimensions: width,
              precision: 'float32',
              embedding,
            },
          };
        }),
      }),
      { status: 200 }
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, widths };
}

function embedder(
  fetchImpl: typeof fetch,
  sink: VectorSink | null,
  extra: Partial<ConstructorParameters<typeof Embedder>[0]> = {}
) {
  return new Embedder({
    endpoint: 'http://orch',
    token: 't',
    maxInFlight: 10,
    maxRetries: 0,
    batchSize: 5,
    priority: 'low',
    fetch: fetchImpl,
    sleep: async () => undefined,
    sourceDimensions: 2048,
    sink,
    ...extra,
  });
}

const SOURCE = { model: 'm', revision: 'r', profile: 'p' };

const inputs = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: String(i + 1), imageUrl: 'u' }));

/** A sink that keeps what it is given, for reading back. */
function memorySink(opts: ConstructorParameters<typeof VectorSink>[1] = {}) {
  const objects = new Map<string, Uint8Array>();
  const put: SinkPut = async (key, body) => void objects.set(key, body);
  return { sink: new VectorSink(put, { flushEveryMs: 0, ...opts }), objects };
}

/** Shape and data of a .npy file written by `npy`. */
function readNpy(file: Uint8Array) {
  const headerLength = new DataView(file.buffer, file.byteOffset).getUint16(8, true);
  const header = Buffer.from(file.subarray(10, 10 + headerLength)).toString('latin1');
  const shape = /'shape': \(([^)]*)\)/
    .exec(header)![1]
    .split(',')
    .filter((s) => s.trim())
    .map(Number);
  return { header, headerLength, shape, data: file.subarray(10 + headerLength) };
}

describe('cutting a wide vector to the stored width', () => {
  test('keeps the first n values, scaled to unit length', () => {
    const cut = unitPrefix([3, 4, 12, 0], 2);
    expect(cut).toEqual([0.6, 0.8]);
    const long = unitPrefix(wide(7), 256);
    expect(long).toHaveLength(256);
    expect(Math.hypot(...long)).toBeCloseTo(1, 12);
    // Proportional to the prefix: the direction is unchanged.
    expect(long[5] / long[3]).toBeCloseTo(wide(7)[5] / wide(7)[3], 12);
  });
});

describe('embedding at 2048 with a sink', () => {
  test('requests 2048, stores the cut vector, keeps the full one, and stamps 256 with its source', async () => {
    const { fetchImpl, widths } = orchestrator();
    const { sink, objects } = memorySink();
    const e = embedder(fetchImpl, sink);
    const stored = new Map<number, number[]>();
    const result = await e.embed(inputs(10), {
      onVectors: async (vectors) => void vectors.forEach((v, id) => stored.set(id, v)),
    });
    expect(result.error).toBeUndefined();
    // The first workflow, its check at 256, then the second workflow only.
    expect(widths).toEqual([2048, 256, 2048]);
    expect(stored.size).toBe(10);
    for (const [id, vector] of stored) {
      expect(vector).toHaveLength(256);
      expect(vector[0]).toBeCloseTo(unitPrefix(wide(id), 256)[0], 12);
    }
    expect(result.stamp).toMatchObject({ dimensions: 256, sourceDimensions: 2048 });

    await sink.close();
    const shard = [...objects.keys()].find((k) => k.endsWith('.vectors.npy'))!;
    expect(shard).toMatch(/^wemm-2b\/r1\/p1\/d2048\//);
    const { shape, data } = readNpy(objects.get(shard)!);
    expect(shape).toEqual([10, 2048]);
    const ids = readNpy(objects.get(shard.replace('.vectors.npy', '.ids.npy'))!);
    const firstId = new DataView(ids.data.buffer, ids.data.byteOffset).getInt32(0, true);
    const first = fromHalf(new DataView(data.buffer, data.byteOffset).getUint16(0, true));
    expect(first).toBeCloseTo(wide(firstId)[0], 2);
  });

  test('refuses to keep any vector when the cut one differs from the direct 256 embed', async () => {
    // A different 256-d vector: what a model that does not nest its widths would return.
    const { fetchImpl, widths } = orchestrator((id) => unitPrefix(wide(id).slice(256), 256));
    const { sink } = memorySink();
    const e = embedder(fetchImpl, sink);
    let written = 0;
    const result = await e.embed(inputs(5), { onVectors: async (v) => void (written += v.size) });
    expect(result.error).toBeInstanceOf(ModelMismatchError);
    expect(written).toBe(0);
    expect(result.vectors.size).toBe(0);
    expect(sink.stats().buffered).toBe(0);
    // Settled for the process: the next call is refused before it submits anything.
    const again = await e.embed(inputs(5));
    expect(again.error).toBeInstanceOf(ModelMismatchError);
    expect(widths).toEqual([2048, 256]);
  });

  test('a check that cannot be made is retried a few times, then wide embeds are refused', async () => {
    // Every step at 256 fails, so no image ever embeds both ways.
    const { fetchImpl, widths } = orchestrator(() => null);
    const { sink } = memorySink();
    const e = embedder(fetchImpl, sink);
    const result = await e.embed(inputs(5));
    expect(result.error).toBeInstanceOf(PrefixCheckUnavailableError);
    expect(result.vectors.size).toBe(0);
    expect(widths).toEqual([2048, 256, 256, 256]);
    // Nothing more is paid for at this width until the cooldown ends.
    const again = await e.embed(inputs(5));
    expect(again.error).toBeInstanceOf(PrefixCheckUnavailableError);
    expect(widths).toHaveLength(4);
  });

  test('until a cut vector is checked, no second workflow may be submitted', async () => {
    const { fetchImpl } = orchestrator();
    const e = embedder(fetchImpl, memorySink().sink);
    const held = await e.budget.acquire(5);
    expect(e.submitAllowance(5)).toBe(0);
    e.budget.release(held);
    expect(e.submitAllowance(5)).toBe(5);
    await e.embed(inputs(5));
    const again = await e.budget.acquire(5);
    expect(e.submitAllowance(5)).toBe(5);
    e.budget.release(again);
  });

  test('images and videos are each checked once', async () => {
    const { fetchImpl, widths } = orchestrator();
    const e = embedder(fetchImpl, memorySink().sink);
    const mixed = [...inputs(4), { id: '5', videoUrl: 'v' }];
    const result = await e.embed(mixed);
    expect(result.error).toBeUndefined();
    expect(widths).toEqual([2048, 256, 256]);
    await e.embed([{ id: '6', videoUrl: 'v' }, ...inputs(2)]);
    expect(widths).toEqual([2048, 256, 256, 2048]);
  });

  test('while any kind is still being checked, no second workflow may be submitted', async () => {
    const base = orchestrator();
    let release: () => void = () => undefined;
    let held = false;
    // The direct 256 embed of the video is held, so its check stays pending.
    const fetchImpl = (async (u: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        steps: Array<{ name: string; input: { dimensions: number; videoUrl?: string } }>;
      };
      if (body.steps[0].input.dimensions === 256 && body.steps[0].input.videoUrl) {
        held = true;
        await new Promise<void>((r) => (release = r));
      }
      return base.fetchImpl(u, init);
    }) as unknown as typeof fetch;
    const e = embedder(fetchImpl, memorySink().sink);
    await e.embed(inputs(5));
    const video = e.embed([{ id: '9', videoUrl: 'v' }]);
    for (let i = 0; i < 200 && !held; i++) await new Promise((r) => setImmediate(r));
    expect(held).toBe(true);
    expect(e.budget.inFlight).toBeGreaterThan(0);
    expect(e.submitAllowance(5)).toBe(0);
    release();
    expect((await video).error).toBeUndefined();
    const again = await e.budget.acquire(1);
    expect(e.submitAllowance(5)).toBe(5);
    e.budget.release(again);
  });

  test('a check the orchestrator cannot answer refuses wide embeds for a while, then checks again', async () => {
    let down = true;
    const base = orchestrator();
    const fetchImpl = (async (u: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        steps: Array<{ input: { dimensions: number } }>;
      };
      if (down && body.steps[0].input.dimensions === 256) {
        base.widths.push(256);
        return new Response('', { status: 503 });
      }
      return base.fetchImpl(u, init);
    }) as unknown as typeof fetch;
    let t = 0;
    const sleeps: number[] = [];
    const e = embedder(fetchImpl, memorySink().sink, {
      now: () => t,
      sleep: async (ms) => void sleeps.push(ms),
    });
    const first = await e.embed(inputs(5));
    expect(first.error).toBeInstanceOf(PrefixCheckUnavailableError);
    expect(first.error).not.toBeInstanceOf(ModelMismatchError);
    expect(base.widths).toEqual([2048, 256, 256, 256]);
    // Spaced out, so a blip of a few seconds does not use up every attempt.
    expect(sleeps).toEqual(expect.arrayContaining([5000, 10000]));
    // Refused without paying while it cools down.
    expect((await e.embed(inputs(5))).error).toBeInstanceOf(PrefixCheckUnavailableError);
    expect(base.widths).toHaveLength(4);
    down = false;
    t += 10 * 60_000;
    const later = await e.embed(inputs(5));
    expect(later.error).toBeUndefined();
    expect(later.vectors.size).toBe(5);
    expect(base.widths.slice(4)).toEqual([2048, 256]);
  });

  test('a width the orchestrator does not honour stops wide embedding after one workflow', async () => {
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { steps: Array<{ name: string }> };
      calls++;
      return new Response(
        JSON.stringify({
          id: 'wf',
          status: 'succeeded',
          steps: body.steps.map((st) => ({
            name: st.name,
            status: 'succeeded',
            output: {
              model: 'wemm-2b',
              modelRevision: 'r1',
              profile: 'p1',
              dimensions: 1024,
              precision: 'float32',
              embedding: wide(1).slice(0, 1024),
            },
          })),
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;
    let calls = 0;
    const e = embedder(fetchImpl, memorySink().sink);
    expect((await e.embed(inputs(10))).error).toBeInstanceOf(ModelMismatchError);
    expect((await e.embed(inputs(10))).error).toBeInstanceOf(ModelMismatchError);
    expect(calls).toBe(1);
  });

  test('with no sink, it requests 256 and stores what comes back, as before', async () => {
    const { fetchImpl, widths } = orchestrator();
    const e = embedder(fetchImpl, null);
    const result = await e.embed(inputs(10));
    expect(result.error).toBeUndefined();
    expect(widths).toEqual([256, 256]);
    expect(e.sourceDimensions).toBe(256);
    expect(result.vectors.get(3)).toEqual(unitPrefix(wide(3), 256));
    expect(result.stamp).not.toHaveProperty('sourceDimensions');
  });

  test('a sink that never answers holds up no Qdrant write', async () => {
    const { fetchImpl } = orchestrator();
    const sink = new VectorSink(() => new Promise<void>(() => undefined), {
      flushEveryMs: 0,
      shardSize: 2,
      maxBuffered: 4,
    });
    const e = embedder(fetchImpl, sink);
    let written = 0;
    const result = await e.embed(inputs(10), { onVectors: async (v) => void (written += v.size) });
    expect(result.error).toBeUndefined();
    expect(written).toBe(10);
    // Bounded: the shard being written plus the buffer; the rest dropped and counted.
    const stats = sink.stats();
    expect(stats.written).toBe(0);
    expect(stats.buffered).toBeLessThanOrEqual(4 + 2);
    expect(stats.dropped).toBeGreaterThan(0);
  });
});

describe('vector sink', () => {
  test('half precision matches IEEE 754 for exact values and rounds to nearest', () => {
    expect([1, -2, 0.5, 0, 65504].map(toHalf)).toEqual([0x3c00, 0xc000, 0x3800, 0, 0x7bff]);
    expect(toHalf(1e6)).toBe(0x7c00);
    expect(toHalf(2 ** -24)).toBe(1);
    // Half an ulp: relative for normal values, 2^-25 for subnormal ones such as 1e-5.
    for (const v of [0.1, -0.333, 0.987654, 1e-5]) {
      const bound = Math.max(Math.abs(v) * 2 ** -11, 2 ** -25);
      expect(Math.abs(fromHalf(toHalf(v)) - v)).toBeLessThanOrEqual(bound);
    }
  });

  test('an exact tie rounds to the even half', () => {
    // Halfway between 1 and the next half (1 + 2^-10): even is 1.
    expect(toHalf(1 + 2 ** -11)).toBe(0x3c00);
    // Halfway between 0x3c01 and 0x3c02: even is 0x3c02.
    expect(toHalf(1 + 3 * 2 ** -11)).toBe(0x3c02);
  });

  test('a .npy header is 64-byte aligned and states the dtype and shape', () => {
    const file = npy('<f2', [3, 2048], new Uint8Array(3 * 2048 * 2));
    expect([...file.subarray(0, 8)]).toEqual([0x93, 78, 85, 77, 80, 89, 1, 0]);
    const { header, headerLength, shape } = readNpy(file);
    expect((10 + headerLength) % 64).toBe(0);
    expect(header.endsWith('\n')).toBe(true);
    expect(header).toContain("'descr': '<f2'");
    expect(shape).toEqual([3, 2048]);
    expect(readNpy(npy('<i4', [5], new Uint8Array(20))).header).toContain("'shape': (5,)");
  });

  test('a failing store is retried by later writes, counted, and bounded', async () => {
    let up = false;
    const objects: string[] = [];
    const sink = new VectorSink(
      async (key) => {
        if (!up) throw new Error('bucket down');
        objects.push(key);
      },
      { flushEveryMs: 0, shardSize: 2, maxBuffered: 6 }
    );
    for (let id = 1; id <= 20; id++) sink.add(id, [id, 0], SOURCE);
    await sink.flush();
    const down = sink.stats();
    expect(down.failedFlushes).toBeGreaterThan(0);
    expect(down.buffered).toBeLessThanOrEqual(6 + 2);
    expect(down.dropped + down.buffered).toBe(20);
    up = true;
    await sink.close();
    expect(sink.stats()).toMatchObject({ buffered: 0, written: down.buffered });
    // Two files per shard of two vectors.
    expect(objects.filter((k) => k.endsWith('.ids.npy')).length * 2).toBe(down.buffered);
  });
});

describe('vector sink writes', () => {
  test('each shard writes its vectors file before its ids file', async () => {
    const { sink, objects } = memorySink({ shardSize: 2 });
    for (let id = 1; id <= 4; id++) sink.add(id, [id, 0], SOURCE);
    await sink.close();
    const keys = [...objects.keys()];
    expect(keys).toHaveLength(4);
    for (let i = 0; i < keys.length; i += 2) {
      expect(keys[i]).toMatch(/\.vectors\.npy$/);
      expect(keys[i + 1]).toBe(keys[i].replace('.vectors.npy', '.ids.npy'));
    }
  });

  test('a write that hangs times out, counts as failed, and is retried', async () => {
    let hang = true;
    const keys: string[] = [];
    const signals: AbortSignal[] = [];
    const sink = new VectorSink(
      async (key, _body, signal) => {
        signals.push(signal);
        if (hang) return new Promise<void>(() => undefined);
        keys.push(key);
      },
      { flushEveryMs: 0, shardSize: 2, putTimeoutMs: 20 }
    );
    sink.add(1, [1, 0], SOURCE);
    sink.add(2, [2, 0], SOURCE);
    await sink.flush();
    expect(sink.stats()).toMatchObject({ failedFlushes: 1, written: 0, buffered: 2 });
    // The request itself is aborted, not only abandoned.
    expect(signals[0].aborted).toBe(true);
    hang = false;
    await sink.close();
    expect(sink.stats()).toMatchObject({ written: 2, buffered: 0 });
    expect(keys).toHaveLength(2);
  });

  test('an id that does not fit the int32 ids file is dropped and counted', () => {
    const { sink } = memorySink();
    sink.add(2 ** 31, [1, 0], SOURCE);
    sink.add(2 ** 31 - 1, [1, 0], SOURCE);
    expect(sink.stats()).toMatchObject({ dropped: 1, buffered: 1 });
  });

  test('images and videos go to separate shards under their own profile', async () => {
    const { sink, objects } = memorySink();
    sink.add(1, [1, 0], { ...SOURCE, profile: 'image-p' });
    sink.add(2, [2, 0], { ...SOURCE, profile: 'video-p' });
    await sink.close();
    const ids = [...objects.entries()]
      .filter(([k]) => k.endsWith('.ids.npy'))
      .map(([k, body]) => [k.split('/')[2], readNpy(body).shape[0]]);
    expect(ids.sort()).toEqual([
      ['image-p', 1],
      ['video-p', 1],
    ]);
  });

  test('the shard being written is never the one the buffer bound drops', async () => {
    let release: () => void = () => undefined;
    let first = true;
    const writtenIds: number[] = [];
    const sink = new VectorSink(
      async (key, body) => {
        if (first) {
          first = false;
          await new Promise<void>((r) => (release = r));
        }
        if (key.endsWith('.ids.npy')) {
          const view = new DataView(body.buffer, body.byteOffset);
          const header = view.getUint16(8, true);
          for (let o = 10 + header; o < body.length; o += 4)
            writtenIds.push(view.getInt32(o, true));
        }
      },
      { flushEveryMs: 0, shardSize: 2, maxBuffered: 4 }
    );
    // A partial first shard, held mid-write, so it differs in size from the full ones behind it.
    sink.add(1, [1, 0], SOURCE);
    void sink.flush(true);
    for (let id = 2; id <= 13; id++) sink.add(id, [id, 0], SOURCE);
    release();
    await sink.close();
    // The held shard is kept and written; the bound drops the oldest after it, leaving the newest.
    expect(writtenIds).toEqual([1, 12, 13]);
    expect(sink.stats()).toMatchObject({ written: 3, dropped: 10, buffered: 0 });
  });
});

describe('model stamp with a source width', () => {
  function store(metadata: Record<string, unknown>) {
    const client = {
      getCollection: async () => ({ config: { metadata: { ...metadata } } }),
      updateCollection: async (
        _n: string,
        { metadata: m }: { metadata: Record<string, unknown> }
      ) => void Object.assign(metadata, m),
    };
    return new VectorStore(client as unknown as QdrantClient, 'c');
  }
  const got = {
    model: 'wemm-2b',
    modelRevision: 'r1',
    profile: 'p1',
    dimensions: 256,
    sourceDimensions: 2048,
  };

  test('the first fill records it; a collection already filled keeps its own', async () => {
    const fresh: Record<string, unknown> = { model: 'wemm-2b', dimensions: 256 };
    await store(fresh).assertModel(got);
    expect(fresh).toMatchObject({ dimensions: 256, sourceDimensions: 2048, modelRevision: 'r1' });

    const filled: Record<string, unknown> = { ...got, sourceDimensions: undefined };
    await store(filled).assertModel(got);
    expect(filled.sourceDimensions).toBeUndefined();
  });
});
