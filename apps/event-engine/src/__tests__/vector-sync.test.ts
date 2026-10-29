// Fakes stand in for Postgres, Qdrant and the orchestrator; what is under test is the decision
// each makes reach (embed, delete, payload write, retry), which is what a caller would notice.
import type { Pool } from 'pg';
import { describe, expect, test, vi } from 'vitest';
import { inWindow, parseWindow, runBackfill, watchRunLimits } from '@/vector-sync/backfill';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileRunState, type RunLimits, type RunState } from '@/vector-sync/cursor';
import { imageIdFromEvent, VectorSyncQueue } from '@/vector-sync/consumer';
import { ModelMismatchError, VectorStore } from '@/vector-sync/qdrant';
import type { QdrantClient } from '@qdrant/js-client-rest';
import { parseRateLimitHeader, parseRetryAfter, RateLimiter } from '@/vector-sync/ratelimit';
import {
  buildEmbedInput,
  takeBatch,
  Embedder,
  type EmbedderOptions,
  JobBudget,
  MixedStampError,
} from '@/vector-sync/embedder';
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

/** A 256-d vector whose first value is `n`. */
const vec = (n: number) => Array.from({ length: 256 }, (_, i) => (i === 0 ? n : 0));

/** A workflow in the one-input-per-step shape; steps for `failIds` fail. */
function workflowBody(ids: string[], modelRevision = 'r1', failIds: string[] = []) {
  return JSON.stringify({
    id: 'wf',
    status: failIds.length ? 'failed' : 'succeeded',
    steps: ids.map((id, index) =>
      failIds.includes(id)
        ? { name: `img-${id}`, status: 'failed' }
        : {
            name: `img-${id}`,
            status: 'succeeded',
            output: { ...STAMP, modelRevision, precision: 'float32', embedding: vec(index) },
          }
    ),
  });
}

