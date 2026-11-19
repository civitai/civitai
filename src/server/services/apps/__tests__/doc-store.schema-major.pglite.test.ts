import { readFileSync } from 'fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createDocStore,
  createDocStoreMaintenance,
  type DocStore,
} from '~/server/services/apps/doc-store';
import type { DocCollection } from '~/server/services/apps/doc-store.types';
import {
  createPgliteHarness,
  MIGRATION_SCHEMA_MAJOR_DOWN,
  MIGRATION_SCHEMA_MAJOR_UP,
  type Harness,
} from './doc-store.harness';
import { BOARD, ctx, freshApp, NS_PROD, PREFS, TALLIES } from './doc-store.functional';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * `appdata.doc.schema_major`: every write of a document body stamps the major its caller passes
 * (`DocCollection.schemaMajor`), once the manual migration added the column; until then every
 * write still succeeds, unstamped. Real migrations on PGlite, row-level security ON, as
 * `appdata_rw`; the harness's runtime isolation recorder checks every statement, the probe
 * included. Expected majors are literals, pairwise distinct and distinct from any version number
 * a fixture produces.
 */

const ALICE = 4101;
const BOB = 4202;

const at = (coll: DocCollection, schemaMajor: number | null | undefined): DocCollection =>
  schemaMajor === undefined ? coll : { ...coll, schemaMajor };

/** `key → schema_major` of an app's documents, read as the superuser. */
async function stamps(h: Harness, app: string, ns = NS_PROD): Promise<Record<string, unknown>> {
  const rows = await h.raw(
    `SELECT d.key, d.schema_major FROM appdata.doc d WHERE d.app_id = $1 AND d.ns = $2 ORDER BY d.key`,
    [app, ns]
  );
  return Object.fromEntries(rows.map((r) => [r.key as string, r.schema_major]));
}

/**
 * Which of `schema_major` and `seq` the doc table has, from the catalog. `seq` always exists, so it
 * is the positive control that the query can find a column at all.
 */
async function docColumns(h: Harness): Promise<string[]> {
  const rows = await h.raw(
    `SELECT a.attname FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'appdata' AND c.relname = 'doc' AND a.attname IN ('schema_major', 'seq')
       AND NOT a.attisdropped ORDER BY a.attname`
  );
  return rows.map((r) => r.attname as string);
}

const PROBE = /SELECT d\.schema_major FROM appdata\.doc d/;

describe('with the schema_major column applied', () => {
  let h: Harness;
  let store: DocStore;

  beforeAll(async () => {
    h = await createPgliteHarness({ rls: true, schemaMajor: true });
    store = createDocStore({ db: h.db });
  });
  afterAll(async () => {
    expect(h.violations).toEqual([]);
    await h?.close();
  });

  it('🔴 put stamps the major on insert and on every update; null clears it; an absent major leaves it', async () => {
    const app = freshApp('MAJORPUT');
    const c = ctx(app, NS_PROD, ALICE);
    await store.put(c, at(PREFS, 3), 'k1', { theme: 'moss' });
    expect(await stamps(h, app)).toEqual({ k1: 3 });

    await store.put(c, at(PREFS, 7), 'k1', { theme: 'fern' });
    expect(await stamps(h, app)).toEqual({ k1: 7 });

    await store.put(c, at(PREFS, null), 'k1', { theme: 'ivy' });
    expect(await stamps(h, app)).toEqual({ k1: null });

    await store.put(c, at(PREFS, 11), 'k1', { theme: 'oak' });
    await store.put(c, at(PREFS, undefined), 'k1', { theme: 'elm' });
    expect(await stamps(h, app)).toEqual({ k1: 11 });
  });

  it('🔴 create stamps the major', async () => {
    const app = freshApp('MAJORCREATE');
    const doc = await store.create(ctx(app, NS_PROD, BOB), at(BOARD, 13), { title: 'first' });
    expect(await stamps(h, app)).toEqual({ [doc.key]: 13 });
  });

  it('🔴 the counter document a first increment creates is stamped; a later increment does not restamp it', async () => {
    const app = freshApp('MAJORTALLY');
    const c = ctx(app, NS_PROD, ALICE);
    await store.increment(c, at(TALLIES, 17), 'song-1', 'plays');
    expect(await stamps(h, app)).toEqual({ 'song-1': 17 });
    // The body was not written again, so the major it was written under stands.
    expect(await store.increment(c, at(TALLIES, 19), 'song-1', 'plays')).toEqual({ value: 2 });
    expect(await stamps(h, app)).toEqual({ 'song-1': 17 });
  });

  it('🔴 a schema migration stamps the documents it rewrites, and only those', async () => {
    const app = freshApp('MAJORMIGRATE');
    const c = ctx(app, NS_PROD, ALICE);
    await store.put(c, at(PREFS, 23), 'old', { theme: 'moss', legacy: 1 });
    await store.put(c, at(PREFS, 29), 'new', { theme: 'fern' });
    const maint = createDocStoreMaintenance({ db: h.db });
    const result = await maint.migrateDocuments(
      app,
      at(PREFS, 31),
      (data) => {
        if (!('legacy' in data)) return null;
        const { legacy: _legacy, ...rest } = data;
        return rest;
      },
      { limit: 10 }
    );
    expect(result).toMatchObject({ scanned: 2, migrated: 1, unchanged: 1, failed: 0 });
    expect(await stamps(h, app)).toEqual({ new: 29, old: 31 });
  });

  it('a development namespace is not stamped (no major passed)', async () => {
    const app = freshApp('MAJORDEV');
    const devNs = `dev:${ALICE}`;
    await store.put(ctx(app, devNs, ALICE), PREFS, 'k1', { theme: 'moss' });
    expect(await stamps(h, app, devNs)).toEqual({ k1: null });
  });

  it('invariant guard: reads are unchanged — the stored body and the record shape, no major in either', async () => {
    const app = freshApp('MAJORREAD');
    const c = ctx(app, NS_PROD, ALICE);
    const written = await store.put(c, at(PREFS, 37), 'k1', { theme: 'moss', n: 5 });
    const read = await store.get(c, PREFS, 'k1');
    expect(read).toEqual(written);
    expect(read?.data).toEqual({ theme: 'moss', n: 5 });
    expect(Object.keys(read ?? {}).sort()).toEqual([
      'author',
      'counters',
      'createdAt',
      'data',
      'key',
      'marks',
      'updatedAt',
      'version',
      'viewer',
    ]);
    const [many] = await store.getMany(c, PREFS, ['k1']);
    expect(many).toEqual(written);
    const listed = await store.list(c, PREFS, {});
    expect(listed.items).toEqual([written]);
  });

  // Last in this block: it drops the column.
  it('the up migration is idempotent; the rollback drops the column, and a store that had found it fails one write, then writes unstamped', async () => {
    const app = freshApp('MAJORDOWN');
    const c = ctx(app, NS_PROD, ALICE);
    const own = createDocStore({ db: h.db });
    await own.put(c, at(PREFS, 73), 'k1', { theme: 'moss' });
    await h.raw(readFileSync(MIGRATION_SCHEMA_MAJOR_UP, 'utf8'));
    expect(await stamps(h, app)).toEqual({ k1: 73 });

    await h.raw(readFileSync(MIGRATION_SCHEMA_MAJOR_DOWN, 'utf8'));
    expect(await docColumns(h)).toEqual(['seq']);

    await expect(own.put(c, at(PREFS, 79), 'k2', { theme: 'fern' })).rejects.toMatchObject({
      code: '42703',
    });
    const after = await own.put(c, at(PREFS, 83), 'k3', { theme: 'ivy' });
    expect(after.data).toEqual({ theme: 'ivy' });
    expect(await own.get(c, PREFS, 'k2')).toBeNull();
  });
});

