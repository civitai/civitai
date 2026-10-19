import { readFileSync } from 'fs';
import { join } from 'path';
import type { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { serverSchema } from '~/env/server-schema';
import { decodeTagIndex } from '~/server/services/resource-intent-tags/payload';
import type * as Build from '~/server/services/resource-intent-tags/build';
import {
  loopYielder,
  readonlyClickHouse,
  runTagIndexBuild,
  genObservationPages,
  observationCoverage,
  TAG_OBSERVATION_FLOOR,
  tagBuildConfig,
  type TagBuildDeps,
  type TagBuildEnv,
  type TagClickHouse,
} from '~/server/services/resource-intent-tags/pipeline';
import {
  genSliceCondition,
  TAG_SOURCE_PARAMS,
  type genObservationOf,
  observationKeyFingerprint,
  observationUserHash,
} from '~/server/services/resource-intent-tags/sources';
import { RESOURCE_INTENT_TAGS_SPEC_HASH } from '~/server/services/resource-intent-tags/spec';
import type { TagIndexObjectStore } from '~/server/services/resource-intent-tags/store';
import { __flushPendingEmitsForTest } from '~/utils/metadata/audit-slow-log';
import { pgliteSql, utcPglite } from './resource-intent-cooc.harness';

/**
 * The weekly tag-index build's pipeline: each gate refuses before the reads it protects (reached with
 * a case every earlier gate passes), the newest frozen vocabulary is the one built and stored, and
 * generator prompts never reach the slow-audit log. Postgres reads are canned except the vocabulary
 * read, which runs against the real migrations in PGlite.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const logToAxiom = loggingMock.logToAxiom;
const clickhouseClient = vi.hoisted(() => ({ createClient: vi.fn() }));
// Every accumulator the pipeline makes, held weakly, so a test can see whether one is still reachable.
const accumulators = vi.hoisted(() => [] as WeakRef<object>[]);
const cooperativeFinalizes = vi.hoisted(() => ({
  count: 0,
  opts: [] as unknown[],
  built: [] as Build.TagIndexData[],
}));
vi.mock('~/server/services/resource-intent-tags/build', async (importOriginal) => {
  const real = await importOriginal<typeof Build>();
  class TrackedAccumulator extends real.TagIndexAccumulator {
    constructor(...args: ConstructorParameters<typeof real.TagIndexAccumulator>) {
      super(...args);
      accumulators.push(new WeakRef(this));
    }
    finalizeCooperative(
      ...args: Parameters<InstanceType<typeof real.TagIndexAccumulator>['finalizeCooperative']>
    ) {
      cooperativeFinalizes.count++;
      cooperativeFinalizes.opts.push(args[2]);
      return super.finalizeCooperative(...args).then((r) => {
        cooperativeFinalizes.built.push(r.data);
        return r;
      });
    }
  }
  return { ...real, TagIndexAccumulator: TrackedAccumulator };
});
vi.mock('@clickhouse/client', () => clickhouseClient);

const migration = (name: string) =>
  readFileSync(
    join(process.cwd(), 'packages/civitai-db-schema/prisma/migrations', name, 'migration.sql'),
    'utf8'
  );
const VOCAB_SQL = migration('20261029120000_resource_intent_tags');
const SNAPSHOT_SQL = migration('20261103120000_resource_intent_tag_index_snapshot');
const PAYLOAD_CAP_SQL = migration('20261106120000_resource_intent_tag_index_snapshot_payload_cap');

const KEY = Buffer.alloc(32, 0x11);
const ENV: Required<TagBuildEnv> = {
  RESOURCE_INTENT_TAG_INDEX_BUCKET: 'ri-tag-index-test',
  RESOURCE_INTENT_TAG_INDEX_B2_ENDPOINT: 'https://b2.invalid',
  RESOURCE_INTENT_TAG_INDEX_B2_ACCESS_KEY: 'ri-key-id',
  RESOURCE_INTENT_TAG_INDEX_B2_SECRET_KEY: 'ri-secret',
  P2M_CLICKHOUSE_URL: 'https://clickhouse.invalid:8443',
  P2M_CLICKHOUSE_USER: 'p2m-reader',
  P2M_CLICKHOUSE_PASSWORD: 'pw',
  P2M_HASH_KEY: KEY.toString('hex'),
  P2M_HASH_KEY_FINGERPRINT: observationKeyFingerprint(KEY),
};

function vocabulary(keys: string[], salt: number) {
  const tags = keys.map((key, id) => ({
    id,
    key,
    idf: 1 + id + salt,
    users: 25,
    explicit: false,
    near: [],
  }));
  const payload = Buffer.from(JSON.stringify({ schema: 'p2m-vocab/2', tags }));
  return payload;
}
// Different payloads, so different versions; the build reads whichever the gate picks.
const OLD_FROZEN = vocabulary(['castle', 'lighthouse', 'watercolor'], 0);
const NEW_FROZEN = vocabulary(['castle', 'lighthouse', 'watercolor'], 0.5);
const CANDIDATE = vocabulary(['castle', 'lighthouse', 'watercolor'], 0.25);

async function insertVocab(db: PGlite, payload: Buffer, status: string, frozenAt: string | null) {
  await db.query(
    `INSERT INTO "ResourceIntentVocabulary" ("vocabVersion", payload, "rulesSummary", status, "frozenAt", "frozenBy")
     VALUES (encode(sha256($1), 'hex'), $1, '{}', $2, $3, $4)`,
    [payload, status, frozenAt, frozenAt && 'operator']
  );
}
const versionOf = async (db: PGlite, payload: Buffer) =>
  (await db.query<{ v: string }>(`SELECT encode(sha256($1), 'hex') AS v`, [payload])).rows[0].v;

const GEN_PROMPTS = [
  'secret prompt one: watercolor lighthouse at dusk',
  'secret prompt two: castle on a cliff, watercolor',
  'secret prompt three: lighthouse in a storm',
];

type World = {
  db: PGlite;
  deps: TagBuildDeps & { query: NonNullable<TagBuildDeps['query']> };
  chQueries: string[];
  chDrained: string[];
  workWhileOpen: string[];
  streamOpen: () => boolean;
  postedBatches: number[][];
  pgReads: string[];
  objectsMade: Mock<() => TagIndexObjectStore>;
  store: Map<string, Buffer>;
  closed: ReturnType<typeof vi.fn>;
};

/**
 * Model content rows. Model 1 is the add-on the training rows use; model 3 is an add-on no training
 * row uses, whose content carries 'castle'.
 */
const CONTENT = [
  {
    id: 1,
    name: 'watercolor lighthouse',
    type: 'LORA',
    description: '<p>castle</p>',
    tags: ['watercolor'],
    versions: [{ baseModel: 'SDXL 1.0', trainedWords: ['lighthouse'] }],
  },
  {
    id: 3,
    name: 'castle',
    type: 'LORA',
    description: '',
    tags: [],
    versions: [{ baseModel: 'SDXL 1.0', trainedWords: [] }],
  },
  // A checkpoint no training row uses.
  {
    id: 4,
    name: 'lighthouse',
    type: 'Checkpoint',
    description: '',
    tags: [],
    versions: [{ baseModel: 'SDXL 1.0', trainedWords: [] }],
  },
];

// Users 42 and 7, hashed as the extractor writes them; 42 also posts below.
const defaultGenRows = GEN_PROMPTS.map((p, i) => ({
  u: observationUserHash(KEY, i % 2 ? 7 : 42),
  p,
  v: [101, 201],
  liked: 1,
  favorite: 0,
  disliked: 0,
}));

async function world(
  opts: {
    vocabs?: [Buffer, string, string | null][];
    readonly?: number;
    /** Observations at or after the window's end, and hours from the floor holding one (of 864). */
    after?: number;
    hours?: number;
    /** Generator rows on the window's first day (the fixture's three prompts by default). */
    genRows?: Parameters<typeof genObservationOf>[0][];
    env?: TagBuildEnv;
    /** The snapshot table without the payload-cap migration (its P6c bound). */
    withoutCapMigration?: boolean;
    /** Eligible model ids, ascending (model 1 by default: the used add-on with content). */
    eligible?: number[];
  } = {}
): Promise<World> {
  const db = await utcPglite(
    ...(opts.withoutCapMigration
      ? [VOCAB_SQL, SNAPSHOT_SQL]
      : [VOCAB_SQL, SNAPSHOT_SQL, PAYLOAD_CAP_SQL])
  );
  for (const [p, s, f] of opts.vocabs ?? [[NEW_FROZEN, 'frozen', '2026-10-10T00:00:00Z']])
    await insertVocab(db, p, s, f);
  const chQueries: string[] = [];
  const chDrained: string[] = [];
  const pgReads: string[] = [];
  const postedBatches: number[][] = [];
  // Work done while a ClickHouse response is still open: ClickHouse aborts a response stalled past
  // its send timeout, so none may happen.
  let openStreams = 0;
  const workWhileOpen: string[] = [];
  const closed = vi.fn(async () => undefined);
  const now = 1_800_000_000;
  const ch: TagClickHouse = {
    async *rows<T>(q: string) {
      chQueries.push(q);
      openStreams++;
      try {
        // Counted once the generator has yielded its last row and returned.
        yield* rowsOf<T>(q);
        chDrained.push(q);
      } finally {
        openStreams--;
      }
    },
    close: closed,
  };
  async function* rowsOf<T>(q: string): AsyncGenerator<T> {
    if (q.includes(`getSetting('readonly')`)) yield { ro: opts.readonly ?? 2 } as T;
    else if (q.includes('uniqExactIf'))
      yield {
        after: String(opts.after ?? 5000),
        hours: String(opts.hours ?? 864),
        newest: String(now - 3 * 3600),
        now: String(now),
      } as T;
    else if (q.includes('p2m_restricted.promptText')) {
      // Only the window's first day (2026-07-21) holds rows.
      if (!q.includes(`time >= toDateTime('2026-07-21 00:00:00', 'UTC')`)) return;
      for (const row of opts.genRows ?? defaultGenRows) yield row as T;
    } else throw new Error(`unexpected ClickHouse query: ${q}`);
  }
  const base = pgliteSql(db);
  const query = vi.fn(async (sql: Prisma.Sql) => {
    const t = sql.text;
    pgReads.push(t);
    if (openStreams) workWhileOpen.push('postgres read');
    if (t.includes('"ResourceIntentVocabulary"')) return base.query(sql);
    if (t.includes('FROM "ModelVersion" mv JOIN "Model" m'))
      return [
        { id: 101, modelId: 1, type: 'LORA', baseModel: 'SDXL 1.0', flagged: false },
        { id: 201, modelId: 2, type: 'Checkpoint', baseModel: 'SDXL 1.0', flagged: false },
      ];
    // Images 1–10: 1–5 inside the training window, 6–10 after its end, so the sample is ids [1, 6).
    if (t.includes('max(id) AS max FROM "Image"')) return [{ max: 10 }];
    if (t.includes('FROM "Image" WHERE id >=')) {
      const id = Number(sql.values[0]);
      if (id > 10) return [];
      return [
        { id, createdAt: new Date(id <= 5 ? '2026-08-01T00:00:00Z' : '2026-10-19T12:00:00Z') },
      ];
    }
    if (t.includes('jsonb_agg(DISTINCT')) {
      postedBatches.push(sql.values.slice(0, 2).map(Number));
      const resources = [
        { modelId: 1, type: 'LORA', baseModel: 'SDXL 1.0', listed: true },
        { modelId: 2, type: 'Checkpoint', baseModel: 'SDXL 1.0', listed: true },
      ];
      return [
        { userId: 42, prompt: 'castle, watercolor', resources, reactions: 3, tips: 1 },
        { userId: 43, prompt: 'lighthouse', resources, reactions: 0, tips: 0 },
      ];
    }
    if (t.includes('ORDER BY m.id LIMIT')) {
      const [after, types, page] = sql.values as [number, string[], number];
      // Only models of the types the statement asks for (model 1 and 3 are LORAs, 4 a Checkpoint).
      const typeOf = (id: number) => CONTENT.find((m) => m.id === id)?.type ?? 'LORA';
      return (opts.eligible ?? [1])
        .filter((id) => id > after && types.includes(typeOf(id)))
        .slice(0, page)
        .map((id) => ({ id }));
    }
    if (t.includes('WITH ms AS')) return [];
    if (t.includes('FROM "Model" m WHERE m.id = ANY')) {
      const ids = sql.values.find(Array.isArray) as number[];
      // Model 2 is requested but returns no row (as a model flagged since its use would).
      return CONTENT.filter((m) => ids.includes(m.id));
    }
    throw new Error(`unexpected Postgres read: ${t}`);
  });
  const store = new Map<string, Buffer>();
  const objects: TagIndexObjectStore = {
    prefix: 'resource-intent/tag-index',
    put: async (k, b) => void store.set(k, Buffer.from(b)),
    get: async () => {
      throw new Error('not read here');
    },
  };
  const objectsMade = vi.fn(() => objects);
  return {
    db,
    chQueries,
    chDrained,
    workWhileOpen,
    streamOpen: () => openStreams > 0,
    postedBatches,
    pgReads,
    objectsMade,
    store,
    closed,
    deps: {
      env: opts.env ?? ENV,
      now: new Date('2026-10-20T06:00:00Z'),
      query,
      clickhouse: async () => ch,
      objects: objectsMade,
      sql: pgliteSql(db),
    },
  };
}

/** Nothing past the gates ran: no prompt-text read, no Postgres read but the vocabulary's, no upload. */
function expectNoTrainingReads(w: World) {
  expect(w.chQueries.some((q) => q.includes('p2m_restricted.promptText'))).toBe(false);
  expect(w.pgReads.some((q) => !q.includes('"ResourceIntentVocabulary"'))).toBe(false);
  expect(w.store.size).toBe(0);
}

const SAVED = ['AUDIT_SLOW_LOG_MS', 'AUDIT_SLOW_LOG_RAW'] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of SAVED) saved[k] = process.env[k];
  logToAxiom.mockClear();
});
afterEach(() => {
  for (const k of SAVED)
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
});

