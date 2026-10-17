import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { TagBuildStats } from '~/server/services/resource-intent-tags/build';
import {
  decodeTagIndex,
  encodeTagIndex,
  TAG_INDEX_MAX_PAYLOAD_BYTES,
} from '~/server/services/resource-intent-tags/payload';
import {
  latestReadyManifest,
  loadLatestSnapshot,
  putSnapshot,
  TagIndexManifestInsertError,
  TagIndexObjectMissingError,
  TagIndexPayloadCorruptError,
  TagIndexPayloadHashError,
  TagIndexPayloadSizeError,
  TagIndexSnapshotUnservableError,
  TagIndexSpecHashMismatchError,
  TagIndexStudyDuplicateError,
  TagIndexVocabularyMissingError,
  TagIndexVocabularyNotFrozenError,
  TagIndexVocabVersionMismatchError,
  type PutTagIndexSnapshotMeta,
  type TagIndexObjectStore,
  type TagIndexStoreDeps,
} from '~/server/services/resource-intent-tags/store';
import { asFixtureWriter, pgliteSql, utcPglite } from './resource-intent-cooc.harness';
import { smallTagIndexData } from './resource-intent-tags.fixture';

/** The tag-index snapshot store against both real migrations in PGlite and an in-memory object store. */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const migration = (name: string) =>
  readFileSync(
    join(process.cwd(), 'packages/civitai-db-schema/prisma/migrations', name, 'migration.sql'),
    'utf8'
  );
const VOCAB_SQL = migration('20261029120000_resource_intent_tags');
const SNAPSHOT_SQL = migration('20261103120000_resource_intent_tag_index_snapshot');

const DAY = 86_400_000;
const SPEC = 'd'.repeat(64);
const OTHER_SPEC = 'e'.repeat(64);
const PREFIX = 'ri/tag-index';
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function vocabulary(label: string) {
  const payload = Buffer.from(JSON.stringify({ label }));
  return { payload, vocabVersion: sha(payload) };
}
const V1 = vocabulary('one');
const V2 = vocabulary('two');

const STATS = { rows: { gen: 8, post: 8 }, postings: 12 } as unknown as TagBuildStats;

/** Payloads built once: the codec is not what this file tests. */
const payloadCache = new Map<string, Promise<Buffer>>();
const payloadOf = (vocabVersion: string, specHash = SPEC) => {
  const k = `${vocabVersion}:${specHash}`;
  if (!payloadCache.has(k))
    payloadCache.set(k, encodeTagIndex(smallTagIndexData(vocabVersion), specHash));
  return payloadCache.get(k) as Promise<Buffer>;
};

type Status = 'candidate' | 'frozen' | 'retired';

async function freshDb(vocabs: [typeof V1, Status][] = [[V1, 'frozen']]) {
  const db = await utcPglite(VOCAB_SQL, SNAPSHOT_SQL);
  for (const [v, status] of vocabs) await insertVocab(db, v, status);
  const statements: string[] = [];
  const log: string[] = [];
  const base = pgliteSql(db, statements);
  const sql: typeof base = {
    query: <T>(q: Prisma.Sql) => {
      log.push(q.text.trim().split(/\s+/)[0]);
      return base.query<T>(q);
    },
    execute: base.execute,
  };
  const store = new Map<string, Buffer>();
  const gets: { key: string; expectedBytes: number }[] = [];
  const objects: TagIndexObjectStore & { failPut?: Error; failGet?: Error } = {
    prefix: PREFIX,
    put: async (key, bytes) => {
      log.push(`put ${key}`);
      if (objects.failPut) throw objects.failPut;
      store.set(key, Buffer.from(bytes));
    },
    get: async (key, expectedBytes) => {
      gets.push({ key, expectedBytes });
      if (objects.failGet) throw objects.failGet;
      const b = store.get(key);
      if (!b) throw new TagIndexObjectMissingError(`no object ${key}`);
      return Buffer.from(b);
    },
  };
  const deps: TagIndexStoreDeps = { sql, objects };
  const rows = async () =>
    (
      await db.query<{ id: string; kind: string; status: string }>(
        `SELECT "id", "kind", "status" FROM "ResourceIntentTagIndexSnapshot" ORDER BY "createdAt", "id"`
      )
    ).rows;
  return { db, sql, deps, objects, store, gets, log, rows };
}

