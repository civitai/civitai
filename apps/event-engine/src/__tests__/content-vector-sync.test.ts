import { createHash } from 'crypto';
import { describe, expect, test, vi } from 'vitest';
import type { EmbedInput } from '@/vector-sync/embedder';
import { syncIds, type Domain, type DomainPayload } from '@/vector-sync/domain/sync';
import { DomainSyncQueue } from '@/vector-sync/domain/queue';
import { vectorSyncMetrics } from '@/vector-sync/metrics';
import { contentRoute, OUTBOX_TOPIC, selectDomains } from '@/vector-sync/content/consumer';
import type { VectorPoint } from '@/vector-sync/qdrant';

type Payload = DomainPayload & { title: string; nsfwLevel: number[] };

const doc = (title: string, nsfw = 1): Payload => ({
  title,
  nsfwLevel: [nsfw],
  search_text: `Title: ${title}`,
  docHash: createHash('sha256').update(`Title: ${title}`).digest('hex'),
});

/** Records every write, so a test can say exactly how many Qdrant writes a sync made. */
class Store {
  points = new Map<number, VectorPoint<Payload>>();
  writes: string[] = [];
  failNext = false;
  /** Only the requested fields, as Qdrant's include does, so a field the sync forgets to read shows. */
  payloadFields = async (ids: number[], fields: string[]) =>
    new Map(
      ids.flatMap((id) => {
        const p = this.points.get(id)?.payload as Record<string, unknown> | undefined;
        return p ? [[id, Object.fromEntries(fields.map((f) => [f, p[f]]))]] : [];
      })
    );
  delete = async (ids: number[]) => {
    for (const id of ids) this.writes.push(`delete ${id}`), this.points.delete(id);
  };
  setPayloads = async (payloads: Map<number, Payload>) => {
    if (this.failNext && payloads.size) throw new Error('qdrant down');
    for (const [id, payload] of payloads) {
      this.writes.push(`payload ${id}`);
      const point = this.points.get(id);
      if (point) point.payload = payload;
    }
  };
  upsert = async (points: VectorPoint<Payload>[]) => {
    for (const p of points) this.writes.push(`upsert ${p.id}`), this.points.set(p.id, p);
  };
  assertModel = async () => undefined;
  isStamped = async () => true;
  idsMatching = async () => [];
}

const embedder = {
  embed: async (
    inputs: EmbedInput[],
    o: { onVectors?: (v: Map<number, number[]>) => Promise<void> } = {}
  ) => {
    const vectors = new Map(inputs.map((i) => [Number(i.id), [1]]));
    await o.onVectors?.(vectors);
    return { vectors, failed: [], stamp: undefined };
  },
};

function setup() {
  const rows = new Map<number, Payload>();
  const getDocs = async (_pg: unknown, ids: number[]) =>
    new Map(ids.flatMap((id) => (rows.has(id) ? [[id, { ...rows.get(id)! }]] : [])));
  const store = new Store();
  const deps = { pg: { query: vi.fn() }, store, embedder } as never;
  return { rows, getDocs, store, deps };
}

describe('domain sync writes nothing for an unchanged row', () => {
  test('a re-read of an unchanged row makes zero Qdrant writes; a changed field makes one', async () => {
    const { rows, getDocs, store, deps } = setup();
    rows.set(1, doc('castle'));
    await syncIds(getDocs, [1], deps);
    expect(store.writes).toEqual(['upsert 1']);

    store.writes = [];
    const stats = await syncIds(getDocs, [1], deps);
    expect(store.writes).toEqual([]);
    expect(stats).toMatchObject({ unchanged: 1, updated: 0, embedded: 0 });

    rows.set(1, doc('castle', 4));
    expect(await syncIds(getDocs, [1], deps)).toMatchObject({ updated: 1, unchanged: 0 });
    expect(store.writes).toEqual(['payload 1']);
    expect(store.points.get(1)!.payload.nsfwLevel).toEqual([4]);
  });

  test('an edit that changes the text and the rating moves the rating at once, before the re-embed', async () => {
    const { rows, getDocs, store, deps } = setup();
    rows.set(1, doc('castle', 1));
    await syncIds(getDocs, [1], deps);
    rows.set(1, doc('dungeon', 16));
    store.writes = [];
    await syncIds(getDocs, [1], { ...(deps as object), embedder: null } as never);
    // No embedder: only the payload moves; the old docHash stays so the next sync re-embeds.
    expect(store.writes).toEqual(['payload 1']);
    expect(store.points.get(1)!.payload).toMatchObject({
      nsfwLevel: [16],
      docHash: doc('castle').docHash,
    });
    store.writes = [];
    await syncIds(getDocs, [1], deps);
    expect(store.writes).toEqual(['upsert 1']);
    expect(store.points.get(1)!.payload.docHash).toBe(doc('dungeon').docHash);
  });

  test('a point written before payloadHash existed is rewritten once, then left alone', async () => {
    const { rows, getDocs, store, deps } = setup();
    rows.set(1, doc('castle'));
    store.points.set(1, { id: 1, vector: [1], payload: doc('castle') });

    await syncIds(getDocs, [1], deps);
    expect(store.writes).toEqual(['payload 1']);
    store.writes = [];
    await syncIds(getDocs, [1], deps);
    expect(store.writes).toEqual([]);
  });
});