describe('the happy path (the control every refusal below departs from)', () => {
  it('builds from the NEWEST frozen vocabulary, stores a production snapshot and records it', async () => {
    const w = await world({
      vocabs: [
        [OLD_FROZEN, 'frozen', '2026-10-01T00:00:00Z'],
        [NEW_FROZEN, 'frozen', '2026-10-10T00:00:00Z'],
        // Newer than both, but never built from.
        [CANDIDATE, 'candidate', null],
      ],
    });
    const cooperativeBefore = cooperativeFinalizes.count;
    const { summary, payload } = await runTagIndexBuild({ dryRun: false }, w.deps);
    // The index is computed in slices that yield the event loop.
    expect(cooperativeFinalizes.count).toBe(cooperativeBefore + 1);
    // With float32 postings: half the memory of the largest arrays, the same encoded bytes.
    expect(cooperativeFinalizes.opts.at(-1)).toEqual({ float32Postings: true });
    // And the encode consumed the built postings as it packed them.
    for (const kind of ['addon', 'checkpoint'] as const)
      expect(cooperativeFinalizes.built.at(-1)?.kinds[kind].postings.resource).toHaveLength(0);
    const newest = await versionOf(w.db, NEW_FROZEN);
    expect(newest).not.toBe(await versionOf(w.db, OLD_FROZEN));
    expect(summary.vocabVersion).toBe(newest);
    expect(summary.specHash).toBe(RESOURCE_INTENT_TAGS_SPEC_HASH);
    expect(summary).toMatchObject({
      dryRun: false,
      created: true,
      observations: 3,
      genUsers: 2,
      // Posted users hashed with the observations' key: user 42 is one person across both sources.
      postUsers: 2,
      genAndPostUsers: 1,
      postedRows: 2,
      contentModelsRequested: 2,
      contentModels: 1,
      payloadBytes: payload.length,
    });
    // Every input reached the index: generator and posted rows, three users, model 1's content.
    expect(summary.stats).toMatchObject({
      rows: { gen: 3, post: 2 },
      users: 3,
      models: { content: 1, used: 2, addon: 1, checkpoint: 1 },
      modelsWithContentTag: 1,
    });
    expect(w.postedBatches).toEqual([[1, 6]]);
    const rows = (
      await w.db.query<{ id: string; vocabVersion: string; specHash: string; status: string }>(
        `SELECT id, "vocabVersion", "specHash", status FROM "ResourceIntentTagIndexSnapshot"`
      )
    ).rows;
    expect(rows).toEqual([
      {
        id: summary.snapshotId,
        vocabVersion: newest,
        specHash: RESOURCE_INTENT_TAGS_SPEC_HASH,
        status: 'ready',
      },
    ]);
    expect([...w.store.values()].map((b) => b.length)).toEqual([payload.length]);
    expect(w.closed).toHaveBeenCalledTimes(1);
    // Every ClickHouse result read to its end (a half-read stream aborts the response).
    // The two gates' queries, then one generator query per UTC day of the 90-day window.
    expect(w.chQueries).toHaveLength(2 + 90);
    expect(w.chDrained).toEqual(w.chQueries);
    expect(w.workWhileOpen).toEqual([]);
  });

  it('indexes an eligible model no training row used, on its content alone with the prior fit 0', async () => {
    const w = await world({ eligible: [1, 3, 4] });
    const { summary, payload } = await runTagIndexBuild({ dryRun: true }, w.deps);
    expect(summary).toMatchObject({
      eligibleModels: 3,
      // The union of the used models (1, 2) and the eligible ones (1, 3, 4).
      contentModelsRequested: 4,
      contentModels: 3,
    });
    expect(summary.stats.models).toEqual({ content: 3, used: 2, addon: 2, checkpoint: 2 });
    const { index } = await decodeTagIndex(payload);
    // The never-used checkpoint too, at the prior fit.
    expect(index.kinds.checkpoint.modelIds).toEqual([2, 4]);
    expect(index.kinds.checkpoint.fit[1]).toBe(0);
    const addon = index.kinds.addon;
    expect(addon.modelIds).toEqual([1, 3]);
    const r = addon.modelIds.indexOf(3);
    // No use, so no fit of its own: the resource fit is the shrinkage prior's 0.
    expect(addon.fit[r]).toBe(0);
    // Its one content tag, 'castle' (vocabulary id 0) from its name: c = the name weight, no pair fit.
    const { ptr, resource, c, fit } = addon.postings;
    const entries = [];
    for (let t = 0; t + 1 < ptr.length; t++)
      for (let k = ptr[t]; k < ptr[t + 1]; k++)
        if (resource[k] === r) entries.push({ t, c: c[k], fit: fit[k] });
    expect(entries).toHaveLength(1);
    expect(entries[0].t).toBe(0);
    expect(entries[0].c).toBeCloseTo(0.8, 6);
    expect(entries[0].fit).toBeNaN();
    // The eligibility read happened once, before the content read.
    const eligibleAt = w.pgReads.flatMap((q, i) => (q.includes('ORDER BY m.id LIMIT') ? [i] : []));
    expect(eligibleAt).toHaveLength(1);
    expect(eligibleAt[0]).toBeLessThan(
      w.pgReads.findIndex((q) => q.includes('FROM "Model" m WHERE m.id = ANY'))
    );
  });

  it('the same inputs build the same bytes', async () => {
    const a = await runTagIndexBuild({ dryRun: true }, (await world({ eligible: [1, 3] })).deps);
    const b = await runTagIndexBuild({ dryRun: true }, (await world({ eligible: [1, 3] })).deps);
    expect(Buffer.compare(a.payload, b.payload)).toBe(0);
    // And an eligible model changes them: the control that the comparison can fail.
    const c = await runTagIndexBuild({ dryRun: true }, (await world({ eligible: [1] })).deps);
    expect(Buffer.compare(a.payload, c.payload)).not.toBe(0);
  });

  it('a dry run needs no bucket or bucket credentials, makes no object store and stores nothing', async () => {
    const w = await world({
      env: {
        ...ENV,
        RESOURCE_INTENT_TAG_INDEX_BUCKET: undefined,
        RESOURCE_INTENT_TAG_INDEX_B2_ENDPOINT: undefined,
        RESOURCE_INTENT_TAG_INDEX_B2_ACCESS_KEY: undefined,
        RESOURCE_INTENT_TAG_INDEX_B2_SECRET_KEY: undefined,
      },
    });
    const { summary } = await runTagIndexBuild({ dryRun: true }, w.deps);
    expect(summary).toMatchObject({
      dryRun: true,
      snapshotId: null,
      created: null,
      observations: 3,
    });
    expect(w.objectsMade).not.toHaveBeenCalled();
    expect(w.store.size).toBe(0);
    expect((await w.db.query(`SELECT 1 FROM "ResourceIntentTagIndexSnapshot"`)).rows).toHaveLength(
      0
    );
  });

  it('refuses a production build before reading anything while the table holds the old bound', async () => {
    const w = await world({ withoutCapMigration: true });
    await expect(runTagIndexBuild({ dryRun: false }, w.deps)).rejects.toThrow(
      /apply migration 20261106120000_resource_intent_tag_index_snapshot_payload_cap/
    );
    expectNoTrainingReads(w);
    expect(w.chQueries).toEqual([]);
    // A dry run stores nothing, so it is not refused.
    const d = await world({ withoutCapMigration: true });
    await expect(runTagIndexBuild({ dryRun: true }, d.deps)).resolves.toBeDefined();
  });

  it('refuses trial limits on a production build', async () => {
    const w = await world();
    await expect(
      runTagIndexBuild({ dryRun: false, limits: { models: 1 } }, w.deps)
    ).rejects.toThrow('limits are for dry runs only');
    expectNoTrainingReads(w);
  });
});

