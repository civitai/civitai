// End to end against the REAL document-store migration (PGlite, row-level security on, the
// store as `appdata_rw`): legacy tables and the main-database rows are seeded in the same
// in-process database, and the run reads and writes them exactly as it would in production.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDocStore } from '~/server/services/apps/doc-store';
import {
  createPgliteHarness,
  type Harness,
} from '../../src/server/services/apps/__tests__/doc-store.harness';
import { runCutover, type Sources } from '../oneoffs/strength-finder-cutover/run';
import { appSchemaIdent, sanitizeAppSlug } from '~/server/utils/apps-slug';

const APP = 'apb_test';
// The legacy schema name, derived the way the provisioner derives it (`-` becomes `_`).
const S = appSchemaIdent(sanitizeAppSlug('strength-finder')!);
const MANIFEST = {
  storage: {
    collections: {
      picks: { visibility: 'shared', write: 'own', marks: ['vote'], indexes: { lv: 'number' } },
      sweeps: { visibility: 'private' },
    },
  },
};
const OPTS = { sha: 'test', dirty: false };

let h: Harness;
let sources: Sources;

async function seed(shared: [key: string, author: number, hiddenBy: number | null][]) {
  await h.raw(
    `CREATE TABLE app_blocks (id text, block_id text, status text, manifest jsonb, updated_at timestamptz)`
  );
  await h.raw(
    `CREATE TABLE app_block_publish_requests (id text, app_block_id text, status text, manifest jsonb, reviewed_at timestamptz)`
  );
  await h.raw(`INSERT INTO app_blocks VALUES ($1, 'strength-finder', 'approved', $2, now())`, [
    APP,
    JSON.stringify(MANIFEST),
  ]);
  await h.raw(
    `INSERT INTO app_block_publish_requests VALUES ('pubreq_1', $1, 'approved', $2, now())`,
    [APP, JSON.stringify(MANIFEST)]
  );
  await h.raw(`CREATE SCHEMA ${S}`);
  await h.raw(`CREATE TABLE ${S}.kv (block_instance_id text, user_id int, key text, value jsonb,
    size_bytes int GENERATED ALWAYS AS (octet_length(value::text)) STORED, created_at timestamptz DEFAULT now())`);
  await h.raw(`CREATE TABLE ${S}.shared_kv (key text PRIMARY KEY, author_user_id int, value jsonb,
    size_bytes int GENERATED ALWAYS AS (octet_length(value::text)) STORED,
    hidden_at timestamptz, hidden_by int, created_at timestamptz DEFAULT now())`);
  await h.raw(`CREATE TABLE ${S}.votes (key text, user_id int)`);
  await h.raw(`CREATE TABLE ${S}.counters (key text, count bigint)`);
  await h.raw(`CREATE TABLE ${S}.shared_kv_reports (id text, key text)`);
  await h.raw(`INSERT INTO ${S}.kv (block_instance_id, user_id, key, value) VALUES
    ('bi', 7, 'week/1', '{"reps": 5}'), ('bi', 7, 'best', '42'), ('bi', 8, 'week/1', '{"reps": 9}')`);
  let n = 0;
  for (const [key, author, hiddenBy] of shared) {
    await h.raw(
      `INSERT INTO ${S}.shared_kv (key, author_user_id, value, hidden_at, hidden_by, created_at)
       VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' minutes')::interval)`,
      [
        key,
        author,
        JSON.stringify({ title: key, lv: 2 }),
        hiddenBy ? new Date() : null,
        hiddenBy,
        String(n++),
      ]
    );
  }
  await h.raw(`INSERT INTO ${S}.votes VALUES ('p1', 7), ('p1', 8), ('p2/x', 7)`);
}

const docs = () =>
  h.raw(
    `SELECT coll, scope_uid, key, author_kind, author_uid, data, hidden_by FROM appdata.doc ORDER BY coll, scope_uid, key`
  );

beforeEach(async () => {
  h = await createPgliteHarness({ rls: true });
  const superuser = h.dbAs(null);
  sources = {
    main: { query: async (sql, params) => ({ rows: await h.raw(sql, params) }) },
    apps: superuser,
    appdata: h.db,
  };
});
afterEach(async () => {
  await h.close();
});

