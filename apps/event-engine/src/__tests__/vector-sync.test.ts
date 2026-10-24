// Fakes stand in for Postgres, Qdrant and the orchestrator; what is under test is the decision
// each makes reach (embed, delete, payload write, retry), which is what a caller would notice.
import type { Pool } from 'pg';
import { describe, expect, test, vi } from 'vitest';
import { inWindow, parseWindow, runBackfill } from '@/vector-sync/backfill';
import type { RunState } from '@/vector-sync/cursor';
import { imageIdFromEvent, VectorSyncQueue } from '@/vector-sync/consumer';
import { ModelMismatchError, VectorStore } from '@/vector-sync/qdrant';
import type { QdrantClient } from '@qdrant/js-client-rest';
import { buildEmbedInput, chunkInputs, Embedder, MixedStampError } from '@/vector-sync/embedder';
import {
  eligibleSql,
  IMAGE_ROW_COLUMNS,
  isEligible,
  type ImageRow,
} from '@/vector-sync/eligibility';
import type { ModelStamp, VectorPoint } from '@/vector-sync/qdrant';
import type { ImagePayload } from '@/vector-sync/source';
import { reconcile } from '@/vector-sync/reconcile';
import { syncImageIds } from '@/vector-sync/sync';

function imageRow(id: number, patch: Partial<ImageRow> = {}): ImageRow {
  return {
    id,
    url: `key-${id}`,
    type: 'image',
    nsfwLevel: 1,
    userId: 7,
    postId: 70,
    sortAt: new Date('2026-10-01T00:00:00Z'),
    ingestion: 'Scanned',
    tosViolation: false,
    blockedFor: null,
    needsReview: null,
    minor: false,
    poi: false,
    sizeKB: 100,
    width: 1024,
    height: 1024,
    duration: null,
    ...patch,
  };
}

/** Answers the queries in vector-sync/source.ts and reconcile.ts from in-memory rows. */
class FakePg {
  images = new Map<number, ImageRow>();
  tags = new Map<number, number[]>();
  baseModels = new Map<number, string[]>();
  queries: string[] = [];

  put(...rows: ImageRow[]) {
    for (const row of rows) this.images.set(row.id, row);
    return this;
  }

  query = async (sql: string, params: unknown[]): Promise<{ rows: unknown[] }> => {
    this.queries.push(sql);
    if (sql.includes('"TagsOnImageDetails"')) {
      const ids = params[0] as number[];
      return {
        rows: ids
          .filter((id) => this.tags.has(id))
          .map((imageId) => ({ imageId, tagIds: this.tags.get(imageId) })),
      };
    }
    if (sql.includes('"ImageResourceNew"')) {
      const ids = params[0] as number[];
      return {
        rows: ids
          .filter((id) => this.baseModels.has(id))
          .map((imageId) => ({ imageId, baseModels: this.baseModels.get(imageId) })),
      };
    }
    if (sql.includes('i.id = ANY')) {
      const ids = params[0] as number[];
      return { rows: ids.filter((id) => this.images.has(id)).map((id) => this.images.get(id)) };
    }
    if (sql.includes('i.id >= $1 AND i.id < $2')) {
      const [lo, hi] = params as number[];
      return {
        rows: [...this.images.values()]
          .filter((r) => r.id >= lo && r.id < hi)
          .sort((a, b) => b.id - a.id),
      };
    }
    throw new Error(`FakePg: unexpected query ${sql}`);
  };
}

class FakeStore {
  points = new Map<number, { vector: number[]; payload: ImagePayload }>();
  deletes: number[][] = [];
  payloadWrites: Map<number, ImagePayload>[] = [];
  stamps: ModelStamp[] = [];
  /** Runs after an upsert lands, to simulate a concurrent change. */
  afterUpsert?: () => void;

  existing = async (ids: number[]) => new Set(ids.filter((id) => this.points.has(id)));
  delete = async (ids: number[]) => {
    if (ids.length) this.deletes.push(ids);
    for (const id of ids) this.points.delete(id);
  };
  setPayloads = async (payloads: Map<number, ImagePayload>) => {
    if (payloads.size) this.payloadWrites.push(payloads);
    for (const [id, payload] of payloads) {
      const point = this.points.get(id);
      if (!point) throw new Error(`no point ${id}`);
      point.payload = payload;
    }
  };
  upsert = async (points: VectorPoint[]) => {
    for (const p of points) this.points.set(p.id, { vector: p.vector, payload: p.payload });
    this.afterUpsert?.();
  };
  assertModel = async (stamp: ModelStamp) => void this.stamps.push(stamp);
  stamped = true;
  isStamped = async () => this.stamped;
  idsInRange = async (lo: number, hi: number) =>
    [...this.points.keys()].filter((id) => id >= lo && id < hi).sort((a, b) => a - b);
}

const STAMP: ModelStamp = { model: 'wemm-2b', modelRevision: 'r1', profile: 'p1', dimensions: 256 };

class FakeEmbedder {
  calls: string[][] = [];
  /** Ids this embedder fails to return, reporting a systemic error, as a batch out of retries would. */
  dropIds = new Set<number>();
  embed = async (
    inputs: { id: string }[],
    { acceptStamp }: { acceptStamp?: (stamp: ModelStamp) => Promise<void> } = {}
  ) => {
    this.calls.push(inputs.map((i) => i.id));
    // Same contract as Embedder: a rejected stamp is reported in `error`, with no vectors.
    try {
      await acceptStamp?.(STAMP);
    } catch (error) {
      return { vectors: new Map<number, number[]>(), failed: [], stamp: null, error };
    }
    const kept = inputs.filter((i) => !this.dropIds.has(Number(i.id)));
    return {
      vectors: new Map(kept.map((i) => [Number(i.id), [Number(i.id)]])),
      failed: [],
      stamp: STAMP,
      error: kept.length < inputs.length ? new Error('503 out of retries') : undefined,
    };
  };
}

/** An in-memory lease with the same contract as the Redis one. */
function memoryLease() {
  let holder: string | null = null;
  return {
    acquireLease: async (owner: string, _ttlMs?: number) => {
      if (holder && holder !== owner) return false;
      holder = owner;
      return true;
    },
    renewLease: async (owner: string) => holder === owner,
    releaseLease: async (owner: string) => {
      if (holder === owner) holder = null;
    },
  };
}