describe('gate 1: the environment, before anything is read', () => {
  const keys = Object.keys(ENV) as (keyof TagBuildEnv)[];
  for (const k of keys)
    for (const value of [undefined, ''])
      it(`refuses with ${k} ${value === undefined ? 'unset' : 'empty'}, naming it`, async () => {
        const w = await world({ env: { ...ENV, [k]: value } });
        const err = await runTagIndexBuild({ dryRun: false }, w.deps).catch((e: Error) => e);
        expect((err as Error).message).toBe(
          `tag index build: ${k} not set; refusing before reading anything`
        );
        expect(w.chQueries).toEqual([]);
        expect(w.deps.query).not.toHaveBeenCalled();
        expect(w.objectsMade).not.toHaveBeenCalled();
      });

  it('names every missing variable at once', () => {
    expect(() => tagBuildConfig({}, { requireBucket: true })).toThrow(
      `tag index build: ${keys.join(', ')} not set; refusing before reading anything`
    );
  });

  it("names the snapshot bucket's credentials, so a production build refuses before reading without them", () => {
    // Pinned literally: the list above is derived from the fixture, which a removed key leaves.
    expect(() => tagBuildConfig({}, { requireBucket: true })).toThrow(
      'tag index build: RESOURCE_INTENT_TAG_INDEX_BUCKET, RESOURCE_INTENT_TAG_INDEX_B2_ENDPOINT, ' +
        'RESOURCE_INTENT_TAG_INDEX_B2_ACCESS_KEY, RESOURCE_INTENT_TAG_INDEX_B2_SECRET_KEY, ' +
        'P2M_CLICKHOUSE_URL, P2M_CLICKHOUSE_USER, P2M_CLICKHOUSE_PASSWORD, P2M_HASH_KEY, ' +
        'P2M_HASH_KEY_FINGERPRINT not set; refusing before reading anything'
    );
    // A dry run stores nothing and needs none of them.
    expect(() => tagBuildConfig({}, { requireBucket: false })).toThrow(
      'tag index build: P2M_CLICKHOUSE_URL, P2M_CLICKHOUSE_USER, P2M_CLICKHOUSE_PASSWORD, ' +
        'P2M_HASH_KEY, P2M_HASH_KEY_FINGERPRINT not set; refusing before reading anything'
    );
  });

  it('refuses a hash key that is not hex', async () => {
    const w = await world({ env: { ...ENV, P2M_HASH_KEY: 'zz' + ENV.P2M_HASH_KEY.slice(2) } });
    await expect(runTagIndexBuild({ dryRun: false }, w.deps)).rejects.toThrow(
      'P2M_HASH_KEY is not hex'
    );
    expect(w.chQueries).toEqual([]);
  });

  it("refuses a hash key without the observations' fingerprint", async () => {
    const other = Buffer.alloc(32, 0x22).toString('hex');
    const w = await world({ env: { ...ENV, P2M_HASH_KEY: other } });
    await expect(runTagIndexBuild({ dryRun: false }, w.deps)).rejects.toThrow(
      /observation hash key has fingerprint [0-9a-f]{16}, expected/
    );
    expect(w.chQueries).toEqual([]);
    expect(w.deps.query).not.toHaveBeenCalled();
  });
});

