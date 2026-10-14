import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDocStore } from '~/server/services/apps/doc-store';
import { DocStoreError } from '~/server/services/apps/doc-store.types';
import { barrier, createRealPgHarness, REAL_PG_URL } from './doc-store.harness';
import type { Harness } from './doc-store.harness';
import {
  assertUsageConsistent,
  BOARD,
  ctx,
  defineFunctionalSuite,
  freshApp,
  NS_PROD,
  POSTS,
  PREFS,
} from './doc-store.functional';
import { defineRlsSuite } from './doc-store.rls';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The document store against a REAL Postgres server, with one connection per
 * store call so writers genuinely race. This is the only file that exercises
 * concurrency — PGlite is a single session.
 *
 * Needs `APPDATA_TEST_DATABASE_URL`: a superuser URL to a THROWAWAY server (the
 * suite creates and drops its own databases, and the cluster-wide role
 * `appdata_rw`). Never point it at a shared, staging or production database.
 * Without it every case here is skipped, and the properties below are NOT
 * exercised by that run: quota under concurrent writers, the pre-flight-read
 * control, concurrent marks and counters, and deadlock-freedom.
 */

if (!REAL_PG_URL) {
  console.warn(
    '[doc-store.pg.test] APPDATA_TEST_DATABASE_URL unset — real-Postgres and concurrency cases SKIPPED'
  );
}

describe.skipIf(!REAL_PG_URL)('doc-store on Postgres — superuser (RLS bypassed)', () => {
  defineFunctionalSuite(() => createRealPgHarness({ rls: false }));
});

describe.skipIf(!REAL_PG_URL)('doc-store on Postgres — appdata_rw (RLS on)', () => {
  defineFunctionalSuite(() => createRealPgHarness({ rls: true }));
});

describe.skipIf(!REAL_PG_URL)('doc-store RLS probes on Postgres', () => {
  defineRlsSuite(() => createRealPgHarness({ rls: true }));
});

const N = 8;
const DOC = { p: 'xxxxxxxxxx' }; // 19 bytes of jsonb text
const DOC_BYTES = 19;

describe.skipIf(!REAL_PG_URL)('concurrency on Postgres (appdata_rw, RLS on)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createRealPgHarness({ rls: true });
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

  it(`control: a pre-flight read then write lets ${N} racing writers overshoot the ceiling`, async () => {
    // The pattern the store replaced: read usage, check, then add. All writers
    // read before any writes (the barrier), so every check passes.
    const app = freshApp('preflight');
    const limit = 3 * DOC_BYTES + 5;
    await h.raw(`INSERT INTO appdata.usage_app (app_id, ns) VALUES ($1, $2)`, [app, NS_PROD]);
    const gate = barrier(N);
    const writers = Array.from({ length: N }, async () => {
      const c = await h.rawAsRole();
      try {
        await c.query(
          `BEGIN; SELECT set_config('appdata.app_id', '${app}', true), set_config('appdata.ns', '${NS_PROD}', true)`
        );
        const [u] = await c.query(
          `SELECT u.bytes FROM appdata.usage_app u WHERE u.app_id = $1 AND u.ns = $2`,
          [app, NS_PROD]
        );
        await gate.wait();
        if (Number(u.bytes) + DOC_BYTES > limit) {
          await c.query('ROLLBACK');
          return false;
        }
        await c.query(
          `UPDATE appdata.usage_app u SET bytes = u.bytes + $3 WHERE u.app_id = $1 AND u.ns = $2`,
          [app, NS_PROD, DOC_BYTES]
        );
        await c.query('COMMIT');
        return true;
      } finally {
        await c.close();
      }
    });
    const passed = (await Promise.all(writers)).filter(Boolean).length;
    const [u] = await h.raw(`SELECT bytes FROM appdata.usage_app WHERE app_id = $1`, [app]);
    expect(gate.arrived).toBe(N);
    expect(passed).toBe(N);
    expect(Number(u.bytes)).toBe(N * DOC_BYTES);
    expect(Number(u.bytes)).toBeGreaterThan(limit);
  });

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
        store.put(ctx(app, NS_PROD, 1000 + i), PREFS, `k${i}`, DOC)
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

  it(`viewer ceiling: one viewer, ${N} racing writes — exactly 2 fit`, async () => {
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
    expect(ok).toBe(2);
    expect(codes).toEqual(Array(N - 2).fill('quota_exceeded'));
    await assertUsageConsistent(h, app, NS_PROD);
  });

  it('marks: 12 users, each racing 3 identical marks on one doc — count 12, then 0 after racing unmarks', async () => {
    const app = freshApp('race_mark');
    const store = createDocStore({ db: h.db });
    await store.put(ctx(app, NS_PROD, 1), POSTS, 'k', { status: 'open' });
    const users = Array.from({ length: 12 }, (_, i) => 500 + i);
    await settle(
      users.flatMap((u) =>
        [0, 1, 2].map(() => store.mark(ctx(app, NS_PROD, u), POSTS, 'k', 'vote'))
      )
    );
    const doc = await store.get(ctx(app, NS_PROD, null), POSTS, 'k');
    expect(doc?.marks.vote).toBe(12);
    const [rows] = await h.raw(
      `SELECT count(*)::int AS n FROM appdata.doc_mark WHERE app_id = $1`,
      [app]
    );
    expect(rows.n).toBe(12);
    const un = await settle(
      users.flatMap((u) => [0, 1].map(() => store.unmark(ctx(app, NS_PROD, u), POSTS, 'k', 'vote')))
    );
    expect(un.codes).toEqual([]);
    expect((await store.get(ctx(app, NS_PROD, null), POSTS, 'k'))?.marks.vote).toBe(0);
  });

  it('counters: 20 racing increments of 3 sum exactly', async () => {
    const app = freshApp('race_ctr');
    const store = createDocStore({ db: h.db });
    await store.put(ctx(app, NS_PROD, 1), POSTS, 'k', { status: 'open' });
    const r = await settle(
      Array.from({ length: 20 }, (_, i) =>
        store.increment(ctx(app, NS_PROD, 600 + i), POSTS, 'k', 'views', 3)
      )
    );
    expect(r.codes).toEqual([]);
    expect((await store.get(ctx(app, NS_PROD, null), POSTS, 'k'))?.counters.views).toBe(60);
  });

  it('mixed racing writes, deletes, marks and counters across users and keys settle with no deadlock and consistent usage', async () => {
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
    // Deadlocks would surface as raw pg errors (40P01); none may appear.
    expect(r.codes.filter((c) => !['version_conflict', 'not_found'].includes(c))).toEqual([]);
    await assertUsageConsistent(h, app, NS_PROD);
    const seqs = await h.raw(
      `SELECT seq FROM appdata.doc WHERE app_id = $1 AND ns = $2
       UNION ALL SELECT seq FROM appdata.doc_tomb WHERE app_id = $1 AND ns = $2`,
      [app, NS_PROD]
    );
    expect(new Set(seqs.map((s) => Number(s.seq))).size).toBe(seqs.length);
  });
});
