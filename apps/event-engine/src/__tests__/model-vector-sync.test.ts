import { describe, expect, test, vi } from 'vitest';
import { Embedder, type EmbedInput } from '@/vector-sync/embedder';
import {
  cleanHtml,
  modelDocument,
  normalizeTitle,
  nsfwLevels,
  type ModelSource,
} from '@/vector-sync/models/document';
import { getModelDocs, type ModelPayload } from '@/vector-sync/models/source';
import { backfillModels } from '@/vector-sync/models/backfill';
import { syncModelIds, type ModelSyncDeps } from '@/vector-sync/models/sync';
import {
  modelRefFromEvent,
  ModelSyncQueue,
  type ModelQueueDeps,
} from '@/vector-sync/models/consumer';
import type { QdrantClient } from '@qdrant/js-client-rest';
import {
  ModelMismatchError,
  VectorStore,
  type ModelStamp,
  type VectorPoint,
} from '@/vector-sync/qdrant';

const VECTOR = Array.from({ length: 256 }, (_, i) => (i === 0 ? 1 : 0));
const STAMP = { model: 'wemm-2b', modelRevision: 'r1', profile: 'text', dimensions: 256 };

function model(id: number, over: Partial<ModelSource & { nsfwLevel: number }> = {}) {
  return {
    id,
    name: `Model ${id}`,
    type: 'LORA',
    username: 'someone',
    description: '<p>A <b>soft</b> watercolor style.</p>',
    tags: ['style'],
    versions: [
      { id: id * 10, name: 'v1', description: null, baseModel: 'SDXL 1.0', trainedWords: ['wc'] },
    ],
    checkpointType: null,
    nsfwLevel: 1,
    publishedAt: new Date('2026-01-01T00:00:00Z'),
    userId: 7,
    ...over,
  };
}

/** Postgres as the query sees it: only eligible models come back. */
class FakeDb {
  rows = new Map<number, ReturnType<typeof model>>();
  /** Every Model row, eligible or not; defaults to the eligible ones. */
  extraIds = new Set<number>();
  get ids() {
    return new Set([...this.rows.keys(), ...this.extraIds]);
  }
  /** Runs once, after the first read, as a write committed while vectors are made. */
  onRead?: () => void;
  /** One hook per document read, in order, for writes across several rounds. */
  onReads: Array<() => void> = [];
  query = async (sql: string, params: unknown[]) => {
    // The backfill's page query: ids in [from, cursor), newest first.
    if (sql.startsWith('SELECT id FROM')) {
      const [from, cursor, limit] = params as number[];
      const ids = [...this.ids].filter((id) => id >= from && id < cursor).sort((a, b) => b - a);
      return { rows: ids.slice(0, limit).map((id) => ({ id })) };
    }
    const [ids] = params as [number[]];
    const rows = ids.flatMap((id) => (this.rows.has(id) ? [{ ...this.rows.get(id)! }] : []));
    const hook = this.onRead ?? this.onReads.shift();
    this.onRead = undefined;
    hook?.();
    return { rows };
  };
}

class FakeStore {
  points = new Map<number, VectorPoint<ModelPayload>>();
  payloadFields = async (ids: number[]) =>
    new Map(
      ids.flatMap((id) => (this.points.has(id) ? [[id, this.points.get(id)!.payload]] : []))
    ) as Map<number, Partial<ModelPayload>>;
  delete = async (ids: number[]) => void ids.forEach((id) => this.points.delete(id));
  setPayloads = async (payloads: Map<number, ModelPayload>) => {
    for (const [id, payload] of payloads) {
      const point = this.points.get(id);
      if (point) point.payload = payload;
    }
  };
  upsert = async (points: VectorPoint<ModelPayload>[]) =>
    void points.forEach((p) => this.points.set(p.id, p));
  assertModel = async (_stamp: ModelStamp) => undefined;
  stamped = true;
  isStamped = async () => this.stamped;
  idsMatching = async (field: keyof ModelPayload, values: number[]) =>
    [...this.points.values()]
      .filter((p) => (p.payload[field] as number[] | undefined)?.some((v) => values.includes(v)))
      .map((p) => p.id);
  idsInRange = async (lo: number, hi: number) =>
    [...this.points.keys()].filter((id) => id >= lo && id < hi).sort((a, b) => a - b);
}