describe("the build's env vars in the server schema", () => {
  const names = [
    'P2M_CLICKHOUSE_URL',
    'P2M_CLICKHOUSE_USER',
    'P2M_CLICKHOUSE_PASSWORD',
    'P2M_HASH_KEY',
    'P2M_HASH_KEY_FINGERPRINT',
  ] as const;
  for (const name of names)
    it(`${name}: optional, an empty value reads as unset, any other string kept`, () => {
      const field = serverSchema.shape[name];
      expect(field.parse(undefined)).toBeUndefined();
      // An empty value must not fail the schema: it is parsed at every pod's start.
      expect(field.parse('')).toBeUndefined();
      expect(field.parse('not validated here')).toBe('not validated here');
    });
});

describe("gate 2: the ClickHouse account's own profile is readonly=2", () => {
  for (const level of [0, 1])
    it(`refuses an account at readonly=${level}`, async () => {
      const w = await world({ readonly: level });
      await expect(runTagIndexBuild({ dryRun: false }, w.deps)).rejects.toThrow(
        `the ClickHouse account runs at readonly=${level}; it needs a profile with readonly=2`
      );
      expect(w.chQueries).toHaveLength(1);
      expect(w.deps.query).not.toHaveBeenCalled();
      expect(w.closed).toHaveBeenCalledTimes(1);
    });
});

