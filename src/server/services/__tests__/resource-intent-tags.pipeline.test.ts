import { readFileSync } from 'fs';
import { join } from 'path';
import type { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serverSchema } from '~/env/server-schema';
import {
  loopYielder,
  runTagIndexBuild,
  TAG_BUILD_MAX_OBSERVATION_AGE_HOURS,
  tagBuildConfig,
  type TagBuildDeps,
  type TagBuildEnv,
  type TagClickHouse,
} from '~/server/services/resource-intent-tags/pipeline';
import { observationKeyFingerprint } from '~/server/services/resource-intent-tags/sources';
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

const migration = (name: string) =>
  readFileSync(
    join(process.cwd(), 'packages/civitai-db-schema/prisma/migrations', name, 'migration.sql'),
    'utf8'
  );
const VOCAB_SQL = migration('20261029120000_resource_intent_tags');
const SNAPSHOT_SQL = migration('20261103120000_resource_intent_tag_index_snapshot');

const KEY = Buffer.alloc(32, 0x11);
const ENV: Required<TagBuildEnv> = {
  RESOURCE_INTENT_TAG_INDEX_BUCKET: 'ri-tag-index-test',
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
  pgReads: string[];
  objectsMade: ReturnType<typeof vi.fn>;
  store: Map<string, Buffer>;
  closed: ReturnType<typeof vi.fn>;
};

async function world(
  opts: {
    vocabs?: [Buffer, string, string | null][];
    readonly?: number;
    ageSec?: number;
    recentRows?: number;
    env?: TagBuildEnv;
  } = {}
): Promise<World> {
  const db = await utcPglite(VOCAB_SQL, SNAPSHOT_SQL);
  for (const [p, s, f] of opts.vocabs ?? [[NEW_FROZEN, 'frozen', '2026-10-10T00:00:00Z']])
    await insertVocab(db, p, s, f);
  const chQueries: string[] = [];
  const pgReads: string[] = [];
  const closed = vi.fn(async () => undefined);
  const now = 1_800_000_000;
  const ch: TagClickHouse = {
    async *rows<T>(q: string) {
      chQueries.push(q);
      if (q.includes(`getSetting('readonly')`)) yield { ro: opts.readonly ?? 2 } as T;
      else if (q.includes('max(time)'))
        yield {
          newest: String(now - (opts.ageSec ?? 3 * 3600)),
          now: String(now),
          n: String(opts.recentRows ?? 5000),
        } as T;
      else if (q.includes('p2m_restricted.promptText'))
        for (const [i, p] of GEN_PROMPTS.entries())
          yield {
            u: String(1000 + (i % 2)),
            p,
            v: [101, 201],
            liked: 1,
            favorite: 0,
            disliked: 0,
          } as T;
      else throw new Error(`unexpected ClickHouse query: ${q}`);
    },
    close: closed,
  };
  const base = pgliteSql(db);
  const query = vi.fn(async (sql: Prisma.Sql) => {
    const t = sql.text;
    pgReads.push(t);
    if (t.includes('"ResourceIntentVocabulary"')) return base.query(sql);
    if (t.includes('FROM "ModelVersion" mv JOIN "Model" m'))
      return [
        { id: 101, modelId: 1, type: 'LORA', baseModel: 'SDXL 1.0', flagged: false },
        { id: 201, modelId: 2, type: 'Checkpoint', baseModel: 'SDXL 1.0', flagged: false },
      ];
    if (t.includes('max(id) AS max FROM "Image"')) return [{ max: null }];
    if (t.includes('WITH ms AS')) return [];
    if (t.includes('FROM "Model" m WHERE m.id = ANY'))
      return [
        {
          id: 1,
          name: 'watercolor lighthouse',
          type: 'LORA',
          description: '<p>castle</p>',
          tags: ['watercolor'],
          versions: [{ baseModel: 'SDXL 1.0', trainedWords: ['lighthouse'] }],
        },
        {
          id: 2,
          name: 'castle model',
          type: 'Checkpoint',
          description: '',
          tags: [],
          versions: [{ baseModel: 'SDXL 1.0', trainedWords: null }],
        },
      ];
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

/** Nothing past the gates ran: no observation, Postgres training read, upload or ClickHouse client. */
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
    const { summary, payload } = await runTagIndexBuild({ dryRun: false }, w.deps);
    const newest = await versionOf(w.db, NEW_FROZEN);
    expect(newest).not.toBe(await versionOf(w.db, OLD_FROZEN));
    expect(summary.vocabVersion).toBe(newest);
    expect(summary.specHash).toBe(RESOURCE_INTENT_TAGS_SPEC_HASH);
    expect(summary).toMatchObject({
      dryRun: false,
      created: true,
      observations: 3,
      genUsers: 2,
      postUsers: 0,
      genAndPostUsers: 0,
      contentModels: 2,
      payloadBytes: payload.length,
    });
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
  });

  it('a dry run needs no bucket, makes no object store and stores nothing', async () => {
    const w = await world({ env: { ...ENV, RESOURCE_INTENT_TAG_INDEX_BUCKET: undefined } });
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

describe('gate 2: a read-only ClickHouse session', () => {
  it('refuses a session that is not read-only', async () => {
    const w = await world({ readonly: 0 });
    await expect(runTagIndexBuild({ dryRun: false }, w.deps)).rejects.toThrow(
      'the ClickHouse session is not read-only'
    );
    expect(w.chQueries).toHaveLength(1);
    expect(w.deps.query).not.toHaveBeenCalled();
    expect(w.closed).toHaveBeenCalledTimes(1);
  });
});

describe('gate 3: generator observations no older than the limit', () => {
  const LIMIT = TAG_BUILD_MAX_OBSERVATION_AGE_HOURS * 3600;

  it('is six hours', () => expect(TAG_BUILD_MAX_OBSERVATION_AGE_HOURS).toBe(6));

  it('refuses one second past the limit, before any training read', async () => {
    const w = await world({ ageSec: LIMIT + 1 });
    await expect(runTagIndexBuild({ dryRun: false }, w.deps)).rejects.toThrow(
      'the newest generator observation is 360 min old (limit 6 h); the extractor is stalled'
    );
    expect(w.deps.query).not.toHaveBeenCalled();
    expectNoTrainingReads(w);
  });

  it('builds at exactly the limit', async () => {
    const w = await world({ ageSec: LIMIT });
    await expect(runTagIndexBuild({ dryRun: false }, w.deps)).resolves.toBeDefined();
  });

  it('refuses when the last three days hold no observation at all', async () => {
    const w = await world({ recentRows: 0, ageSec: 60 });
    await expect(runTagIndexBuild({ dryRun: false }, w.deps)).rejects.toThrow(
      'no generator observation in the last 3 days'
    );
    expectNoTrainingReads(w);
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
