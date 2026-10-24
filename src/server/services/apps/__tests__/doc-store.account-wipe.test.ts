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
  snapshot,
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
 * own `dev:<uid>` (deleted outright), its own `rev:<request>:<uid>` (handled like `prod`: review
 * namespaces are purged with their request), and another user's `dev:` and `rev:` (untouched). Expected values are literals, never read back from the store under test.
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

/**
 * Every place a VIEWER's user id can be stored, and how many rows still hold `uid` there.
 * `doc.hidden_by` is deliberately excluded: it records the moderator who hid a document, and
 * moderator-action metadata is kept by design.
 */
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
    it('deletes private docs (index rows, tombstones) and the shared docs the account authored (index rows, tallies, every viewer’s marks, refunds, tombstones), releases counter docs, removes its marks with their tallies, and releases usage — touching nothing else of anyone else', async () => {
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
      const [sharedBefore] = await h.raw(
        `SELECT COALESCE(sum(size_bytes), 0)::int AS bytes, count(*)::int AS docs FROM appdata.doc
          WHERE app_id = $1 AND ns = 'prod' AND scope_uid = 0 AND author_kind = 'user' AND author_uid = $2`,
        [app, WIPED]
      );
      // Positive controls: WIPED is named in every place a user id can live, so "0 after" is real.
      const named = await rowsNaming(h, app, WIPED);
      for (const [k, n] of Object.entries(named))
        expect({ k, named: n > 0 }).toEqual({ k, named: true });
      expect(privBefore.docs).toBe(2);
      expect(sharedBefore.docs).toBe(2);
      expect(await tally(h, app, 'posts', 'post-o', 'mark', 'vote')).toBe(2);
      expect(await tally(h, app, 'posts', 'post-o', 'mark', 'star')).toBe(1);
      expect(await tally(h, app, 'posts', 'post-o', 'mark', 'report')).toBe(1);
      expect(await tally(h, app, 'posts', 'post-w', 'mark', 'vote')).toBe(2);
      const indexRows = (key: string) =>
        h.raw(`SELECT name FROM appdata.doc_index WHERE app_id = $1 AND key = $2`, [app, key]);
      expect((await indexRows('post-w')).length).toBeGreaterThan(0);
      const otherMarks = () =>
        h.raw(
          `SELECT coll, key, name, user_id FROM appdata.doc_mark WHERE app_id = $1 AND user_id = $2 ORDER BY 1, 2, 3`,
          [app, OTHER]
        );
      const before = {
        otherPrivate: await h.raw(
          `SELECT * FROM appdata.doc WHERE app_id = $1 AND scope_uid = $2 ORDER BY coll, key`,
          [app, OTHER]
        ),
        otherShared: await h.raw(
          `SELECT * FROM appdata.doc WHERE app_id = $1 AND scope_uid = 0 AND author_uid = $2 ORDER BY coll, key`,
          [app, OTHER]
        ),
        otherMarks: await otherMarks(),
        otherUsage: await h.raw(
          `SELECT bytes, docs FROM appdata.usage_user WHERE app_id = $1 AND user_id = $2`,
          [app, OTHER]
        ),
      };
      expect(before.otherMarks.map((m) => `${m.key}:${m.name}`)).toEqual([
        'post-o:vote',
        'post-w:report',
        'post-w:vote',
      ]);

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
            sharedDocs: 2,
            sharedBytes: sharedBefore.bytes,
            counterDocsReleased: 1,
            marks: 4,
            namespaceRows: 0,
          },
        ],
      });

      // Nothing anywhere still holds the account's id.
      expect(await rowsNaming(h, app, WIPED)).toEqual(NAMES_NOBODY);

      // The authored shared docs are gone, hidden or not, with their index rows and tallies; each
      // left a tombstone for the change feed.
      expect(await rawDoc(h, app, NS_PROD, 'posts', 'post-w')).toBeUndefined();
      expect(await rawDoc(h, app, NS_PROD, 'board', 'note-w')).toBeUndefined();
      expect(await indexRows('post-w')).toEqual([]);
      expect(await tally(h, app, 'posts', 'post-w', 'mark', 'vote')).toBeNull();
      expect(
        (
          await h.raw(
            `SELECT coll, key FROM appdata.doc_tomb WHERE app_id = $1 AND scope_uid = 0 ORDER BY coll, key`,
            [app]
          )
        ).map((r) => `${r.coll}/${r.key}`)
      ).toEqual(['board/note-w', 'posts/post-w']);
      // The counter document stays a counter document, with its counts, owned by nobody.
      expect(await rawDoc(h, app, NS_PROD, 'tallies', 'game-w')).toMatchObject({
        author_kind: 'counter',
        author_uid: null,
        last_writer_uid: null,
      });
      expect(await tally(h, app, 'tallies', 'game-w', 'counter', 'plays')).toBe(5);

      // Each surviving tally lost exactly the account's marks.
      expect(await tally(h, app, 'posts', 'post-o', 'mark', 'vote')).toBe(1);
      expect(await tally(h, app, 'posts', 'post-o', 'mark', 'star')).toBe(0);
      expect(await tally(h, app, 'posts', 'post-o', 'mark', 'report')).toBe(0);
      await assertTalliesMatchMarks(h, app);

      // The bystander: its own documents and usage exactly as they were; of its marks, only the
      // ones on the deleted documents went with them.
      expect(
        await h.raw(
          `SELECT * FROM appdata.doc WHERE app_id = $1 AND scope_uid = $2 ORDER BY coll, key`,
          [app, OTHER]
        )
      ).toEqual(before.otherPrivate);
      expect(
        await h.raw(
          `SELECT * FROM appdata.doc WHERE app_id = $1 AND scope_uid = 0 AND author_uid = $2 ORDER BY coll, key`,
          [app, OTHER]
        )
      ).toEqual(before.otherShared);
      expect((await otherMarks()).map((m) => `${m.key}:${m.name}`)).toEqual(['post-o:vote']);
      expect(
        await h.raw(
          `SELECT bytes, docs FROM appdata.usage_user WHERE app_id = $1 AND user_id = $2`,
          [app, OTHER]
        )
      ).toEqual(before.otherUsage);
      expect(before.otherUsage).toHaveLength(1);

      // The app's usage lost exactly the deleted documents, private and shared.
      const [usageAfter] = await h.raw(
        `SELECT bytes::int AS bytes, docs FROM appdata.usage_app WHERE app_id = $1 AND ns = 'prod'`,
        [app]
      );
      expect(usageAfter).toEqual({
        bytes: usageBefore.bytes - privBefore.bytes - sharedBefore.bytes,
        docs: usageBefore.docs - 4,
      });
      await assertUsageConsistent(h, app, NS_PROD);
    });

    it('readers, `author=me` and the moderator queue no longer find the account’s shared docs — a hidden one included — and the keys are free again', async () => {
      const app = await seedProd('WIPEREAD');
      const w = ctx(app, NS_PROD, WIPED);
      const o = ctx(app, NS_PROD, OTHER);
      const anon = ctx(app, NS_PROD, null);
      // Positive controls: before the wipe the account authors post-w, both posts are in the
      // report queue, and a moderator has hidden its board note.
      expect((await store.list(w, POSTS, { author: 'me' })).items.map((d) => d.key)).toEqual([
        'post-w',
      ]);
      const queued = async () =>
        (await mod.listReported(app, NS_PROD, { status: 'all', limit: 10 }))
          .map((r) => `${r.collection}/${r.key}`)
          .sort();
      expect(await mod.setHidden(app, NS_PROD, 'board', 'note-w', true, 9)).toMatchObject({
        changed: true,
      });
      expect(await queued()).toEqual(['board/note-w', 'posts/post-o', 'posts/post-w']);

      await maint.wipeAccount(WIPED);

      for (const c of [w, o, anon]) {
        expect(await store.get(c, POSTS, 'post-w')).toBeNull();
        expect((await store.list(c, POSTS)).items.map((d) => d.key)).toEqual(['post-o']);
        expect((await store.get(c, TALLIES, 'game-w'))?.author).toEqual({ kind: 'counter' });
      }
      expect(await mod.get(app, NS_PROD, 'board', 'note-w')).toBeNull();
      // post-w is deleted; post-o's only report was the account's own.
      expect(await queued()).toEqual([]);
      expect((await store.list(w, POSTS, { author: 'me' })).items).toEqual([]);
      expect((await store.list(o, POSTS, { author: 'me' })).items.map((d) => d.key)).toEqual([
        'post-o',
      ]);
      expect(await store.get(o, POSTS, 'post-o')).toMatchObject({
        marks: { vote: 1, star: 0 },
        viewer: { marks: ['vote'] },
      });
      // The account's own private documents are gone; the bystander's are not.
      expect(await store.get(w, PREFS, 'theme')).toBeNull();
      expect(await store.get(o, PREFS, 'theme')).toMatchObject({ data: { mode: 'o' } });
      // The key is free: anyone may create it again, as a new document.
      expect(await store.put(o, POSTS, 'post-w', { status: 'new' })).toMatchObject({
        version: 1,
        author: { kind: 'user', uid: OTHER, isViewer: true },
        marks: { vote: 0, star: 0 },
      });
      await assertUsageConsistent(h, app, NS_PROD);
      await assertTalliesMatchMarks(h, app);
    });
  });

  describe('every app and namespace the account has rows in', () => {
    it('handles every app; deletes the account’s own dev namespace outright and wipes its review namespace per user; leaves another user’s dev namespace alone', async () => {
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
          sharedDocs: n.sharedDocs,
        }));
      expect(seen).toEqual(
        [
          { appId: app1, ns: ownDev, mode: 'namespace', marks: 0, sharedDocs: 0 },
          { appId: app1, ns: NS_PROD, mode: 'user', marks: 0, sharedDocs: 2 },
          { appId: app2, ns: NS_PROD, mode: 'user', marks: 0, sharedDocs: 2 },
          { appId: markOnly, ns: NS_PROD, mode: 'user', marks: 1, sharedDocs: 0 },
          { appId: req, ns: ownRev, mode: 'user', marks: 0, sharedDocs: 2 },
        ].sort((a, b) => (a.appId + a.ns < b.appId + b.ns ? -1 : 1))
      );

      // The account's own dev namespace: no row of any kind is left.
      for (const [appId, ns] of [[app1, ownDev]]) {
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
        [req, ownRev],
      ]) {
        await assertUsageConsistent(h, appId, ns);
      }
      await assertTalliesMatchMarks(h, markOnly);
    });

    it('a row naming the account inside ANOTHER user’s dev or review namespace is handled per user — that namespace is never deleted outright', async () => {
      // Not reachable through the store (only the namespace owner's tokens resolve to it), so
      // seeded directly: the wipe must still decide by the namespace's owner, not by its shape.
      const app = freshApp('WIPEFOREIGNNS');
      const req = `pubreq_WIPEFOREIGN${app.slice(-3)}`;
      const foreign: [string, string][] = [
        [app, `dev:${OTHER}`],
        [req, reviewNamespace(req, OTHER)],
      ];
      for (const [appId, ns] of foreign) {
        await seedUser(store, appId, ns, OTHER, 'o');
        await h.raw(
          `INSERT INTO appdata.doc_mark (app_id, ns, coll, key, name, user_id) VALUES ($1, $2, 'posts', 'post-o', 'vote', $3)`,
          [appId, ns, WIPED]
        );
      }
      const keep = await Promise.all(
        foreign.map(([appId, ns]) =>
          h.raw(
            `SELECT * FROM appdata.doc WHERE app_id = $1 AND ns = $2 ORDER BY coll, scope_uid, key`,
            [appId, ns]
          )
        )
      );
      expect(keep.map((k) => k.length)).toEqual([5, 5]);

      try {
        const out = await maint.wipeAccount(WIPED);
        expect(out.failures.filter((f) => f.appId === app)).toEqual([]);
        expect(out.failures.filter((f) => f.appId === req)).toEqual([
          {
            appId: req,
            ns: reviewNamespace(req, OTHER),
            error: expect.stringMatching(/review namespace does not belong/),
          },
        ]);
        // The dev namespace is wiped per user. The review namespace's context belongs to OTHER,
        // so it is refused as a failure and left as it was; neither is deleted outright.
        expect(out.namespaces.find((n) => n.appId === app)).toMatchObject({
          mode: 'user',
          marks: 1,
        });
        expect(out.namespaces.some((n) => n.appId === req && n.mode === 'namespace')).toBe(false);
        for (const [i, [appId, ns]] of foreign.entries()) {
          expect(
            await h.raw(
              `SELECT * FROM appdata.doc WHERE app_id = $1 AND ns = $2 ORDER BY coll, scope_uid, key`,
              [appId, ns]
            )
          ).toEqual(keep[i]);
        }
        expect(await rowsNaming(h, app, WIPED)).toEqual(NAMES_NOBODY);
      } finally {
        // Remove the refused review mark so later cases start from no failures.
        await h.raw(`DELETE FROM appdata.doc_mark WHERE app_id = $1 AND user_id = $2`, [
          req,
          WIPED,
        ]);
      }
    });

    it('pages the enumeration: an account in more namespaces than one page holds is wiped in all of them', async () => {
      const PAGE = 500;
      const tag = `ab_WIPEPAGE${freshApp('p').slice(-3)}_`;
      const apps = Array.from(
        { length: PAGE + 1 },
        (_, i) => `${tag}${String(i).padStart(4, '0')}`
      );
      await h.raw(
        `INSERT INTO appdata.usage_user (app_id, ns, user_id, bytes, docs)
         SELECT a, 'prod', $2, 0, 0 FROM unnest($1::text[]) AS a`,
        [apps, WIPED]
      );
      const out = await maint.wipeAccount(WIPED);
      expect(out.failures).toEqual([]);
      expect(out.namespaces.filter((n) => n.appId.startsWith(tag)).map((n) => n.appId)).toEqual(
        apps
      );
      const [left] = await h.raw(
        `SELECT count(*)::int AS n FROM appdata.usage_user WHERE app_id LIKE $1 AND user_id = $2`,
        [`${tag}%`, WIPED]
      );
      expect(left.n).toBe(0);
    });

    it('a tally already below its marks (drift) stops at 0 instead of failing the wipe', async () => {
      const app = await seedProd('WIPEDRIFT');
      await h.raw(
        `UPDATE appdata.doc_tally SET count = 0 WHERE app_id = $1 AND key = 'post-o' AND kind = 'mark' AND name = 'star'`,
        [app]
      );
      const out = await maint.wipeAccount(WIPED);
      expect(out.failures).toEqual([]);
      expect(await tally(h, app, 'posts', 'post-o', 'mark', 'star')).toBe(0);
      expect(await rowsNaming(h, app, WIPED)).toEqual(NAMES_NOBODY);
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
      const ranForBad: string[] = [];
      const failing: DocStoreDb = {
        async connect() {
          const inner = await h.db.connect();
          const client: DocStoreClient = {
            async query(sql, params) {
              // After every change to documents, marks, tallies and usage_app: all must undo.
              if (/DELETE FROM appdata\.usage_user u/.test(sql) && params?.[0] === bad) {
                throw new Error('injected wipe failure');
              }
              if (params?.[0] === bad) ranForBad.push(sql);
              return inner.query(sql, params);
            },
            release: (err) => inner.release(err),
          };
          return client;
        },
      };
      const out = await createDocStoreMaintenance({ db: failing }).wipeAccount(WIPED);
      expect(out.failures).toEqual([{ appId: bad, ns: NS_PROD, error: 'injected wipe failure' }]);
      // The rollback is what restored these, not their never having run.
      for (const ran of [
        /DELETE FROM appdata\.doc d\s+WHERE d\.app_id = \$1 AND d\.ns = \$2 AND d\.scope_uid = \$3/,
        /FOR UPDATE OF d/,
        /INSERT INTO appdata\.doc_tomb/,
        /DELETE FROM appdata\.doc_mark mk/,
        /INSERT INTO appdata\.usage_app/,
      ]) {
        expect({ ran: String(ran), seen: ranForBad.some((s) => ran.test(s)) }).toEqual({
          ran: String(ran),
          seen: true,
        });
      }
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

  it('negative control: the recorder flags an enumeration keyed on another user and one outside its transaction', async () => {
    const before = h.violations.length;
    const c = await h.db.connect();
    const enumerate = `SELECT wu.app_id FROM appdata.usage_user wu WHERE wu.user_id = $1::int`;
    try {
      await c.query(
        `BEGIN; SELECT set_config('appdata.app_id', '', true), set_config('appdata.ns', '', true), set_config('appdata.account_wipe_uid', '${WIPED}', true), set_config('lock_timeout', '3s', true)`
      );
      await c.query(enumerate, [OTHER]);
      await c.query('ROLLBACK');
      await c.query(
        `BEGIN; SELECT set_config('appdata.app_id', 'ab_RECORDER', true), set_config('appdata.ns', 'prod', true), set_config('lock_timeout', '3s', true)`
      );
      await c.query(enumerate, [WIPED]);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
    const flagged = h.violations.splice(before);
    expect(flagged.map((v) => v.split(':')[0])).toEqual([
      '$1 does not match the bound account-wipe user',
      'account-wipe statement outside its transaction, or vice versa',
    ]);
  });

  it('every appdata statement ran in its bound transaction with the matching keys (runtime shape)', () => {
    // Positive control: the recorder saw the enumeration and a per-namespace wipe statement.
    expect(
      h.statements.some((s) =>
        /FROM appdata\.usage_user wu WHERE wu\.user_id = \$1::int/.test(s.sql)
      )
    ).toBe(true);
    expect(
      h.statements.some((s) => /OR EXISTS \(SELECT 1 FROM appdata\.doc_mark lm/.test(s.sql))
    ).toBe(true);
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

  it.each([
    ['private', PREFS, { privateDocs: 2, sharedDocs: 0 }],
    ['shared', BOARD, { privateDocs: 1, sharedDocs: 1 }],
  ] as const)(
    'a %s document the account is still writing when its namespace is wiped does not survive with its uid',
    async (_kind, coll, counts) => {
      const maint = createDocStoreMaintenance({ db: h.db });
      const app = freshApp('WIPEINFLIGHT');
      const w = ctx(app, NS_PROD, WIPED);
      await createDocStore({ db: h.db }).put(w, PREFS, 'existing', { a: 1 });
      // The writer runs to its COMMIT and is held there, holding its usage_app and usage_user
      // row locks, with its document not yet visible to anyone.
      let parked!: () => void;
      const isParked = new Promise<void>((r) => (parked = r));
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const gated: DocStoreDb = {
        async connect() {
          const inner = await h.db.connect();
          return {
            async query(sql, params) {
              if (sql === 'COMMIT') {
                parked();
                await gate;
              }
              return inner.query(sql, params);
            },
            release: (err) => inner.release(err),
          };
        },
      };
      const writer = createDocStore({ db: gated }).put(w, coll, 'inflight', { b: 2 });
      await isParked;
      const wipe = maint.wipeAccount(WIPED);
      // Wait until the wipe is blocked on the writer's locks (observed, not timed).
      let waiting = 0;
      for (let i = 0; i < 200 && waiting === 0; i++) {
        await new Promise((r) => setTimeout(r, 25));
        const [row] = await h.raw(
          `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`
        );
        waiting = Number(row.n);
      }
      expect(waiting, 'the wipe never blocked on the in-flight writer').toBeGreaterThan(0);
      release();
      await writer;
      const out = await wipe;
      expect(out.failures).toEqual([]);
      expect(out.namespaces).toMatchObject([{ appId: app, ...counts }]);
      expect(await rowsNaming(h, app, WIPED)).toEqual(NAMES_NOBODY);
      await assertUsageConsistent(h, app, NS_PROD);
    }
  );

  it('two accounts that authored posts and marked each other’s are wiped concurrently without deadlock, round after round', async () => {
    const store = createDocStore({ db: h.db });
    const maint = createDocStoreMaintenance({ db: h.db });
    const ROUNDS = 10;
    for (let round = 0; round < ROUNDS; round++) {
      const app = freshApp('WIPECROSS');
      const a = ctx(app, NS_PROD, WIPED);
      const b = ctx(app, NS_PROD, OTHER);
      for (const [c, tag] of [
        [a, 'a'],
        [b, 'b'],
      ] as const) {
        await store.put(c, POSTS, `post-${tag}1`, { status: 'open' });
        await store.put(c, POSTS, `post-${tag}2`, { status: 'open' });
      }
      for (const key of ['post-b1', 'post-b2']) await store.mark(a, POSTS, key, 'vote');
      for (const key of ['post-a1', 'post-a2']) await store.mark(b, POSTS, key, 'vote');

      const [wa, wb] = await Promise.all([maint.wipeAccount(WIPED), maint.wipeAccount(OTHER)]);
      expect({ round, failures: [...wa.failures, ...wb.failures] }).toEqual({
        round,
        failures: [],
      });
      expect(await rowsNaming(h, app, WIPED)).toEqual(NAMES_NOBODY);
      expect(await rowsNaming(h, app, OTHER)).toEqual(NAMES_NOBODY);
      expect(await h.raw(`SELECT key FROM appdata.doc WHERE app_id = $1`, [app])).toEqual([]);
      await assertUsageConsistent(h, app, NS_PROD);
    }
  });

  it('two accounts that created counter documents and reported each other’s are wiped concurrently without deadlock, round after round', async () => {
    const store = createDocStore({ db: h.db });
    const maint = createDocStoreMaintenance({ db: h.db });
    const ROUNDS = 10;
    for (let round = 0; round < ROUNDS; round++) {
      const app = freshApp('WIPECOUNTERX');
      const a = ctx(app, NS_PROD, WIPED);
      const b = ctx(app, NS_PROD, OTHER);
      for (const [c, tag] of [
        [a, 'a'],
        [b, 'b'],
      ] as const) {
        await store.increment(c, TALLIES, `game-${tag}1`, 'plays', 1);
        await store.increment(c, TALLIES, `game-${tag}2`, 'plays', 1);
      }
      for (const key of ['game-b1', 'game-b2']) await store.mark(a, TALLIES, key, 'report');
      for (const key of ['game-a1', 'game-a2']) await store.mark(b, TALLIES, key, 'report');

      const [wa, wb] = await Promise.all([maint.wipeAccount(WIPED), maint.wipeAccount(OTHER)]);
      expect({ round, failures: [...wa.failures, ...wb.failures] }).toEqual({
        round,
        failures: [],
      });
      expect(await rowsNaming(h, app, WIPED)).toEqual(NAMES_NOBODY);
      expect(await rowsNaming(h, app, OTHER)).toEqual(NAMES_NOBODY);
      // Counter documents survive their creators, released.
      expect(
        await h.raw(
          `SELECT key, author_kind, author_uid FROM appdata.doc WHERE app_id = $1 ORDER BY key`,
          [app]
        )
      ).toEqual(
        ['game-a1', 'game-a2', 'game-b1', 'game-b2'].map((key) => ({
          key,
          author_kind: 'counter',
          author_uid: null,
        }))
      );
      await assertUsageConsistent(h, app, NS_PROD);
    }
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