describe('strength-finder cutover copy (PGlite, RLS on)', () => {
  it('copies under the original authors, keeps hidden state and votes, leaves other documents alone, and a re-run writes nothing', async () => {
    await seed([
      ['p1', 11, null],
      ['p2/x', 12, 900],
    ]);
    // A document the app wrote after go-live: the untouched control.
    const store = createDocStore({ db: h.db });
    const picks = {
      name: 'picks',
      config: {
        visibility: 'shared',
        write: 'own',
        marks: ['vote'],
        counters: [],
        indexes: new Map(),
        showAuthor: false,
        kind: 'document',
      },
    } as never;
    await store.put({ appId: APP, ns: 'prod', viewerUid: 55 }, picks, 'live-1', { title: 'new' });

    const dry = await runCutover(sources, { execute: false, ...OPTS });
    expect(dry.report.aborts).toEqual([]);
    expect(dry.report.pendingWrites).toBe(5);
    expect(dry.report.positiveControl).toEqual({
      authorNotKeptAdded: 1,
      onRealRow: true,
      executeRefused: true,
    });
    expect(dry.mapping).toEqual([
      { store: 'kv', legacyKey: 'week/1', key: 'week:1' },
      { store: 'shared_kv', legacyKey: 'p2/x', key: 'p2:x' },
    ]);
    expect(await docs()).toHaveLength(1); // a dry run writes nothing

    const run = await runCutover(sources, { execute: true, ...OPTS });
    expect(run.report.executed).toEqual({ privatePuts: 3, sharedPuts: 2, marks: 3, hides: 1 });
    expect(run.report.readback).toMatchObject({
      pendingWrites: 0,
      preExistingSharedDocsChanged: 0,
      preExistingSharedDocsControls: 1,
    });

    expect(
      (await docs()).map((d) => [
        d.coll,
        d.scope_uid,
        d.key,
        d.author_kind,
        d.author_uid,
        d.hidden_by,
      ])
    ).toEqual([
      ['picks', 0, 'live-1', 'user', 55, null],
      ['picks', 0, 'p1', 'user', 11, null],
      ['picks', 0, 'p2:x', 'user', 12, 900],
      ['sweeps', 7, 'best', 'user', 7, null],
      ['sweeps', 7, 'week:1', 'user', 7, null],
      ['sweeps', 8, 'week:1', 'user', 8, null],
    ]);
    expect((await docs()).find((d) => d.key === 'best')?.data).toEqual({ value: 42 });
    expect(
      await h.raw(`SELECT key, count FROM appdata.doc_tally WHERE name = 'vote' ORDER BY key`)
    ).toEqual([
      { key: 'p1', count: 2 },
      { key: 'p2:x', count: 1 },
    ]);
    // The store's own bookkeeping, not a copy of it: one seq per write, usage charged to authors.
    const [usage] = await h.raw(`SELECT docs FROM appdata.usage_app WHERE app_id = $1`, [APP]);
    expect(Number(usage.docs)).toBe(3);
    expect(
      await h.raw(
        `SELECT user_id, docs FROM appdata.usage_user WHERE app_id = $1 ORDER BY user_id`,
        [APP]
      )
    ).toEqual([
      { user_id: 7, docs: 2 },
      { user_id: 8, docs: 1 },
      { user_id: 11, docs: 1 },
      { user_id: 12, docs: 1 },
      { user_id: 55, docs: 1 },
    ]);

    const before = await h.raw(`SELECT key, seq, version FROM appdata.doc ORDER BY key, scope_uid`);
    const again = await runCutover(sources, { execute: true, ...OPTS });
    expect(again.report.executed).toEqual({ privatePuts: 0, sharedPuts: 0, marks: 0, hides: 0 });
    expect(
      await h.raw(`SELECT key, seq, version FROM appdata.doc ORDER BY key, scope_uid`)
    ).toEqual(before);
  });

  it('writes nothing at all when one shared row cannot keep its author', async () => {
    await seed([
      ['p1', 11, null],
      ['p2/x', 12, null],
    ]);
    await h.raw(`UPDATE ${S}.shared_kv SET author_user_id = NULL WHERE key = 'p2/x'`);
    const dry = await runCutover(sources, { execute: false, ...OPTS });
    expect(dry.report.aborts).toMatchObject([{ reason: 'author_not_kept', count: 1 }]);
    await expect(runCutover(sources, { execute: true, ...OPTS })).rejects.toThrow(
      /author_not_kept=1/
    );
    expect(await docs()).toEqual([]);
  });
});