function deps(pg: FakePg, store: FakeStore, embedder: FakeEmbedder | null = new FakeEmbedder()) {
  // FakePg answers only the queries vector-sync makes, not pg's full overload set.
  return { pg: pg as unknown as Pool, store, embedder };
}

describe('eligibility', () => {
  const ineligible: Array<[string, Partial<ImageRow>]> = [
    ['unscanned', { ingestion: 'Pending' }],
    ['blocked ingestion', { ingestion: 'Blocked' }],
    ['tos violation', { tosViolation: true }],
    ['blocked', { blockedFor: 'moderated' }],
    ['no post', { postId: null }],
    ['needs review', { needsReview: 'poi' }],
    ['minor', { minor: true }],
    ['poi', { poi: true }],
  ];

  test('a scanned, posted, unflagged image is eligible', () => {
    expect(isEligible(imageRow(1))).toBe(true);
  });

  test.each(ineligible)('%s is not eligible', (_name, patch) => {
    expect(isEligible(imageRow(1, patch))).toBe(false);
  });

  test('the SQL predicate names every rule the row check applies', () => {
    expect(eligibleSql('i')).toBe(
      `i."ingestion" = 'Scanned' AND i."tosViolation" = false AND i."blockedFor" IS NULL AND i."postId" IS NOT NULL AND i."needsReview" IS NULL AND i."minor" = false AND i."poi" = false`
    );
  });
});

describe('sync transitions', () => {
  test('an unscanned insert is not embedded', async () => {
    const pg = new FakePg().put(imageRow(1, { ingestion: 'Pending' }));
    const store = new FakeStore();
    const embedder = new FakeEmbedder();
    const stats = await syncImageIds([1], deps(pg, store, embedder));
    expect(embedder.calls).toEqual([]);
    expect(store.points.size).toBe(0);
    expect(store.deletes).toEqual([]);
    expect(stats.embedded).toBe(0);
  });

  test('the scan completing embeds it, with its payload', async () => {
    const pg = new FakePg().put(imageRow(1, { ingestion: 'Pending' }));
    pg.tags.set(1, [5, 9]);
    pg.baseModels.set(1, ['SDXL 1.0']);
    const store = new FakeStore();
    const embedder = new FakeEmbedder();
    await syncImageIds([1], deps(pg, store, embedder));
    pg.put(imageRow(1, { ingestion: 'Scanned', nsfwLevel: 4 }));
    const stats = await syncImageIds([1], deps(pg, store, embedder));

    expect(embedder.calls).toEqual([['1']]);
    expect(stats.embedded).toBe(1);
    expect(store.points.get(1)?.payload).toEqual({
      nsfwLevel: 4,
      tagIds: [5, 9],
      baseModels: ['SDXL 1.0'],
      type: 'image',
      userId: 7,
      postId: 70,
      sortAt: '2026-10-01T00:00:00.000Z',
    });
    expect(store.stamps).toEqual([STAMP]);
  });

  test('blocking an embedded image deletes its point and embeds nothing', async () => {
    const pg = new FakePg().put(imageRow(1));
    const store = new FakeStore();
    const embedder = new FakeEmbedder();
    await syncImageIds([1], deps(pg, store, embedder));
    expect(store.points.has(1)).toBe(true);

    pg.put(imageRow(1, { blockedFor: 'moderated' }));
    const stats = await syncImageIds([1], deps(pg, store, embedder));
    expect(store.points.has(1)).toBe(false);
    expect(stats.deleted).toBe(1);
    expect(embedder.calls).toHaveLength(1);
  });

  test('a deleted image row deletes its point', async () => {
    const pg = new FakePg().put(imageRow(1));
    const store = new FakeStore();
    await syncImageIds([1], deps(pg, store));
    pg.images.delete(1);
    await syncImageIds([1], deps(pg, store));
    expect(store.points.has(1)).toBe(false);
  });

  test('an nsfwLevel or tag change on an embedded image rewrites the payload without re-embedding', async () => {
    const pg = new FakePg().put(imageRow(1, { nsfwLevel: 1 }));
    const store = new FakeStore();
    const embedder = new FakeEmbedder();
    await syncImageIds([1], deps(pg, store, embedder));

    pg.put(imageRow(1, { nsfwLevel: 8 }));
    pg.tags.set(1, [42]);
    const stats = await syncImageIds([1], deps(pg, store, embedder));
    expect(embedder.calls).toHaveLength(1);
    expect(stats.updated).toBe(1);
    expect(store.points.get(1)?.payload).toMatchObject({ nsfwLevel: 8, tagIds: [42] });
  });

  test('with embedding switched off, eligible images are counted, not embedded; deletes still apply', async () => {
    const pg = new FakePg().put(imageRow(1), imageRow(2, { tosViolation: true }));
    const store = new FakeStore();
    store.points.set(2, { vector: [2], payload: {} as ImagePayload });
    const stats = await syncImageIds([1, 2], deps(pg, store, null));
    expect(store.points.has(1)).toBe(false);
    expect(store.points.has(2)).toBe(false);
    expect(stats.embedOff).toBe(1);
  });

  test('an image blocked while its embed was in flight is deleted again after the upsert', async () => {
    const pg = new FakePg().put(imageRow(1));
    const store = new FakeStore();
    store.afterUpsert = () => pg.put(imageRow(1, { tosViolation: true }));
    const stats = await syncImageIds([1], deps(pg, store));
    expect(store.points.has(1)).toBe(false);
    expect(stats.embedded).toBe(0);
  });

  test('videos are skipped and counted while video embedding is off', async () => {
    const pg = new FakePg().put(imageRow(1, { type: 'video' }), imageRow(2));
    const store = new FakeStore();
    const embedder = new FakeEmbedder();
    const stats = await syncImageIds([1, 2], deps(pg, store, embedder));
    expect(embedder.calls).toEqual([['2']]);
    expect(stats.skipped).toEqual({ 'video-disabled': 1 });
  });
});