describe('without the schema_major column', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createPgliteHarness({ rls: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  afterAll(async () => {
    expect(h.violations).toEqual([]);
    await h?.close();
  });

  it('control: the column really is absent here', async () => {
    expect(await docColumns(h)).toEqual(['seq']);
  });

  it('🔴 every kind of body write still succeeds with a major passed, and the column is probed once', async () => {
    const store = createDocStore({ db: h.db });
    const app = freshApp('NOMAJOR');
    const c = ctx(app, NS_PROD, ALICE);
    const before = h.statements.length;

    const put = await store.put(c, at(PREFS, 41), 'k1', { theme: 'moss' });
    expect(put.data).toEqual({ theme: 'moss' });
    const updated = await store.put(c, at(PREFS, 43), 'k1', { theme: 'fern' }, { ifVersion: 1 });
    expect(updated.version).toBe(2);
    const created = await store.create(ctx(app, NS_PROD, BOB), at(BOARD, 47), { title: 'hi' });
    expect(created.data).toEqual({ title: 'hi' });
    expect(await store.increment(c, at(TALLIES, 53), 'song-1', 'plays')).toEqual({ value: 1 });
    const migrated = await createDocStoreMaintenance({ db: h.db }).migrateDocuments(
      app,
      at(PREFS, 59),
      (data) => ({ ...data, migrated: true }),
      { limit: 10 }
    );
    expect(migrated).toMatchObject({ scanned: 1, migrated: 1, failed: 0 });
    expect((await store.get(c, PREFS, 'k1'))?.data).toEqual({ theme: 'fern', migrated: true });

    // The viewer store probed once and kept the answer; the maintenance store is its own instance
    // and probed once too.
    const probes = h.statements.slice(before).filter((s) => PROBE.test(s.sql));
    expect(probes.map((s) => s.params)).toEqual([
      [app, NS_PROD],
      [app, NS_PROD],
    ]);
  });

  it('a write with no major passed never probes', async () => {
    const store = createDocStore({ db: h.db });
    const app = freshApp('NOPROBE');
    const before = h.statements.length;
    await store.put(ctx(app, NS_PROD, ALICE), PREFS, 'k1', { theme: 'moss' });
    expect(h.statements.slice(before).filter((s) => PROBE.test(s.sql))).toEqual([]);
  });

  it('🔴 applying the migration later starts the stamping within the recheck interval, without a restart', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-06T12:00:00Z'));
    const store = createDocStore({ db: h.db });
    const app = freshApp('LATEMAJOR');
    const c = ctx(app, NS_PROD, ALICE);
    await store.put(c, at(PREFS, 61), 'k1', { theme: 'moss' });

    await h.raw(readFileSync(MIGRATION_SCHEMA_MAJOR_UP, 'utf8'));
    // Inside the interval the store still trusts its "absent".
    vi.setSystemTime(new Date('2026-11-06T12:00:30Z'));
    await store.put(c, at(PREFS, 67), 'k2', { theme: 'fern' });
    expect(await stamps(h, app)).toEqual({ k1: null, k2: null });

    vi.setSystemTime(new Date('2026-11-06T12:01:01Z'));
    await store.put(c, at(PREFS, 71), 'k3', { theme: 'ivy' });
    expect(await stamps(h, app)).toEqual({ k1: null, k2: null, k3: 71 });
  });
});