describe("gate 3: the training window's generator coverage", () => {
  // The test window, 2026-07-21 to 2026-10-19, starts before the observation table's floor
  // (2026-09-13T00:00Z), so coverage is counted over the 864 hours from the floor; 2% allows 17.
  const FLOOR = '2026-09-13T00:00:00.000Z';
  const SPAN = 864;

  it('refuses when no observation lies at or after the window end, before any training read', async () => {
    const w = await world({ after: 0 });
    await expect(runTagIndexBuild({ dryRun: false }, w.deps)).rejects.toThrow(
      'no generator observation at or after the window end 2026-10-19T00:00:00.000Z'
    );
    expect(w.deps.query).not.toHaveBeenCalled();
    expectNoTrainingReads(w);
  });

  it("pins the floor at the observation table's first hour", () => {
    expect(TAG_OBSERVATION_FLOOR.toISOString()).toBe(FLOOR);
  });

  it('a window starting before the floor, fully covered after it, builds and records the short span', async () => {
    const w = await world({ hours: SPAN });
    const { summary } = await runTagIndexBuild({ dryRun: false }, w.deps);
    const q = w.chQueries[1];
    expect(q).toContain(`countIf(time >= toDateTime('2026-10-19 00:00:00', 'UTC')) AS after`);
    // An hour counts only when the slice the build reads holds a row, bucketed by UTC hour.
    expect(q.replace(/\s+/g, ' ')).toContain(
      `uniqExactIf(toStartOfHour(time, 'UTC'), time < toDateTime('2026-10-19 00:00:00', 'UTC') AND toMinute(toTimeZone(time, 'UTC')) < 2)`
    );
    expect(q).toContain(`WHERE time >= toDateTime('2026-09-13 00:00:00', 'UTC')`);
    const recorded = { start: FLOOR, hours: SPAN, missing: 0 };
    expect(summary.observationHours).toEqual(recorded);
    expect(summary.stats.observationHours).toEqual(recorded);
    const [row] = (
      await w.db.query<{ h: unknown }>(
        `SELECT "buildStats"->'observationHours' AS h FROM "ResourceIntentTagIndexSnapshot"`
      )
    ).rows;
    expect(row.h).toEqual(recorded);
  });

  it('the same window with 18 missing hours after the floor (over 2%) refuses, before any training read', async () => {
    const w = await world({ hours: SPAN - 18 });
    await expect(runTagIndexBuild({ dryRun: false }, w.deps)).rejects.toThrow(
      `18 of the 864 hours from ${FLOOR} have no generator observation (allowed 17)`
    );
    expect(w.deps.query).not.toHaveBeenCalled();
    expectNoTrainingReads(w);
  });

  it('builds with 17 missing hours after the floor', async () => {
    const w = await world({ hours: SPAN - 17 });
    const { summary } = await runTagIndexBuild({ dryRun: false }, w.deps);
    expect(summary.observationHours).toEqual({ start: FLOOR, hours: SPAN, missing: 17 });
  });

  it('a dry run reports missing hours over the limit instead of refusing', async () => {
    const w = await world({
      hours: SPAN - 100,
      env: { ...ENV, RESOURCE_INTENT_TAG_INDEX_BUCKET: undefined },
    });
    const { summary } = await runTagIndexBuild({ dryRun: true }, w.deps);
    expect(summary.observationHours).toEqual({ start: FLOOR, hours: SPAN, missing: 100 });
  });

  it('the coverage count and the generator read share one slice predicate', async () => {
    const w = await world();
    await runTagIndexBuild({ dryRun: false }, w.deps);
    const slice = genSliceCondition(TAG_SOURCE_PARAMS.genSliceMinutes);
    expect(slice).toBe(`toMinute(toTimeZone(time, 'UTC')) < 2`);
    const coverage = w.chQueries[1];
    const reads = w.chQueries.filter((q) => q.includes('p2m_restricted.promptText'));
    expect(reads).toHaveLength(90);
    expect(coverage).toContain(slice);
    // The read applies it to the observations it returns and to the prompts it joins.
    for (const q of reads) expect(q.split(slice)).toHaveLength(3);
  });

  describe('a window starting after the floor ignores it', () => {
    const window = {
      start: new Date('2026-12-20T00:00:00Z'),
      end: new Date('2027-03-20T00:00:00Z'),
    };
    const fake = (hours: number) => {
      const asked: string[] = [];
      const ch: TagClickHouse = {
        async *rows<T>(q: string) {
          asked.push(q);
          yield { after: '10', hours: String(hours), newest: '0', now: '0' } as T;
        },
        close: async () => undefined,
      };
      return { ch, asked };
    };

    it('counts the whole window, from its own start', async () => {
      const { ch, asked } = fake(2160);
      const c = await observationCoverage(ch, window, true);
      expect(c.start.toISOString()).toBe('2026-12-20T00:00:00.000Z');
      expect({ hours: c.hours, missingHours: c.missingHours }).toEqual({
        hours: 2160,
        missingHours: 0,
      });
      expect(asked[0]).toContain(`WHERE time >= toDateTime('2026-12-20 00:00:00', 'UTC')`);
    });

    it('so a gap anywhere in it counts: 44 missing of 2,160 refuses', async () => {
      const { ch } = fake(2160 - 44);
      await expect(observationCoverage(ch, window, true)).rejects.toThrow(
        '44 of the 2160 hours from 2026-12-20T00:00:00.000Z have no generator observation (allowed 43)'
      );
    });
  });
});

