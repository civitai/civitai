import { readFileSync } from 'fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DocStore, DocStoreMaintenance } from '~/server/services/apps/doc-store';
import { createDocStore, createDocStoreMaintenance } from '~/server/services/apps/doc-store';
import { purgeViewerDocuments } from '~/server/services/apps/doc-store-purge';
import {
  createPgliteHarness,
  MIGRATION_APP_PURGE_DOWN,
  MIGRATION_APP_PURGE_UP,
  type Harness,
} from './doc-store.harness';
import { ctx, freshApp, NS_PROD, POSTS, PREFS, TALLIES } from './doc-store.functional';
import { APPDATA_TABLES } from './doc-store.sql-scan';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

// Every call here passes its own store; reaching the production instance is a test bug.
vi.mock('~/server/services/apps/doc-store-maintenance.instance', () => ({
  getDocStoreMaintenance: () => {
    throw new Error('test must pass its own store');
  },
}));

/**
 * Bulk deletes through the maintenance object, on the embedded Postgres as `appdata_rw` with
 * row-level security ON (the policy the app-purge migration adds is what lets the enumeration
 * see an app's namespaces at all) and OFF (the module's own predicates alone: a purge statement
 * that lost its app key would reach the bystander app's rows):
 *   - `purgeApp`: every row of one app, every namespace, in batches; nothing of any other app;
 *   - `wipeAccount(uid, { proceed })`: the account wipe stops between namespaces when told to;
 *   - `purgeViewerDocuments`: the server's one entry point to the account wipe takes no app scope.
 * Expected values are literals, never read back from the store under test.
 */

// Pairwise distinct, and distinct from every id and literal the other suites use.
const ALICE = 7_101;
const BOB = 7_202;
const DEV_NS = `dev:${ALICE}`;

/** Rows of `appId` across every appdata table (superuser read, RLS bypassed). */
async function rowsOf(h: Harness, appId: string, ns?: string): Promise<number> {
  let n = 0;
  for (const t of APPDATA_TABLES) {
    const [r] = await h.raw(
      `SELECT count(*)::int AS n FROM appdata.${t} WHERE app_id = $1 AND ($2::text IS NULL OR ns = $2)`,
      [appId, ns ?? null]
    );
    n += Number(r.n);
  }
  return n;
}

/** Docs of `appId` keyed by viewer: private docs by their owner, shared docs by their author. */
async function docsOf(h: Harness, appId: string, uid: number): Promise<number> {
  const [r] = await h.raw(
    `SELECT count(*)::int AS n FROM appdata.doc
      WHERE app_id = $1
        AND (scope_uid = $2 OR (scope_uid = 0 AND author_kind = 'user' AND author_uid = $2))`,
    [appId, uid]
  );
  return Number(r.n);
}

/** Alice and Bob each write private + shared docs, a mark and a counter in prod; Alice in dev. */
async function seed(store: DocStore, appId: string, docsEach = 3): Promise<void> {
  for (const uid of [ALICE, BOB]) {
    const c = ctx(appId, NS_PROD, uid);
    for (let i = 0; i < docsEach; i += 1) {
      await store.put(c, PREFS, `pref-${i}`, { uid, i });
      await store.put(c, POSTS, `post-${uid}-${i}`, { status: 'open' });
    }
  }
  // Each marks the other's post (after both exist), and both count a play.
  for (const uid of [ALICE, BOB]) {
    const c = ctx(appId, NS_PROD, uid);
    await store.mark(c, POSTS, `post-${uid === ALICE ? BOB : ALICE}-0`, 'vote');
    await store.increment(c, TALLIES, 'game', 'plays', 1);
  }
  await store.put(ctx(appId, DEV_NS, ALICE), PREFS, 'dev-pref', { a: 1 });
}

