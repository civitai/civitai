import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DocStore, DocStoreClient, DocStoreDb } from '~/server/services/apps/doc-store';
import { createDocStore, reviewNamespace } from '~/server/services/apps/doc-store';
import { createPgliteHarness, type Harness } from './doc-store.harness';
import {
  assertUsageConsistent,
  BOARD,
  ctx,
  expectCode,
  freshApp,
  NS_DEV,
  NS_PROD,
  POSTS,
  PREFS,
  TALLIES,
} from './doc-store.functional';
import { APPDATA_TABLES } from './doc-store.sql-scan';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * Review namespaces of the document store: one per (publish request, moderator), and their
 * deletion when the request is decided (`DocStore.purgeReview`). Run on the embedded Postgres
 * as `appdata_rw` with row-level security ON (both layers) and OFF (the module's own
 * predicates alone — without RLS a purge statement that lost its `ns = $2` would delete other
 * namespaces, and the "untouched" assertions below would see it).
 */

// Pairwise distinct, and distinct from every id the functional suite uses.
const MOD_1 = 3_101;
const MOD_2 = 3_202;
let reqSeq = 0;
const freshRequest = (tag: string) => `pubreq_${tag}${(reqSeq += 1)}`;

const asMod = (publishRequestId: string, uid: number) =>
  ctx(publishRequestId, reviewNamespace(publishRequestId, uid), uid);

/** Rows per appdata table for one app id, every namespace (superuser read, RLS bypassed). */
async function rowsByTable(h: Harness, appId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of APPDATA_TABLES) {
    const [r] = await h.raw(`SELECT count(*)::int AS n FROM appdata.${t} WHERE app_id = $1`, [
      appId,
    ]);
    out[t] = Number(r.n);
  }
  return out;
}

/** A full snapshot of one app id's rows, for "untouched" comparisons. */
async function snapshot(h: Harness, appId: string) {
  const out: Record<string, unknown[]> = {};
  for (const t of APPDATA_TABLES) {
    out[t] = await h.raw(`SELECT * FROM appdata.${t} WHERE app_id = $1 ORDER BY 1, 2, 3, 4, 5`, [
      appId,
    ]);
  }
  return out;
}

/** Every kind of row a moderator can create: private + shared docs, an index row, a counter,
 * a counter-created doc, a mark, and a tombstone. */
async function seedModerator(store: DocStore, publishRequestId: string, uid: number) {
  const c = asMod(publishRequestId, uid);
  await store.put(c, PREFS, 'theme', { mode: `m${uid}` });
  await store.put(c, POSTS, 'p1', { status: 'open', score: uid });
  await store.increment(c, POSTS, 'p1', 'views', 2);
  await store.mark(c, POSTS, 'p1', 'vote');
  await store.increment(c, TALLIES, 'game', 'plays', 1);
  await store.put(c, BOARD, 'gone', { t: 1 });
  await store.delete(c, BOARD, 'gone');
}