function insertVocab(db: PGlite, v: typeof V1, status: Status) {
  const frozen = status === 'candidate' ? null : '2026-10-01T00:00:00Z';
  return db.query(
    `INSERT INTO "ResourceIntentVocabulary" ("vocabVersion", "payload", "rulesSummary", "status", "frozenAt", "frozenBy")
     VALUES ($1, $2, '{}', $3, $4, $5)`,
    [v.vocabVersion, v.payload, status, frozen, frozen && 'operator']
  );
}

const NOW = new Date();
const meta = (over: Partial<PutTagIndexSnapshotMeta> = {}): PutTagIndexSnapshotMeta => ({
  kind: 'production',
  vocabVersion: V1.vocabVersion,
  specHash: SPEC,
  buildStats: STATS,
  pinnedUntil: null,
  now: NOW,
  ...over,
});
const studyMeta = (over: Partial<PutTagIndexSnapshotMeta> = {}) =>
  meta({ kind: 'study', pinnedUntil: new Date(Date.now() + 30 * DAY), ...over });

type Row = {
  kind: string;
  status: string;
  retiredAt: string | null;
  vocabVersion: string;
  specHash: string;
  payloadSha256: string;
  payloadBytes: number;
  objectKey: string;
  pinnedUntil: string | null;
  buildStats: string;
  createdAt: string | null;
};
const ROW_SHA = sha(Buffer.from('x'));
/** A valid production row; each column overridable. */
function insertRow(db: PGlite, over: Partial<Row> = {}) {
  const r: Row = {
    kind: 'production',
    status: 'ready',
    retiredAt: null,
    vocabVersion: V1.vocabVersion,
    specHash: SPEC,
    payloadSha256: ROW_SHA,
    payloadBytes: 1,
    objectKey: `p/${over.kind ?? 'production'}/${over.payloadSha256 ?? ROW_SHA}`,
    pinnedUntil: null,
    buildStats: '{}',
    createdAt: null,
    ...over,
  };
  return db.query(
    `INSERT INTO "ResourceIntentTagIndexSnapshot"
       ("kind", "status", "retiredAt", "vocabVersion", "specHash", "payloadSha256", "payloadBytes",
        "objectKey", "pinnedUntil", "buildStats", "createdAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, COALESCE($11::timestamp, now()))`,
    [
      r.kind,
      r.status,
      r.retiredAt,
      r.vocabVersion,
      r.specHash,
      r.payloadSha256,
      r.payloadBytes,
      r.objectKey,
      r.pinnedUntil,
      r.buildStats,
      r.createdAt,
    ]
  );
}

/** A manifest row for `bytes` written by hand, for payloads `putSnapshot` itself would refuse. */
async function insertManifest(
  db: PGlite,
  bytes: Buffer,
  over: { specHash?: string; vocabVersion?: string } = {}
) {
  const s = sha(bytes);
  const objectKey = `${PREFIX}/production/${s}`;
  await insertRow(db, { ...over, payloadSha256: s, payloadBytes: bytes.length, objectKey });
  return objectKey;
}

const ahead = (days: number) => new Date(Date.now() + days * DAY).toISOString();

