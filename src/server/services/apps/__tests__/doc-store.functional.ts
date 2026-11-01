// Behavioural suite for the document store, run on the embedded Postgres (PGlite)
// as `appdata_rw` twice: with row-level security DISABLED on the tables, and with it on.
// The RLS-disabled run is what makes the isolation cases a test of the module's
// own predicates: without RLS, a dropped `app_id = $1` leaks.
//
// Expected values are literals, never derived from the store under test. Usage
// counters are cross-checked against a recompute (`sum(size_bytes)`), a different
// mechanism from the incremental one under test.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDocStore } from '~/server/services/apps/doc-store';
import type { DocStore } from '~/server/services/apps/doc-store';
import type {
  DocCollection,
  DocCollectionConfig,
  DocIndexType,
  DocStoreContext,
  DocStoreErrorCode,
} from '~/server/services/apps/doc-store.types';
import { DocStoreError } from '~/server/services/apps/doc-store.types';
import type { Harness } from './doc-store.harness';
import { APPDATA_TABLES } from './doc-store.sql-scan';

/**
 * A collection declaration in the manifest parser's shape (`DocCollectionConfig`
 * IS `DeclaredStorageCollection`), from the terse literal the cases below write:
 * omitted lists are empty and `indexes` is given as an object.
 */
export function decl(
  c: Partial<Omit<DocCollectionConfig, 'indexes'>> &
    Pick<DocCollectionConfig, 'visibility'> & { indexes?: Record<string, DocIndexType> }
): DocCollectionConfig {
  return {
    kind: 'docs',
    counters: [],
    marks: [],
    showAuthor: false,
    ...c,
    indexes: new Map(Object.entries(c.indexes ?? {})),
  };
}

// Pairwise-distinct identities, distinct from every literal the assertions use.
export const APP_A = 'ab_ISOLATIONAPPA';
export const APP_B = 'ab_ISOLATIONAPPB';
export const NS_PROD = 'prod';
export const NS_DEV = 'dev:4711';
export const VIEWER_1 = 101;
export const VIEWER_2 = 202;

export const PREFS: DocCollection = { name: 'prefs', config: decl({ visibility: 'private' }) };
export const POSTS: DocCollection = {
  name: 'posts',
  config: decl({
    visibility: 'shared',
    write: 'own',
    marks: ['vote', 'star'],
    counters: ['vote', 'views'],
    indexes: { status: 'string', score: 'number', 'meta.tag': 'string', at: 'time' },
  }),
};
export const BOARD: DocCollection = {
  name: 'board',
  config: decl({ visibility: 'shared', write: 'own' }),
};
/** Counter-only: no document writes by anyone; documents exist through increments. */
export const TALLIES: DocCollection = {
  name: 'tallies',
  config: decl({ visibility: 'shared', write: 'none', counters: ['plays'] }),
};
export const PLAYS: DocCollection = {
  name: 'plays',
  config: decl({ visibility: 'shared', write: 'owner', counters: ['plays'] }),
};

export const ctx = (appId: string, ns: string, viewerUid: number | null): DocStoreContext => ({
  appId,
  ns,
  viewerUid,
});

export async function expectCode(p: Promise<unknown>, code: DocStoreErrorCode) {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(DocStoreError);
    expect((err as DocStoreError).code).toBe(code);
    return err as DocStoreError;
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}

let appSeq = 0;
/** A fresh app id per test so tests never share rows. */
export const freshApp = (tag: string) => `ab_${tag}_${(appSeq += 1)}`;

/** Every row of every appdata table for one app id (superuser, RLS bypassed), for "untouched" checks. */
export async function snapshot(h: Harness, appId: string) {
  const out: Record<string, unknown[]> = {};
  for (const t of APPDATA_TABLES) {
    out[t] = await h.raw(`SELECT * FROM appdata.${t} WHERE app_id = $1 ORDER BY 1, 2, 3, 4, 5`, [
      appId,
    ]);
  }
  return out;
}

/**
 * Recompute usage from the documents themselves and compare with the counters. The app's
 * row counts SHARED documents only (`scope_uid = 0`); a private document is charged to its
 * viewer's row alone.
 */
export async function assertUsageConsistent(h: Harness, appId: string, ns: string) {
  const [recomputed] = await h.raw(
    `SELECT COALESCE(sum(size_bytes), 0)::bigint AS bytes, count(*)::int AS docs
       FROM appdata.doc WHERE app_id = $1 AND ns = $2 AND scope_uid = 0`,
    [appId, ns]
  );
  const [usage] = await h.raw(
    `SELECT bytes, docs FROM appdata.usage_app WHERE app_id = $1 AND ns = $2`,
    [appId, ns]
  );
  expect({ bytes: Number(usage?.bytes ?? 0), docs: Number(usage?.docs ?? 0) }).toEqual({
    bytes: Number(recomputed.bytes),
    docs: Number(recomputed.docs),
  });
  const perUser = await h.raw(
    `SELECT u.user_id, u.bytes, u.docs,
            COALESCE((SELECT sum(d.size_bytes) FROM appdata.doc d WHERE d.app_id = u.app_id AND d.ns = u.ns
                        AND ((d.scope_uid = u.user_id) OR (d.scope_uid = 0 AND d.author_kind IN ('user', 'counter') AND d.author_uid = u.user_id))), 0)::bigint AS want_bytes,
            (SELECT count(*) FROM appdata.doc d WHERE d.app_id = u.app_id AND d.ns = u.ns
                        AND ((d.scope_uid = u.user_id) OR (d.scope_uid = 0 AND d.author_kind IN ('user', 'counter') AND d.author_uid = u.user_id)))::int AS want_docs
       FROM appdata.usage_user u WHERE u.app_id = $1 AND u.ns = $2`,
    [appId, ns]
  );
  // Every user who owns bytes must HAVE a usage row — a missing row is invisible to the loop below.
  const owners = await h.raw(
    `SELECT DISTINCT CASE WHEN d.scope_uid <> 0 THEN d.scope_uid ELSE d.author_uid END AS uid
       FROM appdata.doc d WHERE d.app_id = $1 AND d.ns = $2
        AND (d.scope_uid <> 0 OR (d.author_kind IN ('user', 'counter') AND d.author_uid IS NOT NULL))`,
    [appId, ns]
  );
  const charged = new Set(perUser.map((r) => Number(r.user_id)));
  expect(owners.map((o) => Number(o.uid)).filter((u) => !charged.has(u))).toEqual([]);
  for (const r of perUser) {
    expect({ user: r.user_id, bytes: Number(r.bytes), docs: Number(r.docs) }).toEqual({
      user: r.user_id,
      bytes: Number(r.want_bytes),
      docs: Number(r.want_docs),
    });
  }
}

/**
 * Number, boolean and time all store into `v_num`. Re-declare an index from
 * number to boolean, and separately to time, and check neither a filter nor a
 * sort under the new type reaches rows written under the old one. The number
 * values are chosen so that, without the type match, they WOULD match: `1` is
 * the stored form of `true`, and `7` is a valid time (7 ms after the epoch).
 */
export async function assertNumericRetypeIsolated(store: DocStore, appId: string) {
  const who = ctx(appId, NS_PROD, VIEWER_1);
  const keys = async (coll: DocCollection, q: Parameters<DocStore['list']>[2]) =>
    (await store.list(who, coll, q)).items.map((d) => d.key);
  for (const [name, newType, newValue, probe] of [
    ['to_bool', 'boolean', true, true],
    ['to_time', 'time', '2026-01-01T00:00:00Z', 7],
  ] as const) {
    const asNumber: DocCollection = {
      name,
      config: decl({ visibility: 'shared', indexes: { f: 'number' } }),
    };
    const retyped: DocCollection = {
      name,
      config: decl({ visibility: 'shared', indexes: { f: newType } }),
    };
    await store.put(who, asNumber, 'num-1', { f: 1 });
    await store.put(who, asNumber, 'num-7', { f: 7 });
    await store.put(who, retyped, 'new', { f: newValue });
    // Positive control: under the OLD type the number rows are there to be found.
    expect({ name, old: await keys(asNumber, { where: { f: 7 } }) }).toEqual({
      name,
      old: ['num-7'],
    });
    expect({ name, filter: await keys(retyped, { where: { f: probe } }) }).toEqual({
      name,
      filter: newType === 'boolean' ? ['new'] : [],
    });
    expect({ name, asc: await keys(retyped, { sort: 'f' }) }).toEqual({ name, asc: ['new'] });
    expect({ name, desc: await keys(retyped, { sort: '-f' }) }).toEqual({ name, desc: ['new'] });
  }
}

