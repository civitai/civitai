import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { TagBuildStats } from '~/server/services/resource-intent-tags/build';
import type * as Payload from '~/server/services/resource-intent-tags/payload';
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
  TagIndexSnapshotTableBoundError,
  TagIndexSnapshotUnservableError,
  TagIndexSpecHashMismatchError,
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

const decodeSpy = vi.hoisted(() => ({ fail: null as Error | null, assembled: 0, validated: 0 }));
vi.mock('~/server/services/resource-intent-tags/payload', async (importOriginal) => {
  const real = await importOriginal<typeof Payload>();
  return {
    ...real,
    decodeTagIndex: async (payload: Uint8Array) => {
      const e = decodeSpy.fail;
      decodeSpy.fail = null;
      if (e) throw e;
      decodeSpy.assembled++;
      return real.decodeTagIndex(payload);
    },
    // The put's decode (validated arrays, not assembled).
    decodeTagIndexData: async (payload: Uint8Array) => {
      const e = decodeSpy.fail;
      decodeSpy.fail = null;
      if (e) throw e;
      decodeSpy.validated++;
      return real.decodeTagIndexData(payload);
    },
  };
});
const allocationFailure = () =>
  Object.assign(new Error('memory'), { code: 'ERR_MEMORY_ALLOCATION_FAILED' });

const migration = (name: string) =>
  readFileSync(
    join(process.cwd(), 'packages/civitai-db-schema/prisma/migrations', name, 'migration.sql'),
    'utf8'
  );
const VOCAB_SQL = migration('20261029120000_resource_intent_tags');
const SNAPSHOT_SQL = migration('20261103120000_resource_intent_tag_index_snapshot');
const PAYLOAD_CAP_SQL = migration('20261106120000_resource_intent_tag_index_snapshot_payload_cap');

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