describe('embed inputs', () => {
  test('an image is sent as a 512px edge variant; an absolute URL is not sent', () => {
    const opts = { imageLocation: 'https://cdn.example', embedVideo: false };
    expect(buildEmbedInput(imageRow(1, { url: 'abc-123' }), opts)).toEqual({
      input: { id: '1', imageUrl: 'https://cdn.example/abc-123/width=512/abc-123.jpeg' },
    });
    expect(buildEmbedInput(imageRow(1, { url: 'https://elsewhere.example/a.png' }), opts)).toEqual({
      skip: 'external-url',
    });
  });

  test('a video over 60 seconds is skipped when video embedding is on', () => {
    const opts = { imageLocation: 'https://cdn.example', embedVideo: true };
    expect(buildEmbedInput(imageRow(1, { type: 'video', duration: 61 }), opts)).toEqual({
      skip: 'video-too-long',
    });
    expect(buildEmbedInput(imageRow(1, { type: 'video', duration: 10, url: 'v' }), opts)).toEqual({
      input: { id: '1', videoUrl: 'https://cdn.example/v/original=true/v.mp4' },
    });
  });

  test('batches hold at most 128 inputs and 8 videos', () => {
    const images = Array.from({ length: 300 }, (_, i) => ({ id: String(i), imageUrl: 'x' }));
    expect(chunkInputs(images).map((b) => b.length)).toEqual([128, 128, 44]);
    const videos = Array.from({ length: 20 }, (_, i) => ({ id: String(i), videoUrl: 'x' }));
    expect(chunkInputs(videos).map((b) => b.length)).toEqual([8, 8, 4]);
    // VECTOR_EMBED_BATCH_SIZE=1 must be env-only if the orchestrator moves to one input per job.
    expect(chunkInputs(images.slice(0, 3), 1).map((b) => b.length)).toEqual([1, 1, 1]);
  });
});

describe('embedder', () => {
  const ok = (ids: string[]) =>
    new Response(
      JSON.stringify({
        id: 'wf',
        status: 'succeeded',
        steps: [
          {
            output: { ...STAMP, data: ids.map((id, index) => ({ id, index, embedding: [index] })) },
          },
        ],
      }),
      { status: 200 }
    );
  const idsOf = (init?: RequestInit) =>
    (JSON.parse(String(init?.body)).steps[0].input.inputs as { id: string }[]).map((i) => i.id);

  function embedder(fetchImpl: typeof fetch, maxRetries = 3) {
    const sleeps: number[] = [];
    const e = new Embedder({
      endpoint: 'http://orch',
      token: 't',
      maxInFlight: 2,
      maxRetries,
      priority: 'low',
      fetch: fetchImpl,
      sleep: async (ms) => void sleeps.push(ms),
    });
    return { e, sleeps };
  }

  test('backs off on 429, honouring Retry-After, then succeeds with the same idempotency key', async () => {
    const keys: string[] = [];
    let calls = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      keys.push(JSON.parse(String(init?.body)).externalId);
      if (++calls <= 2)
        return new Response('queue full', { status: 429, headers: { 'retry-after': '7' } });
      return ok(idsOf(init));
    }) as unknown as typeof fetch;
    const { e, sleeps } = embedder(fetchImpl);
    const result = await e.embed([{ id: '1', imageUrl: 'u' }]);
    expect(result.vectors.get(1)).toEqual([0]);
    expect(sleeps).toHaveLength(2);
    expect(Math.min(...sleeps)).toBeGreaterThanOrEqual(7000);
    expect(new Set(keys).size).toBe(1);
  });

  test('gives up after maxRetries rather than retrying forever', async () => {
    const fetchImpl = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    const { e, sleeps } = embedder(fetchImpl, 2);
    const result = await e.embed([{ id: '1', imageUrl: 'u' }]);
    expect(String(result.error)).toMatch(/gave up after 3 attempts/);
    expect(sleeps).toHaveLength(2);
  });

  test('a rejected batch is split until the bad input is isolated; the rest still embed', async () => {
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const ids = idsOf(init);
      if (ids.includes('3')) return new Response('bad imageUrl', { status: 400 });
      return ok(ids);
    }) as unknown as typeof fetch;
    const { e } = embedder(fetchImpl);
    const result = await e.embed(['1', '2', '3', '4'].map((id) => ({ id, imageUrl: 'u' })));
    expect([...result.vectors.keys()].sort()).toEqual([1, 2, 4]);
    expect(result.failed).toEqual([3]);
  });

  test('an auth failure stops the run instead of being bisected', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('', { status: 401 })
    ) as unknown as typeof fetch;
    const { e } = embedder(fetchImpl);
    const result = await e.embed(['1', '2'].map((id) => ({ id, imageUrl: 'u' })));
    expect(String(result.error)).toMatch(/401/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('consumer', () => {
  test('reads the image id from each topic, including deletes, and ignores snapshot reads', () => {
    expect(imageIdFromEvent('postgres.Image', { op: 'u', before: null, after: { id: 5 } })).toBe(5);
    expect(imageIdFromEvent('postgres.Image', { op: 'd', before: { id: 6 }, after: null })).toBe(6);
    expect(
      imageIdFromEvent('postgres.TagsOnImageNew', {
        op: 'd',
        before: { imageId: 7, tagId: 1 },
        after: null,
      })
    ).toBe(7);
    expect(
      imageIdFromEvent('postgres.ImageResourceNew', {
        op: 'c',
        before: null,
        after: { imageId: 8 },
      })
    ).toBe(8);
    expect(imageIdFromEvent('postgres.Image', { op: 'r', after: { id: 9 } })).toBeNull();
  });

  test('a burst of events for one image is one sync; offsets commit only after a flush succeeds', async () => {
    const pg = new FakePg().put(imageRow(1));
    const store = new FakeStore();
    const embedder = new FakeEmbedder();
    const commits: unknown[] = [];
    const queue = new VectorSyncQueue(deps(pg, store, embedder), async (o) => void commits.push(o));

    const failing = vi.spyOn(store, 'existing').mockRejectedValueOnce(new Error('qdrant down'));
    for (let offset = 0; offset < 30; offset++)
      queue.add(1, { topic: 'postgres.TagsOnImageNew', partition: 0, offset: String(offset) });
    await expect(queue.flush()).rejects.toThrow('qdrant down');
    expect(commits).toEqual([]);
    failing.mockRestore();

    await queue.flush();
    expect(embedder.calls).toEqual([['1']]);
    expect(commits).toEqual([[{ topic: 'postgres.TagsOnImageNew', partition: 0, offset: '30' }]]);
  });
});

describe('backfill', () => {
  function memoryState(
    cursor: number | null = null
  ): RunState & { cursor: number | null; paused: boolean } {
    const s = {
      cursor,
      paused: false,
      getCursor: async () => s.cursor,
      setCursor: async (id: number) => void (s.cursor = id),
      isPaused: async () => s.paused,
      setPaused: async (p: boolean) => void (s.paused = p),
      reset: async () => void (s.cursor = null),
      close: async () => undefined,
      ...memoryLease(),
    };
    return s;
  }

  test('embeds eligible images at or below the watermark, newest first, and finishes at the floor', async () => {
    const pg = new FakePg().put(
      ...Array.from({ length: 30 }, (_, i) =>
        imageRow(i + 1, { ingestion: i % 3 ? 'Scanned' : 'Pending' })
      )
    );
    const store = new FakeStore();
    const embedder = new FakeEmbedder();
    const state = memoryState();
    const result = await runBackfill(
      { watermark: 25, floor: 0, span: 10, pages: 2 },
      { ...deps(pg, store, embedder), state }
    );

    const embedded = [...store.points.keys()].sort((a, b) => a - b);
    expect(embedded).toEqual(
      Array.from({ length: 25 }, (_, i) => i + 1).filter((id) => (id - 1) % 3 !== 0)
    );
    expect(embedded.some((id) => id > 25)).toBe(false);
    // 25 is unscanned in this fixture, so the newest eligible is 24.
    expect(Math.max(...embedder.calls[0].map(Number))).toBe(24);
    expect(result.done).toBe(true);
    expect(state.cursor).toBe(0);
  });

  test('resumes from the stored cursor without re-reading pages above it', async () => {
    const pg = new FakePg().put(...Array.from({ length: 30 }, (_, i) => imageRow(i + 1)));
    const store = new FakeStore();
    const state = memoryState(11);
    await runBackfill(
      { watermark: 30, floor: 0, span: 10, pages: 1 },
      { ...deps(pg, store), state }
    );
    expect([...store.points.keys()].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 10 }, (_, i) => i + 1)
    );
  });

  test('a dry run writes nothing and leaves the cursor alone', async () => {
    const pg = new FakePg().put(imageRow(1), imageRow(2));
    const store = new FakeStore();
    const embedder = new FakeEmbedder();
    const state = memoryState();
    const result = await runBackfill(
      { watermark: 2, floor: 0, span: 10, pages: 1 },
      { ...deps(pg, store, embedder), state, dryRun: true }
    );
    expect(result.embedded).toBe(2);
    expect(store.points.size).toBe(0);
    expect(embedder.calls).toEqual([]);
    expect(state.cursor).toBeNull();
  });

  test('stops near --limit and keeps the cursor where it stopped', async () => {
    const pg = new FakePg().put(...Array.from({ length: 100 }, (_, i) => imageRow(i + 1)));
    const store = new FakeStore();
    const state = memoryState();
    const result = await runBackfill(
      { watermark: 100, floor: 0, span: 10, pages: 1, limit: 20 },
      { ...deps(pg, store), state }
    );
    expect(store.points.size).toBe(20);
    expect(result.done).toBe(false);
    expect(state.cursor).toBe(81);
  });

  test('a paused run starts no pages until resumed', async () => {
    const pg = new FakePg().put(imageRow(1));
    const store = new FakeStore();
    const state = memoryState();
    state.paused = true;
    let waits = 0;
    await runBackfill(
      { watermark: 1, floor: 0, span: 10, pages: 1 },
      {
        ...deps(pg, store),
        state,
        sleep: async () => {
          if (++waits === 3) state.paused = false;
        },
      }
    );
    expect(waits).toBe(3);
    expect(store.points.has(1)).toBe(true);
  });
});