const domain = (name: string, over: Partial<Domain<Payload>> = {}): Domain<Payload> => ({
  name,
  table: name,
  getDocs: async () => new Map(),
  topics: [`postgres.${name}`],
  refFromEvent: (_t, v) => ({ id: (v as { after: { id: number } }).after.id }),
  cdcTables: [],
  store: () => {
    throw new Error('not in tests');
  },
  alias: () => name,
  ...over,
});

describe('content consumer routing', () => {
  const article = domain('article', { outboxEntity: 'Article' });
  const comic = domain('comic', { outboxEntity: 'Comic' });
  const route = contentRoute([article, comic]);
  const outbox = (after: Record<string, unknown>, op = 'c') => route(OUTBOX_TOPIC, { op, after });

  test('a search.update Outbox insert reaches the domain its entityType names', () => {
    expect(outbox({ event: 'search.update', entityType: 'Article', entityId: 42 })).toEqual([
      ['article', { id: 42 }],
    ]);
    expect(outbox({ event: 'search.update', entityType: 'Comic', entityId: '7' })).toEqual([
      ['comic', { id: 7 }],
    ]);
  });

  test('other Outbox rows, deletes of the row, and unknown entities are ignored', () => {
    expect(outbox({ event: 'PUBLISHED', entityType: 'Article', entityId: 42 })).toEqual([]);
    expect(
      route(OUTBOX_TOPIC, { op: 'd', before: { event: 'search.update' }, after: null })
    ).toEqual([]);
    expect(outbox({ event: 'search.update', entityType: 'Model', entityId: 42 })).toEqual([]);
    expect(route(OUTBOX_TOPIC, null)).toEqual([]);
  });

  test("a domain's own topic reaches only that domain", () => {
    expect(route('postgres.comic', { op: 'u', after: { id: 3 } })).toEqual([['comic', { id: 3 }]]);
    expect(route('postgres.other', { op: 'u', after: { id: 3 } })).toEqual([]);
  });

  test('the domain list refuses an unknown name and an empty list', () => {
    expect(selectDomains(['comic'], [article, comic])).toEqual([comic]);
    expect(() => selectDomains(['comics'], [article, comic])).toThrow(
      /Unknown content domains: comics/
    );
    expect(() => selectDomains([], [article, comic])).toThrow(/names no domain/);
  });
});

describe('one queue over several domains', () => {
  test("a failing domain doesn't stop the others' writes, and holds the offset until it recovers", async () => {
    const a = setup();
    const b = setup();
    a.rows.set(1, doc('a'));
    b.rows.set(1, doc('b'));
    const commits: unknown[] = [];
    const q = new DomainSyncQueue(
      [
        // The failing domain first, so a flush that stopped at the first failure would show.
        { domain: domain('comic', { getDocs: b.getDocs }), deps: b.deps },
        { domain: domain('article', { getDocs: a.getDocs }), deps: a.deps },
      ],
      async (o) => void commits.push(o)
    );
    b.store.points.set(1, { id: 1, vector: [1], payload: doc('old b') });
    b.store.failNext = true;
    const at = { topic: OUTBOX_TOPIC, partition: 0, offset: '9' };
    q.add('article', { id: 1 }, at);
    q.add('comic', { id: 1 }, at);

    await expect(q.flush()).rejects.toThrow('qdrant down');
    expect(a.store.writes).toEqual(['upsert 1']);
    expect(commits).toEqual([]);

    b.store.failNext = false;
    await q.flush();
    expect(commits).toEqual([[{ ...at, offset: '10' }]]);
  });
});