describe('a generator read that returns nothing', () => {
  it('refuses a production build, after the gates passed', async () => {
    const w = await world({ genRows: [] });
    await expect(runTagIndexBuild({ dryRun: false }, w.deps)).rejects.toThrow(
      'tag index build: the generator read returned no observations; refusing'
    );
    // Every day of the window was asked for, and nothing was stored.
    expect(w.chQueries.filter((q) => q.includes('p2m_restricted.promptText'))).toHaveLength(90);
    expect(w.store.size).toBe(0);
  });

  it('a dry run reports it instead', async () => {
    const w = await world({
      genRows: [],
      env: { ...ENV, RESOURCE_INTENT_TAG_INDEX_BUCKET: undefined },
    });
    const { summary } = await runTagIndexBuild({ dryRun: true }, w.deps);
    expect(summary.observations).toBe(0);
  });
});

describe('generator observations are read a day per query, each response read to its end', () => {
  it('tags nothing and reads no Postgres while a ClickHouse response is open', async () => {
    // More rows on one day than the old reader buffered before tagging (20,000).
    const genRows = Array.from({ length: 20_001 }, (_, i) => ({
      ...defaultGenRows[i % 3],
      p: `row ${i}`,
    }));
    const w = await world({ genRows });
    w.deps.excludeGenPrompt = () => {
      if (w.streamOpen()) w.workWhileOpen.push('tagging');
      return false;
    };
    const { summary } = await runTagIndexBuild({ dryRun: false }, w.deps);
    expect(summary.observations).toBe(20_001);
    expect(w.workWhileOpen).toEqual([]);
  });

  it('pages cover the window exactly, one UTC day each, and the limit spans the pages', async () => {
    const asked: string[] = [];
    const ch: TagClickHouse = {
      async *rows<T>(q: string) {
        asked.push(
          q
            .match(
              /time >= (toDateTime\('[^']+', 'UTC'\)) AND time < (toDateTime\('[^']+', 'UTC'\))/
            )
            ?.slice(1)
            .join(' .. ') ?? ''
        );
        for (let i = 0; i < 2; i++)
          yield { u: '1', p: 'x', v: [1], liked: 0, favorite: 0, disliked: 0 } as T;
      },
      close: async () => undefined,
    };
    const window = {
      start: new Date('2026-07-21T00:00:00Z'),
      end: new Date('2026-07-23T12:00:00Z'),
    };
    const pages: number[] = [];
    for await (const page of genObservationPages(ch, window)) pages.push(page.length);
    expect(pages).toEqual([2, 2, 2]);
    expect(asked).toEqual([
      `toDateTime('2026-07-21 00:00:00', 'UTC') .. toDateTime('2026-07-22 00:00:00', 'UTC')`,
      `toDateTime('2026-07-22 00:00:00', 'UTC') .. toDateTime('2026-07-23 00:00:00', 'UTC')`,
      `toDateTime('2026-07-23 00:00:00', 'UTC') .. toDateTime('2026-07-23 12:00:00', 'UTC')`,
    ]);
    const limited: number[] = [];
    for await (const page of genObservationPages(ch, window, 3)) limited.push(page.length);
    expect(limited).toEqual([2, 2]);
  });
});

