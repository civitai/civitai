import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { TagBuildStats } from '~/server/services/resource-intent-tags/build';
import { decodeTagIndex, encodeTagIndex } from '~/server/services/resource-intent-tags/payload';
import {
  latestReadyManifest,
  loadLatestSnapshot,
  putSnapshot,
  TagIndexObjectMissingError,
  TagIndexPayloadCorruptError,
  TagIndexPayloadHashError,
  TagIndexSnapshotUnservableError,
  TagIndexVocabularyNotFrozenError,
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

    it('stored bytes of the right length but another sha256', async () => {
      const { deps, store } = await freshDb();
      const { manifest } = await putSnapshot(deps, await payloadOf(V1.vocabVersion), meta());
      const b = store.get(manifest.objectKey) as Buffer;
      b[b.length >> 1] ^= 0xff;
      await refusedLoad(deps, TagIndexPayloadHashError, /sha256/);
    });
  });
});
