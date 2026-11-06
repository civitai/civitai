import { describe, expect, test } from 'vitest';
import { Embedder, type EmbedInput } from '@/vector-sync/embedder';
import {
  cleanHtml,
  modelDocument,
  normalizeTitle,
  nsfwLevels,
  type ModelSource,
} from '@/vector-sync/models/document';
import type { ModelPayload } from '@/vector-sync/models/source';
import { syncModelIds, type ModelSyncDeps } from '@/vector-sync/models/sync';
import type { ModelStamp, VectorPoint } from '@/vector-sync/qdrant';

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
    versions: [{ name: 'v1', description: null, baseModel: 'SDXL 1.0', trainedWords: ['wc'] }],
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
  /** Runs once, after the first read, as a write committed while vectors are made. */
  onRead?: () => void;
  query = async (_sql: string, [ids]: [number[]]) => {
    const rows = ids.flatMap((id) => (this.rows.has(id) ? [{ ...this.rows.get(id)! }] : []));
    const hook = this.onRead;
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
}

class FakeEmbedder {
  texts: string[] = [];
  embed = async (
    inputs: EmbedInput[],
    { onVectors }: { onVectors?: (v: Map<number, number[]>) => Promise<void> } = {}
  ) => {
    this.texts.push(...inputs.map((i) => i.text!));
    const vectors = new Map(inputs.map((i) => [Number(i.id), [Number(i.id)]]));
    await onVectors?.(vectors);
    return { vectors, failed: [], stamp: STAMP };
  };
}

function setup() {
  const db = new FakeDb();
  const store = new FakeStore();
  const embedder = new FakeEmbedder();
  const deps = { pg: db, store, embedder } as unknown as ModelSyncDeps;
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
    const versions = ['one', 'two', 'three', 'four'].map((name) => ({
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
    expect(await syncModelIds([1], deps)).toMatchObject({ embedded: 1 });
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
  const result = await e.embed([{ id: '5', text: 'Name: Model 5' }]);
  expect(body!.steps[0].input).toMatchObject({ text: 'Name: Model 5' });
  expect(body!.steps[0].input).not.toHaveProperty('imageUrl');
  expect(result.vectors.get(5)).toEqual(VECTOR);
});
