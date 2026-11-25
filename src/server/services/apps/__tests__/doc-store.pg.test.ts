import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDocStore } from '~/server/services/apps/doc-store';
import { DocStoreError } from '~/server/services/apps/doc-store.types';
import type { DocCollection } from '~/server/services/apps/doc-store.types';
import { barrier, createRealPgHarness, REAL_PG_URL } from './doc-store.harness';
import type { Harness } from './doc-store.harness';
import { defineRlsSuite } from './doc-store.rls';
import {
  assertNumericRetypeIsolated,
  assertUsageConsistent,
  BOARD,
  ctx,
  decl,
  freshApp,
  NS_PROD,
  POSTS,
  PREFS,
} from './doc-store.functional';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The document store against a REAL Postgres server, with one connection per
 * store call so writers genuinely race. This is the only file that exercises
 * concurrency — PGlite is a single session.
 *
 * Needs `APPDATA_TEST_DATABASE_URL`: a superuser URL to a THROWAWAY server (the
 * suite creates and drops its own databases, and the cluster-wide role
 * `appdata_rw`). Never point it at a shared, staging or production database.
 * CI's unit job provides one (a `postgres:18` service in `.github/workflows/lint.yml`).
 * Without it every case here is skipped, and the properties below are NOT
 * exercised by that run: quota under concurrent writers, concurrent reports,
 * the lock timeout, and deadlock-freedom. Everything else is covered by `doc-store.pglite.test.ts`.
 */

if (!REAL_PG_URL) {
  console.warn(
    '[doc-store.pg.test] APPDATA_TEST_DATABASE_URL unset — real-Postgres and concurrency cases SKIPPED'
  );
}

// In CI the unit job provides a Postgres service; a missing URL there means the
// wiring broke, and silently skipping would hide every concurrency property.
describe.runIf(!!process.env.CI)('CI provides a real Postgres', () => {
  it('APPDATA_TEST_DATABASE_URL is set', () => {
    expect(REAL_PG_URL, 'the unit job must set APPDATA_TEST_DATABASE_URL').toBeTruthy();
  });
});

const N = 8;
const DOC = { p: 'xxxxxxxxxx' }; // 19 bytes of jsonb text
const DOC_BYTES = 19;

