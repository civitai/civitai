import { readFileSync } from 'fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createPgliteHarness, MIGRATION_DOWN, MIGRATION_UP } from './doc-store.harness';
import type { Harness } from './doc-store.harness';
import { defineFunctionalSuite } from './doc-store.functional';
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

describe('doc-store on PGlite — superuser (RLS bypassed): the module predicates alone', () => {
  defineFunctionalSuite(track({ rls: false }));
});

describe('doc-store on PGlite — appdata_rw (RLS on): both layers', () => {
  defineFunctionalSuite(track({ rls: true }));
});

describe('doc-store RLS probes on PGlite', () => {
  defineRlsSuite(track({ rls: true }));
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

describe('migration', () => {
  const up = readFileSync(MIGRATION_UP, 'utf8');
  const down = readFileSync(MIGRATION_DOWN, 'utf8');
  let pg: PGlite;
  afterAll(async () => {
    await pg?.close();
  });

  it('applies twice (idempotent), rolls back twice, and re-applies', async () => {
    pg = new PGlite();
    const tables = async () =>
      (
        await pg.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'appdata'`
        )
      ).rows[0].n;
    await pg.exec(up);
    await pg.exec(`INSERT INTO appdata.usage_app (app_id, ns, bytes) VALUES ('ab_MIG', 'prod', 5)`);
    await pg.exec(up);
    expect(await tables()).toBe(7);
    // Re-applying keeps data.
    expect(
      (await pg.query<{ bytes: number }>(`SELECT bytes::int FROM appdata.usage_app`)).rows
    ).toEqual([{ bytes: 5 }]);
    await pg.exec(down);
    await pg.exec(down);
    expect(await tables()).toBe(0);
    expect((await pg.query(`SELECT 1 FROM pg_roles WHERE rolname = 'appdata_rw'`)).rows).toEqual(
      []
    );
    await pg.exec(up);
    expect(await tables()).toBe(7);
  });
});
