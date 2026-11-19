import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DocStoreDb } from '~/server/services/apps/doc-store';
import { createDocStore } from '~/server/services/apps/doc-store';
import { createPgliteHarness } from './doc-store.harness';
import type { Harness } from './doc-store.harness';
import {
  ctx,
  defineFunctionalSuite,
  expectCode,
  NS_PROD,
  PREFS,
  VIEWER_1,
} from './doc-store.functional';
import { defineRlsSuite } from './doc-store.rls';

// Booting PGlite (WASM Postgres) can exceed the default hook timeout on a contended runner.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The document store against an in-process Postgres (PGlite), running the real
 * migration. PGlite is ONE session, so nothing here races: concurrency (quota
 * overshoot, concurrent marks) is exercised only by `doc-store.pg.test.ts`
 * against a real server.
 */

const harnesses: Harness[] = [];
const track = (opts: { rls: boolean }) => async () => {
  const h = await createPgliteHarness(opts);
  harnesses.push(h);
  return h;
};

describe('doc-store on PGlite — appdata_rw, RLS disabled on the tables: the module predicates alone', () => {
  defineFunctionalSuite(track({ rls: false }));
});

describe('doc-store on PGlite — appdata_rw (RLS on): both layers', () => {
  defineFunctionalSuite(track({ rls: true }));
});

describe('doc-store RLS probes on PGlite', () => {
  defineRlsSuite(track({ rls: true }));
});

describe('the store refuses a role row-level security does not bind', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await track({ rls: true })();
    await h.raw(`CREATE ROLE appdata_bypass NOLOGIN BYPASSRLS`);
    await h.raw(`GRANT appdata_rw TO appdata_bypass`);
  });
  afterAll(async () => {
    await h?.close();
  });
  const me = ctx('ab_ROLECHECK', NS_PROD, VIEWER_1);

  async function refusals(db: DocStoreDb | null) {
    const refused: { name: string; superuser: boolean; bypassRls: boolean }[] = [];
    const store = createDocStore({ db, onRefused: (r) => refused.push(r) });
    for (let i = 0; i < 3; i++) {
      await expectCode(store.put(me, PREFS, `k${i}`, { a: 1 }), 'storage_disabled');
      await expectCode(store.get(me, PREFS, 'k0'), 'storage_disabled');
    }
    return refused;
  }

  it('a superuser connection: every call storage_disabled, logged once, nothing written', async () => {
    expect(await refusals(h.dbAs(null))).toEqual([
      { name: expect.any(String), superuser: true, bypassRls: true },
    ]);
    expect(await h.raw(`SELECT 1 FROM appdata.doc WHERE app_id = 'ab_ROLECHECK'`)).toEqual([]);
  });

  it('a BYPASSRLS (non-superuser) connection: refused the same way', async () => {
    expect(await refusals(h.dbAs('appdata_bypass'))).toEqual([
      { name: 'appdata_bypass', superuser: false, bypassRls: true },
    ]);
  });

  it('no pool configured: storage_disabled, never a fallback', async () => {
    const store = createDocStore({ db: null });
    await expectCode(store.put(me, PREFS, 'k', { a: 1 }), 'storage_disabled');
    await expectCode(store.list(me, PREFS), 'storage_disabled');
  });

  it('positive control: appdata_rw itself is accepted and writes', async () => {
    const refused: unknown[] = [];
    const store = createDocStore({ db: h.dbAs('appdata_rw'), onRefused: (r) => refused.push(r) });
    expect((await store.put(me, PREFS, 'ok', { a: 1 })).version).toBe(1);
    expect(refused).toEqual([]);
  });
});

describe('runtime isolation shape of every statement the store sent', () => {
  // Runs after the suites above (vitest runs a file's tests in order).
  it('every appdata statement carried the bound app id and namespace as $1/$2 and passed the shape scan', () => {
    const statements = harnesses.flatMap((h) => h.statements);
    const violations = harnesses.flatMap((h) => h.violations);
    // Positive control: the recorder saw real traffic, including assembled list SQL.
    expect(statements.length).toBeGreaterThan(300);
    expect(
      statements.filter((s) => /ORDER BY/.test(s.sql) && /appdata\.doc_index sx/.test(s.sql)).length
    ).toBeGreaterThan(5);
    expect(new Set(statements.map((s) => s.app)).size).toBeGreaterThan(10);
    expect(violations).toEqual([]);
  });
});