describe('review round 5', () => {
  test('a resume takes deferred ids a few hundred at a time, so deletes are not held behind them', async () => {
    const pg = new FakePg();
    for (let id = 1; id <= 2000; id++) pg.put(imageRow(id));
    const store = new FakeStore();
    const embedder = new FakeEmbedder();
    const queue = new VectorSyncQueue(deps(pg, store, embedder), async () => undefined);
    queue.setGate('paused');
    for (let id = 1; id <= 2000; id++)
      queue.add(id, { topic: 'postgres.Image', partition: 0, offset: String(id) });
    await queue.flush();
    expect(queue.deferred.size).toBe(2000);

    queue.setGate(null);
    queue.add(null, { topic: 'postgres.Image', partition: 0, offset: '2001' });
    await queue.flush();
    expect(embedder.calls.flat()).toHaveLength(512);
    expect(queue.deferred.size).toBe(2000 - 512);
  });

  test('a backfill waits while the connector check fails and resumes when it passes', async () => {
    const pg = new FakePg().put(...Array.from({ length: 10 }, (_, i) => imageRow(i + 1)));
    const store = new FakeStore();
    let checks = 0;
    let cursor: number | null = null;
    const state: RunState = {
      getCursor: async () => cursor,
      setCursor: async (id) => void (cursor = id),
      isPaused: async () => false,
      setPaused: async () => undefined,
      reset: async () => undefined,
      close: async () => undefined,
      ...memoryLease(),
    };
    const pointsWhileBlocked: number[] = [];
    await runBackfill(
      { watermark: 10, floor: 0, span: 5, pages: 1 },
      {
        ...deps(pg, store),
        state,
        sleep: async () => undefined,
        gateEveryMs: 0,
        gateCheck: async () => {
          checks++;
          if (checks <= 3) {
            pointsWhileBlocked.push(store.points.size);
            return 'the connector does not stream public.Image';
          }
          return null;
        },
      }
    );
    expect(pointsWhileBlocked).toEqual([0, 0, 0]);
    expect(store.points.size).toBe(10);
  });
});

describe('collection layout', () => {
  // Decision: every payload index lives on disk. The Qdrant node's RAM is budgeted for the int8
  // vectors; indexes in RAM would add tens of GB at full size. Do not drop on_disk to speed up a
  // filter without re-doing that budget.
  test('bootstrap creates every payload index on disk', async () => {
    const created: Array<{ field_name: string; field_schema: { on_disk?: boolean } }> = [];
    const client = {
      collectionExists: async () => ({ exists: true }),
      getCollection: async () => ({ payload_schema: {}, config: {} }),
      createPayloadIndex: async (_c: string, args: (typeof created)[number]) =>
        void created.push(args),
      getAliases: async () => ({
        aliases: [{ alias_name: 'images_semantic', collection_name: 'c' }],
      }),
    };
    await new VectorStore(client as unknown as QdrantClient, 'c').bootstrap({
      alias: 'images_semantic',
    });
    expect(created.map((c) => c.field_name).sort()).toEqual(
      ['baseModels', 'nsfwLevel', 'postId', 'sortAt', 'tagIds', 'type', 'userId'].sort()
    );
    expect(created.every((c) => c.field_schema.on_disk === true)).toBe(true);
    // userId is only an exclusion and postId is not a search filter: no HNSW links for them.
    const noHnsw = created.filter(
      (c) => (c.field_schema as { enable_hnsw?: boolean }).enable_hnsw === false
    );
    expect(noHnsw.map((c) => c.field_name).sort()).toEqual(['postId', 'userId']);
  });
});