class FakeEmbedder {
  texts: string[] = [];
  /** Steps that fail, as the orchestrator reports them: counted, no vector. */
  failIds = new Set<string>();
  embed = async (
    inputs: EmbedInput[],
    { onVectors }: { onVectors?: (v: Map<number, number[]>) => Promise<void> } = {}
  ) => {
    this.texts.push(...inputs.map((i) => i.text!));
    const ok = inputs.filter((i) => !this.failIds.has(i.id));
    const vectors = new Map(ok.map((i) => [Number(i.id), [Number(i.id)]]));
    await onVectors?.(vectors);
    const failed = inputs.filter((i) => this.failIds.has(i.id)).map((i) => i.id);
    return { vectors, failed, stamp: STAMP };
  };
}

function setup() {
  const db = new FakeDb();
  const store = new FakeStore();
  const embedder = new FakeEmbedder();
  const deps = { pg: db, store, embedder } as unknown as ModelSyncDeps & {
    store: FakeStore;
  };
  return { db, store, embedder, deps };
}

describe('model document', () => {
  test('title key matches the search service: NFKC, lowercase, Python str.split()', () => {
    expect(normalizeTitle('  Moss-Image   LoRA ')).toBe('moss-image lora');
    // Fullwidth letters fold under NFKC.
    expect(normalizeTitle('\uff2d\uff2f\uff33\uff33')).toBe('moss');
    // Python splits on U+001C and U+0085 and not on U+FEFF; JS `\s` does the opposite.
    expect(normalizeTitle('a\x1cb\x85c')).toBe('a b c');
    expect(normalizeTitle('a\ufeffb')).toBe('a\ufeffb');
  });

  test('text has the demo layout, three versions, deduped triggers and a 5,000 cap', () => {
    const versions = ['one', 'two', 'three', 'four'].map((name, i) => ({
      id: i + 1,
      name,
      description: `<p>${name} notes</p>`,
      baseModel: name === 'one' ? 'SDXL 1.0' : 'Illustrious',
      trainedWords: ['wc', name],
    }));
    const doc = modelDocument(model(1, { versions }));
    expect(doc.text).toBe(
      [
        'Name: Model 1',
        'Type: LORA',
        'Creator: someone',
        'Tags: style',
        'Base models: Illustrious, SDXL 1.0',
        'Trigger words: wc, one, two, three, four',
        'Description: A soft watercolor style.',
        'Versions: one: one notes two: two notes three: three notes',
      ].join('\n')
    );
    const long = modelDocument(model(1, { description: '\u{1F3A8}'.repeat(6000) }));
    expect([...long.text]).toHaveLength(5000);
  });

  test('html cleaning drops script, decodes entities and spaces block tags', () => {
    expect(cleanHtml('<p>a&amp;b</p><p>c&#233;</p><script>x()</script>d&unknown;')).toBe(
      'a&b c\u00e9 d&unknown;'
    );
  });

  test('a bitmask becomes its set levels', () => {
    expect(nsfwLevels(0)).toEqual([]);
    expect(nsfwLevels(1 | 4 | 16)).toEqual([1, 4, 16]);
  });
});