describe('ingestion metrics', () => {
  const value = async (
    metric: {
      get: () => Promise<{ values: { value: number; labels: object; metricName?: string }[] }>;
    },
    labels: Record<string, string>,
    metricName?: string
  ) =>
    (await metric.get()).values.find(
      (v) =>
        (!metricName || v.metricName === metricName) &&
        Object.entries(labels).every(([k, x]) => (v.labels as Record<string, unknown>)[k] === x)
    )?.value ?? 0;

  test('a flush counts its embeds, deletes and skips under its own domain', async () => {
    const name = 'metrics-probe';
    const { rows, getDocs, store, deps } = setup();
    rows.set(1, doc('castle'));
    store.points.set(2, { id: 2, vector: [1], payload: doc('gone') });
    const q = new DomainSyncQueue([{ domain: domain(name, { getDocs }), deps }], async () => {});
    const at = { topic: OUTBOX_TOPIC, partition: 0, offset: '1' };
    const points = (outcome: string) => value(vectorSyncMetrics.points, { domain: name, outcome });

    q.add(name, { id: 1 }, at);
    q.add(name, { id: 2 }, at);
    await q.flush();
    expect([await points('embedded'), await points('deleted'), await points('updated')]).toEqual([
      1, 1, 0,
    ]);
    expect(
      await value(
        vectorSyncMetrics.embedSeconds,
        { domain: name },
        'vector_sync_embed_duration_seconds_count'
      )
    ).toBe(1);

    q.add(name, { id: 1 }, at);
    await q.flush();
    expect(await points('embedded')).toBe(1);
    expect(await value(vectorSyncMetrics.skipped, { domain: name, reason: 'unchanged' })).toBe(1);

    store.failNext = true;
    rows.set(1, doc('castle', 4));
    q.add(name, { id: 1 }, at);
    await expect(q.flush()).rejects.toThrow('qdrant down');
    expect(await value(vectorSyncMetrics.flushErrors, { domain: name })).toBe(1);
  });
});

describe('switches', () => {
  async function withEnv<T>(env: Record<string, string | undefined>, run: () => Promise<T>) {
    const saved = { ...process.env };
    vi.resetModules();
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return await run();
    } finally {
      process.env = saved;
    }
  }

  test('VECTOR_<NAME>_EMBED_ENABLED: needs the global switch; models default on, new domains off', async () => {
    const check = (env: Record<string, string | undefined>) =>
      withEnv(env, async () => {
        const { domainEmbedEnabled } = await import('@/config');
        return [domainEmbedEnabled('model', true), domainEmbedEnabled('article')];
      });
    const base = { VECTOR_MODEL_EMBED_ENABLED: undefined, VECTOR_ARTICLE_EMBED_ENABLED: undefined };
    expect(await check({ ...base, VECTOR_SYNC_EMBED_ENABLED: 'true' })).toEqual([true, false]);
    expect(
      await check({
        ...base,
        VECTOR_SYNC_EMBED_ENABLED: 'true',
        VECTOR_ARTICLE_EMBED_ENABLED: 'true',
        VECTOR_MODEL_EMBED_ENABLED: 'false',
      })
    ).toEqual([false, true]);
    expect(
      await check({
        ...base,
        VECTOR_SYNC_EMBED_ENABLED: undefined,
        VECTOR_ARTICLE_EMBED_ENABLED: 'true',
      })
    ).toEqual([false, false]);
  });

  test('CDC_CONTENT_ENABLED: off leaves the connector as it was; on adds every content table without its big columns', async () => {
    const connector = (env: Record<string, string | undefined>) =>
      withEnv(env, async () => {
        const { DebeziumManager } = await import('@/services/debezium-manager');
        return {
          tables: DebeziumManager.getConnectorTables(),
          columns: DebeziumManager.getColumnExclusions()['column.exclude.list']?.split(',') ?? [],
        };
      });
    const none = {
      CDC_MODEL_ENABLED: undefined,
      CDC_IMAGE_ENABLED: undefined,
      CDC_CONTENT_ENABLED: undefined,
    };
    const off = await connector(none);
    const on = await connector({ ...none, CDC_CONTENT_ENABLED: 'true' });
    expect(off.columns).toEqual([]);
    expect(on.tables.filter((t) => !off.tables.includes(t))).toEqual([
      'public.ComicProject',
      'public.ComicChapter',
      'public.Challenge',
      'public.ChallengeEvent',
      'public.Crucible',
      'public.Model3D',
      'public.TagsOnModel3D',
      'public.Storyline',
      'public.StorylineChapter',
    ]);
    expect(on.columns).toEqual(
      expect.arrayContaining([
        'public.ComicProject.description',
        'public.ComicChapter.earlyAccessConfig',
        'public.Challenge.prizes',
        'public.Crucible.takedownReason',
        'public.Model3D.generationParams',
      ])
    );
    expect(on.columns).not.toContain('public.Model.description');

    const both = await connector({
      ...none,
      CDC_CONTENT_ENABLED: 'true',
      CDC_MODEL_ENABLED: 'true',
    });
    expect(both.columns).toEqual(
      expect.arrayContaining(['public.Model.description', 'public.Model3D.meta'])
    );
  });
});

test('a search.update Outbox row, which no handler claims, is still drained from the Outbox', async () => {
  // The site writes these for the content consumer; the main processor must remove them, or the
  // backstop poller would retry and park them.
  const { outboxHandler } = await import('@/handlers/outbox');
  const outboxRemove = vi.fn(async () => undefined);
  await outboxHandler.process({
    record: { id: 5, event: 'search.update', entityType: 'Article', entityId: 42, details: null },
    actions: { outboxRemove },
  } as never);
  expect(outboxRemove).toHaveBeenCalledWith(5);
});