describe('ResourceIntentTagIndexSnapshot migration', () => {
  it('is re-runnable and creates its constraints, indexes and guard trigger', async () => {
    const { db } = await freshDb();
    await expect(db.exec(SNAPSHOT_SQL)).resolves.toBeDefined();
    const cons = await db.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conrelid = '"ResourceIntentTagIndexSnapshot"'::regclass ORDER BY conname`
    );
    expect(cons.rows.map((r) => r.conname)).toEqual([
      'ResourceIntentTagIndexSnapshot_kind_pin_check',
      'ResourceIntentTagIndexSnapshot_payload_check',
      'ResourceIntentTagIndexSnapshot_pkey',
      'ResourceIntentTagIndexSnapshot_status_check',
      'ResourceIntentTagIndexSnapshot_vocabVersion_fkey',
    ]);
    const idx = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'ResourceIntentTagIndexSnapshot' ORDER BY indexname`
    );
    expect(idx.rows.map((r) => r.indexname)).toEqual([
      'ResourceIntentTagIndexSnapshot_kind_payloadSha256_ready_key',
      'ResourceIntentTagIndexSnapshot_latest_ready_idx',
      'ResourceIntentTagIndexSnapshot_pkey',
    ]);
  });

  it('a row names an existing vocabulary, which cannot then be deleted', async () => {
    const { db } = await freshDb();
    const study = { kind: 'study', pinnedUntil: ahead(30) };
    await expect(insertRow(db, { ...study, vocabVersion: V2.vocabVersion })).rejects.toThrow(
      /vocabVersion_fkey/
    );
    await insertRow(db, study);
    await expect(db.query(`DELETE FROM "ResourceIntentVocabulary"`)).rejects.toThrow(
      /vocabVersion_fkey/
    );
  });

  it('a production row needs a frozen vocabulary when inserted; a study row does not', async () => {
    const { db } = await freshDb([
      [V1, 'frozen'],
      [V2, 'candidate'],
    ]);
    await expect(insertRow(db, { vocabVersion: V2.vocabVersion })).rejects.toThrow(
      /needs a frozen vocabulary/
    );
    await expect(
      insertRow(db, { vocabVersion: V2.vocabVersion, kind: 'study', pinnedUntil: ahead(30) })
    ).resolves.toBeDefined();
    await expect(insertRow(db)).resolves.toBeDefined();
  });

  it.each<[string, Partial<Row>, RegExp]>([
    ['a key under another kind', { objectKey: `p/study/${ROW_SHA}` }, /payload_check/],
    ['a key with an empty prefix', { objectKey: `/production/${ROW_SHA}` }, /payload_check/],
    ['a key naming other bytes', { objectKey: `p/production/${'0'.repeat(64)}` }, /payload_check/],
    ['an uppercase sha256', { payloadSha256: ROW_SHA.toUpperCase() }, /payload_check/],
    ['a short spec hash', { specHash: 'd'.repeat(63) }, /payload_check/],
    ['zero bytes', { payloadBytes: 0 }, /payload_check/],
    ['bytes over the cap', { payloadBytes: TAG_INDEX_MAX_PAYLOAD_BYTES + 1 }, /payload_check/],
    ['stats that are not an object', { buildStats: '[]' }, /payload_check/],
    ['a pinned production row', { pinnedUntil: ahead(1) }, /kind_pin_check/],
    ['an unpinned study', { kind: 'study' }, /kind_pin_check/],
    ['a study pinned 59 days', { kind: 'study', pinnedUntil: ahead(59) }, /kind_pin_check/],
    ['a study pin already past', { kind: 'study', pinnedUntil: ahead(-1) }, /kind_pin_check/],
    ['a ready row with retiredAt', { retiredAt: ahead(0) }, /status_check/],
  ])('refuses %s', async (_, over, error) => {
    const { db } = await freshDb();
    await expect(insertRow(db, over)).rejects.toThrow(error);
  });

  it('accepts the boundary values those CHECKs allow', async () => {
    const { db } = await freshDb();
    await insertRow(db, { payloadBytes: TAG_INDEX_MAX_PAYLOAD_BYTES });
    await insertRow(db, { kind: 'study', pinnedUntil: ahead(57.9) });
    expect((await db.query(`SELECT 1 FROM "ResourceIntentTagIndexSnapshot"`)).rows).toHaveLength(2);
  });

  it('the guard sets createdAt, inserts only ready rows, and allows only ready -> retired', async () => {
    const { db } = await freshDb();
    await expect(insertRow(db, { status: 'retired', retiredAt: ahead(0) })).rejects.toThrow(
      /inserted ready/
    );
    // A writer-supplied createdAt is overwritten: the study pin CHECK measures from it.
    await insertRow(db, { createdAt: '2000-01-01' });
    const [{ createdAt }] = (
      await db.query<{ createdAt: Date }>(
        `SELECT "createdAt" FROM "ResourceIntentTagIndexSnapshot"`
      )
    ).rows;
    expect(Math.abs(createdAt.getTime() - Date.now())).toBeLessThan(60_000);
    await expect(
      db.query(`UPDATE "ResourceIntentTagIndexSnapshot" SET "specHash" = $1`, [OTHER_SPEC])
    ).rejects.toThrow(/only its status can change/);
    await db.query(`UPDATE "ResourceIntentTagIndexSnapshot" SET "status" = 'retired'`);
    const [r] = (
      await db.query<{ retiredAt: Date | null }>(
        `SELECT "retiredAt" FROM "ResourceIntentTagIndexSnapshot"`
      )
    ).rows;
    expect(r.retiredAt).toBeInstanceOf(Date);
    await expect(
      db.query(`UPDATE "ResourceIntentTagIndexSnapshot" SET "status" = 'ready'`)
    ).rejects.toThrow(/retire is one-way/);
  });
});