describe('syncModelIds', () => {
  test('a new model is embedded from its document and stored with the agreed payload', async () => {
    const { db, store, embedder, deps } = setup();
    db.rows.set(1, model(1));
    const stats = await syncModelIds([1], deps);
    expect(stats).toMatchObject({ eligible: 1, embedded: 1 });
    const point = store.points.get(1)!;
    expect(embedder.texts).toEqual([point.payload.search_text]);
    expect(point.payload).toMatchObject({
      title_normalized: 'model 1',
      type: 'LORA',
      baseModels: ['SDXL 1.0'],
      nsfwLevel: [1],
      publishedAt: '2026-01-01T00:00:00.000Z',
      tags: ['style'],
      triggerWords: ['wc'],
    });
  });

  test('an unchanged document only rewrites the payload; an edited one is re-embedded', async () => {
    const { db, store, embedder, deps } = setup();
    db.rows.set(1, model(1));
    await syncModelIds([1], deps);

    db.rows.set(1, model(1, { nsfwLevel: 4 }));
    expect(await syncModelIds([1], deps)).toMatchObject({ embedded: 0, updated: 1 });
    expect(store.points.get(1)!.payload.nsfwLevel).toEqual([4]);
    expect(embedder.texts).toHaveLength(1);

    db.rows.set(1, model(1, { description: 'now about castles' }));
    expect(await syncModelIds([1], deps)).toMatchObject({ embedded: 1, updated: 0 });
    expect(embedder.texts[1]).toContain('now about castles');
  });

  test('an unpublished or deleted model loses its point', async () => {
    const { db, store, deps } = setup();
    db.rows.set(1, model(1));
    await syncModelIds([1], deps);
    db.rows.delete(1);
    expect(await syncModelIds([1, 2], deps)).toMatchObject({ deleted: 1 });
    expect(store.points.has(1)).toBe(false);
  });

  test('a model with no published version gets no point', async () => {
    const { db, store, deps } = setup();
    db.rows.set(1, model(1, { versions: [] }));
    await syncModelIds([1], deps);
    expect(store.points.size).toBe(0);
  });

  test('an edit committed during the embed is embedded again, not left stale', async () => {
    const { db, store, embedder, deps } = setup();
    db.rows.set(1, model(1));
    db.onRead = () => db.rows.set(1, model(1, { description: 'edited meanwhile' }));
    await syncModelIds([1], deps);
    expect(embedder.texts).toHaveLength(2);
    expect(store.points.get(1)!.payload.search_text).toContain('edited meanwhile');
  });

  test('an unpublish committed during the embed deletes the point just written', async () => {
    const { db, store, deps } = setup();
    db.rows.set(1, model(1));
    db.onRead = () => db.rows.delete(1);
    expect(await syncModelIds([1], deps)).toMatchObject({ embedded: 0, deleted: 1 });
    expect(store.points.has(1)).toBe(false);
  });

  test('a dry run writes nothing and counts what it would embed', async () => {
    const { db, store, embedder, deps } = setup();
    db.rows.set(1, model(1));
    expect(await syncModelIds([1], { ...deps, dryRun: true })).toMatchObject({ embedded: 1 });
    expect(store.points.size).toBe(0);
    expect(embedder.texts).toHaveLength(0);
  });
});

test('a text input is sent to the orchestrator as text', async () => {
  let body: { steps: Array<{ name: string; input: Record<string, unknown> }> } | undefined;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        id: 'wf',
        status: 'succeeded',
        steps: body!.steps.map((s) => ({
          name: s.name,
          status: 'succeeded',
          output: { ...STAMP, precision: 'float32', embedding: VECTOR },
        })),
      })
    );
  }) as unknown as typeof fetch;
  const e = new Embedder({
    endpoint: 'http://orch',
    token: 't',
    maxInFlight: 8,
    maxRetries: 0,
    priority: 'low',
    fetch: fetchImpl,
  });
  const stamps: ModelStamp[] = [];
  const result = await e.embed([{ id: '5', text: 'Name: Model 5' }], {
    acceptStamp: async (stamp) => void stamps.push(stamp),
  });
  // The model check sees a text step's profile where the site's query path reads it.
  expect(stamps).toEqual([STAMP]);
  expect(body!.steps[0].input).toMatchObject({ text: 'Name: Model 5' });
  expect(body!.steps[0].input).not.toHaveProperty('imageUrl');
  expect(result.vectors.get(5)).toEqual(VECTOR);
});

