// Row-level security probes: raw statements as `appdata_rw` that carry NO
// isolation predicate, so the policies are the only thing standing between them
// and another app's rows. Shared by the PGlite and real-Postgres files.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Harness } from './doc-store.harness';
import { APPDATA_TABLES } from './doc-store.sql-scan';

const RLS_A = 'ab_RLSPROBEA';
const RLS_B = 'ab_RLSPROBEB';

async function rejects(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return String((err as Error).message);
  }
  throw new Error('expected the statement to be refused');
}

export function defineRlsSuite(makeHarness: () => Promise<Harness>) {
  let h: Harness;
  beforeAll(async () => {
    h = await makeHarness();
    for (const app of [RLS_A, RLS_B]) {
      await h.raw(
        `INSERT INTO appdata.doc (app_id, ns, coll, scope_uid, key, data, version, seq, author_kind)
         VALUES ($1, 'prod', 'c', 0, 'k', '{}', 1, 1, 'app')`,
        [app]
      );
    }
  });
  afterAll(async () => {
    await h?.close();
  });

  describe('row-level security (second isolation layer)', () => {
    it('every appdata table has RLS enabled AND forced, with the one scope policy', async () => {
      const rows = await h.raw(
        `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
                (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'appdata' AND p.tablename = c.relname)::int AS policies
           FROM pg_class c WHERE c.relnamespace = 'appdata'::regnamespace AND c.relkind = 'r' ORDER BY c.relname`
      );
      expect(rows).toEqual(
        [...APPDATA_TABLES].sort().map((t) => ({
          relname: t,
          relrowsecurity: true,
          relforcerowsecurity: true,
          policies: 1,
        }))
      );
    });

    it('the superuser sees both rows (positive control: the rows exist)', async () => {
      const rows = await h.raw(
        `SELECT app_id FROM appdata.doc WHERE app_id IN ($1, $2) ORDER BY app_id`,
        [RLS_A, RLS_B]
      );
      expect(rows.map((r) => r.app_id)).toEqual([RLS_A, RLS_B]);
    });

    it('without the setting a predicate-less read sees nothing and an insert is refused', async () => {
      const c = await h.rawAsRole();
      try {
        expect(await c.query(`SELECT app_id FROM appdata.doc`)).toEqual([]);
        expect(await c.query(`SELECT app_id FROM appdata.usage_app`)).toEqual([]);
        const msg = await rejects(
          c.query(
            `INSERT INTO appdata.doc (app_id, ns, coll, scope_uid, key, data, version, seq, author_kind)
             VALUES ('${RLS_A}', 'prod', 'c', 0, 'k2', '{}', 1, 1, 'app')`
          )
        );
        expect(msg).toMatch(/row-level security/);
      } finally {
        await c.close();
      }
    });

    it('bound to app A, a predicate-less statement reaches only app A — and the binding ends with the transaction', async () => {
      const c = await h.rawAsRole();
      try {
        await c.query(
          `BEGIN; SELECT set_config('appdata.app_id', '${RLS_A}', true), set_config('appdata.ns', 'prod', true)`
        );
        expect((await c.query(`SELECT app_id FROM appdata.doc`)).map((r) => r.app_id)).toEqual([
          RLS_A,
        ]);
        expect(
          await c.query(`UPDATE appdata.doc SET version = 99 WHERE app_id = '${RLS_B}' RETURNING 1`)
        ).toEqual([]);
        expect(
          await c.query(`DELETE FROM appdata.doc WHERE app_id = '${RLS_B}' RETURNING 1`)
        ).toEqual([]);
        const msg = await rejects(
          c.query(
            `INSERT INTO appdata.doc (app_id, ns, coll, scope_uid, key, data, version, seq, author_kind)
             VALUES ('${RLS_B}', 'prod', 'c', 0, 'k3', '{}', 1, 1, 'app')`
          )
        );
        expect(msg).toMatch(/row-level security/);
        await c.query('ROLLBACK');
        await c.query(
          `BEGIN; SELECT set_config('appdata.app_id', '${RLS_A}', true), set_config('appdata.ns', 'dev:1', true)`
        );
        expect(await c.query(`SELECT app_id FROM appdata.doc`)).toEqual([]);
        await c.query('COMMIT');
        expect(await c.query(`SELECT app_id FROM appdata.doc`)).toEqual([]);
      } finally {
        await c.close();
      }
      const [b] = await h.raw(`SELECT version FROM appdata.doc WHERE app_id = $1`, [RLS_B]);
      expect(Number(b.version)).toBe(1);
    });
  });
}