describe('backfill lease', () => {
  test('a second run of the same backfill refuses to start while the first holds the lease', async () => {
    const pg = new FakePg().put(...Array.from({ length: 20 }, (_, i) => imageRow(i + 1)));
    const store = new FakeStore();
    let cursor: number | null = null;
    const lease = memoryLease();
    const state: RunState = {
      getCursor: async () => cursor,
      setCursor: async (id) => void (cursor = id),
      isPaused: async () => false,
      setPaused: async () => undefined,
      reset: async () => undefined,
      close: async () => undefined,
      ...lease,
    };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slowPg = new FakePg().put(...pg.images.values());
    const base = slowPg.query;
    slowPg.query = (async (sql: string, params: unknown[]) => {
      await gate;
      return base(sql, params);
    }) as FakePg['query'];
    const first = runBackfill(
      { watermark: 20, floor: 0, span: 10, pages: 1 },
      { ...deps(slowPg, store), state }
    );
    await expect(
      runBackfill({ watermark: 20, floor: 0, span: 10, pages: 1 }, { ...deps(pg, store), state })
    ).rejects.toThrow(/holds its lease/);
    release();
    await first;
    expect(store.points.size).toBe(20);
    // Released at the end, so a later run may start.
    expect(await lease.acquireLease('next', 1000)).toBe(true);
  });
});

describe('reconcile', () => {
  test('embeds eligible ids missing from Qdrant and deletes points that are no longer eligible', async () => {
    const pg = new FakePg().put(imageRow(1), imageRow(2), imageRow(3, { minor: true }));
    const base = pg.query;
    pg.query = (async (sql: string, params: unknown[]) => {
      if (sql.startsWith('SELECT i.id FROM "Image" i WHERE i.id >= $1')) {
        const [lo, hi] = params as number[];
        return {
          rows: [...pg.images.values()]
            .filter((r) => r.id >= lo && r.id < hi && isEligible(r))
            .map((r) => ({ id: r.id })),
        };
      }
      return base(sql, params);
    }) as FakePg['query'];
    const store = new FakeStore();
    store.points.set(2, { vector: [2], payload: {} as ImagePayload });
    store.points.set(3, { vector: [3], payload: {} as ImagePayload });

    const result = await reconcile({ from: 0, to: 10, bucket: 5 }, deps(pg, store));
    expect([...store.points.keys()].sort()).toEqual([1, 2]);
    expect(result).toMatchObject({ buckets: 2, drifted: 1, missing: 1, extra: 1 });
  });
});

describe('Image CDC gate', () => {
  // Adding a table to the connector changes the database publication, and the watcher recreates
  // the connector when the list differs. Default off keeps a deploy of this code a no-op there.
  async function load(env: Record<string, string | undefined>) {
    vi.resetModules();
    const saved = { ...process.env };
    Object.assign(process.env, env);
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
    try {
      const { DebeziumManager } = await import('@/services/debezium-manager');
      return {
        connector: DebeziumManager.getConnectorTables(),
        watcher: DebeziumManager.getTopicsToConsume(),
      };
    } finally {
      process.env = saved;
    }
  }

  test('off by default: the connector streams exactly the watcher tables', async () => {
    const { connector, watcher } = await load({ CDC_IMAGE_ENABLED: undefined });
    expect(connector).not.toContain('public.Image');
    expect(connector.map((t) => `postgres.${t.replace('public.', '')}`)).toEqual(watcher);
  });

  test('on: the connector adds Image, and the metrics watcher still does not consume it', async () => {
    const { connector, watcher } = await load({ CDC_IMAGE_ENABLED: 'true' });
    expect(connector).toContain('public.Image');
    expect(watcher).not.toContain('postgres.Image');
  });
});

