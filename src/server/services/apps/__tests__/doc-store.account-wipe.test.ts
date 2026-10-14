import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  DocStore,
  DocStoreClient,
  DocStoreDb,
  DocStoreMaintenance,
  DocStoreModeration,
} from '~/server/services/apps/doc-store';
import {
  createDocStore,
  createDocStoreMaintenance,
  createDocStoreModeration,
  reviewNamespace,
} from '~/server/services/apps/doc-store';
import type { DocCollection } from '~/server/services/apps/doc-store.types';
import {
  createPgliteHarness,
  createRealPgHarness,
  REAL_PG_URL,
  type Harness,
} from './doc-store.harness';
import {
  assertUsageConsistent,
  BOARD,
  ctx,
  decl,
  expectCode,
  freshApp,
  NS_PROD,
  POSTS,
  PREFS,
  TALLIES,
} from './doc-store.functional';
import { APPDATA_TABLES } from './doc-store.sql-scan';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * Account deletion in the document store (`DocStoreMaintenance.wipeAccount`). Run on the
 * embedded Postgres as `appdata_rw` with row-level security ON (both layers) and OFF (the
 * module's own predicates alone: without RLS a wipe statement that lost its user or namespace key
 * would reach the bystander's rows, and the "untouched" assertions below would see it), and on a
 * real Postgres when `APPDATA_TEST_DATABASE_URL` is set (plus a concurrency case there).
 *
 * Namespaces covered: `prod` (shared by every viewer: only what names the account), the account's
 * own `dev:<uid>` and `rev:<request>:<uid>` (deleted outright), and another user's `dev:<uid>`
 * (untouched). Expected values are literals, never read back from the store under test.
 */

// Pairwise distinct, and distinct from every id and literal the other suites use.
const WIPED = 5_101;
const OTHER = 5_202;
const THIRD = 5_303;

/** A private collection with a declared index, so a private document has index rows to cascade. */
const NOTES: DocCollection = {
  name: 'notes',
  config: decl({ visibility: 'private', indexes: { tag: 'string' } }),
};

/** Every row in every table for one app id (superuser, RLS bypassed), for "untouched" checks. */
async function snapshot(h: Harness, appId: string) {
  const out: Record<string, unknown[]> = {};
  for (const t of APPDATA_TABLES) {
    out[t] = await h.raw(`SELECT * FROM appdata.${t} WHERE app_id = $1 ORDER BY 1, 2, 3, 4, 5`, [
      appId,
    ]);
  }
  return out;
}

/** Every place a user id can be stored, and how many rows still hold `uid` there. */
async function rowsNaming(h: Harness, appId: string, uid: number): Promise<Record<string, number>> {
  const probes: Record<string, string> = {
    'doc.scope_uid': `SELECT count(*)::int AS n FROM appdata.doc WHERE app_id = $1 AND scope_uid = $2`,
    'doc.author_uid': `SELECT count(*)::int AS n FROM appdata.doc WHERE app_id = $1 AND author_uid = $2`,
    'doc.last_writer_uid': `SELECT count(*)::int AS n FROM appdata.doc WHERE app_id = $1 AND last_writer_uid = $2`,
    'doc_index.scope_uid': `SELECT count(*)::int AS n FROM appdata.doc_index WHERE app_id = $1 AND scope_uid = $2`,
    'doc_mark.user_id': `SELECT count(*)::int AS n FROM appdata.doc_mark WHERE app_id = $1 AND user_id = $2`,
    'doc_tomb.scope_uid': `SELECT count(*)::int AS n FROM appdata.doc_tomb WHERE app_id = $1 AND scope_uid = $2`,
    'usage_user.user_id': `SELECT count(*)::int AS n FROM appdata.usage_user WHERE app_id = $1 AND user_id = $2`,
  };
  const out: Record<string, number> = {};
  for (const [k, sql] of Object.entries(probes))
    out[k] = Number((await h.raw(sql, [appId, uid]))[0].n);
  return out;
}
const NAMES_NOBODY = {
  'doc.scope_uid': 0,
  'doc.author_uid': 0,
  'doc.last_writer_uid': 0,
  'doc_index.scope_uid': 0,
  'doc_mark.user_id': 0,
  'doc_tomb.scope_uid': 0,
  'usage_user.user_id': 0,
};

/** Every mark tally equals the number of marks behind it — the decrement and the delete agree. */
async function assertTalliesMatchMarks(h: Harness, appId: string) {
  const rows = await h.raw(
    `SELECT t.ns, t.coll, t.key, t.name, t.count::int AS count,
            (SELECT count(*)::int FROM appdata.doc_mark m WHERE m.app_id = t.app_id AND m.ns = t.ns
               AND m.coll = t.coll AND m.key = t.key AND m.name = t.name) AS marks
       FROM appdata.doc_tally t WHERE t.app_id = $1 AND t.kind = 'mark'`,
    [appId]
  );
  expect(rows.filter((r) => r.count !== r.marks)).toEqual([]);
}

async function rawDoc(h: Harness, appId: string, ns: string, coll: string, key: string) {
  const [row] = await h.raw(
    `SELECT author_kind, author_uid, last_writer_uid, data, version, seq FROM appdata.doc
      WHERE app_id = $1 AND ns = $2 AND coll = $3 AND scope_uid = 0 AND key = $4`,
    [appId, ns, coll, key]
  );
  return row;
}

async function tally(
  h: Harness,
  appId: string,
  coll: string,
  key: string,
  kind: string,
  name: string
) {
  const [row] = await h.raw(
    `SELECT count::int AS n FROM appdata.doc_tally
      WHERE app_id = $1 AND ns = 'prod' AND coll = $2 AND key = $3 AND kind = $4 AND name = $5`,
    [appId, coll, key, kind, name]
  );
  return row ? Number(row.n) : null;
}

/**
 * One user's data in one (app, ns): two private docs (one indexed), a private tombstone, one
 * authored shared post and board note, and one counter-created document.
 */
async function seedUser(store: DocStore, appId: string, ns: string, uid: number, tag: string) {
  const c = ctx(appId, ns, uid);
  await store.put(c, PREFS, 'theme', { mode: tag });
  await store.put(c, NOTES, 'n1', { tag, body: 'private text' });
  await store.put(c, PREFS, 'tmp', { t: 1 });
  await store.delete(c, PREFS, 'tmp');
  await store.put(c, POSTS, `post-${tag}`, { status: 'open', score: 7, meta: { tag } });
  await store.put(c, BOARD, `note-${tag}`, { t: tag });
  await store.increment(c, TALLIES, `game-${tag}`, 'plays', 2);
}

function defineAccountWipeSuite(makeHarness: () => Promise<Harness>) {
  let h: Harness;
  let store: DocStore;
  let maint: DocStoreMaintenance;
  let mod: DocStoreModeration;
  beforeAll(async () => {
    h = await makeHarness();
    store = createDocStore({ db: h.db });
    maint = createDocStoreMaintenance({ db: h.db });
    mod = createDocStoreModeration({ db: h.db });
  });
  afterAll(async () => {
    await h?.close();
  });

  /** WIPED and OTHER in one app's prod, each marking both posts; WIPED stars and reports OTHER's. */
  async function seedProd(tag: string) {
    const app = freshApp(tag);
    await seedUser(store, app, NS_PROD, WIPED, 'w');
    await seedUser(store, app, NS_PROD, OTHER, 'o');
    const w = ctx(app, NS_PROD, WIPED);
    const o = ctx(app, NS_PROD, OTHER);
    for (const c of [w, o]) {
      await store.mark(c, POSTS, 'post-w', 'vote');
      await store.mark(c, POSTS, 'post-o', 'vote');
    }
    await store.mark(w, POSTS, 'post-o', 'star');
    await store.mark(w, POSTS, 'post-o', 'report');
    await store.mark(o, POSTS, 'post-w', 'report');
    // OTHER increments WIPED's counter document: the counts are the documents', not the user's.
    await store.increment(o, TALLIES, 'game-w', 'plays', 3);
    return app;
  }

  describe('a shared namespace (prod): only what names the account', () => {
    it('deletes private docs (index rows, tombstones), anonymises authored shared docs, releases counter docs, removes marks with their tallies, and releases usage — touching nothing of anyone else', async () => {
      const app = await seedProd('WIPEPROD');
      const [usageBefore] = await h.raw(
        `SELECT bytes::int AS bytes, docs FROM appdata.usage_app WHERE app_id = $1 AND ns = 'prod'`,
        [app]
      );
      const [privBefore] = await h.raw(
        `SELECT COALESCE(sum(size_bytes), 0)::int AS bytes, count(*)::int AS docs FROM appdata.doc
          WHERE app_id = $1 AND ns = 'prod' AND scope_uid = $2`,
        [app, WIPED]
      );
      // Positive controls: WIPED is named in every place a user id can live, so "0 after" is real.
      const named = await rowsNaming(h, app, WIPED);
      for (const [k, n] of Object.entries(named))
        expect({ k, named: n > 0 }).toEqual({ k, named: true });
      expect(privBefore.docs).toBe(2);
      expect(await tally(h, app, 'posts', 'post-o', 'mark', 'vote')).toBe(2);
      expect(await tally(h, app, 'posts', 'post-o', 'mark', 'star')).toBe(1);
      expect(await tally(h, app, 'posts', 'post-o', 'mark', 'report')).toBe(1);
      expect(await tally(h, app, 'posts', 'post-w', 'mark', 'vote')).toBe(2);
      const before = {
        otherPrivate: await h.raw(
          `SELECT * FROM appdata.doc WHERE app_id = $1 AND scope_uid = $2 ORDER BY coll, key`,
          [app, OTHER]
        ),
        otherMarks: await h.raw(
          `SELECT coll, key, name, user_id FROM appdata.doc_mark WHERE app_id = $1 AND user_id = $2 ORDER BY 1, 2, 3`,
          [app, OTHER]
        ),
        otherUsage: await h.raw(
          `SELECT bytes, docs FROM appdata.usage_user WHERE app_id = $1 AND user_id = $2`,
          [app, OTHER]
        ),
        postW: await rawDoc(h, app, NS_PROD, 'posts', 'post-w'),
        indexW: await h.raw(
          `SELECT name, v_text, v_num FROM appdata.doc_index WHERE app_id = $1 AND key = 'post-w' ORDER BY name`,
          [app]
        ),
      };

      const out = await maint.wipeAccount(WIPED);
      expect(out).toEqual({
        userId: WIPED,
        failures: [],
        namespaces: [
          {
            appId: app,
            ns: NS_PROD,
            mode: 'user',
            privateDocs: 2,
            privateBytes: privBefore.bytes,
            anonymised: 2,
            counterDocsReleased: 1,
            marks: 4,
            namespaceRows: 0,
          },
        ],
      });

      // Nothing anywhere still holds the account's id.
      expect(await rowsNaming(h, app, WIPED)).toEqual(NAMES_NOBODY);

      // Anonymised: the kind is `deleted`, no uid survives, and the content is untouched.
      const postW = await rawDoc(h, app, NS_PROD, 'posts', 'post-w');
      expect(postW).toEqual({
        ...before.postW,
        author_kind: 'deleted',
        author_uid: null,
        last_writer_uid: null,
      });
      expect((await rawDoc(h, app, NS_PROD, 'board', 'note-w')).author_kind).toBe('deleted');
      expect(
        await h.raw(
          `SELECT name, v_text, v_num FROM appdata.doc_index WHERE app_id = $1 AND key = 'post-w' ORDER BY name`,
          [app]
        )
      ).toEqual(before.indexW);
      // The counter document stays a counter document, with its counts, owned by nobody.
      expect(await rawDoc(h, app, NS_PROD, 'tallies', 'game-w')).toMatchObject({
        author_kind: 'counter',
        author_uid: null,
        last_writer_uid: null,
      });
      expect(await tally(h, app, 'tallies', 'game-w', 'counter', 'plays')).toBe(5);

      // Each tally lost exactly the account's marks.
      expect(await tally(h, app, 'posts', 'post-o', 'mark', 'vote')).toBe(1);
      expect(await tally(h, app, 'posts', 'post-o', 'mark', 'star')).toBe(0);
      expect(await tally(h, app, 'posts', 'post-o', 'mark', 'report')).toBe(0);
      expect(await tally(h, app, 'posts', 'post-w', 'mark', 'vote')).toBe(1);
      expect(await tally(h, app, 'posts', 'post-w', 'mark', 'report')).toBe(1);
      await assertTalliesMatchMarks(h, app);

      // The bystander's private docs, marks and usage row are exactly as they were.
      expect(
        await h.raw(
          `SELECT * FROM appdata.doc WHERE app_id = $1 AND scope_uid = $2 ORDER BY coll, key`,
          [app, OTHER]
        )
      ).toEqual(before.otherPrivate);
      expect(
        await h.raw(
          `SELECT coll, key, name, user_id FROM appdata.doc_mark WHERE app_id = $1 AND user_id = $2 ORDER BY 1, 2, 3`,
          [app, OTHER]
        )
      ).toEqual(before.otherMarks);
      expect(
        await h.raw(
          `SELECT bytes, docs FROM appdata.usage_user WHERE app_id = $1 AND user_id = $2`,
          [app, OTHER]
        )
      ).toEqual(before.otherUsage);
      expect(before.otherUsage).toHaveLength(1);

      // The app's usage lost exactly the deleted documents; it still counts the anonymised ones.
      const [usageAfter] = await h.raw(
        `SELECT bytes::int AS bytes, docs FROM appdata.usage_app WHERE app_id = $1 AND ns = 'prod'`,
        [app]
      );
      expect(usageAfter).toEqual({
        bytes: usageBefore.bytes - privBefore.bytes,
        docs: usageBefore.docs - 2,
      });
      await assertUsageConsistent(h, app, NS_PROD);
    });

    it('readers see a deleted author; `author=me` matches nobody; nobody may edit or delete it; moderators still hide and delete it, refunding the app only', async () => {
      const app = await seedProd('WIPEREAD');
      const w = ctx(app, NS_PROD, WIPED);
      const o = ctx(app, NS_PROD, OTHER);
      const anon = ctx(app, NS_PROD, null);
      // Positive control: before the wipe the account is the author, to itself and to others.
      expect((await store.list(w, POSTS, { author: 'me' })).items.map((d) => d.key)).toEqual([
        'post-w',
      ]);
      expect((await store.get(o, POSTS, 'post-w'))?.author).toEqual({
        kind: 'user',
        uid: WIPED,
        isViewer: false,
      });

      await maint.wipeAccount(WIPED);

      for (const c of [w, o, anon]) {
        const doc = await store.get(c, POSTS, 'post-w');
        expect(doc?.author).toEqual({ kind: 'deleted' });
        expect(doc?.data).toEqual({ status: 'open', score: 7, meta: { tag: 'w' } });
        expect((await store.get(c, TALLIES, 'game-w'))?.author).toEqual({ kind: 'counter' });
      }
      expect(await store.get(o, POSTS, 'post-w')).toMatchObject({
        marks: { vote: 1, star: 0 },
        viewer: { marks: ['report', 'vote'] },
      });
      expect((await store.list(w, POSTS, { author: 'me' })).items).toEqual([]);
      expect((await store.list(w, BOARD, { author: 'me' })).items).toEqual([]);
      expect((await store.list(o, POSTS, { author: 'me' })).items.map((d) => d.key)).toEqual([
        'post-o',
      ]);
      // The account's own private documents are gone; the bystander's are not.
      expect(await store.get(w, PREFS, 'theme')).toBeNull();
      expect(await store.get(o, PREFS, 'theme')).toMatchObject({ data: { mode: 'o' } });

      for (const c of [w, o]) {
        await expectCode(store.put(c, POSTS, 'post-w', { status: 'edited' }), 'not_author');
        await expectCode(store.delete(c, BOARD, 'note-w'), 'not_author');
      }

      // The moderator's queue names a deleted author and carries no uid.
      const reported = await mod.listReported(app, NS_PROD, { status: 'open', limit: 10 });
      expect(reported.find((r) => r.key === 'post-w')).toMatchObject({
        authorKind: 'deleted',
        authorUid: null,
        reports: 1,
      });
      expect(await mod.setHidden(app, NS_PROD, 'posts', 'post-w', true, 9)).toMatchObject({
        changed: true,
      });
      expect(await store.get(o, POSTS, 'post-w')).toBeNull();
      const otherUsage = await store.usage(o);
      await mod.delete(app, NS_PROD, 'board', 'note-w');
      expect(await mod.get(app, NS_PROD, 'board', 'note-w')).toBeNull();
      // Refunded to the app; no user carried it, so the bystander's own usage did not move.
      expect((await store.usage(o)).viewer).toEqual(otherUsage.viewer);
      await assertUsageConsistent(h, app, NS_PROD);
      await assertTalliesMatchMarks(h, app);
    });
  });

  describe('every app and namespace the account has rows in', () => {
    it('handles every app; deletes the account’s own dev and review namespaces outright; leaves another user’s dev namespace alone', async () => {
      const app1 = freshApp('WIPEMULTI1');
      const app2 = freshApp('WIPEMULTI2');
      const markOnly = freshApp('WIPEMULTI3');
      const req = `pubreq_WIPE${app1.slice(-3)}`;
      const ownDev = `dev:${WIPED}`;
      const ownRev = reviewNamespace(req, WIPED);
      const otherDev = `dev:${OTHER}`;
      await seedUser(store, app1, NS_PROD, WIPED, 'w');
      await seedUser(store, app1, NS_PROD, OTHER, 'o');
      await seedUser(store, app2, NS_PROD, WIPED, 'w');
      await seedUser(store, app1, ownDev, WIPED, 'w');
      await seedUser(store, req, ownRev, WIPED, 'w');
      await seedUser(store, app1, otherDev, OTHER, 'o');
      // In this app the account only voted: no usage row, found through its mark.
      await store.put(ctx(markOnly, NS_PROD, OTHER), POSTS, 'p', { status: 'open' });
      await store.mark(ctx(markOnly, NS_PROD, WIPED), POSTS, 'p', 'vote');
      expect(
        await h.raw(`SELECT 1 FROM appdata.usage_user WHERE app_id = $1 AND user_id = $2`, [
          markOnly,
          WIPED,
        ])
      ).toEqual([]);

      const keepOtherDev = await h.raw(
        `SELECT * FROM appdata.doc WHERE app_id = $1 AND ns = $2 ORDER BY coll, scope_uid, key`,
        [app1, otherDev]
      );
      expect(keepOtherDev.length).toBe(5);
      const keepUsageOtherDev = await h.raw(
        `SELECT * FROM appdata.usage_app WHERE app_id = $1 AND ns = $2`,
        [app1, otherDev]
      );

      const out = await maint.wipeAccount(WIPED);
      expect(out.failures).toEqual([]);
      const seen = out.namespaces
        .filter((n) => [app1, app2, markOnly, req].includes(n.appId))
        .map((n) => ({
          appId: n.appId,
          ns: n.ns,
          mode: n.mode,
          marks: n.marks,
          anonymised: n.anonymised,
        }));
      expect(seen).toEqual(
        [
          { appId: app1, ns: ownDev, mode: 'namespace', marks: 0, anonymised: 0 },
          { appId: app1, ns: NS_PROD, mode: 'user', marks: 0, anonymised: 2 },
          { appId: app2, ns: NS_PROD, mode: 'user', marks: 0, anonymised: 2 },
          { appId: markOnly, ns: NS_PROD, mode: 'user', marks: 1, anonymised: 0 },
          { appId: req, ns: ownRev, mode: 'namespace', marks: 0, anonymised: 0 },
        ].sort((a, b) => (a.appId + a.ns < b.appId + b.ns ? -1 : 1))
      );

      // The account's own namespaces: no row of any kind is left.
      for (const [appId, ns] of [
        [app1, ownDev],
        [req, ownRev],
      ]) {
        for (const t of APPDATA_TABLES) {
          const [r] = await h.raw(
            `SELECT count(*)::int AS n FROM appdata.${t} WHERE app_id = $1 AND ns = $2`,
            [appId, ns]
          );
          expect({ ns, t, n: r.n }).toEqual({ ns, t, n: 0 });
        }
      }
      for (const appId of [app1, app2, markOnly, req]) {
        expect({ appId, named: await rowsNaming(h, appId, WIPED) }).toEqual({
          appId,
          named: NAMES_NOBODY,
        });
      }
      // Another user's dev namespace in the same app: untouched.
      expect(
        await h.raw(
          `SELECT * FROM appdata.doc WHERE app_id = $1 AND ns = $2 ORDER BY coll, scope_uid, key`,
          [app1, otherDev]
        )
      ).toEqual(keepOtherDev);
      expect(
        await h.raw(`SELECT * FROM appdata.usage_app WHERE app_id = $1 AND ns = $2`, [
          app1,
          otherDev,
        ])
      ).toEqual(keepUsageOtherDev);
      expect(await tally(h, markOnly, 'posts', 'p', 'mark', 'vote')).toBe(0);
      for (const [appId, ns] of [
        [app1, NS_PROD],
        [app1, otherDev],
        [app2, NS_PROD],
        [markOnly, NS_PROD],
      ]) {
        await assertUsageConsistent(h, appId, ns);
      }
      await assertTalliesMatchMarks(h, markOnly);
    });

    it('leaves every row of an account it was not asked about exactly as it was', async () => {
      const app = await seedProd('WIPEBYSTANDER');
      await seedUser(store, app, NS_PROD, THIRD, 't');
      const thirdRows = async () => ({
        docs: await h.raw(
          `SELECT * FROM appdata.doc WHERE app_id = $1 AND (scope_uid = $2 OR author_uid = $2) ORDER BY coll, key`,
          [app, THIRD]
        ),
        usage: await h.raw(`SELECT * FROM appdata.usage_user WHERE app_id = $1 AND user_id = $2`, [
          app,
          THIRD,
        ]),
      });
      const keep = await thirdRows();
      expect(keep.docs.length).toBe(5);
      await maint.wipeAccount(WIPED);
      expect(await thirdRows()).toEqual(keep);
    });
  });

  describe('idempotent, atomic per namespace, retryable', () => {
    it('a second wipe finds nothing and changes nothing; an account with no rows is a no-op that writes nothing', async () => {
      const app = await seedProd('WIPETWICE');
      expect((await maint.wipeAccount(WIPED)).namespaces.length).toBeGreaterThan(0);
      const after = await snapshot(h, app);
      const again = await maint.wipeAccount(WIPED);
      expect(again).toEqual({ userId: WIPED, namespaces: [], failures: [] });
      expect(await snapshot(h, app)).toEqual(after);

      const nobody = 5_909;
      const appsBefore = await h.raw(`SELECT count(*)::int AS n FROM appdata.usage_app`);
      expect(await maint.wipeAccount(nobody)).toEqual({
        userId: nobody,
        namespaces: [],
        failures: [],
      });
      expect(await h.raw(`SELECT count(*)::int AS n FROM appdata.usage_app`)).toEqual(appsBefore);
    });

    it('a namespace that fails rolls back in full and is reported; the others complete; a re-run finishes it', async () => {
      const good = await seedProd('WIPEATOMA');
      const bad = await seedProd('WIPEATOMB');
      const badBefore = await snapshot(h, bad);
      const failing: DocStoreDb = {
        async connect() {
          const inner = await h.db.connect();
          const client: DocStoreClient = {
            async query(sql, params) {
              // The LAST statement of the namespace's transaction: everything before it must undo.
              if (/DELETE FROM appdata\.usage_user u/.test(sql) && params?.[0] === bad) {
                throw new Error('injected wipe failure');
              }
              return inner.query(sql, params);
            },
            release: (err) => inner.release(err),
          };
          return client;
        },
      };
      const out = await createDocStoreMaintenance({ db: failing }).wipeAccount(WIPED);
      expect(out.failures).toEqual([{ appId: bad, ns: NS_PROD, error: 'injected wipe failure' }]);
      expect(out.namespaces.map((n) => n.appId)).toContain(good);
      expect(await rowsNaming(h, good, WIPED)).toEqual(NAMES_NOBODY);
      expect(await snapshot(h, bad)).toEqual(badBefore);

      const retry = await maint.wipeAccount(WIPED);
      expect(retry.failures).toEqual([]);
      expect(retry.namespaces.map((n) => n.appId)).toEqual([bad]);
      expect(await rowsNaming(h, bad, WIPED)).toEqual(NAMES_NOBODY);
      await assertUsageConsistent(h, bad, NS_PROD);
      await assertTalliesMatchMarks(h, bad);
    });

    it('refuses a malformed user id, and a store with no connection is storage_disabled', async () => {
      for (const bad of [0, -1, 1.5, 2_147_483_648, Number.NaN]) {
        await expect(maint.wipeAccount(bad)).rejects.toThrow(/malformed user id/);
      }
      await expectCode(
        createDocStoreMaintenance({ db: null }).wipeAccount(WIPED),
        'storage_disabled'
      );
    });
  });

  it('every appdata statement ran in its bound transaction with the matching keys (runtime shape)', () => {
    // Positive control: the recorder saw the enumeration and a per-namespace wipe statement.
    expect(
      h.statements.some((s) =>
        /FROM appdata\.usage_user wu WHERE wu\.user_id = \$1::int/.test(s.sql)
      )
    ).toBe(true);
    expect(h.statements.some((s) => /SET author_kind = 'deleted'/.test(s.sql))).toBe(true);
    expect(h.violations).toEqual([]);
  });
}

describe('account wipe on PGlite — appdata_rw, RLS on: both layers', () => {
  defineAccountWipeSuite(() => createPgliteHarness({ rls: true }));
});

describe('account wipe on PGlite — appdata_rw, RLS disabled: the module predicates alone', () => {
  defineAccountWipeSuite(() => createPgliteHarness({ rls: false }));
});

describe.skipIf(!REAL_PG_URL)('account wipe on Postgres (appdata_rw, RLS on)', () => {
  defineAccountWipeSuite(createRealPgHarness);
});

describe.skipIf(!REAL_PG_URL)('account wipe racing other writers on Postgres', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createRealPgHarness();
  });
  afterAll(async () => {
    await h?.close();
  });

  it('marks, unmarks and an author delete running alongside the wipe neither deadlock nor leave a tally out of step with its marks', async () => {
    const store = createDocStore({ db: h.db });
    const maint = createDocStoreMaintenance({ db: h.db });
    const app = freshApp('WIPERACE');
    const w = ctx(app, NS_PROD, WIPED);
    const voters = Array.from({ length: 6 }, (_, i) => ctx(app, NS_PROD, 6_000 + i));
    await store.put(w, POSTS, 'post-w', { status: 'open' });
    for (let i = 0; i < 4; i++) {
      await store.put(voters[i], POSTS, `post-${i}`, { status: 'open' });
      await store.mark(w, POSTS, `post-${i}`, 'vote');
    }
    await store.mark(w, POSTS, 'post-w', 'vote');
    const [wipe, ...racers] = await Promise.allSettled([
      maint.wipeAccount(WIPED),
      ...voters.map((v, i) => store.mark(v, POSTS, `post-${i % 4}`, 'vote')),
      ...voters.map((v) => store.mark(v, POSTS, 'post-w', 'vote')),
      store.delete(voters[0], POSTS, 'post-0'),
    ]);
    // The wipe completed first time: no namespace failed (a deadlock or lock timeout would be
    // reported there). A racer may lose only by marking `post-0` after its delete.
    expect(wipe).toEqual({
      status: 'fulfilled',
      value: expect.objectContaining({ failures: [] }),
    });
    for (const r of racers) {
      if (r.status === 'rejected') expect(String(r.reason)).toMatch(/document not found/);
    }
    // Whichever order they committed in, the wipe left nothing and every tally is exact.
    const again = await maint.wipeAccount(WIPED);
    expect(again).toEqual({ userId: WIPED, namespaces: [], failures: [] });
    expect(await rowsNaming(h, app, WIPED)).toEqual(NAMES_NOBODY);
    await assertTalliesMatchMarks(h, app);
    await assertUsageConsistent(h, app, NS_PROD);
    expect(h.violations).toEqual([]);
  });
});