describe('putSnapshot', () => {
  it('uploads to a content-addressed key, then inserts a ready manifest', async () => {
    const { deps, store, log, rows } = await freshDb();
    const payload = await payloadOf(V1.vocabVersion);
    const { manifest, created } = await putSnapshot(deps, payload, meta());
    const key = `${PREFIX}/production/${sha(payload)}`;
    expect(created).toBe(true);
    expect(manifest).toMatchObject({
      kind: 'production',
      status: 'ready',
      vocabVersion: V1.vocabVersion,
      specHash: SPEC,
      payloadSha256: sha(payload),
      payloadBytes: payload.length,
      objectKey: key,
      pinnedUntil: null,
      buildStats: STATS,
      retiredAt: null,
    });
    expect(store.get(key)?.equals(payload)).toBe(true);
    expect(log.indexOf(`put ${key}`)).toBeLessThan(log.indexOf('INSERT'));
    expect(await rows()).toHaveLength(1);
  });

  it('a study may name a candidate vocabulary', async () => {
    const { deps } = await freshDb([[V1, 'candidate']]);
    const payload = await payloadOf(V1.vocabVersion);
    const { manifest } = await putSnapshot(deps, payload, studyMeta());
    expect(manifest.kind).toBe('study');
    expect(manifest.objectKey).toBe(`${PREFIX}/study/${sha(payload)}`);
  });

  describe('refuses, uploading and inserting nothing', () => {
    const refused = async (
      setup: Awaited<ReturnType<typeof freshDb>>,
      payload: Buffer,
      m: PutTagIndexSnapshotMeta,
      error: new (...a: never[]) => Error,
      message: RegExp
    ) => {
      const err = await putSnapshot(setup.deps, payload, m).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(error);
      expect((err as Error).message).toMatch(message);
      expect(setup.store.size).toBe(0);
      expect(await setup.rows()).toEqual([]);
    };

    it('a pinned production build, or an unpinned study', async () => {
      const payload = await payloadOf(V1.vocabVersion);
      await refused(
        await freshDb(),
        payload,
        meta({ pinnedUntil: new Date(Date.now() + DAY) }),
        Error,
        /production snapshot cannot be pinned/
      );
      await refused(
        await freshDb(),
        payload,
        studyMeta({ pinnedUntil: null }),
        Error,
        /requires a pin/
      );
    });

    it('an empty payload', async () => {
      await refused(await freshDb(), Buffer.alloc(0), meta(), TagIndexPayloadSizeError, /0 bytes/);
    });

    it('a payload over the size cap', async () => {
      const big = Buffer.alloc(TAG_INDEX_MAX_PAYLOAD_BYTES + 1);
      await refused(await freshDb(), big, meta(), TagIndexPayloadSizeError, /134217729 bytes/);
    });

    it('a payload at the size cap reaches the decode', async () => {
      const atCap = Buffer.alloc(TAG_INDEX_MAX_PAYLOAD_BYTES);
      await refused(await freshDb(), atCap, meta(), TagIndexPayloadCorruptError, /payload/);
    });

    it('a vocabulary that does not exist', async () => {
      const payload = await payloadOf(V2.vocabVersion);
      await refused(
        await freshDb(),
        payload,
        meta({ vocabVersion: V2.vocabVersion }),
        TagIndexVocabularyMissingError,
        /not found/
      );
    });

    it.each(['candidate', 'retired'] as const)(
      'a production build naming a %s vocabulary',
      async (status) => {
        const payload = await payloadOf(V1.vocabVersion);
        await refused(
          await freshDb([[V1, status]]),
          payload,
          meta(),
          TagIndexVocabularyNotFrozenError,
          new RegExp(`is '${status}'`)
        );
      }
    );

    it('a payload that does not decode', async () => {
      const junk = Buffer.from('not a tag index');
      await refused(await freshDb(), junk, meta(), TagIndexPayloadCorruptError, /payload/);
    });

    it('a payload built under another spec hash', async () => {
      const payload = await payloadOf(V1.vocabVersion, OTHER_SPEC);
      await refused(
        await freshDb(),
        payload,
        meta(),
        TagIndexSpecHashMismatchError,
        new RegExp(`specHash ${OTHER_SPEC}`)
      );
    });

    it('a payload built on another vocabulary', async () => {
      const payload = await payloadOf(V2.vocabVersion);
      await refused(
        await freshDb([
          [V1, 'frozen'],
          [V2, 'frozen'],
        ]),
        payload,
        meta(),
        TagIndexVocabVersionMismatchError,
        new RegExp(`vocabVersion ${V2.vocabVersion}`)
      );
    });

    it('a failed upload', async () => {
      const setup = await freshDb();
      setup.objects.failPut = new Error('bucket unreachable');
      await refused(setup, await payloadOf(V1.vocabVersion), meta(), Error, /bucket unreachable/);
    });
  });

  it('an insert failing after the upload leaves the object unreferenced, and a retry lands', async () => {
    const setup = await freshDb();
    const payload = await payloadOf(V1.vocabVersion);
    // An empty prefix fails the table's key CHECK: a real database refusal, after the upload.
    setup.objects.prefix = '';
    const err = await putSnapshot(setup.deps, payload, meta()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TagIndexManifestInsertError);
    expect((err as TagIndexManifestInsertError).objectKey).toBe(`/production/${sha(payload)}`);
    expect((err as Error).message).toMatch(/payload_check/);
    expect([...setup.store.keys()]).toEqual([`/production/${sha(payload)}`]);
    expect(await setup.rows()).toEqual([]);
    expect(await loadLatestSnapshot(setup.deps, SPEC)).toBeNull();

    setup.objects.prefix = PREFIX;
    const { created } = await putSnapshot(setup.deps, payload, meta());
    expect(created).toBe(true);
    expect(await setup.rows()).toHaveLength(1);
  });

  it('the same production payload again returns the standing row', async () => {
    const { deps, rows } = await freshDb();
    const payload = await payloadOf(V1.vocabVersion);
    const first = await putSnapshot(deps, payload, meta());
    const again = await putSnapshot(deps, payload, meta());
    expect(again.created).toBe(false);
    expect(again.manifest.id).toBe(first.manifest.id);
    expect(await rows()).toHaveLength(1);
  });

  it('the same payload again after its row was retired inserts a new ready row', async () => {
    const { deps, db, rows } = await freshDb();
    const payload = await payloadOf(V1.vocabVersion);
    const first = await putSnapshot(deps, payload, meta());
    await db.query(`UPDATE "ResourceIntentTagIndexSnapshot" SET "status" = 'retired'`);
    const again = await putSnapshot(deps, payload, meta());
    expect(again.created).toBe(true);
    expect(again.manifest.id).not.toBe(first.manifest.id);
    expect((await rows()).map((r) => r.status).sort()).toEqual(['ready', 'retired']);
  });

  it('a conflicting ready row retired before it is read back is an insert failure', async () => {
    const { deps, db, sql } = await freshDb();
    const payload = await payloadOf(V1.vocabVersion);
    await putSnapshot(deps, payload, meta());
    const racing: typeof sql = {
      query: async <T>(q: Prisma.Sql) => {
        const r = await sql.query<T>(q);
        if (q.text.includes('ON CONFLICT') && r.length === 0)
          await db.query(`UPDATE "ResourceIntentTagIndexSnapshot" SET "status" = 'retired'`);
        return r;
      },
      execute: sql.execute,
    };
    const err = await putSnapshot({ ...deps, sql: racing }, payload, meta()).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(TagIndexManifestInsertError);
    expect((err as Error).message).toMatch(/conflicted and is gone/);
  });

  it('the same study payload again is refused; production and study rows of one payload coexist', async () => {
    const { deps, rows } = await freshDb();
    const payload = await payloadOf(V1.vocabVersion);
    await putSnapshot(deps, payload, studyMeta());
    await expect(putSnapshot(deps, payload, studyMeta())).rejects.toBeInstanceOf(
      TagIndexStudyDuplicateError
    );
    await putSnapshot(deps, payload, meta());
    expect((await rows()).map((r) => r.kind).sort()).toEqual(['production', 'study']);
  });
});