describe('review round: paid-path failure modes', () => {
  test('an nsfwLevel change during an in-flight embed ends up in the payload, not the stale value', async () => {
    const pg = new FakePg().put(imageRow(1, { nsfwLevel: 1 }));
    const store = new FakeStore();
    store.afterUpsert = () => {
      pg.put(imageRow(1, { nsfwLevel: 16 }));
      pg.tags.set(1, [99]);
    };
    await syncImageIds([1], deps(pg, store));
    expect(store.points.get(1)?.payload).toMatchObject({ nsfwLevel: 16, tagIds: [99] });
  });

  test('when one batch fails, the vectors that succeeded are stored, and the retry pays only for the rest', async () => {
    const pg = new FakePg().put(imageRow(1), imageRow(2));
    const store = new FakeStore();
    const embedder = new FakeEmbedder();
    embedder.dropIds.add(2);
    await expect(syncImageIds([1, 2], deps(pg, store, embedder))).rejects.toThrow('503');
    expect(store.points.has(1)).toBe(true);

    embedder.dropIds.clear();
    await syncImageIds([1, 2], deps(pg, store, embedder));
    expect(embedder.calls).toEqual([['1', '2'], ['2']]);
  });

  test('a model mismatch stops the consumer embedding instead of paying for it every tick', async () => {
    const pg = new FakePg().put(imageRow(1));
    const store = new FakeStore();
    store.assertModel = async () => {
      throw new ModelMismatchError(STAMP, { ...STAMP, modelRevision: 'r2' });
    };
    const embedder = new FakeEmbedder();
    const commits: unknown[] = [];
    const queue = new VectorSyncQueue(deps(pg, store, embedder), async (o) => void commits.push(o));
    queue.add(1, { topic: 'postgres.Image', partition: 0, offset: '0' });
    await expect(queue.flush()).rejects.toThrow(ModelMismatchError);
    await queue.flush();
    await queue.flush();
    expect(embedder.calls).toHaveLength(1);
    expect(store.points.has(1)).toBe(false);
    expect(commits).toHaveLength(1);
  });

  const okBody = (ids: string[], modelRevision = 'r1') =>
    JSON.stringify({
      id: 'wf',
      status: 'succeeded',
      steps: [
        {
          output: {
            ...STAMP,
            modelRevision,
            data: ids.map((id, index) => ({ id, index, embedding: [index] })),
          },
        },
      ],
    });
  const inputIds = (init?: RequestInit) =>
    (JSON.parse(String(init?.body)).steps[0].input.inputs as { id: string }[]).map((i) => i.id);
  const makeEmbedder = (fetchImpl: typeof fetch) =>
    new Embedder({
      endpoint: 'http://orch',
      token: 't',
      maxInFlight: 1,
      maxRetries: 0,
      priority: 'low',
      fetch: fetchImpl,
      sleep: async () => undefined,
    });

  test('batches that come back under different model revisions in one call are not mixed', async () => {
    let n = 0;
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) =>
      new Response(okBody(inputIds(init), ++n === 1 ? 'r1' : 'r2'), {
        status: 200,
      })) as unknown as typeof fetch;
    const inputs = Array.from({ length: 200 }, (_, i) => ({ id: String(i), imageUrl: 'u' }));
    const result = await makeEmbedder(fetchImpl).embed(inputs);
    expect(result.error).toBeInstanceOf(MixedStampError);
    expect(result.vectors.size).toBe(128);
  });

  test('a batch where every input is rejected is split a bounded number of times', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('schema rejected', { status: 400 })
    ) as unknown as typeof fetch;
    const inputs = Array.from({ length: 128 }, (_, i) => ({ id: String(i), imageUrl: 'u' }));
    const result = await makeEmbedder(fetchImpl).embed(inputs);
    expect(result.failed).toHaveLength(128);
    // Depth 4: 1 + 2 + 4 + 8 + 16 submissions, against 255 if split down to single inputs.
    expect(fetchImpl).toHaveBeenCalledTimes(31);
  });

  test('a backfill page that keeps failing stops the run with the cursor above it', async () => {
    const pg = new FakePg().put(...Array.from({ length: 40 }, (_, i) => imageRow(i + 1)));
    const base = pg.query;
    pg.query = (async (sql: string, params: unknown[]) => {
      // The page [21, 31) always fails; the page above it finishes later than its neighbour.
      if (sql.includes('i.id >= $1 AND i.id < $2') && params[0] === 21) throw new Error('pg down');
      if (sql.includes('i.id >= $1 AND i.id < $2') && params[0] === 31) {
        await new Promise((r) => setTimeout(r, 20));
      }
      return base(sql, params);
    }) as FakePg['query'];
    const store = new FakeStore();
    let cursor: number | null = null;
    const state: RunState = {
      getCursor: async () => cursor,
      setCursor: async (id) => void (cursor = id),
      isPaused: async () => false,
      setPaused: async () => undefined,
      reset: async () => undefined,
      close: async () => undefined,
      ...memoryLease(),
    };
    await expect(
      runBackfill(
        { watermark: 40, floor: 0, span: 10, pages: 2 },
        { ...deps(pg, store), state, sleep: async () => undefined }
      )
    ).rejects.toThrow('pg down');
    expect(cursor).toBe(31);
  });
});

describe('embedding gate', () => {
  const connector = (tables: string, taskState = 'RUNNING') =>
    (async (url: string | URL | Request) =>
      new Response(
        JSON.stringify(
          String(url).endsWith('/status')
            ? { connector: { state: 'RUNNING' }, tasks: [{ id: 0, state: taskState }] }
            : { 'table.include.list': tables }
        ),
        { status: 200 }
      )) as unknown as typeof fetch;
  const ON = {
    VECTOR_SYNC_EMBED_ENABLED: 'true',
    CDC_IMAGE_ENABLED: 'true',
    DEBEZIUM_CONNECT_URL: 'http://connect',
    ORCHESTRATOR_ENDPOINT: 'http://orch',
    VECTOR_EMBED_TOKEN: 't',
    VECTOR_IMAGE_LOCATION: 'https://cdn.example',
  };

  async function withEnv<T>(env: Record<string, string | undefined>, run: () => Promise<T>) {
    vi.resetModules();
    const saved = { ...process.env };
    for (const [k, v] of Object.entries({ ...ON, ...env })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return await run();
    } finally {
      process.env = saved;
    }
  }
  const reason = (
    env: Record<string, string | undefined>,
    opts: { withoutImageCdc?: boolean; fetchImpl?: typeof fetch } = {}
  ) =>
    withEnv(env, async () =>
      (await import('@/vector-sync/sync')).embedBlockedReason({
        fetchImpl: connector('public.Comment,public.Image'),
        ...opts,
      })
    );

  test("embedding needs its switch, this process's Image flag, and a connector that streams Image", async () => {
    expect(await reason({})).toBeNull();
    expect(await reason({ VECTOR_SYNC_EMBED_ENABLED: undefined })).toMatch(/EMBED/);
    expect(await reason({ CDC_IMAGE_ENABLED: undefined })).toMatch(/CDC_IMAGE/);
    expect(await reason({ DEBEZIUM_CONNECT_URL: undefined })).toMatch(/cannot be verified/);
    // The flag set here but not on the watcher: the connector still lacks Image.
    expect(
      await reason({}, { fetchImpl: connector('public.Comment,public.ImageResourceNew') })
    ).toMatch(/does not stream public.Image/);
    expect(
      await reason(
        {},
        { fetchImpl: (async () => new Response('', { status: 404 })) as unknown as typeof fetch }
      )
    ).toMatch(/could not be read/);
    // Listed but not flowing.
    expect(await reason({}, { fetchImpl: connector('public.Image', 'FAILED') })).toMatch(
      /not running/
    );
    expect(await reason({ CDC_IMAGE_ENABLED: undefined }, { withoutImageCdc: true })).toBeNull();
  });

  test('the consumer builds no embedder unless its own config allows it', async () => {
    // The connector half is the queue's pausable gate, not a reason to build no embedder.
    const build = (env: Record<string, string | undefined>) =>
      withEnv(env, async () => (await import('@/vector-sync/consumer')).consumerEmbedder());
    expect(await build({})).not.toBeNull();
    expect(await build({ CDC_IMAGE_ENABLED: undefined })).toBeNull();
    expect(await build({ VECTOR_SYNC_EMBED_ENABLED: undefined })).toBeNull();
    await expect(build({ VECTOR_IMAGE_LOCATION: '' })).rejects.toThrow(/VECTOR_IMAGE_LOCATION/);
  });
});

