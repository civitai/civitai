import { readFileSync } from 'fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createDocStore,
  createDocStoreMaintenance,
  createDocStoreModeration,
  type DocStore,
  type DocStoreMaintenance,
  type DocStoreModeration,
} from '~/server/services/apps/doc-store';
import { deriveViewerKey } from '~/server/services/apps/doc-store-viewer-keyed';
import type { DocCollection } from '~/server/services/apps/doc-store.types';
import { createPgliteHarness, MIGRATION_MAINT_RUN_UP, type Harness } from './doc-store.harness';
import {
  assertUsageConsistent,
  ctx,
  decl,
  expectCode,
  freshApp,
  NS_PROD,
} from './doc-store.functional';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * THE MARK MIGRATION and THE PER-COLLECTION PURGE (`docs/app-storage-generic-core.md`, "Data
 * migration", "Counter documents"), against the real migrations on PGlite with RLS on: the key
 * check, the freeze, the copy, the verify, the rollback and the purge's gates, refunds and dump.
 * Expected values are literals or come from the rows the test itself seeded; a derived key is
 * computed by `deriveViewerKey`, whose own golden vectors pin it independently.
 */

// Pairwise distinct, and distinct from every id the other suites use.
const V1 = 4_101;
const V2 = 4_202;
const V3 = 4_303;
/** Only ever reports: no document, no usage row, no other mark. */
const V4 = 4_404;
const MOD = 9_017;
const SECRET = 'mark-migration-test-secret-0123456789';

const RECORDS: DocCollection = {
  name: 'records',
  config: decl({ visibility: 'shared', write: 'own', marks: ['vote', 'star'] }),
};
const OTHER_RECORDS: DocCollection = {
  name: 'drafts',
  config: decl({ visibility: 'shared', write: 'own', marks: ['vote'] }),
};
const VOTES: DocCollection = {
  name: 'votes',
  config: decl({
    visibility: 'shared',
    write: 'own',
    keyedBy: 'parent+viewer',
    indexes: { value: 'number' },
  }),
};
/** The counter collection of rollout step 4, as the old version declares it. */
const POPULAR: DocCollection = {
  name: 'popular_plays',
  config: decl({ visibility: 'shared', write: 'none', counters: ['plays'], marks: ['played'] }),
};
/** The same collection once a new approved version dropped its counters. */
const POPULAR_NO_COUNTERS: DocCollection = {
  name: 'popular_plays',
  config: decl({ visibility: 'shared', write: 'none', marks: ['played'] }),
};
const PLAYS: DocCollection = {
  name: 'plays',
  config: decl({ visibility: 'shared', write: 'own', keyedBy: 'parent+viewer' }),
};

const BODY = { value: 1 };

let h: Harness;
let store: DocStore;
let maint: DocStoreMaintenance;
let mod: DocStoreModeration;

beforeAll(async () => {
  h = await createPgliteHarness({ rls: true });
  store = createDocStore({ db: h.db });
  maint = createDocStoreMaintenance({ db: h.db });
  mod = createDocStoreModeration({ db: h.db });
});
afterAll(async () => {
  // Every statement the maintenance ops sent carried its bound app and namespace as $1/$2.
  if (h) expect(h.violations).toEqual([]);
  await h?.close();
});

const deriver = (app: string, collection: string) => (parent: string, viewerUid: number) =>
  deriveViewerKey(SECRET, {
    appId: app,
    ns: NS_PROD,
    collection,
    mode: 'parent+viewer',
    parent,
    viewerUid,
  });

/** Docs of one collection as stored (superuser read), in key order. */
async function docsOf(app: string, coll: string) {
  return h.raw(
    `SELECT key, data, version, seq, author_uid, author_kind, created_at, updated_at
       FROM appdata.doc WHERE app_id = $1 AND ns = 'prod' AND coll = $2 ORDER BY key`,
    [app, coll]
  );
}
async function usageOf(app: string) {
  return {
    app: await h.raw(
      `SELECT bytes, docs FROM appdata.usage_app WHERE app_id = $1 AND ns = 'prod'`,
      [app]
    ),
    users: await h.raw(
      `SELECT user_id, bytes, docs FROM appdata.usage_user WHERE app_id = $1 AND ns = 'prod' ORDER BY user_id`,
      [app]
    ),
  };
}
async function runOf(app: string, coll: string, kind: string, name: string) {
  const rows = await h.raw(
    `SELECT status, params FROM appdata.maint_run
      WHERE app_id = $1 AND ns = 'prod' AND coll = $2 AND kind = $3 AND name = $4`,
    [app, coll, kind, name]
  );
  return rows[0] ?? null;
}

/**
 * `records` with three documents and five `vote` marks from three voters, each mark created at its
 * own literal time, plus one `star` mark (another mark name on the same collection).
 */
const MARK_TIMES: Record<string, string> = {
  [`rec_a|${V1}`]: '2026-10-01T01:00:00.000Z',
  [`rec_a|${V2}`]: '2026-10-02T02:00:00.000Z',
  [`rec_b|${V1}`]: '2026-10-03T03:00:00.000Z',
  [`rec_b|${V3}`]: '2026-10-04T04:00:00.000Z',
  [`rec_c|${V2}`]: '2026-10-05T05:00:00.000Z',
};
async function seedVotes(app: string) {
  await store.put(ctx(app, NS_PROD, V1), RECORDS, 'rec_a', { title: 'a' });
  await store.put(ctx(app, NS_PROD, V2), RECORDS, 'rec_b', { title: 'b' });
  await store.put(ctx(app, NS_PROD, V3), RECORDS, 'rec_c', { title: 'c' });
  for (const pair of Object.keys(MARK_TIMES)) {
    const [key, uid] = pair.split('|');
    await store.mark(ctx(app, NS_PROD, Number(uid)), RECORDS, key, 'vote');
    await h.raw(
      `UPDATE appdata.doc_mark SET created_at = $1
        WHERE app_id = $2 AND coll = 'records' AND key = $3 AND name = 'vote' AND user_id = $4`,
      [MARK_TIMES[pair], app, key, Number(uid)]
    );
  }
  await store.mark(ctx(app, NS_PROD, V3), RECORDS, 'rec_a', 'star');
}

async function migrate(app: string, keyMap?: Record<string, string>) {
  const frozen = await maint.freezeMarks(app, {
    from: 'records',
    mark: 'vote',
    target: VOTES,
    data: BODY,
    keyMap,
    actorUid: MOD,
  });
  const copy = await maint.copyMarksToDocs(app, {
    from: 'records',
    mark: 'vote',
    target: VOTES,
    deriveKey: deriver(app, 'votes'),
    actorUid: MOD,
  });
  const verify = await maint.verifyMarkMigration(app, {
    from: 'records',
    mark: 'vote',
    deriveKey: deriver(app, 'votes'),
    actorUid: MOD,
  });
  return { frozen, copy, verify };
}

describe('migrateMarksToDocs: copy', () => {
  it('copies each vote to its derived key with the constant body, its author and its created_at; a re-run is a no-op', async () => {
    const app = freshApp('MMCOPY');
    await seedVotes(app);
    const usageBefore = await usageOf(app);
    const first = await migrate(app);
    expect(first.copy).toEqual({ rows: 5, inserted: 5, existing: 0, overCeiling: [] });
    expect(first.verify.ok).toBe(true);

    const key = deriver(app, 'votes');
    const docs = await docsOf(app, 'votes');
    expect(
      docs.map((d) => ({
        key: d.key,
        data: d.data,
        version: d.version,
        author: d.author_uid,
        kind: d.author_kind,
        created: new Date(d.created_at as string).toISOString(),
        updated: new Date(d.updated_at as string).toISOString(),
      }))
    ).toEqual(
      [
        ['rec_a', V1],
        ['rec_a', V2],
        ['rec_b', V1],
        ['rec_b', V3],
        ['rec_c', V2],
      ]
        .map(([parent, uid]) => ({
          key: key(parent as string, uid as number),
          data: { value: 1 },
          version: 1,
          author: uid,
          kind: 'user',
          created: MARK_TIMES[`${parent}|${uid}`],
          updated: MARK_TIMES[`${parent}|${uid}`],
        }))
        .sort((a, b) => (a.key < b.key ? -1 : 1))
    );
    // Each document took its own seq, and its declared index row.
    expect(new Set(docs.map((d) => Number(d.seq))).size).toBe(5);
    const index = await h.raw(
      `SELECT count(*)::int AS n FROM appdata.doc_index
        WHERE app_id = $1 AND coll = 'votes' AND name = 'value' AND v_num = 1`,
      [app]
    );
    expect(index[0].n).toBe(5);
    // Charged to the app and to each voter: V1 two votes, V2 two, V3 one.
    const usage = await usageOf(app);
    const docsBy = (u: typeof usage, uid: number) =>
      Number(u.users.find((r) => Number(r.user_id) === uid)?.docs ?? 0);
    expect([V1, V2, V3].map((uid) => docsBy(usage, uid) - docsBy(usageBefore, uid))).toEqual([
      2, 2, 1,
    ]);
    await assertUsageConsistent(h, app, NS_PROD);

    // Run again: the same documents, nothing charged, still verified.
    const again = await migrate(app);
    expect(again.frozen.created).toBe(false);
    expect(again.copy).toEqual({ rows: 5, inserted: 0, existing: 5, overCeiling: [] });
    expect(again.verify.ok).toBe(true);
    expect(await docsOf(app, 'votes')).toEqual(docs);
    expect(await usageOf(app)).toEqual(usage);
    expect((await runOf(app, 'records', 'mark_migration', 'vote'))?.status).toBe('verified');
  });

  it('copies a vote on a hidden document too, and never writes the source rows', async () => {
    const app = freshApp('MMHIDDEN');
    await seedVotes(app);
    await mod.setHidden(app, NS_PROD, 'records', 'rec_c', true, MOD);
    const marksBefore = await h.raw(
      `SELECT coll, key, name, user_id, created_at FROM appdata.doc_mark WHERE app_id = $1 ORDER BY 1, 2, 3, 4`,
      [app]
    );
    const { copy } = await migrate(app);
    expect(copy.inserted).toBe(5);
    expect(
      await h.raw(
        `SELECT coll, key, name, user_id, created_at FROM appdata.doc_mark WHERE app_id = $1 ORDER BY 1, 2, 3, 4`,
        [app]
      )
    ).toEqual(marksBefore);
  });

  it('a run with other parameters is refused while one is active', async () => {
    const app = freshApp('MMPARAMS');
    await seedVotes(app);
    await migrate(app);
    const err = await expectCode(
      maint.freezeMarks(app, {
        from: 'records',
        mark: 'vote',
        target: VOTES,
        data: { value: -1 },
        actorUid: MOD,
      }),
      'invalid_request'
    );
    expect(err.details).toMatchObject({ reason: 'run_params_differ' });
  });
});

describe('migrateMarksToDocs: verify counts the store rows directly', () => {
  it('a missing document is a mismatch, per parent, per user and by key', async () => {
    const app = freshApp('MMMISSING');
    await seedVotes(app);
    await migrate(app);
    const gone = deriver(app, 'votes')('rec_b', V3);
    await h.raw(`DELETE FROM appdata.doc WHERE app_id = $1 AND coll = 'votes' AND key = $2`, [
      app,
      gone,
    ]);
    const verify = await maint.verifyMarkMigration(app, {
      from: 'records',
      mark: 'vote',
      deriveKey: deriver(app, 'votes'),
      actorUid: MOD,
    });
    expect(verify).toMatchObject({
      ok: false,
      sourceRows: 5,
      targetDocs: 4,
      parentSample: [{ id: 'rec_b', expected: 2, actual: 1 }],
      userSample: [{ id: String(V3), expected: 1, actual: 0 }],
      missing: 1,
      missingSample: [gone],
      extra: 0,
    });
    expect((await runOf(app, 'records', 'mark_migration', 'vote'))?.status).toBe('mismatch');
    // A re-run of the copy puts it back, and the verify passes again.
    expect((await migrate(app)).verify.ok).toBe(true);
  });

  it('an extra document is a mismatch', async () => {
    const app = freshApp('MMEXTRA');
    await seedVotes(app);
    await migrate(app);
    // A document at a key no mark derives (another voter on rec_a).
    const stray = deriver(app, 'votes')('rec_a', V3);
    await h.raw(
      `INSERT INTO appdata.doc (app_id, ns, coll, scope_uid, key, data, version, seq, author_uid, author_kind)
       VALUES ($1, 'prod', 'votes', 0, $2, '{"value":1}', 1, 999, $3, 'user')`,
      [app, stray, V3]
    );
    const verify = await maint.verifyMarkMigration(app, {
      from: 'records',
      mark: 'vote',
      deriveKey: deriver(app, 'votes'),
      actorUid: MOD,
    });
    expect(verify).toMatchObject({
      ok: false,
      targetDocs: 6,
      parentSample: [{ id: 'rec_a', expected: 2, actual: 3 }],
      userSample: [{ id: String(V3), expected: 1, actual: 2 }],
      missing: 0,
      extra: 1,
      extraSample: [stray],
    });
  });
});

describe('migrateMarksToDocs: the freeze', () => {
  it('refuses $mark and $unmark of the frozen mark on that collection only (410 removed)', async () => {
    const app = freshApp('MMFREEZE');
    await seedVotes(app);
    await store.put(ctx(app, NS_PROD, V1), OTHER_RECORDS, 'rec_a', { title: 'other' });
    // Positive control: before the freeze both answer.
    await store.unmark(ctx(app, NS_PROD, V2), RECORDS, 'rec_c', 'vote');
    await store.mark(ctx(app, NS_PROD, V2), RECORDS, 'rec_c', 'vote');

    await maint.freezeMarks(app, {
      from: 'records',
      mark: 'vote',
      target: VOTES,
      data: BODY,
      actorUid: MOD,
    });
    for (const call of [
      () => store.mark(ctx(app, NS_PROD, V3), RECORDS, 'rec_c', 'vote'),
      () => store.unmark(ctx(app, NS_PROD, V1), RECORDS, 'rec_a', 'vote'),
    ]) {
      const err = await expectCode(call(), 'removed');
      expect(err.details).toEqual({
        reason: 'mark_migrated',
        collection: 'records',
        mark: 'vote',
        to: 'votes',
      });
    }
    // Nothing moved: the voter's mark is still there, and the new one was not written.
    const rows = await h.raw(
      `SELECT key, user_id FROM appdata.doc_mark WHERE app_id = $1 AND name = 'vote' ORDER BY 1, 2`,
      [app]
    );
    expect(rows.map((r) => `${r.key}|${r.user_id}`)).toEqual(Object.keys(MARK_TIMES).sort());
    // Another mark on the collection, the same mark on another collection, and a report all
    // still answer.
    expect(await store.mark(ctx(app, NS_PROD, V1), RECORDS, 'rec_b', 'star')).toMatchObject({
      marked: true,
    });
    expect(await store.mark(ctx(app, NS_PROD, V2), OTHER_RECORDS, 'rec_a', 'vote')).toMatchObject({
      marked: true,
    });
    expect(await store.report(ctx(app, NS_PROD, V3), RECORDS, 'rec_a')).toEqual({ added: true });
  });
});

describe('migrateMarksToDocs: the key check', () => {
  const LONG = `k${'x'.repeat(96)}`; // 97 characters: over the parent bound
  async function seedUnfit(app: string) {
    await store.put(ctx(app, NS_PROD, V1), RECORDS, 'grp:one', { title: 'colon' });
    await store.put(ctx(app, NS_PROD, V1), RECORDS, LONG, { title: 'long' });
    await store.put(ctx(app, NS_PROD, V1), RECORDS, 'plain', { title: 'fits' });
    for (const k of ['grp:one', LONG, 'plain']) {
      await store.mark(ctx(app, NS_PROD, V2), RECORDS, k, 'vote');
    }
  }

  it('without a keyMap a key that does not fit refuses the whole target, writing nothing', async () => {
    const app = freshApp('MMUNFIT');
    await seedUnfit(app);
    const dry = await maint.checkMarkMigration(app, { from: 'records', mark: 'vote' });
    expect(dry.check).toMatchObject({ ok: false, rows: 3, keys: 3, users: 1, unfit: 2 });
    expect([...dry.check.unfitSample].sort()).toEqual(['grp:one', LONG].sort());
    expect(dry.run).toBeNull();

    const err = await expectCode(
      maint.freezeMarks(app, {
        from: 'records',
        mark: 'vote',
        target: VOTES,
        data: BODY,
        actorUid: MOD,
      }),
      'invalid_request'
    );
    expect(err.details).toMatchObject({ reason: 'keys_do_not_fit' });
    expect(await runOf(app, 'records', 'mark_migration', 'vote')).toBeNull();
    expect(await docsOf(app, 'votes')).toEqual([]);
    // Not frozen: the mark still answers.
    expect(await store.mark(ctx(app, NS_PROD, V3), RECORDS, 'plain', 'vote')).toMatchObject({
      marked: true,
    });
  });

  it('with a keyMap each such key is copied under its mapped parent, and the map is stored with the run', async () => {
    const app = freshApp('MMMAPPED');
    await seedUnfit(app);
    const keyMap = { 'grp:one': 'grp-one', [LONG]: 'long-1' };
    const dry = await maint.checkMarkMigration(app, { from: 'records', mark: 'vote', keyMap });
    expect(dry.check).toMatchObject({ ok: true, unfit: 0, mapped: 2, collisions: 0 });

    const { verify } = await migrate(app, keyMap);
    expect(verify.ok).toBe(true);
    const key = deriver(app, 'votes');
    expect((await docsOf(app, 'votes')).map((d) => d.key).sort()).toEqual(
      [key('grp-one', V2), key('long-1', V2), key('plain', V2)].sort()
    );
    expect((await runOf(app, 'records', 'mark_migration', 'vote'))?.params).toEqual({
      to: 'votes',
      data: { value: 1 },
      keyMap,
    });
  });

  it('a keyMap that sends two keys to one parent is refused', async () => {
    const app = freshApp('MMCOLLIDE');
    await seedUnfit(app);
    const keyMap = { 'grp:one': 'plain', [LONG]: 'long-1' };
    const dry = await maint.checkMarkMigration(app, { from: 'records', mark: 'vote', keyMap });
    expect(dry.check).toMatchObject({
      ok: false,
      unfit: 0,
      collisions: 1,
      collisionSample: ['plain'],
    });
    const err = await expectCode(
      maint.freezeMarks(app, {
        from: 'records',
        mark: 'vote',
        target: VOTES,
        data: BODY,
        keyMap,
        actorUid: MOD,
      }),
      'invalid_request'
    );
    expect(err.details).toMatchObject({ reason: 'keys_do_not_fit' });
  });
});

describe('migrateMarksToDocs never touches report rows', () => {
  it('report rows are not copied, not frozen and not written; report is refused as a mark name', async () => {
    const app = freshApp('MMREPORT');
    await seedVotes(app);
    await store.report(ctx(app, NS_PROD, V3), RECORDS, 'rec_b');
    await store.mark(ctx(app, NS_PROD, V1), RECORDS, 'rec_c', 'report');
    const reports = () =>
      h.raw(
        `SELECT coll, key, user_id, created_at FROM appdata.doc_mark
          WHERE app_id = $1 AND name = 'report' ORDER BY 1, 2, 3`,
        [app]
      );
    const before = await reports();
    expect(before).toHaveLength(2);

    const { copy, verify } = await migrate(app);
    expect(copy.rows).toBe(5);
    expect(verify).toMatchObject({ ok: true, sourceRows: 5, targetDocs: 5 });
    expect(await reports()).toEqual(before);

    const err = await expectCode(
      maint.checkMarkMigration(app, { from: 'records', mark: 'report' }),
      'invalid_request'
    );
    expect(err.details).toMatchObject({ reason: 'report_not_migrated' });
  });
});

describe('the per-collection purge', () => {
  /**
   * `popular_plays`: three counter documents, two created by V1's increments and one by V2's,
   * with `played` marks by V1, V2 and V3, and one report by V3 on `song_b`.
   */
  async function seedCounters(app: string) {
    await store.increment(ctx(app, NS_PROD, V1), POPULAR, 'song_a', 'plays', 3);
    await store.increment(ctx(app, NS_PROD, V1), POPULAR, 'song_b', 'plays', 1);
    await store.increment(ctx(app, NS_PROD, V2), POPULAR, 'song_c', 'plays', 2);
    await store.increment(ctx(app, NS_PROD, V3), POPULAR, 'song_a', 'plays', 1);
    await store.mark(ctx(app, NS_PROD, V1), POPULAR, 'song_a', 'played');
    await store.mark(ctx(app, NS_PROD, V2), POPULAR, 'song_a', 'played');
    await store.mark(ctx(app, NS_PROD, V3), POPULAR, 'song_c', 'played');
    await store.report(ctx(app, NS_PROD, V3), POPULAR, 'song_b');
  }
  async function migratePlayed(app: string) {
    await maint.freezeMarks(app, {
      from: 'popular_plays',
      mark: 'played',
      target: PLAYS,
      data: { count: 1 },
      actorUid: MOD,
    });
    await maint.copyMarksToDocs(app, {
      from: 'popular_plays',
      mark: 'played',
      target: PLAYS,
      deriveKey: deriver(app, 'plays'),
      actorUid: MOD,
    });
    return maint.verifyMarkMigration(app, {
      from: 'popular_plays',
      mark: 'played',
      deriveKey: deriver(app, 'plays'),
      actorUid: MOD,
    });
  }
  const purge = (
    app: string,
    declared: DocCollection | null,
    openTargets: string[],
    collection = 'popular_plays',
    batchSize?: number
  ) =>
    maint.purgeCollection(app, {
      collection,
      declared,
      mode: 'purge',
      openTargets: new Set(openTargets),
      actorUid: MOD,
      reason: 'retire the counter collection',
      batchSize,
    });
  /** seedCounters, its `played` marks migrated into an open `plays`, its report dismissed. */
  async function readyToPurge(app: string) {
    await seedCounters(app);
    expect((await migratePlayed(app)).ok).toBe(true);
    await mod.dismissReports(app, NS_PROD, 'popular_plays', 'song_b');
  }
  const counterDocs = async (app: string) => (await docsOf(app, 'popular_plays')).map((d) => d.key);

  it('refuses while the collection still declares counters ($inc would re-create a document)', async () => {
    const app = freshApp('PGCOUNTERS');
    await seedCounters(app);
    expect((await migratePlayed(app)).ok).toBe(true);
    await mod.dismissReports(app, NS_PROD, 'popular_plays', 'song_b');
    const err = await expectCode(purge(app, POPULAR, ['plays']), 'invalid_request');
    expect(err.details).toMatchObject({ reason: 'counters_declared' });
    expect(await counterDocs(app)).toEqual(['song_a', 'song_b', 'song_c']);
    // Positive control: the same purge with the counters dropped goes through.
    expect((await purge(app, POPULAR_NO_COUNTERS, ['plays'])).deleted).toBe(3);
  });

  it('refuses while a mark on it is not migrated, not verified, or its target is closed', async () => {
    const app = freshApp('PGMARKS');
    await seedCounters(app);
    await mod.dismissReports(app, NS_PROD, 'popular_plays', 'song_b');
    // No run at all.
    let err = await expectCode(purge(app, POPULAR_NO_COUNTERS, ['plays']), 'invalid_request');
    expect(err.details).toMatchObject({
      reason: 'marks_not_migrated',
      marks: [{ mark: 'played', status: null, to: null, open: false }],
    });
    // Frozen and copied, never verified.
    await maint.freezeMarks(app, {
      from: 'popular_plays',
      mark: 'played',
      target: PLAYS,
      data: { count: 1 },
      actorUid: MOD,
    });
    await maint.copyMarksToDocs(app, {
      from: 'popular_plays',
      mark: 'played',
      target: PLAYS,
      deriveKey: deriver(app, 'plays'),
      actorUid: MOD,
    });
    err = await expectCode(purge(app, POPULAR_NO_COUNTERS, ['plays']), 'invalid_request');
    expect(err.details).toMatchObject({
      reason: 'marks_not_migrated',
      marks: [{ mark: 'played', status: 'copied', to: 'plays', open: true }],
    });
    // Verified, but its switch is closed.
    expect((await migratePlayed(app)).ok).toBe(true);
    err = await expectCode(purge(app, POPULAR_NO_COUNTERS, []), 'invalid_request');
    expect(err.details).toMatchObject({
      reason: 'marks_not_migrated',
      marks: [{ mark: 'played', status: 'verified', to: 'plays', open: false }],
    });
    expect(await counterDocs(app)).toEqual(['song_a', 'song_b', 'song_c']);
    // Verified and open: it goes through.
    expect((await purge(app, POPULAR_NO_COUNTERS, ['plays'])).deleted).toBe(3);
  });

  it('refuses while a report on its documents is open; a dismissed one is deleted with its document', async () => {
    const app = freshApp('PGREPORTS');
    await seedCounters(app);
    expect((await migratePlayed(app)).ok).toBe(true);
    const err = await expectCode(purge(app, POPULAR_NO_COUNTERS, ['plays']), 'invalid_request');
    expect(err.details).toMatchObject({ reason: 'open_reports', open: 1 });
    expect(await counterDocs(app)).toEqual(['song_a', 'song_b', 'song_c']);
    await mod.dismissReports(app, NS_PROD, 'popular_plays', 'song_b');
    expect(await purge(app, POPULAR_NO_COUNTERS, ['plays'])).toMatchObject({
      deleted: 3,
      reportsDeleted: 1,
      marksDeleted: 4,
    });
  });

  it("refunds each document's author_uid (the incrementer), never the moderator; tombstones each key", async () => {
    const app = freshApp('PGREFUND');
    await seedCounters(app);
    expect((await migratePlayed(app)).ok).toBe(true);
    await mod.dismissReports(app, NS_PROD, 'popular_plays', 'song_b');
    const before = await usageOf(app);
    const sizes = await h.raw(
      `SELECT author_uid, sum(size_bytes)::int AS bytes, count(*)::int AS docs FROM appdata.doc
        WHERE app_id = $1 AND coll = 'popular_plays' GROUP BY author_uid ORDER BY author_uid`,
      [app]
    );
    // V1's increments created song_a and song_b, V2's song_c; V3 only incremented song_a.
    expect(sizes.map((r) => [Number(r.author_uid), r.docs])).toEqual([
      [V1, 2],
      [V2, 1],
    ]);

    const out = await purge(app, POPULAR_NO_COUNTERS, ['plays']);
    expect(out.refunds).toEqual(
      sizes.map((r) => ({ userId: Number(r.author_uid), docs: r.docs, bytes: r.bytes }))
    );
    const after = await usageOf(app);
    const docsBy = (u: typeof before, uid: number) =>
      Number(u.users.find((r) => Number(r.user_id) === uid)?.docs ?? 0);
    expect([V1, V2, V3, MOD].map((uid) => docsBy(before, uid) - docsBy(after, uid))).toEqual([
      2, 1, 0, 0,
    ]);
    expect(Number(before.app[0].docs) - Number(after.app[0].docs)).toBe(3);
    await assertUsageConsistent(h, app, NS_PROD);
    expect(await counterDocs(app)).toEqual([]);
    const tombs = await h.raw(
      `SELECT key FROM appdata.doc_tomb WHERE app_id = $1 AND coll = 'popular_plays' ORDER BY key`,
      [app]
    );
    expect(tombs.map((t) => t.key)).toEqual(['song_a', 'song_b', 'song_c']);
    // The migrated plays are untouched.
    expect(await docsOf(app, 'plays')).toHaveLength(3);
  });

  it('writes the dump of every row it deletes, report rows included', async () => {
    const app = freshApp('PGDUMP');
    await seedCounters(app);
    expect((await migratePlayed(app)).ok).toBe(true);
    await mod.dismissReports(app, NS_PROD, 'popular_plays', 'song_b');
    const docs = await docsOf(app, 'popular_plays');
    const out = await purge(app, POPULAR_NO_COUNTERS, ['plays']);
    const dump = await maint.purgeDump(app, { collection: 'popular_plays', runId: out.runId });
    expect(dump?.docs.map((d) => [d.key, d.authorUid, d.authorKind, d.seq])).toEqual(
      docs.map((d) => [d.key, d.author_uid, 'counter', Number(d.seq)])
    );
    expect(dump?.tallies).toEqual([
      { key: 'song_a', kind: 'counter', name: 'plays', count: 4 },
      { key: 'song_a', kind: 'mark', name: 'played', count: 2 },
      { key: 'song_b', kind: 'counter', name: 'plays', count: 1 },
      { key: 'song_c', kind: 'counter', name: 'plays', count: 2 },
      { key: 'song_c', kind: 'mark', name: 'played', count: 1 },
    ]);
    expect(dump?.marks.map((m) => `${m.key}|${m.name}|${m.userId}`)).toEqual([
      `song_a|played|${V1}`,
      `song_a|played|${V2}`,
      `song_b|report|${V3}`,
      `song_c|played|${V3}`,
    ]);
    expect(dump?.docs.find((d) => d.key === 'song_b')?.reportsDismissedAt).not.toBeNull();
    expect((await maint.listMaintRuns(app)).find((r) => r.kind === 'purge')).toMatchObject({
      collection: 'popular_plays',
      name: out.runId,
      status: 'purged',
      actorUid: MOD,
    });
  });

  it('refuses a viewer-keyed collection: its purge is the rollback', async () => {
    const app = freshApp('PGVK');
    const err = await expectCode(purge(app, PLAYS, [], 'plays'), 'invalid_request');
    expect(err.details).toMatchObject({ reason: 'viewer_keyed' });
  });

  it('deletes counter documents only: a collection holding any other document is refused', async () => {
    const app = freshApp('PGNOTCOUNTER');
    await seedVotes(app);
    // `records` holds user-authored documents and no marks once migrated: still not a counter collection.
    const err = await expectCode(purge(app, null, [], 'records'), 'invalid_request');
    expect(err.details).toMatchObject({ reason: 'not_counter_documents', others: 3 });
    expect(await docsOf(app, 'records')).toHaveLength(3);
  });

  it('refuses a mark-migration target as viewer-keyed even when the manifest no longer declares it', async () => {
    const app = freshApp('PGVKUNDECL');
    await seedVotes(app);
    await migrate(app);
    const err = await expectCode(purge(app, null, ['votes'], 'votes'), 'invalid_request');
    expect(err.details).toMatchObject({ reason: 'viewer_keyed' });
    expect(await docsOf(app, 'votes')).toHaveLength(5);
  });

  it('is batched and resumable: each call deletes one batch, dumped in its own row; a re-call continues', async () => {
    const app = freshApp('PGBATCH');
    await readyToPurge(app);
    const first = await purge(app, POPULAR_NO_COUNTERS, ['plays'], 'popular_plays', 2);
    expect(first).toMatchObject({ done: false, batch: 1, deleted: 2, totals: { deleted: 2 } });
    expect(await counterDocs(app)).toEqual(['song_c']);
    expect((await maint.listMaintRuns(app)).find((r) => r.kind === 'purge')).toMatchObject({
      name: first.runId,
      status: 'purging',
    });
    const second = await purge(app, POPULAR_NO_COUNTERS, ['plays'], 'popular_plays', 2);
    expect(second).toMatchObject({
      runId: first.runId,
      done: true,
      batch: 2,
      deleted: 1,
      totals: { batches: 2, deleted: 3, reportsDeleted: 1 },
    });
    expect(second.totals.refunds.map((r) => [r.userId, r.docs])).toEqual([
      [V1, 2],
      [V2, 1],
    ]);
    const dumps = await h.raw(
      `SELECT name FROM appdata.maint_run WHERE app_id = $1 AND kind = 'purge_dump' ORDER BY name`,
      [app]
    );
    expect(dumps.map((d) => d.name)).toEqual([`${first.runId}.000001`, `${first.runId}.000002`]);
    const dump = await maint.purgeDump(app, { collection: 'popular_plays', runId: first.runId });
    expect(dump?.docs.map((d) => d.key)).toEqual(['song_a', 'song_b', 'song_c']);
    await assertUsageConsistent(h, app, NS_PROD);
  });

  it('a rollback is refused once the source collection was purged', async () => {
    const app = freshApp('RBSRCPURGED');
    await readyToPurge(app);
    expect((await purge(app, POPULAR_NO_COUNTERS, ['plays'])).done).toBe(true);
    const err = await expectCode(
      maint.purgeCollection(app, {
        collection: 'plays',
        declared: PLAYS,
        mode: 'rollback',
        openTargets: new Set(),
        actorUid: MOD,
        reason: 'roll back',
        deriveKey: deriver(app, 'plays'),
      }),
      'invalid_request'
    );
    expect(err.details).toMatchObject({ reason: 'source_purged', from: 'popular_plays' });
    expect(await docsOf(app, 'plays')).toHaveLength(3);
  });

  it('an account deletion removes the account from every dump and purge result (operator decision: the wipe covers dumps)', async () => {
    const app = freshApp('PGWIPE');
    await readyToPurge(app);
    const out = await purge(app, POPULAR_NO_COUNTERS, ['plays']);
    const wiped = await maint.wipeAccount(V1);
    expect(wiped.namespaces.find((n) => n.appId === app)?.maintRunsScrubbed).toBe(2);
    const dump = await maint.purgeDump(app, { collection: 'popular_plays', runId: out.runId });
    // V1 authored song_a and song_b (their marks and the report on song_b go with them); V2's
    // song_c and V3's mark on it stay.
    expect(dump?.docs.map((d) => [d.key, d.authorUid])).toEqual([['song_c', V2]]);
    expect(dump?.marks.map((m) => `${m.key}|${m.name}|${m.userId}`)).toEqual([
      `song_c|played|${V3}`,
    ]);
    expect(dump?.tallies.map((t) => t.key)).toEqual(['song_c', 'song_c']);
    const header = (await maint.listMaintRuns(app)).find((r) => r.kind === 'purge');
    expect((header?.result.refunds as { userId: number }[]).map((r) => r.userId)).toEqual([V2]);
    // Positive control: nothing in the runs still names V1.
    const naming = await h.raw(
      `SELECT count(*)::int AS n FROM appdata.maint_run
        WHERE app_id = $1 AND (dump::text ~ $2 OR result::text ~ $2)`,
      [app, `[^0-9]${V1}[^0-9]`]
    );
    expect(naming[0].n).toBe(0);
  });

  it('dumps expire 30 days after their purge finished; a purge still in progress keeps them', async () => {
    const done = freshApp('PGEXPIRE');
    await readyToPurge(done);
    const out = await purge(done, POPULAR_NO_COUNTERS, ['plays']);
    const age = (app: string, days: number) =>
      h.raw(
        `UPDATE appdata.maint_run SET updated_at = now() - make_interval(days => $2)
          WHERE app_id = $1 AND kind = 'purge'`,
        [app, days]
      );
    await age(done, 29);
    expect(await maint.expireMaintDumps(done)).toEqual({ dumps: 0 });
    expect(
      await maint.purgeDump(done, { collection: 'popular_plays', runId: out.runId })
    ).not.toBeNull();
    await age(done, 31);
    expect(await maint.expireMaintDumps(done)).toEqual({ dumps: 1 });
    expect(
      await maint.purgeDump(done, { collection: 'popular_plays', runId: out.runId })
    ).toBeNull();
    // The header and its counts stay.
    expect((await maint.listMaintRuns(done)).find((r) => r.kind === 'purge')).toMatchObject({
      status: 'purged',
      result: { deleted: 3 },
    });

    // A purge never finished: kept while it may still be continued, then abandoned and expired,
    // counted from when it STARTED.
    const partial = freshApp('PGEXPIREPART');
    await readyToPurge(partial);
    const started = await purge(partial, POPULAR_NO_COUNTERS, ['plays'], 'popular_plays', 1);
    const ageStart = (days: number) =>
      h.raw(
        `UPDATE appdata.maint_run SET created_at = now() - make_interval(days => $2)
          WHERE app_id = $1 AND kind = 'purge'`,
        [partial, days]
      );
    await age(partial, 90);
    await ageStart(29);
    expect(await maint.expireMaintDumps(partial)).toEqual({ dumps: 0 });
    expect((await maint.listMaintRuns(partial)).find((r) => r.kind === 'purge')?.status).toBe(
      'purging'
    );
    await ageStart(31);
    expect(await maint.expireMaintDumps(partial)).toEqual({ dumps: 1 });
    expect((await maint.listMaintRuns(partial)).find((r) => r.kind === 'purge')).toMatchObject({
      name: started.runId,
      status: 'abandoned',
    });
    // A re-call starts a new purge instead of continuing the abandoned one.
    const again = await purge(partial, POPULAR_NO_COUNTERS, ['plays']);
    expect(again.runId).not.toBe(started.runId);
    expect(again).toMatchObject({ done: true, deleted: 2 });
  });

  it('the wipe finds a REPORT-ONLY user through the dumps: their purged report leaves no trace', async () => {
    const app = freshApp('PGWIPEREPORTER');
    await seedCounters(app);
    await store.report(ctx(app, NS_PROD, V4), POPULAR, 'song_c');
    expect((await migratePlayed(app)).ok).toBe(true);
    await mod.dismissReports(app, NS_PROD, 'popular_plays', 'song_b');
    await mod.dismissReports(app, NS_PROD, 'popular_plays', 'song_c');
    const out = await purge(app, POPULAR_NO_COUNTERS, ['plays']);
    const reporters = async () =>
      (await maint.purgeDump(app, { collection: 'popular_plays', runId: out.runId }))?.marks
        .filter((m) => m.name === 'report')
        .map((m) => m.userId);
    // Positive control: the dump holds V4's report, and nothing else in the store names V4.
    expect(await reporters()).toEqual([V3, V4]);
    expect(
      await h.raw(
        `SELECT 1 FROM appdata.usage_user WHERE user_id = $1 UNION ALL
         SELECT 1 FROM appdata.doc_mark WHERE user_id = $1`,
        [V4]
      )
    ).toEqual([]);
    const wiped = await maint.wipeAccount(V4);
    expect(wiped.namespaces.filter((n) => n.appId === app)).toMatchObject([
      { ns: NS_PROD, mode: 'user', maintRunsScrubbed: 1, marks: 0, sharedDocs: 0 },
    ]);
    expect(await reporters()).toEqual([V3]);
  });

  it("the wipe removes the user from a verify's per-user sample", async () => {
    const app = freshApp('PGWIPEVERIFY');
    await seedVotes(app);
    await migrate(app);
    await h.raw(`DELETE FROM appdata.doc WHERE app_id = $1 AND coll = 'votes' AND key = $2`, [
      app,
      deriver(app, 'votes')('rec_b', V3),
    ]);
    await maint.verifyMarkMigration(app, {
      from: 'records',
      mark: 'vote',
      deriveKey: deriver(app, 'votes'),
      actorUid: MOD,
    });
    const sample = async () =>
      (
        (await maint.listMaintRuns(app)).find((r) => r.kind === 'mark_migration')?.result
          .verify as { userSample: { id: string }[] }
      ).userSample.map((u) => u.id);
    expect(await sample()).toEqual([String(V3)]);
    await maint.wipeAccount(V3);
    expect(await sample()).toEqual([]);
  });
});

describe('the rollback', () => {
  const rollback = (app: string, openTargets: string[], batchSize?: number) =>
    maint.purgeCollection(app, {
      collection: 'votes',
      declared: VOTES,
      mode: 'rollback',
      openTargets: new Set(openTargets),
      actorUid: MOD,
      reason: 'roll the vote migration back',
      deriveKey: deriver(app, 'votes'),
      batchSize,
    });

  it('refuses when the target holds anything the copy did not write: an @me edit, or a new vote', async () => {
    // The switch fails closed, so a target that WAS open can read closed: the documents decide.
    for (const [tag, write] of [
      [
        'EDIT',
        (app: string) =>
          store.put(ctx(app, NS_PROD, V1), VOTES, deriver(app, 'votes')('rec_a', V1), {
            value: -1,
          }),
      ],
      [
        'NEW',
        (app: string) =>
          store.put(ctx(app, NS_PROD, V3), VOTES, deriver(app, 'votes')('rec_c', V3), { value: 1 }),
      ],
    ] as const) {
      const app = freshApp(`RBWRITTEN${tag}`);
      await seedVotes(app);
      await migrate(app);
      // (The untouched copies pass the guard: the rollback cases below roll them back.)
      await write(app);
      const err = await expectCode(rollback(app, []), 'invalid_request');
      expect({ tag, details: err.details }).toMatchObject({
        tag,
        details: { reason: 'target_written', written: 1 },
      });
      expect(await docsOf(app, 'votes')).toHaveLength(tag === 'NEW' ? 6 : 5);
      expect((await runOf(app, 'records', 'mark_migration', 'vote'))?.status).toBe('verified');
    }
  });

  it('refuses when a copy is gone (a viewer deleted their vote through @me)', async () => {
    const app = freshApp('RBDELETED');
    await seedVotes(app);
    await migrate(app);
    await store.delete(ctx(app, NS_PROD, V2), VOTES, deriver(app, 'votes')('rec_c', V2));
    const err = await expectCode(rollback(app, []), 'invalid_request');
    expect(err.details).toMatchObject({ reason: 'target_written', written: 0, missing: 1 });
  });

  it('is batched: the freeze lifts only when the last batch is gone', async () => {
    const app = freshApp('RBBATCH');
    await seedVotes(app);
    await migrate(app);
    const first = await rollback(app, [], 2);
    expect(first).toMatchObject({ done: false, deleted: 2, rolledBack: null });
    await expectCode(store.mark(ctx(app, NS_PROD, V3), RECORDS, 'rec_c', 'vote'), 'removed');
    expect(await rollback(app, [], 2)).toMatchObject({ done: false, deleted: 2 });
    expect(await rollback(app, [], 2)).toMatchObject({
      done: true,
      deleted: 1,
      totals: { batches: 3, deleted: 5 },
      rolledBack: { from: 'records', mark: 'vote' },
    });
    expect(await store.mark(ctx(app, NS_PROD, V3), RECORDS, 'rec_c', 'vote')).toMatchObject({
      marked: true,
    });
  });

  it('before the switch opens: purges the copies, refunds the voters, lifts the freeze', async () => {
    const app = freshApp('RBDONE');
    await seedVotes(app);
    const before = await usageOf(app);
    await migrate(app);
    const out = await rollback(app, []);
    expect(out).toMatchObject({
      mode: 'rollback',
      deleted: 5,
      rolledBack: { from: 'records', mark: 'vote' },
    });
    expect(await docsOf(app, 'votes')).toEqual([]);
    expect((await usageOf(app)).users).toEqual(before.users);
    expect((await runOf(app, 'records', 'mark_migration', 'vote'))?.status).toBe('rolled_back');
    // The freeze is lifted: the old mark answers again.
    expect(await store.mark(ctx(app, NS_PROD, V3), RECORDS, 'rec_c', 'vote')).toMatchObject({
      marked: true,
    });
  });

  it('refuses once the target is open, and when no migration targets the collection', async () => {
    const app = freshApp('RBOPEN');
    await seedVotes(app);
    await migrate(app);
    let err = await expectCode(rollback(app, ['votes']), 'invalid_request');
    expect(err.details).toMatchObject({ reason: 'target_open' });
    expect(await docsOf(app, 'votes')).toHaveLength(5);

    const none = freshApp('RBNONE');
    err = await expectCode(rollback(none, []), 'invalid_request');
    expect(err.details).toMatchObject({ reason: 'no_migration_run' });
  });
});

describe('the freeze never trusts a cached "no table"', () => {
  // The race: a store that once found `maint_run` absent, the migration applied, a freeze
  // committed — the very next mark through that same store must read the freeze.
  it('a mark right after the table appears and a freeze commits is refused', async () => {
    const bare = await createPgliteHarness({ rls: true, maintRun: false });
    try {
      const viewerStore = createDocStore({ db: bare.db });
      const app = freshApp('FRZRACE');
      await viewerStore.put(ctx(app, NS_PROD, V1), RECORDS, 'rec_a', { title: 'a' });
      // The store looks for the table and finds none.
      await viewerStore.mark(ctx(app, NS_PROD, V1), RECORDS, 'rec_a', 'vote');
      await bare.raw(readFileSync(MIGRATION_MAINT_RUN_UP, 'utf8'));
      await createDocStoreMaintenance({ db: bare.db }).freezeMarks(app, {
        from: 'records',
        mark: 'vote',
        target: VOTES,
        data: BODY,
        actorUid: MOD,
      });
      await expectCode(
        viewerStore.mark(ctx(app, NS_PROD, V2), RECORDS, 'rec_a', 'vote'),
        'removed'
      );
      await expectCode(
        viewerStore.unmark(ctx(app, NS_PROD, V1), RECORDS, 'rec_a', 'vote'),
        'removed'
      );
    } finally {
      await bare.close();
    }
  });
});