describe('gate 4: a frozen vocabulary', () => {
  it('refuses when only a candidate exists, before any training read', async () => {
    const w = await world({ vocabs: [[CANDIDATE, 'candidate', null]] });
    await expect(runTagIndexBuild({ dryRun: false }, w.deps)).rejects.toThrow(
      'tag index build: no frozen vocabulary; refusing'
    );
    expect(w.deps.query).toHaveBeenCalledTimes(1);
    expectNoTrainingReads(w);
  });

  it('a retired vocabulary is not built from either', async () => {
    const w = await world({ vocabs: [[NEW_FROZEN, 'retired', '2026-10-10T00:00:00Z']] });
    await expect(runTagIndexBuild({ dryRun: false }, w.deps)).rejects.toThrow(
      'no frozen vocabulary'
    );
  });
});

describe('generator prompts never reach the slow-audit log', () => {
  it('with the slow log forced on for every audit and raw capture on, no line carries a prompt', async () => {
    process.env.AUDIT_SLOW_LOG_MS = '0';
    process.env.AUDIT_SLOW_LOG_RAW = 'true';
    const w = await world();
    // No excludeGenPrompt: the job's default auditor runs.
    expect(w.deps.excludeGenPrompt).toBeUndefined();
    await runTagIndexBuild({ dryRun: true }, w.deps);
    await __flushPendingEmitsForTest();
    // Positive control: the audit ran on the generator prompts and logged. (Concurrent emit tails
    // can resolve the logging module past this file's mock, so not every line is captured; the
    // single-audit cases in resource-intent-tags.prompt-exclusion.test.ts count exactly.)
    expect(logToAxiom).toHaveBeenCalled();
    const logged = JSON.stringify(logToAxiom.mock.calls);
    expect(logged).toContain('audit-prompt-slow');
    expect(logged).not.toContain('secret prompt');
    expect(logged).not.toContain('rawPrompt');
    expect(logged).not.toContain('promptHash');
  });
});

