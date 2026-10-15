import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  DocStore,
  DocStoreMaintenance,
  DocStoreClient,
  DocStoreDb,
} from '~/server/services/apps/doc-store';
import {
  createDocStore,
  createDocStoreMaintenance,
  reviewNamespace,
} from '~/server/services/apps/doc-store';
import { createPgliteHarness, type Harness } from './doc-store.harness';
import {
  assertUsageConsistent,
  snapshot,
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
 * predicates alone — without RLS a purge statement that lost its `ns LIKE 'rev:%'` would delete
 * prod and dev rows, and the "untouched" assertions below would see it).
 */

// Pairwise distinct, and distinct from every id the functional suite uses.
const MOD_1 = 3_101;
const MOD_2 = 3_202;
let reqSeq = 0;
const freshRequest = (tag: string) => `pubreq_${tag}${(reqSeq += 1)}`;

const asMod = (publishRequestId: string, uid: number) =>
  ctx(publishRequestId, reviewNamespace(publishRequestId, uid), uid);

/** Rows per appdata table for one app id (superuser read, RLS bypassed); `nsLike` narrows. */
async function rowsByTable(
  h: Harness,
  appId: string,
  nsLike = '%'
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of APPDATA_TABLES) {
    const [r] = await h.raw(
      `SELECT count(*)::int AS n FROM appdata.${t} WHERE app_id = $1 AND ns LIKE $2`,
      [appId, nsLike]
    );
    out[t] = Number(r.n);
  }
  return out;
}