describe('loadLatestSnapshot', () => {
  it('round-trips through the codec', async () => {
    const { deps, gets } = await freshDb();
    const payload = await payloadOf(V1.vocabVersion);
    expect(await loadLatestSnapshot(deps, SPEC)).toBeNull();
    const { manifest } = await putSnapshot(deps, payload, meta());
    const loaded = await loadLatestSnapshot(deps, SPEC);
    expect(loaded?.manifest).toEqual(manifest);
    expect(gets).toEqual([{ key: manifest.objectKey, expectedBytes: payload.length }]);
    expect(loaded?.index).toEqual((await decodeTagIndex(payload)).index);
    expect(loaded?.index.vocabulary.map((t) => t.key)).toEqual(
      smallTagIndexData(V1.vocabVersion).vocabulary.map((t) => t.key)
    );
  });

  it('serves the newest ready production row for the spec hash, nothing else', async () => {
    const setup = await freshDb([
      [V1, 'frozen'],
      [V2, 'frozen'],
    ]);
    const { deps, db } = setup;
    const older = await putSnapshot(deps, await payloadOf(V1.vocabVersion), meta());
    const newer = await putSnapshot(
      deps,
      await payloadOf(V2.vocabVersion),
      meta({ vocabVersion: V2.vocabVersion })
    );
    await putSnapshot(
      deps,
      await payloadOf(V1.vocabVersion, OTHER_SPEC),
      meta({ specHash: OTHER_SPEC })
    );
    const study = await putSnapshot(
      deps,
      await payloadOf(V2.vocabVersion),
      studyMeta({ vocabVersion: V2.vocabVersion })
    );
    const setCreated = (id: string, daysAgo: number) =>
      asFixtureWriter(db, () =>
        db.query(`UPDATE "ResourceIntentTagIndexSnapshot" SET "createdAt" = $1 WHERE "id" = $2`, [
          new Date(Date.now() - daysAgo * DAY),
          id,
        ])
      );
    await setCreated(older.manifest.id, 3);
    await setCreated(newer.manifest.id, 2);
    await setCreated(study.manifest.id, 0);
    expect((await latestReadyManifest(setup.sql, SPEC))?.id).toBe(newer.manifest.id);
    expect((await latestReadyManifest(setup.sql, OTHER_SPEC))?.specHash).toBe(OTHER_SPEC);

    await db.query(
      `UPDATE "ResourceIntentTagIndexSnapshot" SET "status" = 'retired' WHERE "id" = $1`,
      [newer.manifest.id]
    );
    const loaded = await loadLatestSnapshot(deps, SPEC);
    expect(loaded?.manifest.id).toBe(older.manifest.id);
    expect(loaded?.index.vocabulary.length).toBeGreaterThan(0);
  });

  it('serves a production snapshot whose vocabulary was retired after the build', async () => {
    const { deps, db } = await freshDb();
    await putSnapshot(deps, await payloadOf(V1.vocabVersion), meta());
    await db.query(`UPDATE "ResourceIntentVocabulary" SET "status" = 'retired'`);
    expect(await loadLatestSnapshot(deps, SPEC)).not.toBeNull();
  });

  describe('refuses', () => {
    const refusedLoad = async (
      deps: TagIndexStoreDeps,
      error: new (...a: never[]) => Error,
      message: RegExp,
      specHash = SPEC
    ) => {
      const err = await loadLatestSnapshot(deps, specHash).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(error);
      expect(err).toBeInstanceOf(TagIndexSnapshotUnservableError);
      expect((err as Error).message).toMatch(message);
    };

    it('a manifest whose vocabulary row is gone', async () => {
      const { deps, db } = await freshDb();
      await putSnapshot(deps, await payloadOf(V1.vocabVersion), meta());
      await asFixtureWriter(db, () => db.query(`DELETE FROM "ResourceIntentVocabulary"`));
      await refusedLoad(deps, TagIndexVocabularyMissingError, /not found/);
    });

    it('a production manifest whose vocabulary is a candidate', async () => {
      const { deps, db } = await freshDb();
      await putSnapshot(deps, await payloadOf(V1.vocabVersion), meta());
      await db.query(
        `UPDATE "ResourceIntentVocabulary" SET "status" = 'candidate', "frozenAt" = NULL, "frozenBy" = NULL`
      );
      await refusedLoad(deps, TagIndexVocabularyNotFrozenError, /is a candidate/);
    });

    it('stored bytes of another length', async () => {
      const { deps, store } = await freshDb();
      const { manifest } = await putSnapshot(deps, await payloadOf(V1.vocabVersion), meta());
      store.set(
        manifest.objectKey,
        Buffer.concat([store.get(manifest.objectKey) as Buffer, Buffer.of(0)])
      );
      await refusedLoad(deps, TagIndexPayloadSizeError, /manifest says/);
    });

    it('stored bytes of the right length but another sha256', async () => {
      const { deps, store } = await freshDb();
      const { manifest } = await putSnapshot(deps, await payloadOf(V1.vocabVersion), meta());
      const b = store.get(manifest.objectKey) as Buffer;
      b[b.length >> 1] ^= 0xff;
      await refusedLoad(deps, TagIndexPayloadHashError, /sha256/);
    });

    it('bytes that match the manifest but do not decode', async () => {
      const { deps, db, store } = await freshDb();
      const junk = Buffer.from('not a tag index');
      store.set(await insertManifest(db, junk), junk);
      await refusedLoad(deps, TagIndexPayloadCorruptError, /tag index snapshot/);
    });

    it('a payload whose spec hash is not the manifest row', async () => {
      const { deps, db, store } = await freshDb();
      const payload = await payloadOf(V1.vocabVersion);
      store.set(await insertManifest(db, payload, { specHash: OTHER_SPEC }), payload);
      await refusedLoad(
        deps,
        TagIndexSpecHashMismatchError,
        new RegExp(`specHash ${SPEC}, expected ${OTHER_SPEC}`),
        OTHER_SPEC
      );
    });

    it('a payload whose vocabulary version is not the manifest row', async () => {
      const { deps, db, store } = await freshDb([
        [V1, 'frozen'],
        [V2, 'frozen'],
      ]);
      const payload = await payloadOf(V2.vocabVersion);
      store.set(await insertManifest(db, payload, { vocabVersion: V1.vocabVersion }), payload);
      await refusedLoad(
        deps,
        TagIndexVocabVersionMismatchError,
        new RegExp(`vocabVersion ${V2.vocabVersion}, expected ${V1.vocabVersion}`)
      );
    });
  });

  it('a download failure is rethrown as it is, not as unservable', async () => {
    const { deps, objects } = await freshDb();
    await putSnapshot(deps, await payloadOf(V1.vocabVersion), meta());
    objects.failGet = new Error('connection reset');
    const err = await loadLatestSnapshot(deps, SPEC).catch((e: unknown) => e);
    expect((err as Error).message).toBe('connection reset');
    expect(err).not.toBeInstanceOf(TagIndexSnapshotUnservableError);
  });
});