describe('the put', () => {
  it('runs with the training-side accumulator already unreachable', async () => {
    const v8 = await import('v8');
    const vm = await import('vm');
    v8.setFlagsFromString('--expose_gc');
    const gc = vm.runInNewContext('gc') as () => void;
    const w = await world();
    const before = accumulators.length;
    let reachableDuringPut: boolean | undefined;
    const objects = w.objectsMade();
    w.deps.objects = () => ({
      ...objects,
      put: async (key, bytes) => {
        gc();
        gc();
        reachableDuringPut = accumulators[before]?.deref() !== undefined;
        await objects.put(key, bytes);
      },
    });
    await runTagIndexBuild({ dryRun: false }, w.deps);
    // Positive control: this build made exactly one accumulator, and the put ran.
    expect(accumulators.length).toBe(before + 1);
    expect(reachableDuringPut).toBe(false);
  });
});

describe('readonlyClickHouse', () => {
  it('closes a result abandoned mid-stream, and leaves a fully read one alone', async () => {
    const results: { close: ReturnType<typeof vi.fn> }[] = [];
    const settings: unknown[] = [];
    clickhouseClient.createClient.mockImplementation((config: unknown) => {
      settings.push(config);
      return {
        query: async () => {
          const rs = {
            close: vi.fn(),
            async *stream() {
              yield [{ json: () => ({ n: 1 }) }, { json: () => ({ n: 2 }) }];
              yield [{ json: () => ({ n: 3 }) }];
            },
          };
          results.push(rs);
          return rs;
        },
        close: async () => undefined,
      };
    });
    const ch = await readonlyClickHouse({ url: 'https://ch.invalid', user: 'u', password: 'p' });
    const all: unknown[] = [];
    for await (const r of ch.rows(`SELECT 1`)) all.push(r);
    expect(all).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(results[0].close).not.toHaveBeenCalled();
    await expect(
      (async () => {
        for await (const r of ch.rows<{ n: number }>(`SELECT 2`))
          if (r.n === 2) throw new Error('consumer failed');
      })()
    ).rejects.toThrow('consumer failed');
    expect(results[1].close).toHaveBeenCalledTimes(1);
    // The client sends no readonly: the session runs at the account's own level, which the gate
    // checks. A client-sent readonly=2 would read back as 2 on a writable account.
    expect(settings).toHaveLength(1);
    const sent = (settings[0] as { clickhouse_settings: Record<string, unknown> })
      .clickhouse_settings;
    expect(sent).toEqual({ max_execution_time: 1800 });
  });
});

describe('loopYielder', () => {
  it('yields only once its slice has passed, then restarts the slice', async () => {
    let t = 0;
    const tick = loopYielder(50, () => t);
    const spy = vi.spyOn(global, 'setImmediate');
    await tick();
    t = 49;
    await tick();
    expect(spy).not.toHaveBeenCalled();
    t = 50;
    await tick();
    expect(spy).toHaveBeenCalledTimes(1);
    t = 99;
    await tick();
    expect(spy).toHaveBeenCalledTimes(1);
    t = 100;
    await tick();
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});