describe.skipIf(!REAL_PG_URL)('concurrency on Postgres (appdata_rw, RLS on)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createRealPgHarness();
  });
  afterAll(async () => {
    await h?.close();
  });

  const settle = async <T>(ps: Promise<T>[]) => {
    const rs = await Promise.allSettled(ps);
    const ok = rs.filter((r) => r.status === 'fulfilled').length;
    const codes = rs
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => (r.reason instanceof DocStoreError ? r.reason.code : String(r.reason)));
    return { ok, codes };
  };

  it(`app ceiling: ${N} writers parked at the charge together — exactly 3 fit, usage never overshoots`, async () => {
    const app = freshApp('race_app');
    const gate = barrier(N);
    const store = createDocStore({
      db: h.db,
      limits: { appBytes: 3 * DOC_BYTES + 5, appDocs: 1000, userBytes: 10_000, userDocs: 1000 },
      hooks: { beforeUsageCharge: () => gate.wait() },
    });
    const { ok, codes } = await settle(
      Array.from({ length: N }, (_, i) =>
        store.put(ctx(app, NS_PROD, 1000 + i), BOARD, `k${i}`, DOC)
      )
    );
    expect(gate.arrived).toBe(N);
    expect(ok).toBe(3);
    expect(codes).toEqual(Array(N - 3).fill('quota_exceeded'));
    const [u] = await h.raw(
      `SELECT bytes, docs, last_seq FROM appdata.usage_app WHERE app_id = $1`,
      [app]
    );
    expect({ bytes: Number(u.bytes), docs: Number(u.docs), seq: Number(u.last_seq) }).toEqual({
      bytes: 3 * DOC_BYTES,
      docs: 3,
      seq: 3,
    });
    await assertUsageConsistent(h, app, NS_PROD);
  });

  it(`private writes: ${N} viewers parked at the charge under an app ceiling that fits none — all land, each with its own seq`, async () => {
    const app = freshApp('race_private');
    const gate = barrier(N);
    const store = createDocStore({
      db: h.db,
      // Smaller than ONE document: were private writes charged to the app, every one would fail.
      limits: { appBytes: DOC_BYTES - 1, appDocs: 1, userBytes: 10_000, userDocs: 1000 },
      hooks: { beforeUsageCharge: () => gate.wait() },
    });
    const { ok, codes } = await settle(
      Array.from({ length: N }, (_, i) =>
        store.put(ctx(app, NS_PROD, 2000 + i), PREFS, `k${i}`, DOC)
      )
    );
    expect(gate.arrived).toBe(N);
    expect(codes).toEqual([]);
    expect(ok).toBe(N);
    const [u] = await h.raw(
      `SELECT bytes, docs, last_seq FROM appdata.usage_app WHERE app_id = $1`,
      [app]
    );
    expect({ bytes: Number(u.bytes), docs: Number(u.docs), seq: Number(u.last_seq) }).toEqual({
      bytes: 0,
      docs: 0,
      seq: N,
    });
    // The seq still serialises on usage_app: N writes, N distinct seqs 1..N.
    const seqs = await h.raw(`SELECT seq FROM appdata.doc WHERE app_id = $1 ORDER BY seq`, [app]);
    expect(seqs.map((r) => Number(r.seq))).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    await assertUsageConsistent(h, app, NS_PROD);
  });

  it(`viewer ceiling: one viewer, ${N} racing writes — exactly 2 fit (user charges serialise behind usage_app by lock order)`, async () => {
    const app = freshApp('race_user');
    const gate = barrier(N);
    const store = createDocStore({
      db: h.db,
      limits: { appBytes: 1_000_000, appDocs: 1000, userBytes: 2 * DOC_BYTES + 5, userDocs: 1000 },
      hooks: { beforeUsageCharge: () => gate.wait() },
    });
    const { ok, codes } = await settle(
      Array.from({ length: N }, (_, i) => store.put(ctx(app, NS_PROD, 77), PREFS, `k${i}`, DOC))
    );
    expect(gate.arrived).toBe(N);
    expect(ok).toBe(2);
    expect(codes).toEqual(Array(N - 2).fill('quota_exceeded'));
    await assertUsageConsistent(h, app, NS_PROD);
  });

  it('a writer blocked on a held usage row gives up as rate_limited instead of parking its connection', async () => {
    const app = freshApp('locked');
    const store = createDocStore({ db: h.db });
    await store.put(ctx(app, NS_PROD, 1), PREFS, 'seed', { a: 1 });
    const holder = await h.rawAsRole();
    try {
      await holder.query(
        `BEGIN; SELECT set_config('appdata.app_id', '${app}', true), set_config('appdata.ns', '${NS_PROD}', true)`
      );
      await holder.query(
        `SELECT 1 FROM appdata.usage_app u WHERE u.app_id = $1 AND u.ns = $2 FOR UPDATE`,
        [app, NS_PROD]
      );
      const started = Date.now();
      const err = await store.put(ctx(app, NS_PROD, 1), PREFS, 'blocked', { a: 1 }).catch((e) => e);
      const waited = Date.now() - started;
      expect(err).toBeInstanceOf(DocStoreError);
      expect((err as DocStoreError).code).toBe('rate_limited');
      expect(waited).toBeGreaterThanOrEqual(2_900);
      expect(waited).toBeLessThan(15_000);
      await holder.query('ROLLBACK');
    } finally {
      await holder.close();
    }
    expect(await store.get(ctx(app, NS_PROD, 1), PREFS, 'blocked')).toBeNull();
  });

  it('reports: 12 users, each racing 3 identical reports on one doc — exactly 12 report rows', async () => {
    const app = freshApp('race_report');
    const store = createDocStore({ db: h.db });
    await store.put(ctx(app, NS_PROD, 1), POSTS, 'k', { status: 'open' });
    const users = Array.from({ length: 12 }, (_, i) => 500 + i);
    const r = await settle(
      users.flatMap((u) => [0, 1, 2].map(() => store.report(ctx(app, NS_PROD, u), POSTS, 'k')))
    );
    expect(r.codes).toEqual([]);
    const [rows] = await h.raw(
      `SELECT count(*)::int AS n FROM appdata.doc_mark WHERE app_id = $1 AND name = 'report'`,
      [app]
    );
    expect(rows.n).toBe(12);
  });

  it('mixed racing writes and deletes across users and keys settle with no deadlock and consistent usage', async () => {
    const app = freshApp('race_mix');
    const store = createDocStore({ db: h.db });
    const keys = ['a', 'b', 'c'];
    for (const k of keys) await store.put(ctx(app, NS_PROD, 1), BOARD, k, { v: 0 });
    const ops: Promise<unknown>[] = [];
    // 24 operations in flight at once: within a small test server's connection budget.
    for (let i = 0; i < 12; i++) {
      const who = ctx(app, NS_PROD, 1 + (i % 4));
      const k = keys[i % 3];
      if (i % 5 === 0) ops.push(store.delete(who, BOARD, k));
      else ops.push(store.put(who, BOARD, k, { v: i, pad: 'y'.repeat(i) }));
      ops.push(store.put(who, PREFS, `p${i % 2}`, { v: i }));
    }
    const r = await settle(ops);
    // Deadlocks would surface as raw pg errors (40P01); none may appear. Every
    // private write is uncontended by key ownership, so at least those succeed.
    // `own`: a viewer touching another's doc is refused as not_author, never a raw error.
    expect(
      r.codes.filter((c) => !['version_conflict', 'not_found', 'not_author'].includes(c))
    ).toEqual([]);
    expect(r.ok).toBeGreaterThanOrEqual(12);
    await assertUsageConsistent(h, app, NS_PROD);
    const seqs = await h.raw(
      `SELECT seq FROM appdata.doc WHERE app_id = $1 AND ns = $2
       UNION ALL SELECT seq FROM appdata.doc_tomb WHERE app_id = $1 AND ns = $2`,
      [app, NS_PROD]
    );
    expect(new Set(seqs.map((s) => Number(s.seq))).size).toBe(seqs.length);
  });

  it('re-declaring number → boolean or number → time never mixes the old rows into filters or sorts', async () => {
    await assertNumericRetypeIsolated(createDocStore({ db: h.db }), freshApp('pg_numretype'));
  });

  it('an index whose type changed sorts only rows of the declared type, paging both ways', async () => {
    const store = createDocStore({ db: h.db });
    const app = freshApp('pg_retyped');
    const v1 = ctx(app, NS_PROD, 1);
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

  it('the statement recorders saw traffic and no violations', async () => {
    const store = createDocStore({ db: h.db });
    const app = freshApp('pg_recorder');
    await store.put(ctx(app, NS_PROD, 1), POSTS, 'k', { status: 'open' });
    await store.report(ctx(app, NS_PROD, 2), POSTS, 'k');
    await store.list(ctx(app, NS_PROD, 2), POSTS, {
      sort: '-updatedAt',
      where: { status: 'open' },
    });
    await store.delete(ctx(app, NS_PROD, 1), POSTS, 'k');
    expect(h.statements.length).toBeGreaterThan(8);
    expect(h.violations).toEqual([]);
  });
});

describe.skipIf(!REAL_PG_URL)('doc-store RLS probes on Postgres', () => {
  defineRlsSuite(createRealPgHarness);
});