function defineReviewSuite(makeHarness: () => Promise<Harness>) {
  let h: Harness;
  let store: DocStore;
  beforeAll(async () => {
    h = await makeHarness();
    store = createDocStore({ db: h.db });
  });
  afterAll(async () => {
    await h?.close();
  });

  describe('per-moderator review namespaces', () => {
    it('two moderators on ONE request see none of each other’s private or shared docs, marks or counters', async () => {
      const pr = freshRequest('ISO');
      const m1 = asMod(pr, MOD_1);
      const m2 = asMod(pr, MOD_2);

      await store.put(m1, PREFS, 'k', { who: 1 });
      await store.put(m1, BOARD, 'same', { by: 1 });
      await store.put(m1, POSTS, 'p', { status: 'open' });
      expect(await store.mark(m1, POSTS, 'p', 'vote')).toEqual({ marked: true, count: 1 });
      expect(await store.increment(m1, POSTS, 'p', 'views', 5)).toEqual({ value: 5 });
      expect(await store.increment(m1, TALLIES, 'g', 'plays', 3)).toEqual({ value: 3 });

      expect(await store.get(m2, PREFS, 'k')).toBeNull();
      expect(await store.get(m2, BOARD, 'same')).toBeNull();
      expect(await store.get(m2, POSTS, 'p')).toBeNull();
      expect(await store.get(m2, TALLIES, 'g')).toBeNull();
      expect((await store.list(m2, BOARD)).items).toEqual([]);
      expect((await store.list(m2, POSTS, { markedBy: 'me', mark: 'vote' })).items).toEqual([]);
      // Moderator 1's shared key is not moderator 1's document in moderator 2's namespace:
      // no `not_author`, a fresh version, and tallies that start from zero.
      expect((await store.put(m2, BOARD, 'same', { by: 2 })).version).toBe(1);
      await store.put(m2, POSTS, 'p', { status: 'closed' });
      expect(await store.mark(m2, POSTS, 'p', 'vote')).toEqual({ marked: true, count: 1 });
      expect(await store.increment(m2, POSTS, 'p', 'views', 2)).toEqual({ value: 2 });
      expect(await store.increment(m2, TALLIES, 'g', 'plays', 1)).toEqual({ value: 1 });

      expect(await store.get(m1, BOARD, 'same')).toMatchObject({ data: { by: 1 }, version: 1 });
      expect(await store.get(m1, POSTS, 'p')).toMatchObject({
        data: { status: 'open' },
        counters: { views: 5 },
        marks: { vote: 1 },
      });
      expect(await store.get(m1, TALLIES, 'g')).toMatchObject({ counters: { plays: 3 } });
      expect((await store.usage(m1)).viewer).toEqual((await store.usage(m1)).app);
      for (const uid of [MOD_1, MOD_2]) {
        await assertUsageConsistent(h, pr, reviewNamespace(pr, uid));
      }
    });

    it('a review namespace is refused with any other request or viewer, and the bare request namespace is no context', async () => {
      const pr = freshRequest('CTX');
      const ns = reviewNamespace(pr, MOD_1);
      for (const bad of [
        ctx(pr, ns, MOD_2), // another moderator's namespace
        ctx(pr, ns, null), // anonymous
        ctx(freshRequest('CTXOTHER'), ns, MOD_1), // another request's app id
        ctx(pr, `rev:${pr}`, MOD_1), // the registry namespace
      ]) {
        // A shared collection, so an anonymous context reaches the context check rather than
        // the private collection's sign-in refusal.
        await expect(store.get(bad, BOARD, 'k')).rejects.toThrow(/doc-store: /);
      }
      expect(() => reviewNamespace('has space', MOD_1)).toThrow(/malformed/);
      expect(() => reviewNamespace(pr, 0)).toThrow(/malformed/);
      expect(await rowsByTable(h, pr)).toEqual(
        Object.fromEntries(APPDATA_TABLES.map((t) => [t, 0]))
      );
    });

    it('every moderator is registered under the request before anything lands in their namespace', async () => {
      const pr = freshRequest('REG');
      await store.get(asMod(pr, MOD_2), PREFS, 'k'); // a read registers too
      await store.put(asMod(pr, MOD_1), PREFS, 'k', { a: 1 });
      const reg = await h.raw(
        `SELECT user_id, bytes::int, docs FROM appdata.usage_user WHERE app_id = $1 AND ns = $2 ORDER BY user_id`,
        [pr, `rev:${pr}`]
      );
      expect(reg).toEqual([
        { user_id: MOD_1, bytes: 0, docs: 0 },
        { user_id: MOD_2, bytes: 0, docs: 0 },
      ]);
    });
  });

  describe('purgeReview', () => {
    it('deletes every row of every moderator namespace of the request, and nothing else', async () => {
      const pr = freshRequest('PURGE');
      const other = freshRequest('KEEP');
      const app = freshApp('REVKEEP');
      for (const uid of [MOD_1, MOD_2]) await seedModerator(store, pr, uid);
      await seedModerator(store, other, MOD_1);
      await store.put(ctx(app, NS_PROD, MOD_1), POSTS, 'p1', { status: 'open' });
      await store.mark(ctx(app, NS_PROD, MOD_1), POSTS, 'p1', 'vote');
      await store.put(ctx(app, NS_DEV, MOD_1), PREFS, 'k', { a: 1 });

      // Positive control: the seed reached EVERY table, so "0 after" is not vacuous.
      const before = await rowsByTable(h, pr);
      for (const t of APPDATA_TABLES) expect({ t, n: before[t] > 0 }).toEqual({ t, n: true });
      const keepOther = await snapshot(h, other);
      const keepApp = await snapshot(h, app);

      const out = await store.purgeReview(pr);
      expect(out.namespaces).toBe(2);
      // Everything but the two registry rows (deleted, not counted) and the index rows (deleted
      // by the document delete's foreign-key cascade, so the count does not see them).
      const total = Object.values(before).reduce((a, b) => a + b, 0);
      expect(out.rows).toBe(total - 2 - before.doc_index);

      expect(await rowsByTable(h, pr)).toEqual(
        Object.fromEntries(APPDATA_TABLES.map((t) => [t, 0]))
      );
      expect(await snapshot(h, other)).toEqual(keepOther);
      expect(await snapshot(h, app)).toEqual(keepApp);
      await assertUsageConsistent(h, other, reviewNamespace(other, MOD_1));
      await assertUsageConsistent(h, app, NS_PROD);
      await assertUsageConsistent(h, app, NS_DEV);
    });

    it('is idempotent: a second purge finds nothing, and a request with no review data is a no-op', async () => {
      const pr = freshRequest('TWICE');
      await seedModerator(store, pr, MOD_1);
      expect((await store.purgeReview(pr)).namespaces).toBe(1);
      expect(await store.purgeReview(pr)).toEqual({ namespaces: 0, rows: 0 });
      expect(await store.purgeReview(freshRequest('NEVER'))).toEqual({ namespaces: 0, rows: 0 });
    });

    it('resumes after a failure part-way: the finished moderator stays gone, a retry finishes the rest', async () => {
      const pr = freshRequest('RESUME');
      for (const uid of [MOD_1, MOD_2]) await seedModerator(store, pr, uid);
      const failOn = reviewNamespace(pr, MOD_2);
      // A pool whose connection refuses moderator 2's document delete, once.
      let failures = 0;
      const flaky: DocStoreDb = {
        async connect() {
          const inner = await h.db.connect();
          const client: DocStoreClient = {
            async query(sql, params) {
              if (
                /DELETE FROM appdata\.doc d/.test(sql) &&
                params?.[1] === failOn &&
                failures === 0
              ) {
                failures += 1;
                throw new Error('injected purge failure');
              }
              return inner.query(sql, params);
            },
            release: (err) => inner.release(err),
          };
          return client;
        },
      };
      await expect(createDocStore({ db: flaky }).purgeReview(pr)).rejects.toThrow(
        'injected purge failure'
      );
      expect(failures).toBe(1);
      const docsByNs = async () =>
        (
          await h.raw(
            `SELECT ns, count(*)::int AS n FROM appdata.doc WHERE app_id = $1 GROUP BY ns ORDER BY ns`,
            [pr]
          )
        ).map((r) => [r.ns, r.n]);
      // Moderator 1 (purged first) is gone; moderator 2's transaction rolled back whole.
      expect(await docsByNs()).toEqual([[failOn, 3]]);
      const reg = await h.raw(
        `SELECT user_id FROM appdata.usage_user WHERE app_id = $1 AND ns = $2`,
        [pr, `rev:${pr}`]
      );
      expect(reg.map((r) => r.user_id)).toEqual([MOD_2]);

      expect((await store.purgeReview(pr)).namespaces).toBe(1);
      expect(await rowsByTable(h, pr)).toEqual(
        Object.fromEntries(APPDATA_TABLES.map((t) => [t, 0]))
      );
    });
  });

  it('every appdata statement carried its bound app id and namespace as $1/$2', () => {
    // Positive control: the recorder saw the registry and purge statements.
    expect(h.statements.some((s) => /DELETE FROM appdata\.usage_app u/.test(s.sql))).toBe(true);
    expect(h.statements.some((s) => /INSERT INTO appdata\.usage_user AS u/.test(s.sql))).toBe(true);
    expect(h.violations).toEqual([]);
  });
}

describe('review namespaces on PGlite — appdata_rw, RLS on: both layers', () => {
  defineReviewSuite(() => createPgliteHarness({ rls: true }));
});

describe('review namespaces on PGlite — appdata_rw, RLS disabled: the module predicates alone', () => {
  defineReviewSuite(() => createPgliteHarness({ rls: false }));
});

it('a store with no connection refuses the purge as storage_disabled', async () => {
  await expectCode(createDocStore({ db: null }).purgeReview('pubreq_NODB'), 'storage_disabled');
});