for (const rls of [true, false]) {
  describe(`document-store bulk deletes (pglite, RLS ${rls ? 'on' : 'disabled'})`, () => {
    let h: Harness;
    let store: DocStore;
    let maint: DocStoreMaintenance;

    beforeAll(async () => {
      h = await createPgliteHarness({ rls });
      store = createDocStore({ db: h.db });
      maint = createDocStoreMaintenance({ db: h.db });
    });
    afterAll(async () => {
      if (h) expect(h.violations).toEqual([]);
      await h?.close();
    });

    describe('purgeApp', () => {
      it('deletes every row of the app in every namespace, and nothing of another app', async () => {
        const doomed = freshApp('PURGE');
        const bystander = freshApp('KEEP');
        await seed(store, doomed);
        await seed(store, bystander);
        const keep = await rowsOf(h, bystander);
        expect(await rowsOf(h, doomed, DEV_NS)).toBeGreaterThan(0);
        expect(keep).toBeGreaterThan(20);

        const out = await maint.purgeApp(doomed, { batchRows: 2 });

        expect(out).toMatchObject({ appId: doomed, namespaces: 2, done: true, stopped: false });
        expect(await rowsOf(h, doomed)).toBe(0);
        expect(await rowsOf(h, bystander)).toBe(keep);
        // The bystander app is still fully usable: its usage rows were not touched.
        expect((await store.usage(ctx(bystander, NS_PROD, ALICE))).viewer?.docs).toBeGreaterThan(0);
      });

      it('deletes in batches: a row budget stops it part-way, and a re-run finishes (resumable)', async () => {
        const app = freshApp('RESUME');
        await seed(store, app, 5);
        const before = await rowsOf(h, app);

        const first = await maint.purgeApp(app, { batchRows: 3, maxRows: 4 });
        expect(first).toMatchObject({ done: false, stopped: false });
        // The budget is checked before each batch, so at most one batch overshoots it.
        expect(first.rows).toBeGreaterThanOrEqual(4);
        expect(first.rows).toBeLessThan(4 + 3);
        const left = await rowsOf(h, app);
        expect(left).toBeGreaterThan(0);
        expect(left).toBeLessThan(before);

        expect(await maint.purgeApp(app, { batchRows: 3 })).toMatchObject({ done: true });
        expect(await rowsOf(h, app)).toBe(0);
        // Idempotent: nothing left to find.
        expect(await maint.purgeApp(app)).toEqual({
          appId: app,
          namespaces: 0,
          rows: 0,
          done: true,
          stopped: false,
        });
      });

      it('stops before the next batch when `proceed` says no, and deletes nothing more', async () => {
        const app = freshApp('STOP');
        await seed(store, app, 5);
        let calls = 0;
        const out = await maint.purgeApp(app, {
          batchRows: 2,
          proceed: async () => (calls += 1) <= 1,
        });
        // One transaction ran (one or two rows), then the second `proceed` stopped it.
        expect(out).toMatchObject({ done: false, stopped: true });
        expect(calls).toBe(2);
        expect(out.rows).toBeGreaterThan(0);
        expect(out.rows).toBeLessThanOrEqual(2);
        const before = await rowsOf(h, app);
        expect(before).toBeGreaterThan(20);
        expect(await maint.purgeApp(app, { proceed: async () => false })).toMatchObject({
          rows: 0,
          stopped: true,
        });
        expect(await rowsOf(h, app)).toBe(before);
      });

      it('re-lists the namespaces before reporting done: a namespace written mid-purge is not left behind', async () => {
        const app = freshApp('RELIST');
        await seed(store, app);
        let calls = 0;
        // A write lands in a namespace the purge's first listing could not have seen.
        const out = await maint.purgeApp(app, {
          proceed: async () => {
            calls += 1;
            if (calls === 1) await store.put(ctx(app, 'dev:7303', 7_303), PREFS, 'late', { a: 1 });
            return true;
          },
        });

        expect(out.done).toBe(false);
        expect(await rowsOf(h, app, 'dev:7303')).toBeGreaterThan(0);
        // The next call finds it and finishes.
        expect(await maint.purgeApp(app)).toMatchObject({ done: true, stopped: false });
        expect(await rowsOf(h, app)).toBe(0);
      });
    });

    describe('wipeAccount with proceed', () => {
      it('stops before the next namespace when `proceed` says no; a re-run finishes', async () => {
        // Earlier cases in this harness left Alice data in their apps; start from none, so the
        // four namespaces below are all she has.
        await maint.wipeAccount(ALICE);
        const app = freshApp('WIPESTOP');
        const other = freshApp('WIPESTOP2');
        await seed(store, app);
        await seed(store, other);
        // Alice has rows in four namespaces: prod and her dev namespace, in each app.
        const perNs = async () =>
          Promise.all([app, other].flatMap((a) => [NS_PROD, DEV_NS].map((ns) => rowsOf(h, a, ns))));
        expect(await docsOf(h, app, ALICE)).toBe(7);
        expect(await docsOf(h, other, ALICE)).toBe(7);
        const before = await perNs();

        let calls = 0;
        const out = await maint.wipeAccount(ALICE, { proceed: async () => (calls += 1) <= 1 });

        // One namespace was wiped, then the second `proceed` stopped it; the other three are
        // untouched.
        expect(calls).toBe(2);
        expect(out).toMatchObject({ stopped: true, failures: [] });
        expect(out.namespaces).toHaveLength(1);
        const after = await perNs();
        expect(after.filter((n, i) => n !== before[i])).toHaveLength(1);

        const rest = await maint.wipeAccount(ALICE);
        expect(rest).toMatchObject({ stopped: false, failures: [] });
        expect(await docsOf(h, app, ALICE)).toBe(0);
        expect(await docsOf(h, other, ALICE)).toBe(0);
        // Bob's own documents stay in both apps.
        expect(await docsOf(h, app, BOB)).toBe(6);
        expect(await docsOf(h, other, BOB)).toBe(6);
      });
    });

    describe('purgeViewerDocuments', () => {
      // There is no one-app variant: a caller passing an app expecting a one-app empty would get
      // an every-app wipe if the option were ignored, so it is refused.
      it('refuses an app scope rather than wiping every app', async () => {
        const app = freshApp('NOSCOPE');
        const other = freshApp('NOSCOPE2');
        await seed(store, app);
        await seed(store, other);

        await expect(
          purgeViewerDocuments(ALICE, { appId: app, store: maint } as never)
        ).rejects.toThrow(/appId/);

        expect(await docsOf(h, app, ALICE)).toBe(7);
        expect(await docsOf(h, other, ALICE)).toBe(7);
      });
    });
  });
}

