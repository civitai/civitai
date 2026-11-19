import { readFileSync } from 'fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDocStore, type DocStore } from '~/server/services/apps/doc-store';
import {
  createPgliteHarness,
  MIGRATION_RECORD_ID_BACKFILL,
  type Harness,
  type Row,
} from './doc-store.harness';
import { BOARD, ctx, freshApp, NS_PROD, PREFS } from './doc-store.functional';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * `appdata.doc.record_id`: the shipped migrations (the column with its `gen_random_uuid()`
 * default, and its CONCURRENTLY-built unique index) applied on PGlite by the harness, row-level
 * security ON, the store writing as `appdata_rw` with no code change. And the shipped batched
 * backfill, run on rows written before the column had a default.
 */

const ALICE = 4301;
const BOB = 4402;
// How Postgres prints a uuid.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The one row a query returns; throws when it returns none. */
async function oneRow(h: Harness, sql: string, params: unknown[]): Promise<Row> {
  const rows = await h.raw(sql, params);
  const row = rows.at(0);
  if (row === undefined) throw new Error(`no row from: ${sql}`);
  return row;
}

describe('the record_id column and its default', () => {
  let h: Harness;
  let store: DocStore;

  beforeAll(async () => {
    h = await createPgliteHarness({ rls: true });
    store = createDocStore({ db: h.db });
  });
  afterAll(async () => {
    expect(h.violations).toEqual([]);
    await h?.close();
  });

  it('gives two users’ private docs with one key, and a shared doc, distinct uuids from the default', async () => {
    const app = freshApp('RECORDID');
    await store.put(ctx(app, NS_PROD, ALICE), PREFS, 'k1', { theme: 'moss' });
    await store.put(ctx(app, NS_PROD, BOB), PREFS, 'k1', { theme: 'fern' });
    await store.put(ctx(app, NS_PROD, ALICE), BOARD, 'b1', { title: 'lantern' });

    const rows = await h.raw(
      `SELECT d.coll, d.scope_uid, d.key, d.record_id::text AS record_id FROM appdata.doc d
        WHERE d.app_id = $1 AND d.ns = $2 ORDER BY d.coll, d.scope_uid`,
      [app, NS_PROD]
    );
    expect(rows.map((r) => [r.coll, r.scope_uid, r.key])).toEqual([
      ['board', 0, 'b1'],
      ['prefs', ALICE, 'k1'],
      ['prefs', BOB, 'k1'],
    ]);
    const ids = rows.map((r) => r.record_id as string);
    for (const id of ids) expect(id).toMatch(UUID_RE);
    expect(new Set(ids).size).toBe(3);
  });

  it('keeps a document’s record_id across an update', async () => {
    const app = freshApp('RECORDIDKEEP');
    const c = ctx(app, NS_PROD, ALICE);
    const read = () =>
      oneRow(
        h,
        `SELECT d.record_id::text AS record_id, d.version FROM appdata.doc d
          WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = 'prefs' AND d.key = 'k1'`,
        [app, NS_PROD]
      );
    await store.put(c, PREFS, 'k1', { theme: 'moss' });
    const first = await read();
    await store.put(c, PREFS, 'k1', { theme: 'oak' });
    const second = await read();
    expect(second.version).toBe(2);
    expect(second.record_id).toBe(first.record_id);
  });

  it('has the unique index the shipped file builds', async () => {
    const rows = await h.raw(
      `SELECT indexdef FROM pg_catalog.pg_indexes
        WHERE schemaname = 'appdata' AND indexname = 'doc_record_id_key'`
    );
    expect(rows.map((r) => r.indexdef)).toEqual([
      'CREATE UNIQUE INDEX doc_record_id_key ON appdata.doc USING btree (record_id)',
    ]);
  });
});

describe('the record_id backfill', () => {
  const file = readFileSync(MIGRATION_RECORD_ID_BACKFILL, 'utf8');
  const blocks: string[] = Array.from(
    file.matchAll(/DO \$backfill\$[\s\S]*?\$backfill\$;/g),
    (m) => m[0]
  );
  // The block the tests run; empty (and the shape test red) unless the file holds exactly one.
  const doBlock: string = blocks.length === 1 ? blocks.join('') : '';
  let h: Harness;

  beforeAll(async () => {
    h = await createPgliteHarness({ rls: true });
  });
  afterAll(async () => {
    expect(h.violations).toEqual([]);
    await h?.close();
  });

  // The file is the DO block plus a session lock_timeout around it. PGlite runs a multi-statement
  // string as one implicit transaction, in which the block's COMMIT is refused, so the test runs
  // the block alone (as psql -f sends it); this pins that nothing else in the file is skipped.
  it('is one DO block between SET and RESET of lock_timeout, and nothing else', () => {
    expect(blocks).toHaveLength(1);
    const rest = file
      .replace(doBlock, '')
      .split('\n')
      .filter((l) => !l.startsWith('--') && l.trim() !== '')
      .join(' ');
    expect(rest).toBe("SET lock_timeout = '1s'; RESET lock_timeout;");
  });

  it('fills every NULL record_id across several batches, keeps existing ids, and a second run changes nothing', async () => {
    const apps = [freshApp('BACKFILLA'), freshApp('BACKFILLB'), freshApp('BACKFILLC')];
    // 2500 rows written as before the default: record_id NULL. More than two batches of 1000,
    // spread over three apps and both scopes.
    await h.raw(
      `INSERT INTO appdata.doc
         (app_id, ns, coll, scope_uid, key, data, version, seq, author_uid, author_kind, last_writer_uid, record_id)
       SELECT (ARRAY[$1, $2, $3]::text[])[1 + i % 3], 'prod', 'prefs', CASE WHEN i % 2 = 0 THEN 0 ELSE i END,
              'k' || i, '{}'::jsonb, 1, i, i, 'user', i, NULL
         FROM generate_series(1, 2500) AS i`,
      apps
    );
    // One row that already has an id (written after the default): the backfill must not touch it.
    const kept = '0d5f7a3c-2b91-4e6d-8c04-b7a1e9f3d265';
    await h.raw(
      `INSERT INTO appdata.doc
         (app_id, ns, coll, scope_uid, key, data, version, seq, author_uid, author_kind, last_writer_uid, record_id)
       VALUES ($1, 'prod', 'prefs', 0, 'kept', '{}'::jsonb, 1, 9999, 77, 'user', 77, $2::uuid)`,
      [apps[0], kept]
    );
    const count = async (where: string) =>
      Number(
        (
          await oneRow(
            h,
            `SELECT count(*)::int AS n FROM appdata.doc WHERE app_id IN ($1, $2, $3) AND ${where}`,
            apps
          )
        ).n
      );
    expect(await count('record_id IS NULL')).toBe(2500);

    await h.raw(doBlock);
    expect(await count('record_id IS NULL')).toBe(0);
    const ids = await h.raw(
      `SELECT key, record_id::text AS record_id FROM appdata.doc
        WHERE app_id IN ($1, $2, $3) ORDER BY app_id, scope_uid, key`,
      apps
    );
    expect(ids).toHaveLength(2501);
    expect(new Set(ids.map((r) => r.record_id)).size).toBe(2501);
    for (const r of ids) expect(r.record_id).toMatch(UUID_RE);
    expect(ids.find((r) => r.key === 'kept')?.record_id).toBe(kept);

    await h.raw(doBlock);
    const again = await h.raw(
      `SELECT key, record_id::text AS record_id FROM appdata.doc
        WHERE app_id IN ($1, $2, $3) ORDER BY app_id, scope_uid, key`,
      apps
    );
    expect(again).toEqual(ids);
  });
});