describe('review round 2', () => {
  const body = (ids: string[], modelRevision: string) =>
    JSON.stringify({
      id: 'wf',
      status: 'succeeded',
      steps: [
        {
          output: {
            ...STAMP,
            modelRevision,
            data: ids.map((id, index) => ({ id, index, embedding: [index] })),
          },
        },
      ],
    });
  const idsIn = (init?: RequestInit) =>
    (JSON.parse(String(init?.body)).steps[0].input.inputs as { id: string }[]).map((i) => i.id);
  const embedderWith = (fetchImpl: typeof fetch, maxInFlight: number) =>
    new Embedder({
      endpoint: 'http://orch',
      token: 't',
      maxInFlight,
      maxRetries: 0,
      priority: 'low',
      fetch: fetchImpl,
      sleep: async () => undefined,
    });
  const inputs = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: String(i), imageUrl: 'u' }));

  test('concurrent batches of a call cannot both claim an empty collection with different models', async () => {
    let n = 0;
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      const revision = ++n === 1 ? 'r1' : 'r2';
      return new Response(body(idsIn(init), revision), { status: 200 });
    }) as unknown as typeof fetch;
    // A collection with no stamp yet, read-then-write with a gap, as Qdrant metadata is.
    let stored: string | null = null;
    const acceptStamp = async (stamp: ModelStamp) => {
      const seen = stored;
      await new Promise((r) => setTimeout(r, 5));
      if (seen && seen !== stamp.modelRevision) throw new Error('mismatch');
      stored ??= stamp.modelRevision;
    };
    const result = await embedderWith(fetchImpl, 4).embed(inputs(3 * 128), { acceptStamp });
    expect(result.error).toBeInstanceOf(MixedStampError);
    expect(result.vectors.size).toBe(128);
  });

  test('after a systemic failure, batches still queued are not submitted', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('', { status: 401 })
    ) as unknown as typeof fetch;
    const result = await embedderWith(fetchImpl, 1).embed(inputs(3 * 128));
    expect(String(result.error)).toMatch(/401/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('health: a slow flush making progress after one failure stays up; a retry loop does not', () => {
    const queue = new VectorSyncQueue(deps(new FakePg(), new FakeStore()), async () => undefined);
    const t0 = 1_000_000_000;
    queue.lastFlushOk = t0;
    queue.consecutiveFailures = 1;
    queue.lastProgress = t0 + 20 * 60_000;
    expect(queue.isHealthy(t0 + 25 * 60_000)).toBe(true);
    // Retries restart the flush every tick, which refreshes progress; the failure count is what tells.
    queue.consecutiveFailures = 3;
    expect(queue.isHealthy(t0 + 25 * 60_000)).toBe(false);
    queue.consecutiveFailures = 0;
    expect(queue.isHealthy(t0 + 70 * 60_000)).toBe(false);
  });

  test('the consumer does not embed into a collection whose model is not yet recorded', async () => {
    const pg = new FakePg().put(imageRow(1));
    const store = new FakeStore();
    store.stamped = false;
    const embedder = new FakeEmbedder();
    const queue = new VectorSyncQueue(deps(pg, store, embedder), async () => undefined);
    queue.add(1, { topic: 'postgres.Image', partition: 0, offset: '0' });
    await queue.flush();
    expect(embedder.calls).toEqual([]);
    store.stamped = true;
    // No new event: the deferred id is retried on its own.
    await queue.flush();
    queue.add(null, { topic: 'postgres.Image', partition: 0, offset: '1' });
    await queue.flush();
    expect(embedder.calls).toEqual([['1']]);
    expect(store.points.has(1)).toBe(true);
  });

  test('a failed connector check pauses embedding and a passing one resumes it, catching up', async () => {
    const pg = new FakePg().put(imageRow(1), imageRow(2));
    const store = new FakeStore();
    const embedder = new FakeEmbedder();
    const queue = new VectorSyncQueue(deps(pg, store, embedder), async () => undefined);
    queue.setGate('the connector could not be read (503/503)');
    queue.add(1, { topic: 'postgres.Image', partition: 0, offset: '0' });
    await queue.flush();
    expect(embedder.calls).toEqual([]);
    expect(queue.deferred.has(1)).toBe(true);

    queue.setGate(null);
    queue.add(2, { topic: 'postgres.Image', partition: 0, offset: '1' });
    await queue.flush();
    expect(embedder.calls.flat().sort()).toEqual(['1', '2']);
    expect(queue.deferred.size).toBe(0);
    expect(queue.embedStopped).toBeNull();
  });

  test('a flush that stored vectors before one batch failed does not count towards unhealthy', async () => {
    const pg = new FakePg().put(imageRow(1), imageRow(2));
    const store = new FakeStore();
    const embedder = new FakeEmbedder();
    embedder.dropIds.add(2);
    const queue = new VectorSyncQueue(deps(pg, store, embedder), async () => undefined);
    queue.consecutiveFailures = 2;
    // Real progress comes from the embedder's onProgress; the fake reports it here.
    const embed = embedder.embed;
    embedder.embed = async (...args) => {
      queue.noteProgress();
      return embed(...args);
    };
    queue.add(1, { topic: 'postgres.Image', partition: 0, offset: '0' });
    queue.add(2, { topic: 'postgres.Image', partition: 0, offset: '1' });
    await expect(queue.flush()).rejects.toThrow('503');
    expect(queue.consecutiveFailures).toBe(0);

    embedder.embed = embed;
    store.existing = async () => {
      throw new Error('qdrant down');
    };
    await expect(queue.flush()).rejects.toThrow('qdrant down');
    expect(queue.consecutiveFailures).toBe(1);
  });

  test('two concurrent first model checks on an empty collection cannot both pass', async () => {
    // Qdrant metadata as the real server keeps it: merged on update, read with a delay.
    let metadata: Record<string, unknown> = { model: 'wemm-2b', dimensions: 256 };
    const tick = () => new Promise((r) => setTimeout(r, 5));
    const client = {
      getCollection: async () => {
        await tick();
        return { config: { metadata: { ...metadata } } };
      },
      updateCollection: async (
        _name: string,
        { metadata: m }: { metadata: Record<string, unknown> }
      ) => {
        await tick();
        metadata = { ...metadata, ...m };
      },
    };
    const store = new VectorStore(client as unknown as QdrantClient, 'c');
    const results = await Promise.allSettled([
      store.assertModel(STAMP),
      store.assertModel({ ...STAMP, modelRevision: 'r2' }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(metadata.modelRevision).toBe('r1');
  });

  test('once a stamp is recorded, a call runs its batches in parallel again', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return new Response(body(idsIn(init), 'r1'), { status: 200 });
    }) as unknown as typeof fetch;
    const e = embedderWith(fetchImpl, 4);
    await e.embed(inputs(128));
    peak = 0;
    await e.embed(inputs(4 * 128));
    expect(peak).toBe(4);
  });

  test('a mixed-model error from the real embed contract also stops consumer embedding', async () => {
    const pg = new FakePg().put(imageRow(1), imageRow(2));
    const store = new FakeStore();
    let n = 0;
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) =>
      new Response(body(idsIn(init), ++n === 1 ? 'r1' : 'r2'), {
        status: 200,
      })) as unknown as typeof fetch;
    const real = embedderWith(fetchImpl, 1);
    // Two batches: force a split at one input by using 129 rows.
    for (let id = 3; id <= 129; id++) pg.put(imageRow(id));
    const ids = Array.from({ length: 129 }, (_, i) => i + 1);
    const queue = new VectorSyncQueue(
      { pg: pg as unknown as Pool, store, embedder: real },
      async () => undefined
    );
    for (const id of ids)
      queue.add(id, { topic: 'postgres.Image', partition: 0, offset: String(id) });
    await expect(queue.flush()).rejects.toThrow(MixedStampError);
    expect(store.points.size).toBe(128);
    expect(queue.embedStopped).toMatch(/two models/);
    await queue.flush();
    expect(n).toBe(2);
  });
});