/** The image ids a submitted workflow asked for, from its step names. */
function stepIds(init?: RequestInit): string[] {
  return (JSON.parse(String(init?.body)).steps as { name: string }[]).map((s) =>
    s.name.replace(/^img-/, '')
  );
}

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
  test("an image is sent as the image cards' stored 800px variant; an absolute URL is not sent", () => {
    const opts = { imageLocation: 'https://cdn.example', embedVideo: false };
    expect(buildEmbedInput(imageRow(1, { url: 'abc-123' }), opts)).toEqual({
      // The cacher keys a stored variant by these parameters: any other set renders a new one
      // from the original, which is the download this exists to avoid.
      input: {
        id: '1',
        imageUrl: 'https://cdn.example/abc-123/anim=false,width=800,optimized=true/abc-123.jpeg',
      },
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

  test('a workflow takes at most its size in inputs and 8 videos', () => {
    const drain = (queue: { id: string; imageUrl?: string; videoUrl?: string }[], size: number) => {
      const sizes: number[] = [];
      while (queue.length) sizes.push(takeBatch(queue, size).length);
      return sizes;
    };
    const images = Array.from({ length: 300 }, (_, i) => ({ id: String(i), imageUrl: 'x' }));
    expect(drain([...images], 128)).toEqual([128, 128, 44]);
    const videos = Array.from({ length: 20 }, (_, i) => ({ id: String(i), videoUrl: 'x' }));
    expect(drain(videos, 128)).toEqual([8, 8, 4]);
    expect(drain(images.slice(0, 3), 1)).toEqual([1, 1, 1]);
  });
});

describe('embedder', () => {
  const ok = (ids: string[]) => new Response(workflowBody(ids), { status: 200 });
  const idsOf = stepIds;

  function embedder(fetchImpl: typeof fetch, maxRetries = 3) {
    const sleeps: number[] = [];
    let clock = 0;
    const e = new Embedder({
      endpoint: 'http://orch',
      token: 't',
      maxInFlight: 256,
      maxRetries,
      priority: 'low',
      fetch: fetchImpl,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    return { e, sleeps };
  }

  test('backs off on 429, honouring Retry-After, then succeeds', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (++calls <= 2)
        return new Response('queue full', { status: 429, headers: { 'retry-after': '7' } });
      return ok(idsOf(init));
    }) as unknown as typeof fetch;
    const { e, sleeps } = embedder(fetchImpl);
    const result = await e.embed([{ id: '1', imageUrl: 'u' }]);
    expect(result.vectors.get(1)).toEqual(vec(0));
    expect(sleeps).toHaveLength(2);
    expect(Math.min(...sleeps)).toBeGreaterThanOrEqual(7000);
    expect(Math.max(...sleeps)).toBeLessThan(120_000);
  });

  test('gives up after maxRetries rather than retrying forever', async () => {
    const fetchImpl = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    const { e, sleeps } = embedder(fetchImpl, 2);
    const result = await e.embed([{ id: '1', imageUrl: 'u' }]);
    expect(String(result.error)).toMatch(/gave up after 3 attempts/);
    // Two retries, then the wait that keeps the caller from re-sending a submit still running.
    expect(sleeps).toHaveLength(3);
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
      limits: {} as RunLimits,
      getLimits: async () => s.limits,
      setLimit: async (name: keyof RunLimits, value: number | null) =>
        void (s.limits = { ...s.limits, [name]: value ?? undefined }),
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

  // The restart ramps in-flight 20 -> 64 -> 128 by `set-inflight`, without a redeploy.
  test('runtime limits reach a running embedder within the re-read interval, never above env', async () => {
    const e = new Embedder({
      endpoint: 'http://orch',
      token: 't',
      maxInFlight: 128,
      maxRetries: 0,
      batchSize: 32,
      priority: 'low',
    });
    const state = memoryState();
    await state.setLimit('inFlight', 20);
    const stop = await watchRunLimits(state, e, 5);
    try {
      expect(e.budget.capacity).toBe(20);
      await state.setLimit('inFlight', 500);
      await new Promise((r) => setTimeout(r, 20));
      expect(e.budget.capacity).toBe(128);
      await state.setLimit('inFlight', 64);
      await new Promise((r) => setTimeout(r, 20));
      expect(e.budget.capacity).toBe(64);
      await state.setLimit('inFlight', null);
      await new Promise((r) => setTimeout(r, 20));
      expect(e.budget.capacity).toBe(128);
    } finally {
      stop();
    }
  });

  test('the file run state keeps limits, and reset clears them', async () => {
    const path = join(tmpdir(), `vector-limits-${process.pid}-${Date.now()}.json`);
    const state = fileRunState(path);
    await state.setLimit('inFlight', 20);
    await state.setLimit('stepsPerSecond', 3);
    expect(await state.getLimits()).toEqual({ inFlight: 20, stepsPerSecond: 3 });
    await state.setLimit('stepsPerSecond', null);
    expect(await state.getLimits()).toEqual({ inFlight: 20 });
    await state.reset();
    expect(await state.getLimits()).toEqual({});
    await rm(path, { force: true });
  });

  const realEmbedder = (fetchImpl: typeof fetch) =>
    new Embedder({
      endpoint: 'http://orch',
      token: 't',
      maxInFlight: 5,
      maxRetries: 0,
      batchSize: 5,
      priority: 'low',
      fetch: fetchImpl,
      sleep: async () => undefined,
    });
  const okWorkflow = (init?: RequestInit) =>
    new Response(workflowBody(stepIds(init)), { status: 200 });

  // Written early, a point must be re-checked at once: a block that landed while it had no point
  // (so its delete found nothing) would otherwise stay searchable until the page ends.
  test('an image blocked mid-page is deleted right after its own workflow is written', async () => {
    const pg = new FakePg().put(...Array.from({ length: 10 }, (_, i) => imageRow(i + 1)));
    const store = new FakeStore();
    const presentAtSecondSubmit: boolean[] = [];
    let posts = 0;
    let blocked = 0;
    await runBackfill(
      { watermark: 10, floor: 0, span: 10, pages: 1 },
      {
        ...deps(pg, store, null),
        embedder: realEmbedder((async (_u: string | URL | Request, init?: RequestInit) => {
          if (++posts === 1) {
            blocked = Number(stepIds(init)[0]);
            pg.put(imageRow(blocked, { tosViolation: true }));
          } else presentAtSecondSubmit.push(store.points.has(blocked));
          return okWorkflow(init);
        }) as unknown as typeof fetch),
        state: memoryState(),
        sleep: async () => undefined,
      }
    );
    expect(presentAtSecondSubmit[0]).toBe(false);
    expect(store.points.has(blocked)).toBe(false);
    expect(store.points.size).toBe(9);
  });

  test('a Qdrant write failing mid-page re-submits nothing already paid for', async () => {
    const pg = new FakePg().put(...Array.from({ length: 20 }, (_, i) => imageRow(i + 1)));
    const store = new FakeStore();
    const upsert = store.upsert;
    let upserts = 0;
    store.upsert = async (points) => {
      if (++upserts === 2) throw new Error('qdrant down');
      return upsert(points);
    };
    const submitted: string[] = [];
    const state = memoryState();
    await runBackfill(
      { watermark: 20, floor: 0, span: 20, pages: 1 },
      {
        ...deps(pg, store, null),
        embedder: realEmbedder((async (_u: string | URL | Request, init?: RequestInit) => {
          submitted.push(...stepIds(init));
          return okWorkflow(init);
        }) as unknown as typeof fetch),
        state,
        sleep: async () => undefined,
      }
    );
    expect(store.points.size).toBe(20);
    expect(submitted.length).toBe(new Set(submitted).size);
    expect(state.cursor).toBe(0);
  });

  // A pod killed mid-page used to lose every vector of the page: they were stored only at page
  // end, and the restart re-submitted them all. Now each workflow is stored as it returns.
  test('a run killed mid-page keeps what it embedded; the restart submits only the rest, and no row below the cursor is ever unwritten', async () => {
    const pg = new FakePg().put(...Array.from({ length: 40 }, (_, i) => imageRow(i + 1)));
    const store = new FakeStore();
    const embedderFor = (fetchImpl: typeof fetch) =>
      new Embedder({
        endpoint: 'http://orch',
        token: 't',
        maxInFlight: 5,
        maxRetries: 0,
        batchSize: 5,
        priority: 'low',
        fetch: fetchImpl,
        sleep: async () => undefined,
      });
    const ok = (init?: RequestInit) => new Response(workflowBody(stepIds(init)), { status: 200 });

    // Run 1: the fourth workflow never returns, as if the pod were killed while it ran.
    let posts = 0;
    let dead = false;
    const hung: Array<(r: Response) => void> = [];
    const first = memoryState();
    const c = clock();
    const run1 = runBackfill(
      { watermark: 40, floor: 0, span: 40, pages: 1 },
      {
        ...deps(pg, store, null),
        embedder: embedderFor((async (_u: string | URL | Request, init?: RequestInit) =>
          ++posts <= 3
            ? ok(init)
            : dead
            ? new Response('', { status: 401 })
            : new Promise<Response>((r) => hung.push(r))) as unknown as typeof fetch),
        state: first,
        // The loop ticks while the fourth workflow hangs, and its retry backoff is fake time.
        now: c.now,
        sleep: c.sleep,
      }
    );
    for (let i = 0; posts < 4 && i < 200; i++) await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(store.points.size).toBe(15);
    expect(first.cursor).toBeNull();

    // Run 2, the restart, from the same (null) cursor.
    const submitted: string[] = [];
    const violations: string[] = [];
    const second = memoryState();
    const setCursor = second.setCursor;
    second.setCursor = async (cursor: number) => {
      for (let id = cursor; id <= 40; id++)
        if (id > 0 && !store.points.has(id))
          violations.push(`${id} unwritten below cursor ${cursor}`);
      await setCursor(cursor);
    };
    await runBackfill(
      { watermark: 40, floor: 0, span: 10, pages: 2 },
      {
        ...deps(pg, store, null),
        embedder: embedderFor((async (_u: string | URL | Request, init?: RequestInit) => {
          submitted.push(...stepIds(init));
          return ok(init);
        }) as unknown as typeof fetch),
        state: second,
        sleep: async () => undefined,
      }
    );
    expect(submitted.length).toBe(25);
    expect(submitted.some((id) => store.points.has(Number(id)) && Number(id) > 25)).toBe(false);
    expect(store.points.size).toBe(40);
    expect(violations).toEqual([]);
    expect(second.cursor).toBe(0);

    // Let the "killed" run end so its lease timer stops.
    dead = true;
    for (const r of hung) r(new Response('', { status: 401 }));
    await run1.catch(() => undefined);
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

  /** A sleep that yields a macrotask, so a loop ticking while a workflow hangs lets the test run. */
  const tick = () => new Promise<void>((r) => setImmediate(r));
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 2000 && !done(); i++) await tick();
    expect(done()).toBe(true);
  };
  /** A clock the backfill's sleeps advance; the loop is its only sleeper in these tests. */
  function clock() {
    const c = {
      t: 0,
      now: () => c.t,
      sleep: async (ms: number) => void ((c.t += ms), await tick()),
    };
    return c;
  }
  /** A FakeEmbedder whose call containing `id` waits for `release()`. */
  function stuckOn(id: number) {
    const embedder = new FakeEmbedder();
    const embed = embedder.embed;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let stuck = false;
    let started = 0;
    embedder.embed = async (inputs, opts) => {
      started++;
      if (inputs.some((i) => Number(i.id) === id)) {
        stuck = true;
        await gate;
      }
      return embed(inputs, opts);
    };
    return { embedder, release: () => release(), isStuck: () => stuck, started: () => started };
  }
  const ids = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i);

  test('pause stops new submissions at the next tick; the workflow in flight is still written', async () => {
    const pg = new FakePg().put(...ids(1, 30).map((id) => imageRow(id)));
    const store = new FakeStore();
    const state = memoryState();
    const { embedder, release, isStuck, started } = stuckOn(25);
    // One workflow out at a time, so the pause has submissions left to stop.
    Object.assign(embedder, { budget: { capacity: 10, inFlight: 0 } });
    const c = clock();
    const sleeps: number[] = [];
    const run = runBackfill(
      { watermark: 30, floor: 0, span: 10 },
      {
        ...deps(pg, store, embedder),
        state,
        now: c.now,
        sleep: async (ms) => void (sleeps.push(ms), await c.sleep(ms)),
      }
    );
    await until(isStuck);
    state.paused = true;
    const callsAtPause = started();
    release();
    await until(() => store.points.has(25));
    const ticked = sleeps.length;
    await until(() => sleeps.length > ticked + 20);
    expect(started()).toBe(callsAtPause);
    expect([...store.points.keys()].sort((a, b) => a - b)).toEqual(ids(21, 30));
    // Re-checked at least every 5 s while paused.
    expect(Math.max(...sleeps.slice(ticked))).toBeLessThanOrEqual(5000);
    state.paused = false;
    await run;
    expect(store.points.size).toBe(30);
  });

  // A straggler holds only the cursor: the budget it does not hold keeps submitting at the rate.
  test('one workflow that never returns: submissions continue at the step rate and the cursor holds above it', async () => {
    const pg = new FakePg().put(...ids(1, 100).map((id) => imageRow(id)));
    const store = new FakeStore();
    const state = memoryState();
    const c = clock();
    const submitAt: number[] = [];
    const embedderWaits: number[] = [];
    let releaseStraggler: () => void = () => undefined;
    const e = new Embedder({
      endpoint: 'http://orch',
      token: 't',
      maxInFlight: 20,
      maxRetries: 0,
      batchSize: 5,
      priority: 'low',
      maxStepsPerSecond: 10,
      // The backfill submits on the embedder's own schedule, so its pacer should never wait.
      now: () => c.t,
      sleep: async (ms) => void embedderWaits.push(ms),
      fetch: (async (_u: string | URL | Request, init?: RequestInit) => {
        submitAt.push(c.t);
        if (stepIds(init).includes('60'))
          return new Promise<Response>((r) => (releaseStraggler = () => r(okWorkflow(init))));
        return okWorkflow(init);
      }) as unknown as typeof fetch,
    });
    const run = runBackfill(
      { watermark: 100, floor: 0, span: 25 },
      { ...deps(pg, store, null), embedder: e, state, now: c.now, sleep: c.sleep }
    );
    await until(() => store.points.size === 95);
    expect(submitAt).toHaveLength(20);
    const gaps = submitAt.slice(1).map((t, i) => t - submitAt[i]);
    // 5 steps at 10 steps/s: one batch every 500 ms, with no gap behind the straggler.
    expect(gaps.every((g) => g === 500)).toBe(true);
    expect(embedderWaits).toEqual([]);
    // The straggler's page is [51, 76): the cursor stops at its top.
    expect(state.cursor).toBe(76);
    releaseStraggler();
    await run;
    expect(store.points.size).toBe(100);
    expect(state.cursor).toBe(0);
  });

  test('a workflow past its deadline is counted failed and the cursor moves on; its vectors are still kept', async () => {
    const pg = new FakePg().put(...ids(1, 30).map((id) => imageRow(id)));
    const store = new FakeStore();
    const state = memoryState();
    const { embedder, release } = stuckOn(15);
    const c = clock();
    const run = runBackfill(
      { watermark: 30, floor: 0, span: 10, deadlineMs: 60_000 },
      { ...deps(pg, store, embedder), state, now: c.now, sleep: c.sleep }
    );
    await until(() => state.cursor === 0);
    expect(c.t).toBeGreaterThanOrEqual(60_000);
    expect([...store.points.keys()].some((id) => id > 10 && id <= 20)).toBe(false);
    release();
    const result = await run;
    expect(result.failed).toBe(10);
    expect(result.done).toBe(true);
    expect(store.points.size).toBe(30);
  });

  test('the reader stops maxDistance ids past a cursor a straggler holds', async () => {
    const pg = new FakePg().put(...ids(1, 100).map((id) => imageRow(id)));
    const store = new FakeStore();
    const state = memoryState();
    const { embedder, release, isStuck } = stuckOn(95);
    const reads: number[] = [];
    const query = pg.query;
    pg.query = (async (sql: string, params: unknown[]) => {
      if (sql.includes('i.id >= $1 AND i.id < $2')) reads.push((params as number[])[0]);
      return query(sql, params);
    }) as FakePg['query'];
    const c = clock();
    const run = runBackfill(
      { watermark: 100, floor: 0, span: 10, maxDistance: 30 },
      { ...deps(pg, store, embedder), state, now: c.now, sleep: c.sleep }
    );
    await until(isStuck);
    await until(() => store.points.size === 20);
    for (let i = 0; i < 50; i++) await tick();
    // [91,101) is stuck; the reader stops at 71, 30 ids below the cursor.
    expect(reads).toEqual([91, 81, 71]);
    expect(store.points.size).toBe(20);
    release();
    await run;
    expect(store.points.size).toBe(100);
    expect(state.cursor).toBe(0);
  });

  test('set-inflight lowered mid-run: once the running workflows drain, no more than the new limit are ever out', async () => {
    const pg = new FakePg().put(...ids(1, 100).map((id) => imageRow(id)));
    const store = new FakeStore();
    const held: Array<() => void> = [];
    let out = 0;
    const outAtSubmit: number[] = [];
    const e = new Embedder({
      endpoint: 'http://orch',
      token: 't',
      maxInFlight: 20,
      maxRetries: 0,
      batchSize: 5,
      priority: 'low',
      sleep: async () => undefined,
      fetch: (async (_u: string | URL | Request, init?: RequestInit) => {
        out += stepIds(init).length;
        outAtSubmit.push(out);
        await new Promise<void>((r) => held.push(r));
        out -= stepIds(init).length;
        return okWorkflow(init);
      }) as unknown as typeof fetch,
    });
    // The pipeline's own gate: a batch is handed over only when the budget can take it now, so
    // none waits inside the embedder (the JobBudget alone would also keep `out` in bounds).
    const embed = e.embed.bind(e);
    let handed = 0;
    const handedOver: number[] = [];
    e.embed = async (inputs, opts) => {
      handed += inputs.length;
      handedOver.push(handed - e.budget.capacity);
      try {
        return await embed(inputs, opts);
      } finally {
        handed -= inputs.length;
      }
    };
    const run = runBackfill(
      { watermark: 100, floor: 0, span: 50 },
      { ...deps(pg, store, null), embedder: e, state: memoryState(), sleep: tick }
    );
    await until(() => out === 20);
    e.setLimits({ inFlight: 5 });
    const lowered = outAtSubmit.length;
    while (store.points.size < 100) {
      await until(() => held.length > 0 || store.points.size === 100);
      held.shift()?.();
      await tick();
    }
    await run;
    expect(Math.max(...outAtSubmit.slice(0, lowered))).toBe(20);
    // Each submit after the lowering found at most 5 steps out, its own included.
    expect(outAtSubmit.length).toBeGreaterThan(lowered);
    expect(outAtSubmit.slice(lowered).every((n) => n <= 5)).toBe(true);
    expect(handedOver.filter((over) => over > 0)).toEqual([]);
  });

  test('a run killed with a straggler out resumes from its cursor with no unwritten id above it', async () => {
    const pg = new FakePg().put(...ids(1, 40).map((id) => imageRow(id)));
    const store = new FakeStore();
    const first = memoryState();
    const straggler = stuckOn(25);
    const run1 = runBackfill(
      { watermark: 40, floor: 0, span: 10 },
      { ...deps(pg, store, straggler.embedder), state: first, sleep: tick }
    );
    await until(() => store.points.size === 30);
    // Killed here: [21,31) is out, the pages below it are written, the cursor holds at its top.
    expect(first.cursor).toBe(31);
    const unwrittenAbove = (cursor: number) =>
      ids(cursor, 40).filter((id) => !store.points.has(id));
    expect(unwrittenAbove(first.cursor!)).toEqual([]);

    const second = memoryState(first.cursor);
    const violations: string[] = [];
    const setCursor = second.setCursor;
    second.setCursor = async (cursor: number) => {
      for (const id of unwrittenAbove(Math.max(cursor, 1)))
        violations.push(`${id} below ${cursor}`);
      await setCursor(cursor);
    };
    const embedder = new FakeEmbedder();
    await runBackfill(
      { watermark: 40, floor: 0, span: 10 },
      { ...deps(pg, store, embedder), state: second }
    );
    expect(
      embedder.calls
        .flat()
        .map(Number)
        .sort((a, b) => a - b)
    ).toEqual(ids(21, 30));
    expect(violations).toEqual([]);
    expect(store.points.size).toBe(40);
    expect(second.cursor).toBe(0);
    straggler.release();
    await run1;
  });

  // Review of this pipeline: the embedder reserved a full batch of step rate for a short one, so
  // on sparse pages its schedule ran ahead and batches queued inside it, past a pause.
  test('sparse pages: short batches are paced by their length and never wait inside the embedder', async () => {
    const pg = new FakePg().put(...ids(1, 30).map((n) => imageRow(n * 10)));
    const store = new FakeStore();
    const c = clock();
    const embedderWaits: number[] = [];
    const submits: number[] = [];
    const e = new Embedder({
      endpoint: 'http://orch',
      token: 't',
      maxInFlight: 40,
      maxRetries: 0,
      batchSize: 20,
      priority: 'low',
      maxStepsPerSecond: 10,
      now: () => c.t,
      sleep: async (ms) => void embedderWaits.push(ms),
      fetch: (async (_u: string | URL | Request, init?: RequestInit) => {
        submits.push(c.t);
        return okWorkflow(init);
      }) as unknown as typeof fetch,
    });
    await runBackfill(
      { watermark: 300, floor: 0, span: 10 },
      { ...deps(pg, store, null), embedder: e, state: memoryState(), now: c.now, sleep: c.sleep }
    );
    expect(store.points.size).toBe(30);
    expect(embedderWaits).toEqual([]);
    // 30 steps at 10 steps/s go out within 3 s; reserving a full 20-step slot per batch takes longer.
    expect(Math.max(...submits)).toBeLessThanOrEqual(3000);
  });

  test('a batch whose re-check failed after its upsert is re-read on retry, not re-embedded', async () => {
    const pg = new FakePg().put(...ids(1, 10).map((id) => imageRow(id)));
    const store = new FakeStore();
    const embedder = new FakeEmbedder();
    let armed = false;
    store.afterUpsert = () => void (armed = true);
    const query = pg.query;
    pg.query = (async (sql: string, params: unknown[]) => {
      if (armed && sql.includes('i.id = ANY')) {
        armed = false;
        throw new Error('postgres blip');
      }
      return query(sql, params);
    }) as FakePg['query'];
    const state = memoryState();
    const c = clock();
    await runBackfill(
      { watermark: 10, floor: 0, span: 10 },
      { ...deps(pg, store, embedder), state, now: c.now, sleep: c.sleep }
    );
    expect(
      embedder.calls
        .flat()
        .map(Number)
        .sort((a, b) => a - b)
    ).toEqual(ids(1, 10));
    expect(store.points.size).toBe(10);
    expect(state.cursor).toBe(0);
  });

  // Review: the expiry ran while a failed batch was re-read, then the requeue wrote to the
  // entries it had cleared, an unhandled rejection that ends the process.
  test('a batch past its deadline while its failure is re-read is not requeued, and the run ends cleanly', async () => {
    const pg = new FakePg().put(...ids(1, 10).map((id) => imageRow(id)));
    const store = new FakeStore();
    const embedder = new FakeEmbedder();
    embedder.dropIds.add(3);
    const c = clock();
    let releaseReread: () => void = () => undefined;
    let rereading = false;
    const query = pg.query;
    pg.query = (async (sql: string, params: unknown[]) => {
      if (sql.includes('i.id = ANY') && String(params[0]) === '3' && !rereading) {
        rereading = true;
        await new Promise<void>((r) => (releaseReread = r));
      }
      return query(sql, params);
    }) as FakePg['query'];
    const state = memoryState();
    const run = runBackfill(
      { watermark: 10, floor: 0, span: 10, deadlineMs: 60_000 },
      { ...deps(pg, store, embedder), state, now: c.now, sleep: c.sleep }
    );
    // Expired while the re-read is held: the cursor passes 3 once it is counted failed.
    await until(() => rereading && state.cursor === 0);
    releaseReread();
    const result = await run;
    expect(result.failed).toBe(1);
    expect(embedder.calls).toHaveLength(1);
    expect(store.points.has(3)).toBe(false);
    expect(result.cursor).toBe(0);
  });

  // Review: a quota with nothing left split one batch inside embed() into one-step workflows
  // sent one after another, which a pause could not reach.
  test('a used-up quota sizes batches in the pipeline, so a pause stops the next workflow', async () => {
    const pg = new FakePg().put(...ids(1, 30).map((id) => imageRow(id)));
    const store = new FakeStore();
    const state = memoryState();
    const c = clock();
    let fetches = 0;
    const e = new Embedder({
      endpoint: 'http://orch',
      token: 't',
      maxInFlight: 10,
      maxRetries: 0,
      batchSize: 10,
      priority: 'low',
      now: () => c.t,
      sleep: async () => undefined,
      fetch: (async (_u: string | URL | Request, init?: RequestInit) => {
        if (++fetches === 3) state.paused = true;
        return new Response(workflowBody(stepIds(init)), {
          status: 200,
          headers: {
            'RateLimit-Policy': '"inflight-multimodalEmbedding";q=80',
            RateLimit: '"inflight-multimodalEmbedding";r=0;t=0',
          },
        });
      }) as unknown as typeof fetch,
    });
    const run = runBackfill(
      { watermark: 30, floor: 0, span: 30 },
      { ...deps(pg, store, null), embedder: e, state, now: c.now, sleep: c.sleep }
    );
    await until(() => fetches >= 3);
    for (let i = 0; i < 50; i++) await tick();
    expect(fetches).toBe(3);
    state.paused = false;
    await run;
    expect(store.points.size).toBe(30);
  });

  test('with --max-rate, a page whose rewrites are still being paced does not hold up a stop', async () => {
    const pg = new FakePg().put(...ids(1, 100).map((id) => imageRow(id)));
    const store = new FakeStore();
    for (const id of ids(1, 100))
      store.points.set(id, { vector: vec(id), payload: {} as ImagePayload });
    const reads: number[] = [];
    const query = pg.query;
    pg.query = (async (sql: string, params: unknown[]) => {
      if (sql.includes('i.id >= $1 AND i.id < $2')) reads.push((params as number[])[0]);
      return query(sql, params);
    }) as FakePg['query'];
    const c = clock();
    // Page one rewrites 50 payloads at 1 write/s: page two may not start for 50 s.
    await runBackfill(
      { watermark: 100, floor: 0, span: 50, maxRate: 1 },
      {
        ...deps(pg, store),
        state: memoryState(),
        now: c.now,
        sleep: c.sleep,
        shouldStop: () => c.t >= 10_000,
      }
    );
    expect(reads).toEqual([51]);
    expect(c.t).toBeLessThan(20_000);
  });

  // A run lasts days: only consecutive read failures stop it, not four blips spread over it.
  test('a page read that fails once is retried, and failures on different pages do not add up', async () => {
    const pg = new FakePg().put(...ids(1, 50).map((id) => imageRow(id)));
    const failedOnce = new Set<number>();
    const query = pg.query;
    pg.query = (async (sql: string, params: unknown[]) => {
      const lo = (params as number[])[0];
      if (sql.includes('i.id >= $1 AND i.id < $2') && !failedOnce.has(lo)) {
        failedOnce.add(lo);
        throw new Error('pg blip');
      }
      return query(sql, params);
    }) as FakePg['query'];
    const store = new FakeStore();
    const c = clock();
    const result = await runBackfill(
      { watermark: 50, floor: 0, span: 10 },
      { ...deps(pg, store), state: memoryState(), now: c.now, sleep: c.sleep }
    );
    expect(failedOnce.size).toBe(6);
    expect(result.done).toBe(true);
    expect(store.points.size).toBe(50);
  });

  // Decision (review of #7150): a wait the loop is woken from clears its timer, so a finished run
  // does not keep the process alive for the rest of a tick.
  test('a run leaves no timer behind once it returns', async () => {
    const pg = new FakePg().put(...ids(1, 10).map((id) => imageRow(id)));
    const store = new FakeStore();
    const embedder = new FakeEmbedder();
    const embed = embedder.embed;
    embedder.embed = async (inputs, opts) => {
      await new Promise((r) => setTimeout(r, 20));
      return embed(inputs, opts);
    };
    // Only this run's timers, by wrapping setTimeout: a process-wide count moves with other suites.
    const pending = new Set<unknown>();
    const { setTimeout: realSet, clearTimeout: realClear } = globalThis;
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      const t: unknown = realSet(() => {
        pending.delete(t);
        fn();
      }, ms);
      pending.add(t);
      return t;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((t?: Parameters<typeof clearTimeout>[0]) => {
      pending.delete(t);
      realClear(t);
    }) as typeof clearTimeout;
    try {
      await runBackfill(
        { watermark: 10, floor: 0, span: 10 },
        { ...deps(pg, store, embedder), state: memoryState() }
      );
    } finally {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    }
    expect(store.points.size).toBe(10);
    expect(pending.size).toBe(0);
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
      getLimits: async () => ({}),
      setLimit: async () => undefined,
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
      getLimits: async () => ({}),
      setLimit: async () => undefined,
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

  const okBody = (ids: string[], modelRevision = 'r1') => workflowBody(ids, modelRevision);
  const inputIds = stepIds;
  const makeEmbedder = (fetchImpl: typeof fetch) =>
    new Embedder({
      endpoint: 'http://orch',
      token: 't',
      // One 128-step workflow at a time.
      maxInFlight: 128,
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
      getLimits: async () => ({}),
      setLimit: async () => undefined,
      getCursor: async () => cursor,
      setCursor: async (id) => void (cursor = id),
      isPaused: async () => false,
      setPaused: async () => undefined,
      reset: async () => undefined,
      close: async () => undefined,
      ...memoryLease(),
    };
    // The read backoff is the run's clock, so a fake one keeps the test fast.
    let t = 0;
    await expect(
      runBackfill(
        { watermark: 40, floor: 0, span: 10, pages: 2 },
        {
          ...deps(pg, store),
          state,
          now: () => t,
          sleep: async (ms) => void ((t += ms), await new Promise((r) => setImmediate(r))),
        }
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

  // parseInt('eight') is NaN, and `attempt >= NaN` is never true: the retries never ended.
  test('a malformed number in the vector-sync env is refused at startup, not run on a default', async () => {
    const start = (env: Record<string, string>) =>
      withEnv(env, async () => (await import('@/vector-sync/embedder')).Embedder.fromConfig('low'));
    await expect(start({ VECTOR_EMBED_MAX_RETRIES: 'eight' })).rejects.toThrow(
      /VECTOR_EMBED_MAX_RETRIES="eight"/
    );
    await expect(start({ VECTOR_EMBED_BATCH_SIZE: '500' })).rejects.toThrow(
      /VECTOR_EMBED_BATCH_SIZE/
    );
    // Number('0x3') is 3; the refusal must come from the parse, not a later range check.
    await expect(start({ VECTOR_EMBED_MAX_RETRIES: '0x3' })).rejects.toThrow(
      /VECTOR_EMBED_MAX_RETRIES="0x3"/
    );
    // Past 2^31 ms the flush interval would fire every millisecond.
    await expect(start({ VECTOR_SYNC_DEBOUNCE_MS: '9999999999' })).rejects.toThrow(/DEBOUNCE_MS/);
    await expect(start({ VECTOR_EMBED_MAX_RETRIES: '3' })).resolves.toBeDefined();
  });

  // Live sync must keep up with uploads; the step cap is for walks over existing images.
  test('the step-rate cap applies to backfill and reconcile, not the live consumer', async () => {
    const paceOf = (priority: 'low' | 'normal') =>
      withEnv({ VECTOR_EMBED_MAX_STEPS_PER_SECOND: '7' }, async () => {
        const { Embedder } = await import('@/vector-sync/embedder');
        const e = Embedder.fromConfig(priority) as unknown as { opts: EmbedderOptions };
        return e.opts.maxStepsPerSecond;
      });
    expect(await paceOf('low')).toBe(7);
    expect(await paceOf('normal')).toBe(0);
  });

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
  const body = (ids: string[], modelRevision: string) => workflowBody(ids, modelRevision);
  const idsIn = stepIds;
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
    const result = await embedderWith(fetchImpl, 4 * 128).embed(inputs(3 * 128), { acceptStamp });
    expect(result.error).toBeInstanceOf(MixedStampError);
    expect(result.vectors.size).toBe(128);
  });

  test('after a systemic failure, batches still queued are not submitted', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('', { status: 401 })
    ) as unknown as typeof fetch;
    const result = await embedderWith(fetchImpl, 128).embed(inputs(3 * 128));
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
    // The budget counts jobs (steps): room for four 128-step workflows.
    const e = embedderWith(fetchImpl, 4 * 128);
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
    const real = embedderWith(fetchImpl, 128);
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
      getLimits: async () => ({}),
      setLimit: async () => undefined,
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
        // A macrotask per sleep: the loop ticks while a workflow is stuck, and an instant sleep
        // would starve the test's own timers.
        sleep: async (ms: number) => {
          clock += Math.max(ms, 1);
          await new Promise((r) => setImmediate(r));
        },
      },
    };
  }

  // 10-28: with every other page done and a --max-rate hold set, the loop waited only on the
  // one page stuck behind a slow workflow, and submitted nothing for minutes.
  test('a page stuck on a slow workflow does not stop new pages once the --max-rate hold ends', async () => {
    const pg = new FakePg().put(...Array.from({ length: 30 }, (_, i) => imageRow(i + 1)));
    const store = new FakeStore();
    const run = clockedRun(pg, store, 0);
    let release: () => void = () => undefined;
    const stuck = new Promise<void>((r) => (release = r));
    const embedder = new FakeEmbedder();
    const embed = embedder.embed;
    embedder.embed = async (inputs, opts) => {
      if (inputs.some((i) => Number(i.id) > 20)) await stuck;
      return embed(inputs, opts);
    };
    const done = runBackfill(
      { watermark: 30, floor: 0, span: 10, pages: 2, maxRate: 5 },
      { ...run.deps, embedder }
    );
    for (let i = 0; i < 200 && !store.points.has(1); i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    // The bottom page (ids 1-10) started after the hold, while the top page is still stuck.
    expect([...store.points.keys()].filter((id) => id <= 10)).toHaveLength(10);
    expect([...store.points.keys()].some((id) => id > 20)).toBe(false);
    release();
    await done;
    expect(store.points.size).toBe(30);
  });

  test('--max-rate paces Qdrant writes', async () => {
    const pg = new FakePg().put(...Array.from({ length: 30 }, (_, i) => imageRow(i + 1)));
    const store = new FakeStore();
    const run = clockedRun(pg, store, 0);
    const upserts: Array<[number, number]> = [];
    const upsert = store.upsert;
    store.upsert = async (points) => {
      upserts.push([run.deps.now(), points.length]);
      return upsert(points);
    };
    // 5 writes/s: by the time a write starts, the writes before it fit the rate.
    await runBackfill({ watermark: 30, floor: 0, span: 10, maxRate: 5 }, run.deps);
    expect(store.points.size).toBe(30);
    expect(upserts).toHaveLength(3);
    let before = 0;
    for (const [at, n] of upserts) {
      expect(at).toBeGreaterThanOrEqual((before / 5) * 1000);
      before += n;
    }
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

describe('one input per step (orchestration #460)', () => {
  const embedderWith = (fetchImpl: typeof fetch, maxInFlight = 512) =>
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
    Array.from({ length: n }, (_, i) => ({ id: String(i + 1), imageUrl: `u${i + 1}` }));

  test('a workflow carries one single-input step per image, named by id, float32', async () => {
    let sent: { steps: Array<{ name: string; input: Record<string, unknown> }> } | undefined;
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return new Response(workflowBody(stepIds(init)), { status: 200 });
    }) as unknown as typeof fetch;
    await embedderWith(fetchImpl).embed([
      { id: '7', imageUrl: 'https://cdn/a.jpeg' },
      { id: '8', videoUrl: 'https://cdn/b.mp4' },
    ]);
    expect(sent!.steps.map((st) => st.name)).toEqual(['img-7', 'img-8']);
    expect(sent!.steps[0].input).toEqual({
      model: 'wemm-2b',
      dimensions: 256,
      precision: 'float32',
      imageUrl: 'https://cdn/a.jpeg',
    });
    expect(sent!.steps[1].input).toEqual({
      model: 'wemm-2b',
      dimensions: 256,
      precision: 'float32',
      videoUrl: 'https://cdn/b.mp4',
    });
    expect(sent!.steps.some((st) => 'inputs' in st.input)).toBe(false);
  });

  test('a failed step fails only its own image, without resubmitting the rest', async () => {
    const fetchImpl = vi.fn(
      async (_u: string | URL | Request, init?: RequestInit) =>
        new Response(workflowBody(stepIds(init), 'r1', ['2']), { status: 200 })
    ) as unknown as typeof fetch;
    const result = await embedderWith(fetchImpl).embed(inputs(3));
    expect([...result.vectors.keys()].sort()).toEqual([1, 3]);
    expect(result.failed).toEqual([2]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('one step from another model revision rejects the workflow it came in', async () => {
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(workflowBody(stepIds(init)));
      body.steps[1].output.modelRevision = 'r2';
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await embedderWith(fetchImpl).embed(inputs(3));
    expect(result.error).toBeInstanceOf(MixedStampError);
    expect(result.vectors.size).toBe(0);
  });

  test('a video step reports its profile as the video profile', async () => {
    const stamps: ModelStamp[] = [];
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) =>
      new Response(workflowBody(stepIds(init)), { status: 200 })) as unknown as typeof fetch;
    await embedderWith(fetchImpl).embed([{ id: '1', videoUrl: 'v' }], {
      acceptStamp: async (st) => void stamps.push(st),
    });
    expect(stamps).toEqual([
      { model: 'wemm-2b', modelRevision: 'r1', dimensions: 256, videoProfile: 'p1' },
    ]);
  });

  test('the in-flight cap counts jobs (steps), not workflows', async () => {
    let jobs = 0;
    let peak = 0;
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      const ids = stepIds(init);
      jobs += ids.length;
      peak = Math.max(peak, jobs);
      await new Promise((r) => setTimeout(r, 5));
      jobs -= ids.length;
      return new Response(workflowBody(ids), { status: 200 });
    }) as unknown as typeof fetch;
    const e = embedderWith(fetchImpl, 300);
    await e.embed(inputs(128)); // records the stamp so the next call runs in parallel
    peak = 0;
    const result = await e.embed(inputs(6 * 128));
    expect(result.vectors.size).toBe(6 * 128);
    expect(peak).toBeLessThanOrEqual(300);
    expect(peak).toBe(256);
  });

  test('a workflow larger than the budget still runs, alone', async () => {
    const budget = new JobBudget(10);
    const n = await budget.acquire(128);
    expect(n).toBe(10);
    let second = false;
    const waiting = budget.acquire(1).then(() => (second = true));
    await Promise.resolve();
    expect(second).toBe(false);
    budget.release(n);
    await waiting;
    expect(second).toBe(true);
  });

  // A quota drop (500 -> q=80) below a queued waiter's size used to strand it, and every waiter
  // behind it, forever.
  test('a queued waiter still starts after the capacity drops below its size', async () => {
    const budget = new JobBudget(500);
    const held = await budget.acquire(500);
    let granted: number | undefined;
    let behind = false;
    void budget.acquire(128).then((n) => (granted = n));
    void budget.acquire(1).then(() => (behind = true));
    budget.setCapacity(80);
    budget.release(held);
    await new Promise((r) => setTimeout(r, 0));
    expect(granted).toBe(80);
    budget.release(80);
    await new Promise((r) => setTimeout(r, 0));
    expect(behind).toBe(true);
  });
});

describe('model stamp by media type', () => {
  test('a video-only stamp does not conflict with a recorded image profile; a different image profile does', async () => {
    let metadata: Record<string, unknown> = {
      model: 'wemm-2b',
      dimensions: 256,
      modelRevision: 'r1',
      profile: 'p1',
    };
    const client = {
      getCollection: async () => ({ config: { metadata: { ...metadata } } }),
      updateCollection: async (
        _n: string,
        { metadata: m }: { metadata: Record<string, unknown> }
      ) => void (metadata = { ...metadata, ...m }),
    };
    const store = new VectorStore(client as unknown as QdrantClient, 'c');
    await store.assertModel({
      model: 'wemm-2b',
      modelRevision: 'r1',
      dimensions: 256,
      videoProfile: 'v1',
    });
    expect(metadata).toMatchObject({ profile: 'p1', videoProfile: 'v1' });
    await expect(
      store.assertModel({ model: 'wemm-2b', modelRevision: 'r1', dimensions: 256, profile: 'p2' })
    ).rejects.toThrow(ModelMismatchError);
    await expect(
      store.assertModel({
        model: 'wemm-2b',
        modelRevision: 'r1',
        dimensions: 256,
        videoProfile: 'v2',
      })
    ).rejects.toThrow(ModelMismatchError);
  });
});

describe('orchestrator rate limits (orchestration #460 guidance)', () => {
  const POLICY = '"inflight-multimodalEmbedding";q=80, "buzz";q=1000;w=60';
  const limited = (r: number) => `"inflight-multimodalEmbedding";r=${r};t=0, "buzz";r=938;t=11`;

  function clocked(fetchImpl: typeof fetch, maxInFlight = 500) {
    let clock = 0;
    const e = new Embedder({
      endpoint: 'http://orch',
      token: 't',
      maxInFlight,
      maxRetries: 2,
      priority: 'low',
      fetch: fetchImpl,
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
    });
    return { e, now: () => clock };
  }
  const ok = (init: RequestInit | undefined, r: number) =>
    new Response(workflowBody(stepIds(init)), {
      status: 200,
      headers: { 'RateLimit-Policy': POLICY, RateLimit: limited(r) },
    });
  const inputs = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: String(i + 1), imageUrl: 'u' }));

  // The orchestrator owners asked for the quota to be ignored while its value is provisional;
  // honoured, a reported r=0 shrank every workflow to one step.
  test('with the quota not honoured, workflows keep their full size and the cap its configured value; a 429 still holds', async () => {
    let clock = 0;
    const sizes: number[] = [];
    const sleeps: number[] = [];
    let calls = 0;
    const e = new Embedder({
      endpoint: 'http://orch',
      token: 't',
      maxInFlight: 500,
      maxRetries: 2,
      batchSize: 32,
      priority: 'low',
      honorQuota: false,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      fetch: (async (_u: string | URL | Request, init?: RequestInit) => {
        if (++calls === 2)
          return new Response('', { status: 429, headers: { 'Retry-After': '7' } });
        sizes.push(stepIds(init).length);
        return ok(init, 0);
      }) as unknown as typeof fetch,
    });
    const result = await e.embed(inputs(128));
    expect(result.vectors.size).toBe(128);
    expect(sizes).toEqual([32, 32, 32, 32]);
    expect(e.budget.capacity).toBe(500);
    expect(Math.max(...sleeps)).toBeGreaterThanOrEqual(7000);
  });

  test('parses the RateLimit and RateLimit-Policy headers', () => {
    expect(parseRateLimitHeader(POLICY)).toEqual(
      new Map([
        ['inflight-multimodalEmbedding', { q: 80 }],
        ['buzz', { q: 1000, w: 60 }],
      ])
    );
    expect(parseRateLimitHeader(limited(3)).get('inflight-multimodalEmbedding')).toEqual({
      r: 3,
      t: 0,
    });
    expect(parseRateLimitHeader(null).size).toBe(0);
  });

  test('the in-flight cap becomes min(maxInFlight, the account quota q)', async () => {
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) =>
      ok(init, 50)) as unknown as typeof fetch;
    const a = clocked(fetchImpl, 500);
    await a.e.embed(inputs(1));
    expect(a.e.budget.capacity).toBe(80);
    expect(a.e.limits.quota).toBe(80);
    const b = clocked(fetchImpl, 40);
    await b.e.embed(inputs(1));
    expect(b.e.budget.capacity).toBe(40);
  });

  test('a workflow is sized to the quota the orchestrator says is left', async () => {
    const sizes: number[] = [];
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      sizes.push(stepIds(init).length);
      return ok(init, 3);
    }) as unknown as typeof fetch;
    const { e } = clocked(fetchImpl);
    await e.embed(inputs(10));
    // The first is sent before any header is seen; after it, r=3 bounds every workflow.
    expect(sizes[0]).toBe(10);
    await e.embed(inputs(10));
    expect(sizes.slice(1).every((n) => n <= 3)).toBe(true);
    expect(sizes.slice(1).reduce((a, b) => a + b, 0)).toBe(10);
  });

  test('a 429 is retried after exactly its Retry-After, and holds every other submit too', async () => {
    let calls = 0;
    const submitTimes: number[] = [];
    let now = () => 0;
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      submitTimes.push(now());
      if (++calls === 2) {
        return new Response(
          JSON.stringify({ title: 'too many unfinished jobs for this account' }),
          {
            status: 429,
            headers: {
              'Retry-After': '1',
              'Content-Type': 'application/problem+json',
              'RateLimit-Policy': POLICY,
              RateLimit: limited(0),
            },
          }
        );
      }
      return ok(init, 200);
    }) as unknown as typeof fetch;
    const run = clocked(fetchImpl);
    now = run.now;
    await run.e.embed(inputs(1)); // stamp seen, so the next call runs workflows in parallel
    const result = await run.e.embed(inputs(4 * 128));
    expect(result.vectors.size).toBe(4 * 128);
    const after = submitTimes.slice(2);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((t) => t >= 1000)).toBe(true);
    expect(after[0]).toBe(1000);
  });

  test('a buzz-window 429 is handled the same way', async () => {
    let calls = 0;
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      if (++calls === 1) {
        return new Response('buzz', {
          status: 429,
          headers: { 'Retry-After': '11', RateLimit: '"buzz";r=0;t=11' },
        });
      }
      return ok(init, 50);
    }) as unknown as typeof fetch;
    const run = clocked(fetchImpl);
    const result = await run.e.embed(inputs(2));
    expect(result.vectors.size).toBe(2);
    expect(run.now()).toBe(11_000);
  });

  test('submits are ephemeral, and a result lost between polls is sent again', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let gets = 0;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'GET') {
        gets++;
        return new Response('', { status: 404 });
      }
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length === 1)
        return new Response(JSON.stringify({ id: 'wf1', status: 'processing' }), { status: 202 });
      expect(String(url)).toContain('wait=60');
      return ok(init, 50);
    }) as unknown as typeof fetch;
    const { e } = clocked(fetchImpl);
    const result = await e.embed(inputs(2));
    expect(bodies.every((b) => b.ephemeral === true)).toBe(true);
    expect(gets).toBe(1);
    expect(bodies).toHaveLength(2);
    expect(result.vectors.size).toBe(2);
  });

  test('a poll that fails is retried as a poll, never by submitting the running workflow again', async () => {
    let posts = 0;
    let gets = 0;
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'GET') {
        if (++gets === 1) return new Response('blip', { status: 503 });
        return new Response(workflowBody(['1', '2']), { status: 200 });
      }
      posts++;
      return new Response(JSON.stringify({ id: 'wf1', status: 'processing' }), { status: 202 });
    }) as unknown as typeof fetch;
    const { e } = clocked(fetchImpl);
    const result = await e.embed(inputs(2));
    expect(posts).toBe(1);
    expect(gets).toBe(2);
    expect(result.vectors.size).toBe(2);
  });

  test('a lost result is sent again without the ambiguous-submit wait', async () => {
    const posts: number[] = [];
    let now = () => 0;
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'GET') return new Response('', { status: 404 });
      posts.push(now());
      if (posts.length === 1)
        return new Response(JSON.stringify({ id: 'wf1', status: 'processing' }), { status: 202 });
      return ok(init, 50);
    }) as unknown as typeof fetch;
    const run = clocked(fetchImpl);
    now = run.now;
    const result = await run.e.embed(inputs(1));
    expect(result.vectors.size).toBe(1);
    expect(posts).toHaveLength(2);
    expect(posts[1] - posts[0]).toBeLessThan(120_000);
  });

  // Shaped as Node 22's fetch throws them: TypeError('fetch failed') with the socket error as cause.
  const fetchFailed = (code: string) =>
    Promise.reject(
      new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) })
    );

  const failedWorkflow = (init: RequestInit | undefined, status: string) => {
    const ids = stepIds(init);
    return new Response(JSON.stringify({ ...JSON.parse(workflowBody(ids, 'r1', ids)), status }), {
      status: 200,
    });
  };

  // An outage (or an expired queue) used to mark every image failed and let the caller move on.
  test.each(['failed', 'expired', 'canceled'])(
    'a %s workflow with no step succeeded is re-submitted, not dropped',
    async (status) => {
      let posts = 0;
      const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) =>
        ++posts === 1 ? failedWorkflow(init, status) : ok(init, 50)) as unknown as typeof fetch;
      const result = await clocked(fetchImpl).e.embed(inputs(2));
      expect(posts).toBe(2);
      expect(result.failed).toEqual([]);
      expect(result.vectors.size).toBe(2);
    }
  );

  test('an expired workflow keeps the steps that finished and re-submits only the rest', async () => {
    const submitted: string[][] = [];
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      const ids = stepIds(init);
      submitted.push(ids);
      if (submitted.length > 1) return ok(init, 50);
      const body = JSON.parse(workflowBody(ids, 'r1', ids.slice(1)));
      return new Response(JSON.stringify({ ...body, status: 'expired' }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await clocked(fetchImpl).e.embed(inputs(3));
    expect(submitted).toEqual([
      ['1', '2', '3'],
      ['2', '3'],
    ]);
    expect([...result.vectors.keys()].sort()).toEqual([1, 2, 3]);
    expect(result.failed).toEqual([]);
  });

  test('a workflow that keeps failing ends as counted failures, without an error that would stall the caller', async () => {
    let posts = 0;
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      posts++;
      return failedWorkflow(init, 'failed');
    }) as unknown as typeof fetch;
    const result = await clocked(fetchImpl).e.embed(inputs(2));
    expect(posts).toBe(3); // maxRetries 2
    expect(result.failed.sort()).toEqual([1, 2]);
    expect(result.error).toBeUndefined();
  });

  // Attempts alone let 8 retries of a 30-minute expiry hold one flush for hours.
  test('an outage is not re-submitted once the batch has been at it for the outage window', async () => {
    let clock = 0;
    let posts = 0;
    const e = new Embedder({
      endpoint: 'http://orch',
      token: 't',
      maxInFlight: 500,
      maxRetries: 8,
      priority: 'low',
      outageRetryForMs: 15 * 60_000,
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
      fetch: (async (_u: string | URL | Request, init?: RequestInit) => {
        posts++;
        clock += 10 * 60_000; // the queue held it until its steps expired
        return failedWorkflow(init, 'expired');
      }) as unknown as typeof fetch,
    });
    const result = await e.embed(inputs(2));
    expect(posts).toBe(2); // at 10 min one re-submit fits the 15-min window; at 20 min none does

    expect(result.failed.sort()).toEqual([1, 2]);
    expect(result.error).toBeUndefined();
  });

  test('one image whose step failed is that image failing: no retry', async () => {
    let posts = 0;
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      posts++;
      return failedWorkflow(init, 'failed');
    }) as unknown as typeof fetch;
    const result = await clocked(fetchImpl).e.embed(inputs(1));
    expect(posts).toBe(1);
    expect(result.failed).toEqual([1]);
  });

  // Ephemeral workflows ignore externalId, so a submit that may have been accepted is only sent
  // again once its steps should be done and cached. Re-sending at once doubles the GPU work.
  test.each([
    ['a network error', () => Promise.reject(new TypeError('socket hang up'))],
    ['a reset after connecting', () => fetchFailed('ECONNRESET')],
    ['an unreachable host on a reused socket', () => fetchFailed('EHOSTUNREACH')],
    ['a TLS error mid-request', () => fetchFailed('ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC')],
    ['a 502', async () => new Response('bad gateway', { status: 502 })],
  ])('an ambiguous submit (%s) is not re-sent before the resubmit delay', async (_, fail) => {
    const posts: number[] = [];
    const bodies: Record<string, unknown>[] = [];
    let now = () => 0;
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      posts.push(now());
      bodies.push(JSON.parse(String(init?.body)));
      if (posts.length === 1) return fail();
      return ok(init, 50);
    }) as unknown as typeof fetch;
    const run = clocked(fetchImpl);
    now = run.now;
    const result = await run.e.embed(inputs(1));
    expect(result.vectors.size).toBe(1);
    expect(posts).toHaveLength(2);
    expect(posts[1] - posts[0]).toBeGreaterThanOrEqual(120_000);
    expect(bodies[1]).not.toHaveProperty('externalId');
  });

  // Nothing reached the orchestrator, so nothing can be running: waiting 120 s per retry through
  // an outage would only stall the batch.
  test.each([
    'ECONNREFUSED',
    'ENOTFOUND',
    'UND_ERR_CONNECT_TIMEOUT',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
  ])(
    'a submit that never left (%s) is retried with normal backoff, not the resubmit delay',
    async (code) => {
      const posts: number[] = [];
      let now = () => 0;
      const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
        posts.push(now());
        if (posts.length === 1) return fetchFailed(code);
        return ok(init, 50);
      }) as unknown as typeof fetch;
      const run = clocked(fetchImpl);
      now = run.now;
      const result = await run.e.embed(inputs(1));
      expect(result.vectors.size).toBe(1);
      expect(posts[1] - posts[0]).toBeLessThan(120_000);
    }
  );

  test('a 2xx submit whose body is cut off is re-sent only after the resubmit delay', async () => {
    const posts: number[] = [];
    let now = () => 0;
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      posts.push(now());
      if (posts.length === 1) return new Response('{"id":"wf1","sta', { status: 200 });
      return ok(init, 50);
    }) as unknown as typeof fetch;
    const run = clocked(fetchImpl);
    now = run.now;
    const result = await run.e.embed(inputs(1));
    expect(result.vectors.size).toBe(1);
    expect(posts[1] - posts[0]).toBeGreaterThanOrEqual(120_000);
  });

  // The caller (a backfill page, the next consumer flush) retries a failed embed within seconds,
  // so giving up on a workflow that may still be running has to wait out the resubmit delay first.
  test.each([
    ['submits', (init?: RequestInit) => init?.method === 'POST'],
    ['polls', (init?: RequestInit) => init?.method === 'GET'],
  ])('giving up on ambiguous %s waits before returning to the caller', async (_, fails) => {
    let last = 0;
    let now = () => 0;
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      last = now();
      if (fails(init)) return new Response('', { status: 503 });
      return new Response(JSON.stringify({ id: 'wf1', status: 'processing' }), { status: 202 });
    }) as unknown as typeof fetch;
    const run = clocked(fetchImpl);
    now = run.now;
    const result = await run.e.embed(inputs(1));
    expect(String(result.error)).toMatch(/gave up/);
    expect(run.now() - last).toBeGreaterThanOrEqual(120_000);
  });

  // Cache hits create no orchestrator job, so no job budget bounded them: a restart re-walked
  // ~1,365 steps/min. Steps now go out at a steady rate whatever they cost the orchestrator.
  // Each submit reserves the next slot; with the clock held still, the waits are the schedule.
  const pacedWaits = async (configured: number, limit?: number) => {
    const waits: number[] = [];
    const e = new Embedder({
      endpoint: 'http://orch',
      token: 't',
      maxInFlight: 500,
      maxRetries: 0,
      batchSize: 10,
      priority: 'low',
      maxStepsPerSecond: configured,
      now: () => 0,
      sleep: async (ms) => void waits.push(ms),
      fetch: (async (_u: string | URL | Request, init?: RequestInit) =>
        ok(init, 500)) as unknown as typeof fetch,
    });
    if (limit !== undefined) e.setLimits({ stepsPerSecond: limit });
    const result = await e.embed(inputs(50));
    expect(result.vectors.size).toBe(50);
    return waits;
  };

  test('steps are submitted at a steady rate, even when every step returns at once', async () => {
    // 10 steps at 5/s: one workflow every 2 s, the first at once.
    expect(await pacedWaits(5)).toEqual([2000, 4000, 6000, 8000]);
  });

  // Two pages share one embedder: a batch sized before its pace wait could overrun the quota
  // that another page's responses lowered meanwhile.
  test('a paced batch is sized from the quota left after its wait', async () => {
    const sizes: number[] = [];
    const e: Embedder = new Embedder({
      endpoint: 'http://orch',
      token: 't',
      maxInFlight: 500,
      maxRetries: 0,
      batchSize: 10,
      priority: 'low',
      maxStepsPerSecond: 5,
      now: () => 0,
      sleep: async () => void (e.limits.remaining = 3),
      fetch: (async (_u: string | URL | Request, init?: RequestInit) => {
        sizes.push(stepIds(init).length);
        return new Response(workflowBody(stepIds(init)), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await e.embed(inputs(20));
    expect(sizes.slice(0, 2)).toEqual([10, 3]);
  });

  test('a runtime step rate lowers the configured one but cannot raise it', async () => {
    expect(await pacedWaits(5, 1)).toEqual([10_000, 20_000, 30_000, 40_000]);
    expect(await pacedWaits(5, 1000)).toEqual([2000, 4000, 6000, 8000]);
  });

  test('Retry-After: 0 still waits, so a 429 is never a tight loop', async () => {
    let calls = 0;
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      if (++calls <= 3) return new Response('', { status: 429, headers: { 'Retry-After': '0' } });
      return ok(init, 50);
    }) as unknown as typeof fetch;
    const run = clocked(fetchImpl);
    await run.e.embed(inputs(1));
    expect(run.now()).toBeGreaterThanOrEqual(3 * 250);
  });

  test('429s are budgeted by time (2 h), longer than one workflow can hold the quota', async () => {
    const times: number[] = [];
    let now = () => 0;
    const fetchImpl = (async () => {
      times.push(now());
      // Without the hold this spins on microtasks and no test timeout can fire; ~12 are expected.
      if (times.length > 100)
        return new Response('runaway: Retry-After not waited', { status: 418 });
      return new Response('', { status: 429, headers: { 'Retry-After': '600' } });
    }) as unknown as typeof fetch;
    const run = clocked(fetchImpl);
    now = run.now;
    const result = await run.e.embed(inputs(1));
    expect(String(result.error)).toMatch(/gave up/);
    expect(Math.max(...times)).toBeGreaterThanOrEqual(2 * 60 * 60_000 - 600_000);
    expect(times.length).toBeGreaterThan(10);
  });

  test('a step with no profile or revision is failed, not kept unchecked', async () => {
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(workflowBody(stepIds(init)));
      delete body.steps[0].output.profile;
      delete body.steps[1].output.modelRevision;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const { e } = clocked(fetchImpl);
    const result = await e.embed(inputs(3));
    expect(result.failed.sort()).toEqual([1, 2]);
    expect([...result.vectors.keys()]).toEqual([3]);
  });

  test('isStamped needs the image profile, not only a revision', async () => {
    let metadata: Record<string, unknown> = { modelRevision: 'r1', videoProfile: 'v1' };
    const client = { getCollection: async () => ({ config: { metadata } }) };
    const store = new VectorStore(client as unknown as QdrantClient, 'c');
    expect(await store.isStamped()).toBe(false);
    metadata = { ...metadata, profile: 'p1' };
    expect(await store.isStamped()).toBe(true);
  });

  test('an in-flight cap below the batch size is refused, since it now counts jobs', async () => {
    vi.resetModules();
    const saved = { ...process.env };
    Object.assign(process.env, {
      ORCHESTRATOR_ENDPOINT: 'http://orch',
      VECTOR_EMBED_TOKEN: 't',
      VECTOR_IMAGE_LOCATION: 'https://cdn.example',
      VECTOR_EMBED_MAX_IN_FLIGHT: '4',
    });
    try {
      const { Embedder: E } = await import('@/vector-sync/embedder');
      expect(() => E.fromConfig('low')).toThrow(/counts jobs/);
    } finally {
      process.env = saved;
    }
  });
});

describe('ratelimit module', () => {
  test('parses quoted and token names, skips malformed items and non-numeric params', () => {
    const parsed = parseRateLimitHeader('"a,b";q=5, plain;r=2;t=1, ;q=3, "c";x=abc;q=7');
    expect(parsed.get('a,b')).toEqual({ q: 5 });
    expect(parsed.get('plain')).toEqual({ r: 2, t: 1 });
    expect(parsed.get('c')).toEqual({ q: 7 });
    expect(parsed.size).toBe(3);
  });

  test('an empty or non-decimal param is dropped, not read as 0 (r=0 would mean no quota left)', () => {
    expect(parseRateLimitHeader('p;r=;q=0x10;t=1e3;w=   ').get('p')).toEqual({});
  });

  test('Retry-After as seconds or an HTTP-date', () => {
    const now = Date.parse('2026-10-24T02:00:00Z');
    expect(parseRetryAfter('1', now)).toBe(1000);
    expect(parseRetryAfter('0.5', now)).toBe(500);
    expect(parseRetryAfter('Sat, 24 Oct 2026 02:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter('Sat, 24 Oct 2026 01:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });

  // Past 2^31 ms setTimeout fires at once, so an unbounded hold became a 1 ms spin.
  test('Retry-After is capped at an hour', () => {
    expect(parseRetryAfter('86400', 0)).toBe(3_600_000);
    expect(parseRetryAfter('9'.repeat(400), 0)).toBe(3_600_000);
    expect(parseRetryAfter('Sat, 24 Oct 2099 02:00:00 GMT', 0)).toBe(3_600_000);
  });

  test('may I send N now / when to retry', () => {
    const rl = new RateLimiter('inflight-x');
    expect(rl.allowance(128, false, 0)).toBe(128);
    rl.observe(
      new Headers({ 'RateLimit-Policy': '"inflight-x";q=80', RateLimit: '"inflight-x";r=3;t=0' })
    );
    expect([rl.quota, rl.remaining]).toEqual([80, 3]);
    expect(rl.allowance(128, false, 0)).toBe(3);
    rl.reserve(3);
    expect(rl.allowance(128, false, 0)).toBe(0);
    expect(rl.allowance(128, true, 0)).toBe(1);
    expect(rl.hold(0, 1000)).toBe(250);
    expect(rl.waitMs(1100)).toBe(150);
    expect(rl.allowance(128, true, 1100)).toBe(0);
  });
});