async function freshDb(
  vocabs: [typeof V1, Status][] = [[V1, 'frozen']],
  migrations = [VOCAB_SQL, SNAPSHOT_SQL, PAYLOAD_CAP_SQL]
) {
  const db = await utcPglite(...migrations);
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
      return { bytes: Buffer.from(b), sha256: sha(b) };
    },
  };
  const deps: TagIndexStoreDeps = { sql, objects };
  const rows = async () =>
    (
      await db.query<{ id: string; status: string }>(
        `SELECT "id", "status" FROM "ResourceIntentTagIndexSnapshot" ORDER BY "createdAt", "id"`
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

const meta = (over: Partial<PutTagIndexSnapshotMeta> = {}): PutTagIndexSnapshotMeta => ({
  vocabVersion: V1.vocabVersion,
  specHash: SPEC,
  buildStats: STATS,
  ...over,
});

type Row = {
  status: string;
  retiredAt: string | null;
  vocabVersion: string;
  specHash: string;
  payloadSha256: string;
  payloadBytes: number;
  objectKey: string;
  buildStats: string;
  createdAt: string | null;
};
const ROW_SHA = sha(Buffer.from('x'));
/** A valid row; each column overridable. */
function insertRow(db: PGlite, over: Partial<Row> = {}) {
  const r: Row = {
    status: 'ready',
    retiredAt: null,
    vocabVersion: V1.vocabVersion,
    specHash: SPEC,
    payloadSha256: ROW_SHA,
    payloadBytes: 1,
    objectKey: `p/${over.payloadSha256 ?? ROW_SHA}`,
    buildStats: '{}',
    createdAt: null,
    ...over,
  };
  return db.query(
    `INSERT INTO "ResourceIntentTagIndexSnapshot"
       ("status", "retiredAt", "vocabVersion", "specHash", "payloadSha256", "payloadBytes",
        "objectKey", "buildStats", "createdAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, COALESCE($9::timestamp, now()))`,
    [
      r.status,
      r.retiredAt,
      r.vocabVersion,
      r.specHash,
      r.payloadSha256,
      r.payloadBytes,
      r.objectKey,
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
  const objectKey = `${PREFIX}/${s}`;
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
      'ResourceIntentTagIndexSnapshot_payload_check',
      'ResourceIntentTagIndexSnapshot_pkey',
      'ResourceIntentTagIndexSnapshot_status_check',
      'ResourceIntentTagIndexSnapshot_vocabVersion_fkey',
    ]);
    const idx = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'ResourceIntentTagIndexSnapshot' ORDER BY indexname`
    );
    expect(idx.rows.map((r) => r.indexname)).toEqual([
      'ResourceIntentTagIndexSnapshot_latest_ready_idx',
      'ResourceIntentTagIndexSnapshot_payloadSha256_ready_key',
      'ResourceIntentTagIndexSnapshot_pkey',
    ]);
    const trg = await db.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname`
    );
    expect(trg.rows.map((r) => r.tgname)).toEqual([
      'ResourceIntentTagIndexSnapshot_guard',
      'ResourceIntentVocabulary_snapshot_guard',
    ]);
  });

  // STRUCTURAL PIN, not behaviour: PGlite has one connection, so no test here can show the guard's
  // row lock blocking a concurrent un-freeze. The behavioural evidence is the two-connection race
  // matrix run on PostgreSQL 16 (PR #6168): without FOR SHARE an un-freeze and an insert both commit.
  it('the guard reads the vocabulary row FOR SHARE (structural pin)', async () => {
    const { db } = await freshDb();
    const [{ def }] = (
      await db.query<{ def: string }>(
        `SELECT pg_get_functiondef('"ResourceIntentTagIndexSnapshot_guard"'::regproc) AS def`
      )
    ).rows;
    expect(def).toMatch(
      /FROM "ResourceIntentVocabulary"\s+WHERE "vocabVersion" = NEW\."vocabVersion" AND "status" = 'frozen'\s+FOR SHARE;/
    );
  });

  it('a row names an existing vocabulary, which cannot then be deleted', async () => {
    const { db } = await freshDb();
    // The guard's frozen check would refuse first; with only it off, the foreign key refuses.
    const T = '"ResourceIntentTagIndexSnapshot"';
    await db.exec(`ALTER TABLE ${T} DISABLE TRIGGER "ResourceIntentTagIndexSnapshot_guard"`);
    await expect(insertRow(db, { vocabVersion: V2.vocabVersion })).rejects.toThrow(
      /vocabVersion_fkey/
    );
    await db.exec(`ALTER TABLE ${T} ENABLE TRIGGER "ResourceIntentTagIndexSnapshot_guard"`);
    await insertRow(db);
    await expect(db.query(`DELETE FROM "ResourceIntentVocabulary"`)).rejects.toThrow(
      /vocabVersion_fkey/
    );
  });

  it('a row needs a frozen vocabulary when inserted', async () => {
    const V3 = vocabulary('three');
    const { db } = await freshDb([
      [V1, 'frozen'],
      [V2, 'candidate'],
      [V3, 'retired'],
    ]);
    await expect(insertRow(db, { vocabVersion: V2.vocabVersion })).rejects.toThrow(
      /needs a frozen vocabulary/
    );
    await expect(insertRow(db, { vocabVersion: V3.vocabVersion })).rejects.toThrow(
      /needs a frozen vocabulary/
    );
    await expect(insertRow(db)).resolves.toBeDefined();
  });

  it('a vocabulary a ready row names cannot go back to candidate, but may be retired', async () => {
    const { db } = await freshDb();
    await insertRow(db);
    const toCandidate = () =>
      db.query(
        `UPDATE "ResourceIntentVocabulary" SET "status" = 'candidate', "frozenAt" = NULL, "frozenBy" = NULL`
      );
    await expect(toCandidate()).rejects.toThrow(/retire the snapshot first/);
    await db.query(`UPDATE "ResourceIntentVocabulary" SET "status" = 'retired'`);
    await expect(toCandidate()).rejects.toThrow(/retire the snapshot first/);
    await db.query(`UPDATE "ResourceIntentTagIndexSnapshot" SET "status" = 'retired'`);
    await expect(toCandidate()).resolves.toBeDefined();
  });

  it.each<[string, Partial<Row>, RegExp]>([
    ['a key with an empty prefix', { objectKey: `/${ROW_SHA}` }, /payload_check/],
    ['a key with no prefix', { objectKey: ROW_SHA }, /payload_check/],
    ['a key naming other bytes', { objectKey: `p/${'0'.repeat(64)}` }, /payload_check/],
    ['an uppercase sha256', { payloadSha256: ROW_SHA.toUpperCase() }, /payload_check/],
    ['a short spec hash', { specHash: 'd'.repeat(63) }, /payload_check/],
    ['zero bytes', { payloadBytes: 0 }, /payload_check/],
    ['bytes over the cap', { payloadBytes: TAG_INDEX_MAX_PAYLOAD_BYTES + 1 }, /payload_check/],
    ['stats that are not an object', { buildStats: '[]' }, /payload_check/],
    ['a ready row with retiredAt', { retiredAt: ahead(0) }, /status_check/],
  ])('refuses %s', async (_, over, error) => {
    const { db } = await freshDb();
    await expect(insertRow(db, over)).rejects.toThrow(error);
  });

  it('accepts the boundary values those CHECKs allow', async () => {
    const { db } = await freshDb();
    await insertRow(db, { payloadBytes: TAG_INDEX_MAX_PAYLOAD_BYTES });
    expect((await db.query(`SELECT 1 FROM "ResourceIntentTagIndexSnapshot"`)).rows).toHaveLength(1);
  });

  it.each<[string, unknown]>([
    ['id', 'another-id'],
    ['vocabVersion', V2.vocabVersion],
    ['specHash', OTHER_SPEC],
    ['payloadSha256', 'f'.repeat(64)],
    ['payloadBytes', 2],
    ['objectKey', `q/${ROW_SHA}`],
    ['buildStats', '{"a":1}'],
    ['createdAt', '2000-01-01'],
  ])('the guard refuses a change to %s', async (column, value) => {
    const { db } = await freshDb([
      [V1, 'frozen'],
      [V2, 'frozen'],
    ]);
    await insertRow(db);
    await expect(
      db.query(`UPDATE "ResourceIntentTagIndexSnapshot" SET "${column}" = $1`, [value])
    ).rejects.toThrow(/only its status can change/);
  });

  it('the guard refuses a change to retiredAt', async () => {
    const { db } = await freshDb();
    await insertRow(db);
    await db.query(`UPDATE "ResourceIntentTagIndexSnapshot" SET "status" = 'retired'`);
    await expect(
      db.query(`UPDATE "ResourceIntentTagIndexSnapshot" SET "retiredAt" = $1`, [ahead(1)])
    ).rejects.toThrow(/retiredAt cannot change/);
  });

  it('the guard sets createdAt, inserts only ready rows, and allows only ready -> retired', async () => {
    const { db } = await freshDb();
    await expect(insertRow(db, { status: 'retired', retiredAt: ahead(0) })).rejects.toThrow(
      /inserted ready/
    );
    // A writer-supplied createdAt is overwritten.
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

describe('the payload-cap migration (20261106120000)', () => {
  const OLD_BOUND = 134_217_728;
  const NEW_BOUND = 268_435_456;
  const checkDef = async (db: PGlite) =>
    (
      await db.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conname = 'ResourceIntentTagIndexSnapshot_payload_check'`
      )
    ).rows.map((r) => r.def);

  it("pins the bound: 256 MiB, the code's cap", () => {
    expect(TAG_INDEX_MAX_PAYLOAD_BYTES).toBe(NEW_BOUND);
  });

  it('before it, the P6c bound refuses one byte over 128 MiB (the control)', async () => {
    const db = await utcPglite(VOCAB_SQL, SNAPSHOT_SQL);
    await insertVocab(db, V1, 'frozen');
    await expect(insertRow(db, { payloadBytes: OLD_BOUND + 1 })).rejects.toThrow(/payload_check/);
    await expect(insertRow(db, { payloadBytes: OLD_BOUND })).resolves.toBeDefined();
  });

  it('after both migrations in order: old bound + 1 and the new bound are accepted, new bound + 1 refused', async () => {
    const db = await utcPglite(VOCAB_SQL, SNAPSHOT_SQL, PAYLOAD_CAP_SQL);
    await insertVocab(db, V1, 'frozen');
    await expect(insertRow(db, { payloadBytes: OLD_BOUND + 1 })).resolves.toBeDefined();
    const sha2 = sha(Buffer.from('y'));
    await expect(
      insertRow(db, { payloadBytes: NEW_BOUND, payloadSha256: sha2 })
    ).resolves.toBeDefined();
    await expect(
      insertRow(db, { payloadBytes: NEW_BOUND + 1, payloadSha256: sha(Buffer.from('z')) })
    ).rejects.toThrow(/payload_check/);
  });

  it('changes only the bound, and is re-runnable', async () => {
    const before = await utcPglite(VOCAB_SQL, SNAPSHOT_SQL);
    const [oldDef] = await checkDef(before);
    const db = await utcPglite(VOCAB_SQL, SNAPSHOT_SQL, PAYLOAD_CAP_SQL);
    const [newDef] = await checkDef(db);
    expect(oldDef).toContain(`<= ${OLD_BOUND}`);
    expect(newDef).toBe(oldDef.replace(`<= ${OLD_BOUND}`, `<= ${NEW_BOUND}`));
    // Again, with a row standing: still one constraint, the same definition, the row kept.
    await insertVocab(db, V1, 'frozen');
    await insertRow(db, { payloadBytes: NEW_BOUND });
    await expect(db.exec(PAYLOAD_CAP_SQL)).resolves.toBeDefined();
    expect(await checkDef(db)).toEqual([newDef]);
    expect((await db.query(`SELECT 1 FROM "ResourceIntentTagIndexSnapshot"`)).rows).toHaveLength(1);
  });

  it('sets a lock timeout before it alters the table', () => {
    expect(PAYLOAD_CAP_SQL.indexOf("SET lock_timeout = '3s';")).toBeGreaterThan(-1);
    expect(PAYLOAD_CAP_SQL.indexOf("SET lock_timeout = '3s';")).toBeLessThan(
      PAYLOAD_CAP_SQL.indexOf('ALTER TABLE')
    );
  });
});

describe('putSnapshot', () => {
  it('uploads to a content-addressed key, then inserts a ready manifest', async () => {
    const { deps, store, log, rows } = await freshDb();
    const payload = await payloadOf(V1.vocabVersion);
    const { manifest, created } = await putSnapshot(deps, payload, meta());
    const key = `${PREFIX}/${sha(payload)}`;
    expect(created).toBe(true);
    expect(manifest).toMatchObject({
      status: 'ready',
      vocabVersion: V1.vocabVersion,
      specHash: SPEC,
      payloadSha256: sha(payload),
      payloadBytes: payload.length,
      objectKey: key,
      buildStats: STATS,
      retiredAt: null,
    });
    expect(store.get(key)?.equals(payload)).toBe(true);
    expect(log.indexOf(`put ${key}`)).toBeLessThan(log.indexOf('INSERT'));
    expect(await rows()).toHaveLength(1);
  });

  it('validates the payload without assembling the scorer’s maps', async () => {
    const { deps } = await freshDb();
    const [assembled, validated] = [decodeSpy.assembled, decodeSpy.validated];
    await putSnapshot(deps, await payloadOf(V1.vocabVersion), meta());
    expect([decodeSpy.assembled - assembled, decodeSpy.validated - validated]).toEqual([0, 1]);
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

    it('an empty payload', async () => {
      await refused(await freshDb(), Buffer.alloc(0), meta(), TagIndexPayloadSizeError, /0 bytes/);
    });

    it('a payload over the size cap', async () => {
      const big = Buffer.alloc(TAG_INDEX_MAX_PAYLOAD_BYTES + 1);
      await refused(await freshDb(), big, meta(), TagIndexPayloadSizeError, /268435457 bytes/);
    });

    it('a payload over the bound the table still holds, before the cap migration', async () => {
      // The table at its P6c bound (128 MiB), and a payload one byte over it, under the code's cap.
      const setup = await freshDb([[V1, 'frozen']], [VOCAB_SQL, SNAPSHOT_SQL]);
      const over = Buffer.alloc(134_217_728 + 1);
      await refused(
        setup,
        over,
        meta(),
        TagIndexSnapshotTableBoundError,
        /admits payloads up to 134217728 bytes.*apply migration 20261106120000_resource_intent_tag_index_snapshot_payload_cap/
      );
      expect(setup.log.filter((l) => l.startsWith('put '))).toEqual([]);
      // Control: the same bytes after the migration get past the bound (to the decode).
      await refused(await freshDb(), over, meta(), TagIndexPayloadCorruptError, /payload/);
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

    it.each(['candidate', 'retired'] as const)('a build naming a %s vocabulary', async (status) => {
      const payload = await payloadOf(V1.vocabVersion);
      await refused(
        await freshDb([[V1, status]]),
        payload,
        meta(),
        TagIndexVocabularyNotFrozenError,
        new RegExp(`is '${status}'`)
      );
    });

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
    expect((err as TagIndexManifestInsertError).objectKey).toBe(`/${sha(payload)}`);
    expect((err as Error).message).toMatch(/payload_check/);
    expect([...setup.store.keys()]).toEqual([`/${sha(payload)}`]);
    expect(await setup.rows()).toEqual([]);
    expect(await loadLatestSnapshot(setup.deps, SPEC)).toBeNull();

    setup.objects.prefix = PREFIX;
    const { created } = await putSnapshot(setup.deps, payload, meta());
    expect(created).toBe(true);
    expect(await setup.rows()).toHaveLength(1);
  });

  it('the same payload again returns the standing row', async () => {
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

  it('serves the newest ready row for the spec hash, nothing else', async () => {
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
    const setCreated = (id: string, daysAgo: number) =>
      asFixtureWriter(db, () =>
        db.query(`UPDATE "ResourceIntentTagIndexSnapshot" SET "createdAt" = $1 WHERE "id" = $2`, [
          new Date(Date.now() - daysAgo * DAY),
          id,
        ])
      );
    await setCreated(older.manifest.id, 3);
    await setCreated(newer.manifest.id, 2);
    expect((await latestReadyManifest(setup.sql, SPEC))?.id).toBe(newer.manifest.id);
    expect((await latestReadyManifest(setup.sql, OTHER_SPEC))?.specHash).toBe(OTHER_SPEC);
    // exceptIds: the newest ready row under the spec that none of them names.
    expect((await latestReadyManifest(setup.sql, SPEC, [newer.manifest.id]))?.id).toBe(
      older.manifest.id
    );
    expect(
      await latestReadyManifest(setup.sql, SPEC, [newer.manifest.id, older.manifest.id])
    ).toBeNull();
    expect((await latestReadyManifest(setup.sql, SPEC, [older.manifest.id]))?.id).toBe(
      newer.manifest.id
    );

    await db.query(
      `UPDATE "ResourceIntentTagIndexSnapshot" SET "status" = 'retired' WHERE "id" = $1`,
      [newer.manifest.id]
    );
    const loaded = await loadLatestSnapshot(deps, SPEC);
    expect(loaded?.manifest.id).toBe(older.manifest.id);
    expect(loaded?.index.vocabulary.length).toBeGreaterThan(0);
  });

  it('serves a snapshot whose vocabulary was retired after the build', async () => {
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

    it('a manifest whose vocabulary is a candidate', async () => {
      const { deps, db } = await freshDb();
      await putSnapshot(deps, await payloadOf(V1.vocabVersion), meta());
      // The vocabulary trigger refuses this; the loader still does not serve it.
      await asFixtureWriter(db, () =>
        db.query(
          `UPDATE "ResourceIntentVocabulary" SET "status" = 'candidate', "frozenAt" = NULL, "frozenBy" = NULL`
        )
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

  it('running out of memory while decoding is rethrown as it is, on put and on load', async () => {
    const { deps } = await freshDb();
    const payload = await payloadOf(V1.vocabVersion);
    decodeSpy.fail = allocationFailure();
    const onPut = await putSnapshot(deps, payload, meta()).catch((e: unknown) => e);
    expect((onPut as { code?: string }).code).toBe('ERR_MEMORY_ALLOCATION_FAILED');
    expect(onPut).not.toBeInstanceOf(TagIndexSnapshotUnservableError);
    await putSnapshot(deps, payload, meta());
    decodeSpy.fail = allocationFailure();
    const onLoad = await loadLatestSnapshot(deps, SPEC).catch((e: unknown) => e);
    expect((onLoad as { code?: string }).code).toBe('ERR_MEMORY_ALLOCATION_FAILED');
    expect(onLoad).not.toBeInstanceOf(TagIndexSnapshotUnservableError);
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