describe('review fixes', () => {
  test('a re-embed that fails still moves the payload, and keeps the old hash so it retries', async () => {
    const { db, store, embedder, deps } = setup();
    db.rows.set(1, model(1));
    await syncModelIds([1], deps);
    const oldHash = store.points.get(1)!.payload.docHash;

    db.rows.set(1, model(1, { description: 'now explicit', nsfwLevel: 16 }));
    embedder.failIds.add('1');
    expect(await syncModelIds([1], deps)).toMatchObject({ embedded: 0, failed: 1 });
    // A stale nsfwLevel would let a browsing filter match what it must not.
    expect(store.points.get(1)!.payload).toMatchObject({ nsfwLevel: [16], docHash: oldHash });

    embedder.failIds.clear();
    expect(await syncModelIds([1], deps)).toMatchObject({ embedded: 1 });
    expect(store.points.get(1)!.payload.docHash).not.toBe(oldHash);
  });

  test('a lone surrogate or NUL reference becomes U+FFFD, not invalid JSON', () => {
    expect(cleanHtml('a&#xD800;b&#0;c')).toBe('a\ufffdb\ufffdc');
  });

  test('table cells and lists are spaced; a script cut short by truncation is dropped', () => {
    expect(cleanHtml('<td>foo</td><td>bar</td><h4>baz</h4><!-- x > y -->q')).toBe('foo bar baz q');
    expect(cleanHtml('kept <script>var leaked = 1')).toBe('kept');
  });

  test('the backfill walks every id once, deletes points of hard-deleted models, and resumes', async () => {
    const { db, store, deps } = setup();
    for (const id of [2, 3, 5, 8, 9]) db.rows.set(id, model(id));
    db.extraIds.add(7); // a draft: a row, not eligible
    // A model that had a point, then was hard-deleted: no row at all.
    store.points.set(6, { id: 6, vector: [6], payload: {} as ModelPayload });

    const first = await backfillModels({ from: 0, to: 10, page: 2, limit: 3 }, deps);
    expect(first).toMatchObject({ complete: false, next: 5 });
    expect([...store.points.keys()].sort()).toEqual([5, 8, 9]);

    const rest = await backfillModels({ from: 0, to: first.next, page: 2 }, deps);
    expect(rest.complete).toBe(true);
    expect([...store.points.keys()].sort()).toEqual([2, 3, 5, 8, 9]);
  });
});

describe('second review fixes', () => {
  test('an edit during the last round still lands its payload, and is counted stale', async () => {
    const { db, store, deps } = setup();
    db.rows.set(1, model(1));
    const edit =
      (n: number, nsfwLevel = 1) =>
      () =>
        db.rows.set(1, model(1, { description: `edit ${n}`, nsfwLevel }));
    // Reads alternate: a round's read, then its post-embed re-read. Each embed sees an edit.
    db.onReads = [edit(1), () => undefined, edit(2), () => undefined, edit(3, 16)];
    const stats = await syncModelIds([1], deps);
    expect(stats.stale).toBe(1);
    expect(store.points.get(1)!.payload.nsfwLevel).toEqual([16]);
  });

  test('image and text inputs in one call keep separate stamps, so neither is refused', async () => {
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        steps: Array<{ name: string; input: { text?: string } }>;
      };
      return new Response(
        JSON.stringify({
          id: 'wf',
          status: 'succeeded',
          steps: body.steps.map((s) => ({
            name: s.name,
            status: 'succeeded',
            output: {
              ...STAMP,
              profile: s.input.text === undefined ? 'image-512' : 'text',
              precision: 'float32',
              embedding: VECTOR,
            },
          })),
        })
      );
    }) as unknown as typeof fetch;
    const e = new Embedder({
      endpoint: 'http://orch',
      token: 't',
      maxInFlight: 8,
      maxRetries: 0,
      priority: 'low',
      fetch: fetchImpl,
    });
    const result = await e.embed([
      { id: '1', imageUrl: 'https://cdn.example/a.jpeg' },
      { id: '2', text: 'Name: Model 2' },
    ]);
    expect(result.error).toBeUndefined();
    expect([...result.vectors.keys()].sort()).toEqual([1, 2]);
  });
});