const NONE = Object.fromEntries(APPDATA_TABLES.map((t) => [t, 0]));

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
  let maint: DocStoreMaintenance;
  beforeAll(async () => {
    h = await makeHarness();
    store = createDocStore({ db: h.db });
    maint = createDocStoreMaintenance({ db: h.db });
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

    it('a review namespace is refused with any other request or viewer', async () => {
      const pr = freshRequest('CTX');
      const ns = reviewNamespace(pr, MOD_1);
      for (const bad of [
        ctx(pr, ns, MOD_2), // another moderator's namespace
        ctx(pr, ns, null), // anonymous
        ctx(freshRequest('CTXOTHER'), ns, MOD_1), // another request's app id
        ctx(pr, `rev:${pr}`, MOD_1), // no moderator
      ]) {
        // A shared collection, so an anonymous context reaches the context check rather than
        // the private collection's sign-in refusal.
        await expect(store.get(bad, BOARD, 'k')).rejects.toThrow(/doc-store: /);
      }
      expect(() => reviewNamespace('has space', MOD_1)).toThrow(/malformed/);
      expect(() => reviewNamespace(pr, 0)).toThrow(/malformed/);
      expect(await rowsByTable(h, pr)).toEqual(NONE);
    });
  });

  describe('purgeReview', () => {
    it('deletes every review row of the request in one go — not its prod or dev rows, not another request', async () => {
      const pr = freshRequest('PURGE');
      const other = freshRequest('KEEP');
      const app = freshApp('REVKEEP');
      for (const uid of [MOD_1, MOD_2]) await seedModerator(store, pr, uid);
      await seedModerator(store, other, MOD_1);
      // prod and dev rows under the request's OWN app id: the purge must not reach them.
      await store.put(ctx(pr, NS_PROD, MOD_1), POSTS, 'p1', { status: 'open' });
      await store.mark(ctx(pr, NS_PROD, MOD_1), POSTS, 'p1', 'vote');
      await store.put(ctx(pr, NS_DEV, MOD_1), PREFS, 'k', { a: 1 });
      await store.put(ctx(app, NS_PROD, MOD_1), POSTS, 'p1', { status: 'open' });
      await store.put(ctx(app, NS_DEV, MOD_1), PREFS, 'k', { a: 1 });

      // Positive control: the seed reached EVERY table, so "0 after" is not vacuous.
      const before = await rowsByTable(h, pr, 'rev:%');
      for (const t of APPDATA_TABLES) expect({ t, n: before[t] > 0 }).toEqual({ t, n: true });
      const keepProdDev = {
        prod: await rowsByTable(h, pr, 'prod'),
        dev: await rowsByTable(h, pr, 'dev:%'),
      };
      expect(keepProdDev.prod.doc).toBe(1);
      expect(keepProdDev.dev.doc).toBe(1);
      const keepOther = await snapshot(h, other);
      const keepApp = await snapshot(h, app);

      const out = await maint.purgeReview(pr);
      // Index rows go by the document delete's foreign-key cascade, so the count omits them.
      const total = Object.values(before).reduce((a, b) => a + b, 0);
      expect(out.rows).toBe(total - before.doc_index);

      expect(await rowsByTable(h, pr, 'rev:%')).toEqual(NONE);
      expect({
        prod: await rowsByTable(h, pr, 'prod'),
        dev: await rowsByTable(h, pr, 'dev:%'),
      }).toEqual(keepProdDev);
      expect(await snapshot(h, other)).toEqual(keepOther);
      expect(await snapshot(h, app)).toEqual(keepApp);
      await assertUsageConsistent(h, pr, NS_PROD);
      await assertUsageConsistent(h, other, reviewNamespace(other, MOD_1));
      await assertUsageConsistent(h, app, NS_PROD);
      await assertUsageConsistent(h, app, NS_DEV);
    });

    it('is idempotent: a second purge deletes nothing, and a request with no review data is a no-op', async () => {
      const pr = freshRequest('TWICE');
      await seedModerator(store, pr, MOD_1);
      expect((await maint.purgeReview(pr)).rows).toBeGreaterThan(0);
      expect(await maint.purgeReview(pr)).toEqual({ rows: 0 });
      expect(await maint.purgeReview(freshRequest('NEVER'))).toEqual({ rows: 0 });
    });

    it('is one transaction: a failure on the last table leaves every row in place, and a retry finishes', async () => {
      const pr = freshRequest('ATOMIC');
      for (const uid of [MOD_1, MOD_2]) await seedModerator(store, pr, uid);
      const before = await rowsByTable(h, pr);
      const failing: DocStoreDb = {
        async connect() {
          const inner = await h.db.connect();
          const client: DocStoreClient = {
            async query(sql, params) {
              if (/DELETE FROM appdata\.usage_user u/.test(sql)) {
                throw new Error('injected purge failure');
              }
              return inner.query(sql, params);
            },
            release: (err) => inner.release(err),
          };
          return client;
        },
      };
      await expect(createDocStoreMaintenance({ db: failing }).purgeReview(pr)).rejects.toThrow(
        'injected purge failure'
      );
      expect(await rowsByTable(h, pr)).toEqual(before);
      expect((await maint.purgeReview(pr)).rows).toBeGreaterThan(0);
      expect(await rowsByTable(h, pr)).toEqual(NONE);
    });
  });

  describe('listReviewAppIds', () => {
    it('lists exactly the requests holding review data, in id order, by keyset page', async () => {
      // A fresh harness's ids are global to it, so compare against the ids this test seeds.
      const tag = `LIST${(reqSeq += 1)}`;
      const ids = [`pubreq_${tag}a`, `pubreq_${tag}b`, `pubreq_${tag}c`];
      for (const id of ids) await seedModerator(store, id, MOD_1);
      const prodOnly = `pubreq_${tag}p`;
      await store.put(ctx(prodOnly, NS_PROD, MOD_1), PREFS, 'k', { a: 1 });
      await store.put(ctx(prodOnly, NS_DEV, MOD_1), PREFS, 'k', { a: 1 });

      const seen: string[] = [];
      let after = '';
      for (;;) {
        const page = await maint.listReviewAppIds({ after, limit: 2 });
        if (page.length === 0) break;
        seen.push(...page);
        after = page[page.length - 1];
      }
      expect(seen).toEqual([...seen].sort());
      expect(seen.filter((id) => id.startsWith(`pubreq_${tag}`))).toEqual(ids);
      // A document whose usage_app row is gone (a write that overlapped a purge) still lists.
      await h.raw(`DELETE FROM appdata.usage_app WHERE app_id = $1`, [ids[2]]);
      expect(
        (await maint.listReviewAppIds({ after: `pubreq_${tag}`, limit: 10 })).filter((id) =>
          id.startsWith(`pubreq_${tag}`)
        )
      ).toEqual(ids);
      // A request whose review data is purged no longer lists.
      await maint.purgeReview(ids[1]);
      const again = await maint.listReviewAppIds({ after: `pubreq_${tag}`, limit: 10 });
      expect(again.filter((id) => id.startsWith(`pubreq_${tag}`))).toEqual([ids[0], ids[2]]);
    });
  });

  it('every appdata statement carried its bound app id and namespace (or request) as $1', () => {
    // Positive control: the recorder saw the purge and the listing.
    expect(h.statements.some((s) => /DELETE FROM appdata\.usage_app u/.test(s.sql))).toBe(true);
    expect(h.statements.some((s) => /FROM appdata\.usage_app u WHERE u\.ns LIKE/.test(s.sql))).toBe(
      true
    );
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
  await expectCode(
    createDocStoreMaintenance({ db: null }).purgeReview('pubreq_NODB'),
    'storage_disabled'
  );
});