describe('purgeApp without the app-purge policy', () => {
  let h: Harness;
  afterAll(async () => {
    await h?.close();
  });

  it('refuses instead of reporting an app with rows as purged', async () => {
    h = await createPgliteHarness({ rls: true, appPurgePolicy: false });
    const store = createDocStore({ db: h.db });
    const maint = createDocStoreMaintenance({ db: h.db });
    const app = freshApp('NOPOLICY');
    await seed(store, app);
    const before = await rowsOf(h, app);
    expect(before).toBeGreaterThan(0);
    await expect(maint.purgeApp(app)).rejects.toThrow(/app-purge policy is not installed/);
    expect(await rowsOf(h, app)).toBe(before);
  });
});

describe('app-purge migration', () => {
  it('applies twice, rolls back twice, and only admits reads of the one app it is set to', async () => {
    const h = await createPgliteHarness({ rls: true, appPurgePolicy: false });
    try {
      const up = readFileSync(MIGRATION_APP_PURGE_UP, 'utf8');
      const down = readFileSync(MIGRATION_APP_PURGE_DOWN, 'utf8');
      const policies = async () =>
        Number(
          (
            await h.raw(
              `SELECT count(*)::int AS n FROM pg_policies WHERE policyname = 'appdata_app_purge_read'`
            )
          )[0].n
        );
      await h.raw(up);
      await h.raw(up);
      expect(await policies()).toBe(2);
      await h.raw(
        `INSERT INTO appdata.usage_app (app_id, ns, bytes) VALUES ('ab_MIGA', 'prod', 1), ('ab_MIGB', 'prod', 1)`
      );
      const role = await h.rawAsRole();
      try {
        await role.query(`BEGIN; SELECT set_config('appdata.app_purge_id', 'ab_MIGA', true)`);
        const seen = await role.query(`SELECT app_id FROM appdata.usage_app ORDER BY app_id`);
        // Read only: a delete under the setting reaches nothing.
        await role.query(`DELETE FROM appdata.usage_app`);
        const after = await role.query(`SELECT app_id FROM appdata.usage_app`);
        await role.query('COMMIT');
        expect(seen).toEqual([{ app_id: 'ab_MIGA' }]);
        expect(after).toEqual([{ app_id: 'ab_MIGA' }]);
      } finally {
        await role.close();
      }
      await h.raw(down);
      await h.raw(down);
      expect(await policies()).toBe(0);
    } finally {
      await h.close();
    }
  });
});