export function defineFunctionalSuite(makeHarness: () => Promise<Harness>) {
  let h: Harness;
  let store: DocStore;

  beforeAll(async () => {
    h = await makeHarness();
    store = createDocStore({ db: h.db });
  });
  afterAll(async () => {
    await h?.close();
  });

  describe('isolation between apps, namespaces and viewers', () => {
    const combos = [APP_A, APP_B].flatMap((app) =>
      [NS_PROD, NS_DEV].flatMap((ns) => [VIEWER_1, VIEWER_2].map((v) => ({ app, ns, v })))
    );
    const tag = (c: { app: string; ns: string; v: number }) => `${c.app}|${c.ns}|${c.v}`;

    it('private docs: the same key in 8 (app, ns, viewer) key spaces stays 8 documents', async () => {
      for (const c of combos) {
        await store.put(ctx(c.app, c.ns, c.v), PREFS, 'same', { who: tag(c) });
        await store.put(ctx(c.app, c.ns, c.v), PREFS, `only-${combos.indexOf(c)}`, { who: tag(c) });
      }
      for (const c of combos) {
        const me = ctx(c.app, c.ns, c.v);
        expect((await store.get(me, PREFS, 'same'))?.data).toEqual({ who: tag(c) });
        const listed = await store.list(me, PREFS, { limit: 100 });
        expect(listed.items.map((d) => d.key).sort()).toEqual(
          ['same', `only-${combos.indexOf(c)}`].sort()
        );
        for (const other of combos) {
          if (other === c) continue;
          expect(await store.get(me, PREFS, `only-${combos.indexOf(other)}`)).toBeNull();
        }
      }
    });

    it('shared docs: one key space per (app, ns), whichever viewer reads', async () => {
      const spaces = [APP_A, APP_B].flatMap((app) => [NS_PROD, NS_DEV].map((ns) => ({ app, ns })));
      for (const [i, s] of spaces.entries()) {
        await store.put(ctx(s.app, s.ns, VIEWER_1), BOARD, 'same', { space: i });
        await store.put(ctx(s.app, s.ns, VIEWER_1), BOARD, `only-${i}`, { space: i });
      }
      for (const [i, s] of spaces.entries()) {
        for (const v of [VIEWER_1, VIEWER_2, null]) {
          const me = ctx(s.app, s.ns, v);
          expect((await store.get(me, BOARD, 'same'))?.data).toEqual({ space: i });
          const many = await store.getMany(
            me,
            BOARD,
            spaces.map((_, j) => `only-${j}`)
          );
          expect(many.map((d) => d?.data ?? null)).toEqual(
            spaces.map((_, j) => (j === i ? { space: i } : null))
          );
        }
      }
    });

    it('marks, counters and deletes in one app do not reach another', async () => {
      await store.put(ctx(APP_A, NS_PROD, VIEWER_1), POSTS, 'p', { status: 'open' });
      await store.put(ctx(APP_B, NS_PROD, VIEWER_1), POSTS, 'p', { status: 'open' });
      await store.mark(ctx(APP_A, NS_PROD, VIEWER_2), POSTS, 'p', 'vote');
      await store.increment(ctx(APP_A, NS_PROD, VIEWER_2), POSTS, 'p', 'views', 7);
      const b = await store.get(ctx(APP_B, NS_PROD, VIEWER_2), POSTS, 'p');
      expect(b?.marks.vote).toBe(0);
      expect(b?.counters.views).toBe(0);
      expect(b?.viewer).toEqual({ marks: [] });
      await store.mark(ctx(APP_B, NS_PROD, VIEWER_1), POSTS, 'p', 'star');
      await store.increment(ctx(APP_B, NS_PROD, VIEWER_1), POSTS, 'p', 'views', 3);
      await store.delete(ctx(APP_A, NS_PROD, VIEWER_1), POSTS, 'p');
      // A's delete removed A's tallies and marks, and none of B's.
      const after = await store.get(ctx(APP_B, NS_PROD, VIEWER_1), POSTS, 'p');
      expect(after?.marks).toEqual({ vote: 0, star: 1 });
      expect(after?.counters).toEqual({ vote: 0, views: 3 });
      expect(after?.viewer).toEqual({ marks: ['star'] });
    });
  });

  describe('context', () => {
    it('refuses a malformed context before touching the database', async () => {
      for (const bad of [
        ctx('', NS_PROD, VIEWER_1),
        ctx("ab_x'; --", NS_PROD, VIEWER_1),
        ctx(APP_A, 'staging', VIEWER_1),
        ctx(APP_A, 'dev:0', VIEWER_1),
        ctx(APP_A, NS_PROD, 0),
        ctx(APP_A, NS_PROD, -3),
        ctx(APP_A, NS_PROD, 1.5),
      ]) {
        await expect(store.put(bad, PREFS, 'k', { a: 1 })).rejects.toThrow(/malformed context/);
        await expect(store.get(bad, BOARD, 'k')).rejects.toThrow(/malformed context/);
      }
    });
  });

  describe('conditional writes', () => {
    it('ifVersion: n writes only at version n; 0 only when absent', async () => {
      const me = ctx(freshApp('ver'), NS_PROD, VIEWER_1);
      const v1 = await store.put(me, PREFS, 'k', { n: 1 }, { ifVersion: 0 });
      expect(v1.version).toBe(1);
      const err0 = await expectCode(
        store.put(me, PREFS, 'k', { n: 9 }, { ifVersion: 0 }),
        'version_conflict'
      );
      expect(err0.details).toEqual({ currentVersion: 1 });
      const v2 = await store.put(me, PREFS, 'k', { n: 2 }, { ifVersion: 1 });
      expect(v2.version).toBe(2);
      const stale = await expectCode(
        store.put(me, PREFS, 'k', { n: 3 }, { ifVersion: 1 }),
        'version_conflict'
      );
      expect(stale.details).toEqual({ currentVersion: 2 });
      await expectCode(
        store.put(me, PREFS, 'absent', { n: 1 }, { ifVersion: 4 }),
        'version_conflict'
      );
      expect((await store.get(me, PREFS, 'k'))?.data).toEqual({ n: 2 });
      await expectCode(store.delete(me, PREFS, 'k', { ifVersion: 1 }), 'version_conflict');
      expect(await store.delete(me, PREFS, 'k', { ifVersion: 2 })).toEqual({ deleted: true });
      expect(await store.delete(me, PREFS, 'k')).toEqual({ deleted: false });
      expect(await store.get(me, PREFS, 'k')).toBeNull();
      const again = await store.put(me, PREFS, 'k', { n: 4 }, { ifVersion: 0 });
      expect(again.version).toBe(1);
    });

    it('counter and mark changes do not bump the version', async () => {
      const app = freshApp('verc');
      await store.put(ctx(app, NS_PROD, VIEWER_1), POSTS, 'k', { status: 'a' });
      await store.increment(ctx(app, NS_PROD, VIEWER_2), POSTS, 'k', 'views');
      await store.mark(ctx(app, NS_PROD, VIEWER_2), POSTS, 'k', 'vote');
      expect((await store.get(ctx(app, NS_PROD, VIEWER_2), POSTS, 'k'))?.version).toBe(1);
    });
  });

  describe('write policy and authorship', () => {
    it('own: only the author updates or deletes', async () => {
      const app = freshApp('own');
      const doc = await store.put(ctx(app, NS_PROD, VIEWER_1), POSTS, 'k', { status: 'a' });
      expect(doc.author).toEqual({ kind: 'user', uid: VIEWER_1, isViewer: true });
      const seen = await store.get(ctx(app, NS_PROD, VIEWER_2), POSTS, 'k');
      expect(seen?.author).toEqual({ kind: 'user', uid: VIEWER_1, isViewer: false });
      await expectCode(
        store.put(ctx(app, NS_PROD, VIEWER_2), POSTS, 'k', { status: 'b' }),
        'not_author'
      );
      await expectCode(store.delete(ctx(app, NS_PROD, VIEWER_2), POSTS, 'k'), 'not_author');
      const created = await store.create(ctx(app, NS_PROD, VIEWER_2), POSTS, { status: 'c' });
      expect(created.key).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(created.author).toEqual({ kind: 'user', uid: VIEWER_2, isViewer: true });
    });

    it('owner: viewers cannot write documents, but may increment declared counters', async () => {
      const app = freshApp('owner');
      await expectCode(
        store.put(ctx(app, NS_PROD, VIEWER_1), PLAYS, 'k', { a: 1 }),
        'write_policy'
      );
      await expectCode(store.create(ctx(app, NS_PROD, VIEWER_1), PLAYS, { a: 1 }), 'write_policy');
      await expectCode(store.delete(ctx(app, NS_PROD, VIEWER_1), PLAYS, 'k'), 'write_policy');
      // Owner writes are a later phase; seed an app-authored doc directly.
      await h.raw(
        `INSERT INTO appdata.doc (app_id, ns, coll, scope_uid, key, data, version, seq, author_kind)
         VALUES ($1, $2, 'plays', 0, 'col-1', '{}', 1, 1, 'app')`,
        [app, NS_PROD]
      );
      expect(
        await store.increment(ctx(app, NS_PROD, VIEWER_1), PLAYS, 'col-1', 'plays', 3)
      ).toEqual({ value: 3 });
      const doc = await store.get(ctx(app, NS_PROD, null), PLAYS, 'col-1');
      expect(doc?.author).toEqual({ kind: 'app' });
      expect(doc?.counters).toEqual({ plays: 3 });
      expect(doc?.viewer).toBeNull();
    });

    it('write: anyone, ttlSeconds, kind: log and maxEntries are refused as not supported yet, for every operation', async () => {
      const app = freshApp('unsupported');
      const v1 = ctx(app, NS_PROD, VIEWER_1);
      const anyone: DocCollection = {
        name: 'anyone',
        config: decl({ visibility: 'shared', write: 'anyone' }),
      };
      const ttl: DocCollection = {
        name: 'ttl',
        config: decl({ visibility: 'private', ttlSeconds: 60 }),
      };
      const log: DocCollection = {
        name: 'log',
        config: decl({ visibility: 'private', kind: 'log' }),
      };
      const capped: DocCollection = {
        name: 'capped',
        config: decl({ visibility: 'shared', maxEntries: 100, counters: ['n'] }),
      };
      for (const coll of [anyone, ttl, log, capped]) {
        await expectCode(store.put(v1, coll, 'k', { a: 1 }), 'invalid_request');
        await expectCode(store.create(v1, coll, { a: 1 }), 'invalid_request');
        await expectCode(store.get(v1, coll, 'k'), 'invalid_request');
        await expectCode(store.list(v1, coll), 'invalid_request');
        await expectCode(store.delete(v1, coll, 'k'), 'invalid_request');
      }
      await expectCode(store.increment(v1, capped, 'k', 'n'), 'invalid_request');
      expect(await h.raw(`SELECT 1 FROM appdata.doc WHERE app_id = $1`, [app])).toEqual([]);
    });

    it('anonymous viewers read shared collections and nothing else', async () => {
      const app = freshApp('anon');
      await store.put(ctx(app, NS_PROD, VIEWER_1), BOARD, 'k', { a: 1 });
      expect((await store.get(ctx(app, NS_PROD, null), BOARD, 'k'))?.data).toEqual({ a: 1 });
      await expectCode(store.get(ctx(app, NS_PROD, null), PREFS, 'k'), 'sign_in_required');
      await expectCode(store.list(ctx(app, NS_PROD, null), PREFS), 'sign_in_required');
      await expectCode(
        store.put(ctx(app, NS_PROD, null), BOARD, 'k2', { a: 1 }),
        'sign_in_required'
      );
      await expectCode(store.mark(ctx(app, NS_PROD, null), POSTS, 'k', 'vote'), 'sign_in_required');
      await expectCode(
        store.list(ctx(app, NS_PROD, null), BOARD, { author: 'me' }),
        'sign_in_required'
      );
    });
  });

  describe('counters and marks', () => {
    it('a mark is one per user; the count is the number of distinct markers', async () => {
      const app = freshApp('mark');
      await store.put(ctx(app, NS_PROD, VIEWER_1), POSTS, 'k', { status: 'a' });
      expect(await store.mark(ctx(app, NS_PROD, VIEWER_1), POSTS, 'k', 'vote')).toEqual({
        marked: true,
        count: 1,
      });
      expect(await store.mark(ctx(app, NS_PROD, VIEWER_1), POSTS, 'k', 'vote')).toEqual({
        marked: true,
        count: 1,
      });
      expect(await store.mark(ctx(app, NS_PROD, VIEWER_2), POSTS, 'k', 'vote')).toEqual({
        marked: true,
        count: 2,
      });
      expect(await store.mark(ctx(app, NS_PROD, VIEWER_2), POSTS, 'k', 'star')).toEqual({
        marked: true,
        count: 1,
      });
      const asV2 = await store.get(ctx(app, NS_PROD, VIEWER_2), POSTS, 'k');
      expect(asV2?.marks).toEqual({ vote: 2, star: 1 });
      expect(asV2?.viewer).toEqual({ marks: ['star', 'vote'] });
      expect(await store.unmark(ctx(app, NS_PROD, VIEWER_1), POSTS, 'k', 'vote')).toEqual({
        marked: false,
        count: 1,
      });
      expect(await store.unmark(ctx(app, NS_PROD, VIEWER_1), POSTS, 'k', 'vote')).toEqual({
        marked: false,
        count: 1,
      });
      await expectCode(
        store.mark(ctx(app, NS_PROD, VIEWER_1), POSTS, 'k', 'undeclared'),
        'invalid_request'
      );
      await expectCode(
        store.mark(ctx(app, NS_PROD, VIEWER_1), POSTS, 'missing', 'vote'),
        'not_found'
      );
      await expectCode(
        store.mark(ctx(app, NS_PROD, VIEWER_1), PREFS, 'k', 'vote'),
        'invalid_request'
      );
    });

    it('a counter and a mark of the same name are separate tallies', async () => {
      const app = freshApp('sep');
      await store.put(ctx(app, NS_PROD, VIEWER_1), POSTS, 'k', { status: 'a' });
      await store.mark(ctx(app, NS_PROD, VIEWER_2), POSTS, 'k', 'vote');
      expect(await store.increment(ctx(app, NS_PROD, VIEWER_2), POSTS, 'k', 'vote', 100)).toEqual({
        value: 100,
      });
      const doc = await store.get(ctx(app, NS_PROD, VIEWER_2), POSTS, 'k');
      expect(doc?.marks.vote).toBe(1);
      expect(doc?.counters.vote).toBe(100);
    });

    it('report is built in; its count is never exposed', async () => {
      const app = freshApp('report');
      await store.put(ctx(app, NS_PROD, VIEWER_1), POSTS, 'k', { status: 'a' });
      expect(await store.mark(ctx(app, NS_PROD, VIEWER_2), POSTS, 'k', 'report')).toEqual({
        marked: true,
        count: null,
      });
      const doc = await store.get(ctx(app, NS_PROD, VIEWER_2), POSTS, 'k');
      expect(doc?.marks).toEqual({ vote: 0, star: 0 });
      expect(doc?.viewer).toEqual({ marks: ['report'] });
      await expectCode(
        store.list(ctx(app, NS_PROD, VIEWER_2), POSTS, { sort: '-mark:report' }),
        'index_not_declared'
      );
    });

    it('a counter declared after a doc was created sorts it as 0 straight away', async () => {
      const app = freshApp('latedecl');
      const before: DocCollection = {
        name: 'late',
        config: decl({ visibility: 'shared', write: 'own' }),
      };
      const after: DocCollection = {
        name: 'late',
        config: decl({ visibility: 'shared', write: 'own', counters: ['hits'] }),
      };
      const v1 = ctx(app, NS_PROD, VIEWER_1);
      await store.put(v1, before, 'old', { a: 1 });
      await store.put(v1, after, 'new', { a: 1 });
      await store.increment(v1, after, 'new', 'hits');
      const keys = async () =>
        (await store.list(v1, after, { sort: '-counter:hits' })).items.map((d) => d.key);
      expect(await keys()).toEqual(['new', 'old']);
      expect((await store.get(v1, after, 'old'))?.counters).toEqual({ hits: 0 });
    });

    it('report stays unexposed even when a collection declares it as a mark', async () => {
      const app = freshApp('report_decl');
      const coll: DocCollection = {
        name: 'flagged',
        config: decl({ visibility: 'shared', write: 'own', marks: ['vote', 'report'] }),
      };
      await store.put(ctx(app, NS_PROD, VIEWER_1), coll, 'k', { a: 1 });
      await store.mark(ctx(app, NS_PROD, VIEWER_2), coll, 'k', 'report');
      const doc = await store.get(ctx(app, NS_PROD, VIEWER_1), coll, 'k');
      expect(doc?.marks).toEqual({ vote: 0 });
      await expectCode(
        store.list(ctx(app, NS_PROD, VIEWER_1), coll, { sort: '-mark:report' }),
        'index_not_declared'
      );
    });

    it('increment takes 1..100 on an existing doc and a declared counter only', async () => {
      const app = freshApp('inc');
      await store.put(ctx(app, NS_PROD, VIEWER_1), POSTS, 'k', { status: 'a' });
      await expectCode(
        store.increment(ctx(app, NS_PROD, VIEWER_1), POSTS, 'k', 'views', 0),
        'invalid_request'
      );
      await expectCode(
        store.increment(ctx(app, NS_PROD, VIEWER_1), POSTS, 'k', 'views', 101),
        'invalid_request'
      );
      await expectCode(
        store.increment(ctx(app, NS_PROD, VIEWER_1), POSTS, 'k', 'nope'),
        'invalid_request'
      );
      await expectCode(
        store.increment(ctx(app, NS_PROD, VIEWER_1), POSTS, 'bad key!', 'views'),
        'invalid_request'
      );
      await expectCode(
        store.increment(ctx(app, NS_PROD, VIEWER_1), PREFS, 'k', 'views'),
        'invalid_request'
      );
      expect(await store.increment(ctx(app, NS_PROD, VIEWER_1), POSTS, 'k', 'views')).toEqual({
        value: 1,
      });
      expect(await store.increment(ctx(app, NS_PROD, VIEWER_1), POSTS, 'k', 'views', 41)).toEqual({
        value: 42,
      });
    });

    it('deleting a doc deletes its tallies and marks; re-creating starts from zero', async () => {
      const app = freshApp('deltally');
      await store.put(ctx(app, NS_PROD, VIEWER_1), POSTS, 'k', { status: 'a' });
      await store.mark(ctx(app, NS_PROD, VIEWER_2), POSTS, 'k', 'vote');
      await store.increment(ctx(app, NS_PROD, VIEWER_2), POSTS, 'k', 'views', 5);
      await store.delete(ctx(app, NS_PROD, VIEWER_1), POSTS, 'k');
      expect(await h.raw(`SELECT 1 FROM appdata.doc_tally WHERE app_id = $1`, [app])).toEqual([]);
      expect(await h.raw(`SELECT 1 FROM appdata.doc_mark WHERE app_id = $1`, [app])).toEqual([]);
      const fresh = await store.put(ctx(app, NS_PROD, VIEWER_1), POSTS, 'k', { status: 'a' });
      expect(fresh.counters).toEqual({ vote: 0, views: 0 });
      expect(fresh.marks).toEqual({ vote: 0, star: 0 });
    });
  });

  describe('create on first increment', () => {
    it('creates an empty, unowned version-1 doc, charged to its creator like any create; later increments only count', async () => {
      const app = freshApp('ctrcreate');
      const v1 = ctx(app, NS_PROD, VIEWER_1);
      expect(await store.increment(v1, TALLIES, 'col-9', 'plays', 4)).toEqual({ value: 4 });
      const doc = await store.get(ctx(app, NS_PROD, VIEWER_2), TALLIES, 'col-9');
      expect(doc).toMatchObject({
        key: 'col-9',
        data: {},
        version: 1,
        counters: { plays: 4 },
      });
      expect(doc?.author).toEqual({ kind: 'counter' });
      expect(await store.increment(ctx(app, NS_PROD, VIEWER_2), TALLIES, 'col-9', 'plays')).toEqual(
        { value: 5 }
      );
      expect((await store.get(v1, TALLIES, 'col-9'))?.version).toBe(1);
      const [u] = await h.raw(
        `SELECT bytes, docs, last_seq FROM appdata.usage_app WHERE app_id = $1`,
        [app]
      );
      // `{}` is 2 bytes of jsonb text; one create took one seq; the increment took none.
      expect({ bytes: Number(u.bytes), docs: Number(u.docs), seq: Number(u.last_seq) }).toEqual({
        bytes: 2,
        docs: 1,
        seq: 1,
      });
      // The creating incrementer is charged like any creator; the second incrementer is not.
      const users = await h.raw(
        `SELECT user_id, bytes, docs FROM appdata.usage_user WHERE app_id = $1`,
        [app]
      );
      expect(users.map((r) => [r.user_id, Number(r.bytes), Number(r.docs)])).toEqual([
        [VIEWER_1, 2, 1],
      ]);
      await assertUsageConsistent(h, app, NS_PROD);
      await expectCode(store.increment(v1, TALLIES, 'k'.repeat(129), 'plays'), 'invalid_request');
      await expectCode(
        store.increment(ctx(app, NS_PROD, null), TALLIES, 'col-10', 'plays'),
        'sign_in_required'
      );
    });

    it('write: none refuses every document write, but not increments', async () => {
      const app = freshApp('none');
      const v1 = ctx(app, NS_PROD, VIEWER_1);
      await store.increment(v1, TALLIES, 'k', 'plays');
      await expectCode(store.put(v1, TALLIES, 'k', { a: 1 }), 'write_policy');
      await expectCode(store.put(v1, TALLIES, 'k2', { a: 1 }), 'write_policy');
      await expectCode(store.create(v1, TALLIES, { a: 1 }), 'write_policy');
      await expectCode(store.delete(v1, TALLIES, 'k'), 'write_policy');
    });

    it('under write: own an increment on an absent key is not_found — nobody squats keys by counting', async () => {
      const app = freshApp('squat');
      const v1 = ctx(app, NS_PROD, VIEWER_1);
      await expectCode(store.increment(v1, POSTS, 'squatted', 'views'), 'not_found');
      expect(await h.raw(`SELECT 1 FROM appdata.doc WHERE app_id = $1`, [app])).toEqual([]);
      // The key stays free for its real author.
      expect(
        (await store.put(ctx(app, NS_PROD, VIEWER_2), POSTS, 'squatted', { status: 'mine' })).author
      ).toEqual({
        kind: 'user',
        uid: VIEWER_2,
        isViewer: true,
      });
    });

    it('a counter-created doc is never owned: author=me never lists it, and own never lets anyone edit it', async () => {
      const app = freshApp('ctrown');
      const v1 = ctx(app, NS_PROD, VIEWER_1);
      await store.increment(v1, TALLIES, 'counted', 'plays');
      // The same collection later declared `own`: its counter docs stay unowned.
      const flipped: DocCollection = {
        name: TALLIES.name,
        config: decl({ visibility: 'shared', write: 'own', counters: ['plays'] }),
      };
      await store.put(v1, flipped, 'mine', { a: 1 });
      const keys = (q: Parameters<DocStore['list']>[2]) =>
        store.list(v1, flipped, q).then((r) => r.items.map((d) => d.key));
      expect(await keys({})).toEqual(['counted', 'mine']);
      expect(await keys({ author: 'me' })).toEqual(['mine']);
      await expectCode(store.put(v1, flipped, 'counted', { a: 2 }), 'not_author');
      await expectCode(store.put(v1, flipped, 'counted', { a: 2 }, { ifVersion: 1 }), 'not_author');
      await expectCode(store.delete(v1, flipped, 'counted'), 'not_author');
      expect((await store.get(v1, flipped, 'counted'))?.author).toEqual({ kind: 'counter' });
    });

    it("the create is charged to the incrementer's own ceiling", async () => {
      const app = freshApp('ctruser');
      const tight = createDocStore({
        db: h.db,
        limits: { appBytes: 10_000, appDocs: 100, userBytes: 10_000, userDocs: 2 },
      });
      const v1 = ctx(app, NS_PROD, VIEWER_1);
      await tight.increment(v1, TALLIES, 'a', 'plays');
      await tight.increment(v1, TALLIES, 'b', 'plays');
      const err = await expectCode(tight.increment(v1, TALLIES, 'c', 'plays'), 'quota_exceeded');
      expect(err.details).toEqual({ ceiling: 'viewer' });
      expect(await tight.increment(ctx(app, NS_PROD, VIEWER_2), TALLIES, 'c', 'plays')).toEqual({
        value: 1,
      });
      await assertUsageConsistent(h, app, NS_PROD);
    });

    it('owner collections gain no documents from increments', async () => {
      const app = freshApp('ctrpolicy');
      await expectCode(
        store.increment(ctx(app, NS_PROD, VIEWER_1), PLAYS, 'absent', 'plays'),
        'not_found'
      );
      expect(await h.raw(`SELECT 1 FROM appdata.doc WHERE app_id = $1`, [app])).toEqual([]);
    });

    it('the create is refused by the app quota; an existing doc still counts', async () => {
      const app = freshApp('ctrquota');
      const v1 = ctx(app, NS_PROD, VIEWER_1);
      const tight = createDocStore({
        db: h.db,
        limits: { appBytes: 10_000, appDocs: 1, userBytes: 10_000, userDocs: 10 },
      });
      await tight.increment(v1, TALLIES, 'first', 'plays');
      const err = await expectCode(
        tight.increment(v1, TALLIES, 'second', 'plays'),
        'quota_exceeded'
      );
      expect(err.details).toEqual({ ceiling: 'app' });
      expect(await tight.get(v1, TALLIES, 'second')).toBeNull();
      expect(await tight.increment(v1, TALLIES, 'first', 'plays', 9)).toEqual({ value: 10 });
      await assertUsageConsistent(h, app, NS_PROD);
    });

    it('a hidden key stays not found', async () => {
      const app = freshApp('ctrhidden');
      const v1 = ctx(app, NS_PROD, VIEWER_1);
      await store.increment(v1, TALLIES, 'h', 'plays', 3);
      await h.raw(`UPDATE appdata.doc SET hidden_at = now() WHERE app_id = $1 AND key = 'h'`, [
        app,
      ]);
      await expectCode(store.increment(v1, TALLIES, 'h', 'plays'), 'not_found');
      await assertUsageConsistent(h, app, NS_PROD);
    });
  });

  describe('list', () => {
    let app: string;
    const keys = ['a-1', 'a-2', 'b-1', 'b-2', 'c-1'];
    beforeAll(async () => {
      app = freshApp('list');
      // Created in key order, one viewer per parity, statuses and scores distinct.
      const rows: [string, Record<string, unknown>, number][] = [
        [
          'a-1',
          { status: 'open', score: 30, meta: { tag: 'x' }, at: '2026-01-03T00:00:00Z' },
          VIEWER_1,
        ],
        [
          'a-2',
          { status: 'done', score: 10, meta: { tag: 'y' }, at: '2026-01-01T00:00:00Z' },
          VIEWER_2,
        ],
        [
          'b-1',
          { status: 'open', score: 50, meta: { tag: 'y' }, at: '2026-01-05T00:00:00Z' },
          VIEWER_1,
        ],
        ['b-2', { status: 'open', score: 20, at: '2026-01-02T00:00:00Z' }, VIEWER_2],
        ['c-1', { status: 'done', score: 40, meta: { tag: 'x' } }, VIEWER_1],
      ];
      for (const [key, data, v] of rows) await store.put(ctx(app, NS_PROD, v), POSTS, key, data);
      await store.mark(ctx(app, NS_PROD, VIEWER_2), POSTS, 'b-1', 'vote');
      await store.mark(ctx(app, NS_PROD, VIEWER_1), POSTS, 'b-1', 'vote');
      await store.mark(ctx(app, NS_PROD, VIEWER_2), POSTS, 'c-1', 'vote');
      await store.increment(ctx(app, NS_PROD, VIEWER_1), POSTS, 'a-2', 'views', 9);
    });
    const ks = (r: { items: { key: string }[] }) => r.items.map((d) => d.key);
    const me = (v: number | null = VIEWER_1) => ctx(app, NS_PROD, v);

    it('createdAt and updatedAt order by time, not by key', async () => {
      const app2 = freshApp('times');
      const who = ctx(app2, NS_PROD, VIEWER_1);
      for (const k of ['zz', 'aa', 'mm']) await store.put(who, BOARD, k, { k });
      await store.put(who, BOARD, 'zz', { k: 'again' });
      expect(ks(await store.list(who, BOARD, { sort: 'createdAt' }))).toEqual(['zz', 'aa', 'mm']);
      expect(ks(await store.list(who, BOARD, { sort: '-createdAt' }))).toEqual(['mm', 'aa', 'zz']);
      expect(ks(await store.list(who, BOARD, { sort: 'updatedAt' }))).toEqual(['aa', 'mm', 'zz']);
      const page1 = await store.list(who, BOARD, { sort: 'createdAt', limit: 2 });
      const page2 = await store.list(who, BOARD, {
        sort: 'createdAt',
        limit: 2,
        cursor: page1.nextCursor!,
      });
      expect([...ks(page1), ...ks(page2)]).toEqual(['zz', 'aa', 'mm']);
    });

    it('rewriting a doc moves, changes and drops its index rows', async () => {
      const app2 = freshApp('reindex');
      const who = ctx(app2, NS_PROD, VIEWER_1);
      await store.put(who, POSTS, 'k', { status: 'open', score: 5, meta: { tag: 'x' } });
      await store.put(who, POSTS, 'k', { status: 'done', meta: { tag: 'x' } });
      expect(ks(await store.list(who, POSTS, { where: { status: 'open' } }))).toEqual([]);
      expect(ks(await store.list(who, POSTS, { where: { status: 'done' } }))).toEqual(['k']);
      expect(ks(await store.list(who, POSTS, { sort: 'score' }))).toEqual([]);
      const rows = await h.raw(
        `SELECT name FROM appdata.doc_index WHERE app_id = $1 ORDER BY name`,
        [app2]
      );
      expect(rows.map((r) => r.name)).toEqual(['meta.tag', 'status']);
      await expectCode(store.put(who, POSTS, 'k', { status: 7 }), 'invalid_request');
      const t = await store.put(who, POSTS, 't', { at: 1767225600000 });
      expect(t.version).toBe(1);
      expect(
        ks(
          await store.list(who, POSTS, {
            sort: 'at',
            where: { at: '2026-01-01T00:00:00Z' },
          })
        )
      ).toEqual(['t']);
    });

    it('built-in sorts', async () => {
      expect(ks(await store.list(me(), POSTS))).toEqual(keys);
      expect(ks(await store.list(me(), POSTS, { sort: '-key' }))).toEqual([...keys].reverse());
      expect(ks(await store.list(me(), POSTS, { sort: 'createdAt' }))).toEqual(keys);
      expect(ks(await store.list(me(), POSTS, { sort: '-updatedAt' }))).toEqual(
        [...keys].reverse()
      );
    });

    it('pages through every sort with a cursor and no duplicates or gaps', async () => {
      for (const sort of [
        'key',
        '-key',
        'createdAt',
        '-createdAt',
        'score',
        '-score',
        'status',
        'mark:vote',
        '-counter:views',
        'at',
      ]) {
        const all = ks(await store.list(me(), POSTS, { sort, limit: 100 }));
        const paged: string[] = [];
        let cursor: string | undefined;
        for (let i = 0; i < 10; i++) {
          const page = await store.list(me(), POSTS, { sort, limit: 2, cursor });
          paged.push(...ks(page));
          if (!page.nextCursor) break;
          cursor = page.nextCursor;
        }
        expect({ sort, paged }).toEqual({ sort, paged: all });
      }
    });

    it('index sorts list only docs holding the value, in value order', async () => {
      expect(ks(await store.list(me(), POSTS, { sort: 'score' }))).toEqual([
        'a-2',
        'b-2',
        'a-1',
        'c-1',
        'b-1',
      ]);
      expect(ks(await store.list(me(), POSTS, { sort: '-score' }))).toEqual([
        'b-1',
        'c-1',
        'a-1',
        'b-2',
        'a-2',
      ]);
      expect(ks(await store.list(me(), POSTS, { sort: 'at' }))).toEqual([
        'a-2',
        'b-2',
        'a-1',
        'b-1',
      ]);
      expect(ks(await store.list(me(), POSTS, { sort: 'meta.tag' }))).toEqual([
        'a-1',
        'c-1',
        'a-2',
        'b-1',
      ]);
    });

    it('sorts by a mark or counter, absent tallies as 0, key as tiebreak', async () => {
      expect(ks(await store.list(me(), POSTS, { sort: '-mark:vote' }))).toEqual([
        'b-1',
        'c-1',
        'b-2',
        'a-2',
        'a-1',
      ]);
      expect(ks(await store.list(me(), POSTS, { sort: '-counter:views', limit: 2 }))).toEqual([
        'a-2',
        'c-1',
      ]);
    });

    it('filters: equality on one declared index', async () => {
      expect(ks(await store.list(me(), POSTS, { where: { status: 'open' } }))).toEqual([
        'a-1',
        'b-1',
        'b-2',
      ]);
      expect(ks(await store.list(me(), POSTS, { where: { 'meta.tag': 'y' } }))).toEqual([
        'a-2',
        'b-1',
      ]);
      expect(ks(await store.list(me(), POSTS, { where: { score: 20 } }))).toEqual(['b-2']);
      expect(
        ks(await store.list(me(), POSTS, { where: { status: 'open' }, sort: '-score' }))
      ).toEqual(['b-1', 'a-1', 'b-2']);
      await expectCode(
        store.list(me(), POSTS, { where: { status: 'open', 'meta.tag': 'y' } }),
        'invalid_request'
      );
      await expectCode(store.list(me(), POSTS, { where: { title: 'x' } }), 'index_not_declared');
      await expectCode(store.list(me(), POSTS, { sort: 'title' }), 'index_not_declared');
      await expectCode(store.list(me(), POSTS, { where: { score: 'high' } }), 'invalid_request');
    });

    it('range and prefix filters are not supported', async () => {
      const where = { score: { gte: 20 } } as unknown as Record<string, number>;
      await expectCode(store.list(me(), POSTS, { sort: 'score', where }), 'invalid_request');
    });

    it('filters: author=me, markedBy=me, keyPrefix, and all at once', async () => {
      expect(ks(await store.list(me(VIEWER_2), POSTS, { author: 'me' }))).toEqual(['a-2', 'b-2']);
      expect(ks(await store.list(me(VIEWER_2), POSTS, { markedBy: 'me', mark: 'vote' }))).toEqual([
        'b-1',
        'c-1',
      ]);
      expect(ks(await store.list(me(), POSTS, { keyPrefix: 'b-' }))).toEqual(['b-1', 'b-2']);
      expect(
        ks(
          await store.list(me(VIEWER_2), POSTS, {
            keyPrefix: 'b',
            markedBy: 'me',
            mark: 'vote',
            where: { status: 'open' },
            sort: '-score',
          })
        )
      ).toEqual(['b-1']);
      await expectCode(store.list(me(), POSTS, { markedBy: 'me' }), 'invalid_request');
      await expectCode(store.list(me(), POSTS, { keyPrefix: 'bad prefix' }), 'invalid_request');
    });

    it('a field named after an Object.prototype member is undeclared, not a crash or an empty list', async () => {
      for (const field of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
        await expectCode(
          store.list(me(), POSTS, { where: { [field]: 'x' } }),
          'index_not_declared'
        );
        await expectCode(store.list(me(), POSTS, { sort: field }), 'index_not_declared');
      }
    });

    it('a cursor whose bigint payload was edited to a non-integer is an invalid cursor, not a database error', async () => {
      for (const sort of ['createdAt', '-mark:vote']) {
        const first = await store.list(me(), POSTS, { sort, limit: 1 });
        const parts = first.nextCursor!.split('~');
        for (const payload of [
          '1.5',
          '1e3',
          '-1',
          '9999999999999999999',
          '99999999999999999999999',
        ]) {
          const edited = [parts[0], payload, parts[2]].join('~');
          await expectCode(
            store.list(me(), POSTS, { sort, limit: 1, cursor: edited }),
            'invalid_request'
          );
        }
      }
    });

    it('refuses a cursor from another sort or direction, a malformed one, or an oversized one', async () => {
      const first = await store.list(me(), POSTS, { sort: 'score', limit: 1 });
      expect(first.nextCursor).not.toBeNull();
      await expectCode(
        store.list(me(), POSTS, { sort: '-score', cursor: first.nextCursor! }),
        'invalid_request'
      );
      await expectCode(
        store.list(me(), POSTS, { sort: 'createdAt', cursor: first.nextCursor! }),
        'invalid_request'
      );
      await expectCode(
        store.list(me(), POSTS, { sort: 'score', cursor: `${first.nextCursor!}~extra` }),
        'invalid_request'
      );
      await expectCode(
        store.list(me(), POSTS, { sort: 'score', cursor: 'no-separators' }),
        'invalid_request'
      );
      await expectCode(
        store.list(me(), POSTS, { sort: 'score', cursor: 'x'.repeat(513) }),
        'invalid_request'
      );
    });
  });

  describe('index rows across declaration changes and viewers', () => {
    it('re-declaring number → boolean or number → time never mixes the old rows into filters or sorts', async () => {
      await assertNumericRetypeIsolated(store, freshApp('numretype'));
    });

    it('an index whose type changed sorts only rows of the declared type, paging both ways', async () => {
      const app = freshApp('retyped');
      const v1 = ctx(app, NS_PROD, VIEWER_1);
      const asNumber: DocCollection = {
        name: 'retyped',
        config: decl({ visibility: 'shared', indexes: { rank: 'number' } }),
      };
      const asString: DocCollection = {
        name: 'retyped',
        config: decl({ visibility: 'shared', indexes: { rank: 'string' } }),
      };
      for (const [k, r] of [
        ['n1', 3],
        ['n2', 1],
        ['n3', 2],
      ] as const) {
        await store.put(v1, asNumber, k, { rank: r });
      }
      for (const [k, r] of [
        ['s1', 'b'],
        ['s2', 'a'],
        ['s3', 'c'],
      ] as const) {
        await store.put(v1, asString, k, { rank: r });
      }
      for (const [sort, want] of [
        ['rank', ['s2', 's1', 's3']],
        ['-rank', ['s3', 's1', 's2']],
      ] as const) {
        const paged: string[] = [];
        let cursor: string | undefined;
        for (let i = 0; i < 10; i++) {
          const page = await store.list(v1, asString, { sort, limit: 1, cursor });
          paged.push(...page.items.map((d) => d.key));
          if (!page.nextCursor) break;
          cursor = page.nextCursor;
        }
        expect({ sort, paged }).toEqual({ sort, paged: [...want] });
      }
    });

    it('declare → write → undeclare → rewrite → redeclare never serves a value from before the undeclare', async () => {
      const app = freshApp('redeclare');
      const v1 = ctx(app, NS_PROD, VIEWER_1);
      const declared: DocCollection = {
        name: 'redecl',
        config: decl({ visibility: 'shared', indexes: { status: 'string' } }),
      };
      const undeclared: DocCollection = { name: 'redecl', config: decl({ visibility: 'shared' }) };
      await store.put(v1, declared, 'k', { status: 'open' });
      await store.put(v1, undeclared, 'k', { status: 'closed' });
      expect(await h.raw(`SELECT 1 FROM appdata.doc_index WHERE app_id = $1`, [app])).toEqual([]);
      const open = await store.list(v1, declared, { where: { status: 'open' } });
      expect(open.items.map((d) => d.key)).toEqual([]);
    });

    it('private collections: two viewers with the same key and different index values each see their own', async () => {
      const app = freshApp('prividx');
      const coll: DocCollection = {
        name: 'notes',
        config: decl({ visibility: 'private', indexes: { tag: 'string' } }),
      };
      const v1 = ctx(app, NS_PROD, VIEWER_1);
      const v2 = ctx(app, NS_PROD, VIEWER_2);
      await store.put(v1, coll, 'k', { tag: 'mine-1' });
      await store.put(v2, coll, 'k', { tag: 'mine-2' });
      const keysData = async (c: DocStoreContext, q: Parameters<DocStore['list']>[2]) =>
        (await store.list(c, coll, q)).items.map((d) => [d.key, d.data]);
      expect(await keysData(v1, { where: { tag: 'mine-1' } })).toEqual([['k', { tag: 'mine-1' }]]);
      expect(await keysData(v1, { where: { tag: 'mine-2' } })).toEqual([]);
      expect(await keysData(v2, { where: { tag: 'mine-2' } })).toEqual([['k', { tag: 'mine-2' }]]);
      expect(await keysData(v2, { where: { tag: 'mine-1' } })).toEqual([]);
      expect(await keysData(v1, { sort: 'tag' })).toEqual([['k', { tag: 'mine-1' }]]);
      expect(await keysData(v2, { sort: '-tag' })).toEqual([['k', { tag: 'mine-2' }]]);
    });
  });

  describe('cursor bound at the maximum key and index value lengths', () => {
    it('round-trips 128-char keys and 128-byte multi-byte index values; every cursor ≤ 512', async () => {
      const app = freshApp('cursor');
      const coll: DocCollection = {
        name: 'wide',
        config: decl({ visibility: 'shared', write: 'own', indexes: { label: 'string' } }),
      };
      // 128 bytes each: 3-byte chars, 4-byte chars (surrogate pairs in JS), mixed.
      const labels = [
        '€'.repeat(42) + 'ab',
        '😀'.repeat(32),
        'é'.repeat(64),
        '中'.repeat(42) + 'z' + 'y',
        '\u0001'.repeat(128),
      ];
      for (const l of labels) expect(Buffer.byteLength(l, 'utf8')).toBe(128);
      const docs = labels.map((label, i) => ({
        key: `${String.fromCharCode(97 + i)}`.repeat(128),
        label,
      }));
      for (const d of docs)
        await store.put(ctx(app, NS_PROD, VIEWER_1), coll, d.key, { label: d.label });
      const expected = [...docs]
        .sort((x, y) => Buffer.compare(Buffer.from(x.label), Buffer.from(y.label)))
        .map((d) => d.key);
      const paged: string[] = [];
      const cursors: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 10; i++) {
        const page = await store.list(ctx(app, NS_PROD, VIEWER_1), coll, {
          sort: 'label',
          limit: 1,
          cursor,
        });
        paged.push(...page.items.map((d) => d.key));
        if (!page.nextCursor) break;
        cursors.push(page.nextCursor);
        cursor = page.nextCursor;
      }
      expect(paged).toEqual(expected);
      expect(cursors).toHaveLength(4);
      // The designed worst case: 2-char head, '~', 171 base64url chars, '~', 128-char key.
      for (const c of cursors) expect(c.length).toBe(303);
      await expectCode(
        store.put(ctx(app, NS_PROD, VIEWER_1), coll, 'k', { label: 'x'.repeat(129) }),
        'invalid_request'
      );
      await expectCode(
        store.put(ctx(app, NS_PROD, VIEWER_1), coll, 'k'.repeat(129), { label: 'x' }),
        'invalid_request'
      );
    });
  });

  describe('quota (sequential)', () => {
    it('refuses the shared write that would cross the app ceiling, and a delete or shrink always passes', async () => {
      const app = freshApp('quota');
      // `{"p": "xxxxxxxxxx"}` is 19 bytes of jsonb text; 3 fit under 60, a 4th does not.
      const tight = createDocStore({
        db: h.db,
        limits: { appBytes: 60, appDocs: 100, userBytes: 1000, userDocs: 100 },
      });
      const me = ctx(app, NS_PROD, VIEWER_1);
      for (const k of ['q1', 'q2', 'q3']) await tight.put(me, BOARD, k, { p: 'xxxxxxxxxx' });
      const err = await expectCode(
        tight.put(me, BOARD, 'q4', { p: 'xxxxxxxxxx' }),
        'quota_exceeded'
      );
      expect(err.details).toEqual({ ceiling: 'app' });
      expect(await tight.get(me, BOARD, 'q4')).toBeNull();
      // Growing an existing doc past the ceiling is refused; shrinking is not.
      // 19 → 23 bytes takes 57 to 61.
      await expectCode(tight.put(me, BOARD, 'q1', { p: 'xxxxxxxxxxxxxx' }), 'quota_exceeded');
      await tight.put(me, BOARD, 'q1', { p: 'x' });
      await tight.delete(me, BOARD, 'q2');
      await tight.put(me, BOARD, 'q4', { p: 'xxxxxxxxxx' });
      await assertUsageConsistent(h, app, NS_PROD);
      const [u] = await h.raw(`SELECT bytes, docs FROM appdata.usage_app WHERE app_id = $1`, [app]);
      expect({ bytes: Number(u.bytes), docs: Number(u.docs) }).toEqual({ bytes: 48, docs: 3 });
    });

    it('the app ceiling refuses a shared write from a user who has written nothing before', async () => {
      const app = freshApp('quotashared');
      const tight = createDocStore({
        db: h.db,
        limits: { appBytes: 60, appDocs: 100, userBytes: 1000, userDocs: 100 },
      });
      // Three different authors fill the app's shared space; a fourth author is refused by the
      // APP ceiling (their own row is empty), so the refusal is the app's, not theirs.
      for (const uid of [301, 302, 303]) {
        await tight.put(ctx(app, NS_PROD, uid), BOARD, `n${uid}`, { p: 'xxxxxxxxxx' });
      }
      const err = await expectCode(
        tight.put(ctx(app, NS_PROD, 304), BOARD, 'n304', { p: 'xxxxxxxxxx' }),
        'quota_exceeded'
      );
      expect(err.details).toEqual({ ceiling: 'app' });
      // The doc-count side of the app ceiling binds shared documents too.
      const fewDocs = createDocStore({
        db: h.db,
        limits: { appBytes: 10_000, appDocs: 3, userBytes: 1000, userDocs: 100 },
      });
      const docsErr = await expectCode(
        fewDocs.put(ctx(app, NS_PROD, 304), BOARD, 'n304', { p: 'x' }),
        'quota_exceeded'
      );
      expect(docsErr.details).toEqual({ ceiling: 'app' });
      await assertUsageConsistent(h, app, NS_PROD);
    });

    it('private documents are charged to the viewer only: 26 viewers at their own ceiling never fill the app', async () => {
      const app = freshApp('privnoapp');
      // 25 viewers' worth of the per-viewer ceiling (25 × 38 bytes) is the app's whole byte
      // ceiling, and 26 viewers' private docs (52) are over its doc ceiling. Were private docs
      // charged to the app, the 26th viewer's first private write would already be refused.
      const tight = createDocStore({
        db: h.db,
        limits: { appBytes: 950, appDocs: 51, userBytes: 40, userDocs: 10 },
      });
      const DOC19 = { p: 'xxxxxxxxxx' }; // 19 bytes of jsonb text
      const fillers = Array.from({ length: 26 }, (_, i) => 1001 + i);
      for (const uid of fillers) {
        const v = ctx(app, NS_PROD, uid);
        await tight.put(v, PREFS, 'a', DOC19);
        await tight.put(v, PREFS, 'b', DOC19);
        // Each filler is at its OWN ceiling (38 of 40): the next private write is the viewer's.
        const own = await expectCode(tight.put(v, PREFS, 'c', DOC19), 'quota_exceeded');
        expect(own.details).toEqual({ ceiling: 'viewer' });
      }
      // The 27th viewer: a private write and a shared write both land.
      const late = ctx(app, NS_PROD, 1027);
      expect((await tight.put(late, PREFS, 'mine', DOC19)).version).toBe(1);
      expect((await tight.put(late, BOARD, 'shared', DOC19)).version).toBe(1);

      const [u] = await h.raw(
        `SELECT bytes, docs, last_seq FROM appdata.usage_app WHERE app_id = $1 AND ns = $2`,
        [app, NS_PROD]
      );
      // Shared only: one 19-byte doc. Every landed write still took a seq: 26 × 2 private, then
      // 1 private + 1 shared by the 27th viewer (a refused write takes none).
      expect({ bytes: Number(u.bytes), docs: Number(u.docs), seq: Number(u.last_seq) }).toEqual({
        bytes: 19,
        docs: 1,
        seq: 54,
      });
      // What `info()` reports: `app` is the shared data; `viewer` is everything the viewer holds.
      expect(await tight.usage(late)).toEqual({
        app: { bytes: 19, docs: 1 },
        viewer: { bytes: 38, docs: 2 },
      });
      await assertUsageConsistent(h, app, NS_PROD);
    });

    it('a collection whose visibility changes between manifest versions: each document stays charged by the key space it was written in', async () => {
      const app = freshApp('visflip');
      const asPrivate: DocCollection = { name: 'flip', config: decl({ visibility: 'private' }) };
      const asShared: DocCollection = {
        name: 'flip',
        config: decl({ visibility: 'shared', write: 'own' }),
      };
      const me = ctx(app, NS_PROD, VIEWER_1);
      await store.put(me, asPrivate, 'p', { p: 'xxxxxxxxxx' }); // 19, private key space
      // Redeclared shared: the private document is not in the shared key space and stays charged
      // to its viewer only; a new shared write is charged to the app and the author.
      expect(await store.get(me, asShared, 'p')).toBeNull();
      await store.put(me, asShared, 's', { p: 'x' }); // 10, shared key space
      expect(await store.usage(me)).toEqual({
        app: { bytes: 10, docs: 1 },
        viewer: { bytes: 29, docs: 2 },
      });
      // Redeclared private again: the shared document stays on the app's ceiling.
      expect(await store.get(me, asPrivate, 's')).toBeNull();
      expect(await store.delete(me, asPrivate, 'p')).toEqual({ deleted: true });
      expect(await store.usage(me)).toEqual({
        app: { bytes: 10, docs: 1 },
        viewer: { bytes: 10, docs: 1 },
      });
      await assertUsageConsistent(h, app, NS_PROD);
    });

    it('a private delete refunds the viewer and leaves the app untouched, and still takes a seq', async () => {
      const app = freshApp('privdel');
      const me = ctx(app, NS_PROD, VIEWER_1);
      await store.put(me, BOARD, 's', { p: 'xxxxxxxxxx' });
      await store.put(me, PREFS, 'a', { p: 'xxxxxxxxxx' });
      await store.put(me, PREFS, 'a', { p: 'xxxxxxxxxxxxxx' }); // grows 19 → 23
      // The create and the growth charged the viewer, not the app.
      expect(await store.usage(me)).toEqual({
        app: { bytes: 19, docs: 1 },
        viewer: { bytes: 42, docs: 2 },
      });
      expect(await store.delete(me, PREFS, 'a')).toEqual({ deleted: true });
      const [u] = await h.raw(
        `SELECT bytes, docs, last_seq FROM appdata.usage_app WHERE app_id = $1 AND ns = $2`,
        [app, NS_PROD]
      );
      expect({ bytes: Number(u.bytes), docs: Number(u.docs), seq: Number(u.last_seq) }).toEqual({
        bytes: 19,
        docs: 1,
        seq: 4,
      });
      const tombs = await h.raw(`SELECT key, seq FROM appdata.doc_tomb WHERE app_id = $1`, [app]);
      expect(tombs.map((r) => [r.key, Number(r.seq)])).toEqual([['a', 4]]);
      expect(await store.usage(me)).toEqual({
        app: { bytes: 19, docs: 1 },
        viewer: { bytes: 19, docs: 1 },
      });
      await assertUsageConsistent(h, app, NS_PROD);
    });

    it('a shrink and a delete pass even when usage is already over a lowered ceiling', async () => {
      const app2 = freshApp('lowered');
      const me = ctx(app2, NS_PROD, VIEWER_1);
      for (const k of ['a', 'b', 'c']) await store.put(me, PREFS, k, { p: 'xxxxxxxxxx' }); // 57 bytes
      const lowered = createDocStore({
        db: h.db,
        limits: { appBytes: 20, appDocs: 1, userBytes: 20, userDocs: 1 },
      });
      await expectCode(lowered.put(me, PREFS, 'a', { p: 'xxxxxxxxxxx' }), 'quota_exceeded');
      expect((await lowered.put(me, PREFS, 'a', { p: 'x' })).version).toBe(2);
      expect(await lowered.delete(me, PREFS, 'b')).toEqual({ deleted: true });
      await assertUsageConsistent(h, app2, NS_PROD);
    });

    it('a first write larger than the ceiling is refused (the insert path of the charge)', async () => {
      const tiny = createDocStore({
        db: h.db,
        limits: { appBytes: 5, appDocs: 10, userBytes: 1000, userDocs: 10 },
      });
      const app2 = freshApp('firstwrite');
      await expectCode(
        tiny.put(ctx(app2, NS_PROD, VIEWER_1), BOARD, 'a', { p: 'x' }),
        'quota_exceeded'
      );
      expect(await h.raw(`SELECT 1 FROM appdata.usage_app WHERE app_id = $1`, [app2])).toEqual([]);
      // A first PRIVATE write under the same ceiling lands: it creates the app's row (the seq)
      // with nothing charged to it.
      expect((await tiny.put(ctx(app2, NS_PROD, VIEWER_1), PREFS, 'a', { p: 'x' })).version).toBe(
        1
      );
      const rows = await h.raw(
        `SELECT bytes, docs, last_seq FROM appdata.usage_app WHERE app_id = $1`,
        [app2]
      );
      expect(
        rows.map((r) => ({ bytes: Number(r.bytes), docs: Number(r.docs), seq: Number(r.last_seq) }))
      ).toEqual([{ bytes: 0, docs: 0, seq: 1 }]);
      await assertUsageConsistent(h, app2, NS_PROD);
    });

    it('per-user ceilings: viewer for private docs, author for shared, doc counts too', async () => {
      const app = freshApp('uquota');
      const tight = createDocStore({
        db: h.db,
        limits: { appBytes: 10_000, appDocs: 100, userBytes: 40, userDocs: 2 },
      });
      await tight.put(ctx(app, NS_PROD, VIEWER_1), PREFS, 'a', { p: 'xxxxxxxxxx' });
      await tight.put(ctx(app, NS_PROD, VIEWER_1), PREFS, 'b', { p: 'x' });
      const docs = await expectCode(
        tight.put(ctx(app, NS_PROD, VIEWER_1), PREFS, 'c', { p: 'x' }),
        'quota_exceeded'
      );
      expect(docs.details).toEqual({ ceiling: 'viewer' });
      await tight.put(ctx(app, NS_PROD, VIEWER_2), BOARD, 's', { p: 'xxxxxxxxxx' });
      // Growing a shared doc past its author's ceiling is labelled `author`.
      const author = await expectCode(
        tight.put(ctx(app, NS_PROD, VIEWER_2), BOARD, 's', { p: 'x'.repeat(40) }),
        'quota_exceeded'
      );
      expect(author.details).toEqual({ ceiling: 'author' });
      await assertUsageConsistent(h, app, NS_PROD);
    });
  });

  describe('size, shape and the stored unit', () => {
    it('the cap is exactly 65536 stored bytes, enforced by the database even when the wire size fits', async () => {
      const me = ctx(freshApp('cap'), NS_PROD, VIEWER_1);
      // `{"s": "<n x>"}` is n + 9 bytes stored and n + 8 on the wire.
      const atCap = await store.put(me, PREFS, 'at', { s: 'x'.repeat(65_527) });
      expect(atCap.version).toBe(1);
      const [row] = await h.raw(
        `SELECT size_bytes FROM appdata.doc WHERE key = 'at' AND app_id = $1`,
        [me.appId]
      );
      expect(Number(row.size_bytes)).toBe(65_536);
      // 65,536 on the wire passes the JS pre-check; 65,537 stored fails the CHECK.
      expect(Buffer.byteLength(JSON.stringify({ s: 'x'.repeat(65_528) }))).toBe(65_536);
      await expectCode(store.put(me, PREFS, 'over', { s: 'x'.repeat(65_528) }), 'too_large');
    });

    it('caps a document at 65536 bytes of stored jsonb text, including a payload that only grows once stored', async () => {
      const app = freshApp('size');
      const me = ctx(app, NS_PROD, VIEWER_1);
      await expectCode(store.put(me, PREFS, 'big', { s: 'x'.repeat(70_000) }), 'too_large');
      // 400 × 1e308: ~2.8 KB as JSON, ~124 KB as stored jsonb text (numbers print in full).
      await expectCode(store.put(me, PREFS, 'num', { n: Array(400).fill(1e308) }), 'too_large');
      expect(await store.get(me, PREFS, 'num')).toBeNull();
      await assertUsageConsistent(h, app, NS_PROD);
    });

    it('refuses data Postgres cannot store or that is not a JSON object', async () => {
      const me = ctx(freshApp('shape'), NS_PROD, VIEWER_1);
      let deep: Record<string, unknown> = { leaf: 1 };
      for (let i = 0; i < 16; i++) deep = { d: deep };
      for (const bad of [
        { s: 'a\u0000b' },
        { s: '\ud800' },
        { ['\udc00']: 1 },
        deep,
        [1, 2] as unknown as Record<string, unknown>,
        { d: new Date(0) },
        { u: undefined },
      ]) {
        await expectCode(store.put(me, PREFS, 'k', bad), 'invalid_request');
      }
      let ok: Record<string, unknown> = { leaf: 1 };
      // 15 wraps: the innermost object sits at depth 16, the maximum.
      for (let i = 0; i < 15; i++) ok = { d: ok };
      expect((await store.put(me, PREFS, 'k', ok)).version).toBe(1);
    });
  });

  describe('hidden and expired documents', () => {
    it('a hidden doc is not found by every operation', async () => {
      const app = freshApp('hidden');
      await store.put(ctx(app, NS_PROD, VIEWER_1), POSTS, 'k', { status: 'open' });
      await h.raw(`UPDATE appdata.doc SET hidden_at = now(), hidden_by = 9 WHERE app_id = $1`, [
        app,
      ]);
      const me = ctx(app, NS_PROD, VIEWER_1);
      expect(await store.get(me, POSTS, 'k')).toBeNull();
      expect((await store.list(me, POSTS)).items).toEqual([]);
      expect((await store.list(me, POSTS, { where: { status: 'open' } })).items).toEqual([]);
      await expectCode(store.put(me, POSTS, 'k', { status: 'x' }), 'not_found');
      expect(await store.delete(me, POSTS, 'k')).toEqual({ deleted: false });
      await expectCode(store.mark(me, POSTS, 'k', 'vote'), 'not_found');
      await expectCode(store.increment(me, POSTS, 'k', 'views'), 'not_found');
    });
  });

  describe('seq and tombstones', () => {
    it('a counter-created doc takes a non-zero seq in commit order', async () => {
      const app = freshApp('ctrseq');
      const v1 = ctx(app, NS_PROD, VIEWER_1);
      await store.increment(v1, TALLIES, 'first', 'plays');
      await store.increment(v1, TALLIES, 'second', 'plays');
      await store.increment(v1, TALLIES, 'first', 'plays');
      const rows = await h.raw(`SELECT key, seq FROM appdata.doc WHERE app_id = $1 ORDER BY key`, [
        app,
      ]);
      expect(rows.map((r) => [r.key, Number(r.seq)])).toEqual([
        ['first', 1],
        ['second', 2],
      ]);
    });

    it('every document write and delete takes the next seq of its (app, ns); a delete leaves a tombstone', async () => {
      const app = freshApp('seq');
      const me = ctx(app, NS_PROD, VIEWER_1);
      await store.put(me, PREFS, 'a', { n: 1 });
      await store.put(me, PREFS, 'b', { n: 1 });
      await store.put(me, PREFS, 'a', { n: 2 });
      await store.put(ctx(app, NS_DEV, VIEWER_1), PREFS, 'a', { n: 1 });
      await store.delete(me, PREFS, 'b');
      const seqs = await h.raw(
        `SELECT ns, key, seq FROM appdata.doc WHERE app_id = $1 ORDER BY ns, key`,
        [app]
      );
      expect(seqs.map((r) => [r.ns, r.key, Number(r.seq)])).toEqual([
        [NS_DEV, 'a', 1],
        [NS_PROD, 'a', 3],
      ]);
      const tombs = await h.raw(`SELECT key, seq FROM appdata.doc_tomb WHERE app_id = $1`, [app]);
      expect(tombs.map((r) => [r.key, Number(r.seq)])).toEqual([['b', 4]]);
      const [u] = await h.raw(
        `SELECT last_seq FROM appdata.usage_app WHERE app_id = $1 AND ns = $2`,
        [app, NS_PROD]
      );
      expect(Number(u.last_seq)).toBe(4);
    });
  });

  return {
    harness: () => h,
    store: () => store,
  };
}