describe('follow-ups 13 and 14', () => {
  test('a video over 4096 px on either side is skipped, not sent to fail its batch', () => {
    const opts = { imageLocation: 'https://cdn.example', embedVideo: true };
    const video = (width: number, height: number) =>
      buildEmbedInput(imageRow(1, { type: 'video', duration: 10, url: 'v', width, height }), opts);
    expect(video(4097, 1080)).toEqual({ skip: 'video-too-large-dimensions' });
    expect(video(1080, 5000)).toEqual({ skip: 'video-too-large-dimensions' });
    expect(video(4096, 4096)).toHaveProperty('input');
  });

  // Decision: metadata is free-form, so every number read from it is range-guarded before its
  // cast. An unguarded ::int or ::float8 overflows on a value like 1e10 and fails the whole row
  // query, which wedges live sync on that id. Verified against a real Postgres in PR #6732.
  test('metadata numbers are read through the overflow-safe guard', () => {
    expect(
      IMAGE_ROW_COLUMNS.match(/LEAST\(\(i\.metadata->>'(width|height|duration)'\)::numeric/g)
    ).toHaveLength(3);
    expect(IMAGE_ROW_COLUMNS).not.toMatch(/->>'[a-z]+'\)::(int|float)/);
  });

  test('the window is UTC and may wrap midnight', () => {
    const at = (hhmm: string) => Date.parse(`2026-10-24T${hhmm}:00Z`);
    const night = parseWindow('22:00-06:00');
    expect([at('23:30'), at('02:00'), at('05:59')].map((t) => inWindow(t, night))).toEqual([
      true,
      true,
      true,
    ]);
    expect([at('06:00'), at('12:00'), at('21:59')].map((t) => inWindow(t, night))).toEqual([
      false,
      false,
      false,
    ]);
    const day = parseWindow('09:00-17:30');
    expect([at('09:00'), at('17:29'), at('17:30')].map((t) => inWindow(t, day))).toEqual([
      true,
      true,
      false,
    ]);
    expect(() => parseWindow('25:00-06:00')).toThrow(/HH:MM/);
    expect(() => parseWindow('06:00-06:00')).toThrow(/differ/);
  });

  function clockedRun(pg: FakePg, store: FakeStore, startMs: number, pageMs = 0) {
    let clock = startMs;
    const pageStarts: number[] = [];
    const base = pg.query;
    pg.query = (async (sql: string, params: unknown[]) => {
      if (sql.includes('i.id >= $1 AND i.id < $2')) {
        pageStarts.push(clock);
        clock += pageMs;
      }
      return base(sql, params);
    }) as FakePg['query'];
    let cursor: number | null = null;
    const state: RunState = {
      getCursor: async () => cursor,
      setCursor: async (id) => void (cursor = id),
      isPaused: async () => false,
      setPaused: async () => undefined,
      reset: async () => undefined,
      close: async () => undefined,
      ...memoryLease(),
    };
    return {
      pageStarts,
      deps: {
        ...deps(pg, store),
        state,
        now: () => clock,
        sleep: async (ms: number) => void (clock += Math.max(ms, 1)),
      },
    };
  }

  test('--max-rate spaces pages by their writes', async () => {
    const pg = new FakePg().put(...Array.from({ length: 30 }, (_, i) => imageRow(i + 1)));
    const store = new FakeStore();
    const run = clockedRun(pg, store, 0);
    // 10 writes per page at 5 writes/s: each page must start at least 2 s after the last.
    await runBackfill({ watermark: 30, floor: 0, span: 10, pages: 1, maxRate: 5 }, run.deps);
    expect(store.points.size).toBe(30);
    const gaps = run.pageStarts.slice(1).map((t, i) => t - run.pageStarts[i]);
    // Pages [21,31), [11,21), [1,11) and the empty [0,1): three gaps, each after 10 writes.
    expect(gaps.length).toBe(3);
    expect(gaps.every((g) => g >= 2000)).toBe(true);
  });

  test('--window starts no page outside it, including after it closes mid-run', async () => {
    const pg = new FakePg().put(...Array.from({ length: 30 }, (_, i) => imageRow(i + 1)));
    const store = new FakeStore();
    const start = Date.parse('2026-10-24T21:59:50Z');
    // Each page takes 3 h of fake time, so the run crosses 06:00 and must wait for the next night.
    const run = clockedRun(pg, store, start, 3 * 3600_000);
    const window = '22:00-06:00';
    await runBackfill({ watermark: 30, floor: 0, span: 5, pages: 1, window }, run.deps);
    expect(store.points.size).toBe(30);
    expect(run.pageStarts.every((t) => inWindow(t, parseWindow(window)))).toBe(true);
    expect(run.pageStarts[0]).toBeGreaterThanOrEqual(Date.parse('2026-10-24T22:00:00Z'));
    expect(run.pageStarts.some((t) => t >= Date.parse('2026-10-25T22:00:00Z'))).toBe(true);
  });
});