describe('model CDC consumer', () => {
  const at = (offset: number, topic = 'postgres.Model') => ({
    topic,
    partition: 0,
    offset: String(offset),
  });
  function queue() {
    const env = setup();
    const commits: unknown[] = [];
    const q = new ModelSyncQueue(env.deps as unknown as ModelQueueDeps, async (o) => {
      commits.push(o);
    });
    return { ...env, q, commits };
  }

  test('reads the model from each topic; a version delete yields its version, a snapshot nothing', () => {
    const ref = modelRefFromEvent;
    expect(ref('postgres.Model', { op: 'u', after: { id: 5, modelId: 99 } })).toEqual({ model: 5 });
    expect(ref('postgres.Model', { op: 'd', before: { id: 6 }, after: null })).toEqual({
      model: 6,
    });
    expect(ref('postgres.ModelVersion', { op: 'c', after: { id: 70, modelId: 7 } })).toEqual({
      model: 7,
    });
    expect(ref('postgres.ModelVersion', { op: 'd', before: { id: 80 } })).toEqual({ version: 80 });
    expect(ref('postgres.TagsOnModels', { op: 'd', before: { modelId: 9, tagId: 1 } })).toEqual({
      model: 9,
    });
    expect(ref('postgres.Model', { op: 'r', after: { id: 10 } })).toBeNull();
  });

  test('deleting the last published version removes the point, found through its versionIds', async () => {
    const { db, store, q } = queue();
    db.rows.set(1, model(1));
    db.rows.set(2, model(2));
    q.add({ model: 1 }, at(0));
    q.add({ model: 2 }, at(1));
    await q.flush();
    expect(store.points.get(1)!.payload.versionIds).toEqual([10]);

    // Version 10 deleted: the model row is untouched, but it has no published version left.
    db.rows.set(1, model(1, { versions: [] }));
    q.add({ version: 10 }, at(2, 'postgres.ModelVersion'));
    await q.flush();
    expect([...store.points.keys()]).toEqual([2]);
  });

  test('a deleted version whose lookup fails is retried on the next flush', async () => {
    const { db, store, q, commits } = queue();
    db.rows.set(1, model(1));
    q.add({ model: 1 }, at(0));
    await q.flush();
    db.rows.set(1, model(1, { versions: [] }));
    vi.spyOn(store, 'idsMatching').mockRejectedValueOnce(new Error('qdrant down'));
    q.add({ version: 10 }, at(1, 'postgres.ModelVersion'));
    const committed = commits.length;
    await expect(q.flush()).rejects.toThrow('qdrant down');
    expect(commits).toHaveLength(committed);
    await q.flush();
    expect(store.points.has(1)).toBe(false);
    expect(commits.at(-1)).toEqual([at(2, 'postgres.ModelVersion')]);
  });

  test('a burst for one model is one embed; offsets commit only after a flush succeeds', async () => {
    const { db, store, embedder, q, commits } = queue();
    db.rows.set(1, model(1));
    const failing = vi
      .spyOn(store, 'payloadFields')
      .mockRejectedValueOnce(new Error('qdrant down'));
    for (let offset = 0; offset < 20; offset++)
      q.add({ model: 1 }, at(offset, 'postgres.ModelVersion'));
    await expect(q.flush()).rejects.toThrow('qdrant down');
    expect(commits).toEqual([]);
    failing.mockRestore();

    await q.flush();
    expect(embedder.texts).toHaveLength(1);
    expect(store.points.has(1)).toBe(true);
    expect(commits).toEqual([[at(20, 'postgres.ModelVersion')]]);
  });

  test('unstamped or gated, nothing is embedded, but an unpublished model still loses its point', async () => {
    const { db, store, embedder, q } = queue();
    db.rows.set(1, model(1));
    store.points.set(2, { id: 2, vector: [2], payload: {} as ModelPayload });
    store.stamped = false;
    q.add({ model: 1 }, at(0));
    q.add({ model: 2 }, at(1));
    await q.flush();
    expect(embedder.texts).toEqual([]);
    expect([...store.points.keys()]).toEqual([]);

    store.stamped = true;
    q.setGate('the connector does not stream public.ModelVersion');
    q.add({ model: 1 }, at(2));
    await q.flush();
    expect(embedder.texts).toEqual([]);

    q.setGate(null);
    q.add({ model: 1 }, at(3));
    await q.flush();
    expect(embedder.texts).toHaveLength(1);
  });

  // Adding a table changes the Debezium publication, and the watcher recreates the connector
  // when its list differs, so a deploy with the flag unset must leave the connector as it was.
  async function withEnv<T>(env: Record<string, string | undefined>, run: () => Promise<T>) {
    vi.resetModules();
    const saved = { ...process.env };
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
  const connectorFor = (env: Record<string, string | undefined>) =>
    withEnv(env, async () => {
      const { DebeziumManager } = await import('@/services/debezium-manager');
      return {
        tables: DebeziumManager.getConnectorTables(),
        columns: DebeziumManager.getColumnExclusions(),
        watcher: DebeziumManager.getTopicsToConsume(),
      };
    });

  test('CDC_MODEL_ENABLED: off leaves the connector as it was; on adds both tables without their big columns', async () => {
    const off = await connectorFor({ CDC_MODEL_ENABLED: undefined, CDC_IMAGE_ENABLED: undefined });
    const image = await connectorFor({ CDC_MODEL_ENABLED: undefined, CDC_IMAGE_ENABLED: 'true' });
    expect(image.tables.filter((t) => !off.tables.includes(t))).toEqual(['public.Image']);
    expect(off.columns).toEqual({});
    expect(image.columns).toEqual({});

    const on = await connectorFor({ CDC_MODEL_ENABLED: 'true', CDC_IMAGE_ENABLED: 'true' });
    expect(on.tables.filter((t) => !off.tables.includes(t))).toEqual([
      'public.Image',
      'public.Model',
      'public.ModelVersion',
    ]);
    const excluded = on.columns['column.exclude.list'].split(',');
    expect(excluded).toEqual(
      expect.arrayContaining(['public.Model.description', 'public.ModelVersion.description'])
    );
    // The consumer needs these from every event.
    for (const key of ['public.Model.id', 'public.ModelVersion.id', 'public.ModelVersion.modelId'])
      expect(excluded).not.toContain(key);
    expect(on.watcher).toEqual(off.watcher);
  });

  test('the consumer refuses to start without the flag', async () => {
    const start = (flag: string | undefined) =>
      withEnv({ CDC_MODEL_ENABLED: flag }, async () =>
        (await import('@/vector-sync/models/consumer')).assertModelCdc()
      );
    await expect(start(undefined)).rejects.toThrow(/CDC_MODEL_ENABLED is off/);
    await expect(start('true')).resolves.toBeUndefined();
  });

  test('embedding waits until the connector streams Model and ModelVersion, not just Image', async () => {
    const { modelEmbedBlock } = await import('@/vector-sync/models/consumer');
    const connector = (list: string) =>
      (async (url: string | URL | Request) =>
        new Response(
          JSON.stringify(
            String(url).endsWith('/status')
              ? { connector: { state: 'RUNNING' }, tasks: [{ id: 0, state: 'RUNNING' }] }
              : { 'table.include.list': list }
          )
        )) as unknown as typeof fetch;
    const saved = process.env.DEBEZIUM_CONNECT_URL;
    process.env.DEBEZIUM_CONNECT_URL = 'http://connect';
    try {
      expect(await modelEmbedBlock(connector('public.Image'))).toBe(
        'the connector does not stream public.Model'
      );
      expect(await modelEmbedBlock(connector('public.Image,public.Model'))).toBe(
        'the connector does not stream public.ModelVersion'
      );
      expect(await modelEmbedBlock(connector('public.Model,public.ModelVersion'))).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.DEBEZIUM_CONNECT_URL;
      else process.env.DEBEZIUM_CONNECT_URL = saved;
    }
  });

  test('a long flush that keeps storing vectors stays healthy; one failing without progress does not', () => {
    const { q } = queue();
    const start = Date.now();
    q.lastFlushOk = start - 30 * 60_000;
    q.lastProgress = start - 60_000;
    expect(q.isHealthy(start)).toBe(true);
    q.lastProgress = start - 50 * 60_000;
    expect(q.isHealthy(start)).toBe(false);
    q.lastProgress = start;
    q.consecutiveFailures = 3;
    expect(q.isHealthy(start)).toBe(false);
  });

  test('progress is vectors stored: a flush whose upserts keep failing counts as failing', async () => {
    const { db, store, q } = queue();
    db.rows.set(1, model(1));
    vi.spyOn(store, 'upsert').mockRejectedValue(new Error('qdrant write timeout'));
    for (let i = 0; i < 3; i++) {
      q.add({ model: 1 }, at(i));
      await expect(q.flush()).rejects.toThrow('qdrant write timeout');
    }
    expect(q.consecutiveFailures).toBe(3);
    expect(q.isHealthy(Date.now() + 11 * 60_000)).toBe(false);
  });

  test('a flush that stored vectors before failing is slow, not stuck', async () => {
    const { db, store, q } = queue();
    db.rows.set(1, model(1));
    q.consecutiveFailures = 2;
    q.lastProgress = 0;
    vi.spyOn(store, 'setPayloads').mockResolvedValueOnce().mockRejectedValueOnce(new Error('blip'));
    q.add({ model: 1 }, at(0));
    await expect(q.flush()).rejects.toThrow('blip');
    expect(store.points.has(1)).toBe(true);
    expect(q.consecutiveFailures).toBe(0);
    expect(q.lastProgress).toBeGreaterThan(0);
  });

  test('an idle tick touches neither Qdrant nor the stamp; the stamp state follows the collection', async () => {
    const { store, q } = queue();
    const stampReads = vi.spyOn(store, 'isStamped');
    await q.flush();
    expect(stampReads).not.toHaveBeenCalled();
    store.stamped = false;
    expect(await q.refreshStamp()).toBe(false);
    expect(q.unstamped).toBe(true);
    store.stamped = true;
    expect(await q.refreshStamp()).toBe(true);
    expect(q.unstamped).toBe(false);
  });

  test('a model mismatch stops embedding for good; deletes carry on', async () => {
    const { db, store, embedder, q } = queue();
    db.rows.set(1, model(1));
    vi.spyOn(embedder, 'embed').mockRejectedValueOnce(new ModelMismatchError({}, STAMP));
    q.add({ model: 1 }, at(0));
    await expect(q.flush()).rejects.toThrow(ModelMismatchError);
    expect(q.embedStopped).toMatch(/Embedder returned/);
    store.points.set(2, { id: 2, vector: [2], payload: {} as ModelPayload });
    q.add({ model: 2 }, at(1));
    await q.flush();
    expect(store.points.has(2)).toBe(false);
    expect(embedder.texts).toEqual([]);
  });
});

describe('version-delete lookup against the real query and client', () => {
  // The version ids come from the json_agg in getModelDocs; a fake pg would hide a missing column.
  test('getModelDocs records the ids of the published, searchable versions it read', async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const pg = new PGlite();
    await pg.exec(`
        CREATE TABLE "User" (id int PRIMARY KEY, username text);
        CREATE TABLE "Tag" (id int PRIMARY KEY, name text);
        CREATE TABLE "TagsOnModels" ("modelId" int, "tagId" int);
        CREATE TABLE "Model" (id int PRIMARY KEY, name text, type text, "checkpointType" text,
          "nsfwLevel" int, "publishedAt" timestamp, "userId" int, description text, status text,
          "deletedAt" timestamp, "tosViolation" boolean, minor boolean, availability text);
        CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int, name text,
          description text, "baseModel" text, "trainedWords" text[], status text,
          availability text, index int);
        INSERT INTO "User" VALUES (7, 'someone');
        INSERT INTO "Model" VALUES (1, 'M', 'LORA', NULL, 1, '2026-01-01', 7, NULL, 'Published',
          NULL, false, false, 'Public');
        INSERT INTO "ModelVersion" VALUES
          (11, 1, 'a', NULL, 'SDXL 1.0', '{}', 'Published', 'Public', 0),
          (12, 1, 'b', NULL, 'SDXL 1.0', '{}', 'Draft', 'Public', 1),
          (13, 1, 'c', NULL, 'SDXL 1.0', '{}', 'Published', 'Unsearchable', 2),
          (14, 1, 'd', NULL, 'SDXL 1.0', '{}', 'Published', 'Public', 3);
      `);
    try {
      const docs = await getModelDocs(pg as unknown as Parameters<typeof getModelDocs>[0], [1]);
      expect(docs.get(1)?.versionIds).toEqual([11, 14]);
    } finally {
      await pg.close();
    }
  }, 60_000);

  // Defence in depth: the site's hydration hides Private models too, but the index must not hold
  // their name and description at all. A model turning Private must lose its point, not keep it.
  test('a Private model gets no point, and a model turning Private loses its point', async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const pg = new PGlite();
    await pg.exec(`
        CREATE TABLE "User" (id int PRIMARY KEY, username text);
        CREATE TABLE "Tag" (id int PRIMARY KEY, name text);
        CREATE TABLE "TagsOnModels" ("modelId" int, "tagId" int);
        CREATE TABLE "Model" (id int PRIMARY KEY, name text, type text, "checkpointType" text,
          "nsfwLevel" int, "publishedAt" timestamp, "userId" int, description text, status text,
          "deletedAt" timestamp, "tosViolation" boolean, minor boolean, availability text);
        CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int, name text,
          description text, "baseModel" text, "trainedWords" text[], status text,
          availability text, index int);
        INSERT INTO "User" VALUES (7, 'someone');
        INSERT INTO "Model" VALUES
          (1, 'Public', 'LORA', NULL, 1, '2026-01-01', 7, NULL, 'Published', NULL, false, false, 'Public'),
          (2, 'Private', 'LORA', NULL, 1, '2026-01-01', 7, NULL, 'Published', NULL, false, false, 'Private'),
          (3, 'Soon private', 'LORA', NULL, 1, '2026-01-01', 7, NULL, 'Published', NULL, false, false, 'Public'),
          (4, 'Private versions only', 'LORA', NULL, 1, '2026-01-01', 7, NULL, 'Published', NULL, false, false, 'Public');
        INSERT INTO "ModelVersion" VALUES
          (11, 1, 'a', NULL, 'SDXL 1.0', '{}', 'Published', 'Public', 0),
          (12, 1, 'secret', 'private notes', 'SDXL 1.0', '{}', 'Published', 'Private', 1),
          (21, 2, 'a', NULL, 'SDXL 1.0', '{}', 'Published', 'Public', 0),
          (31, 3, 'a', NULL, 'SDXL 1.0', '{}', 'Published', 'Public', 0),
          (41, 4, 'a', NULL, 'SDXL 1.0', '{}', 'Published', 'Private', 0);
      `);
    try {
      const { store, embedder } = setup();
      const deps = { pg, store, embedder } as unknown as ModelSyncDeps & { store: FakeStore };
      await syncModelIds([1, 2, 3, 4], deps);
      // Positive control: a Public model with a Public version still indexes.
      expect([...store.points.keys()].sort()).toEqual([1, 3]);
      expect(store.points.get(1)!.payload.versionIds).toEqual([11]);
      expect(store.points.get(1)!.payload.search_text).not.toContain('private notes');

      // What a CDC update to Model 3 triggers: a re-sync of its id.
      await pg.exec(`UPDATE "Model" SET availability = 'Private' WHERE id = 3`);
      expect(await syncModelIds([3], deps)).toMatchObject({ deleted: 1 });
      expect([...store.points.keys()]).toEqual([1]);
    } finally {
      await pg.close();
    }
  }, 60_000);

  test('idsMatching filters on any of the values and follows every page', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const pages = [
      { points: [{ id: 1 }, { id: 2 }], next_page_offset: 3 },
      { points: [{ id: 3 }], next_page_offset: null },
    ];
    const client = {
      scroll: async (_c: string, body: Record<string, unknown>) => {
        calls.push(body);
        return pages[calls.length - 1];
      },
    };
    const store = new VectorStore<ModelPayload>(client as unknown as QdrantClient, 'c');
    expect(await store.idsMatching('versionIds', [10, 20], 2)).toEqual([1, 2, 3]);
    expect(calls.map((c) => [c.filter, c.offset])).toEqual([
      [{ must: [{ key: 'versionIds', match: { any: [10, 20] } }] }, undefined],
      [{ must: [{ key: 'versionIds', match: { any: [10, 20] } }] }, 3],
    ]);
    expect(await store.idsMatching('versionIds', [])).toEqual([]);
    expect(calls).toHaveLength(2);
  });
});
