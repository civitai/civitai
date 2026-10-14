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
    it('every appdata table has RLS enabled AND forced, with the scope policy and the two review-maintenance policies', async () => {
      const rows = await h.raw(
        `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
                (SELECT string_agg(p.policyname || ':' || p.cmd, ',' ORDER BY p.policyname)
                   FROM pg_policies p WHERE p.schemaname = 'appdata' AND p.tablename = c.relname) AS policies
           FROM pg_class c WHERE c.relnamespace = 'appdata'::regnamespace AND c.relkind = 'r' ORDER BY c.relname`
      );
      expect(rows).toEqual(
        [...APPDATA_TABLES].sort().map((t) => ({
          relname: t,
          relrowsecurity: true,
          relforcerowsecurity: true,
          policies: 'appdata_review_delete:DELETE,appdata_review_read:SELECT,appdata_scope:ALL',
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
        // Same app, other namespace: the ns half of WITH CHECK refuses it.
        await c.query('ROLLBACK');
        await c.query(
          `BEGIN; SELECT set_config('appdata.app_id', '${RLS_A}', true), set_config('appdata.ns', 'prod', true)`
        );
        expect(
          await rejects(
            c.query(
              `INSERT INTO appdata.doc (app_id, ns, coll, scope_uid, key, data, version, seq, author_kind)
               VALUES ('${RLS_A}', 'dev:1', 'c', 0, 'k4', '{}', 1, 1, 'app')`
            )
          )
        ).toMatch(/row-level security/);
        await c.query('ROLLBACK');
        await c.query(
          `BEGIN; SELECT set_config('appdata.app_id', '${RLS_A}', true), set_config('appdata.ns', 'dev:1', true)`
        );
        expect(await c.query(`SELECT app_id FROM appdata.doc`)).toEqual([]);
        await c.query('COMMIT');
        // A reused connection: the settings now read '' (not NULL). Still nothing
        // visible, and a row scoped to '' is refused by the POLICY, not only by
        // the non-empty CHECK behind it.
        expect(await c.query(`SELECT current_setting('appdata.app_id', true) AS v`)).toEqual([
          { v: '' },
        ]);
        expect(await c.query(`SELECT app_id FROM appdata.doc`)).toEqual([]);
        expect(
          await rejects(c.query(`INSERT INTO appdata.usage_app (app_id, ns) VALUES ('', '')`))
        ).toMatch(/row-level security/);
      } finally {
        await c.close();
      }
      const [b] = await h.raw(`SELECT version FROM appdata.doc WHERE app_id = $1`, [RLS_B]);
      expect(Number(b.version)).toBe(1);
    });
  });

  describe('review maintenance (appdata.review_maintenance)', () => {
    // A request with review rows AND (impossible in practice, but the clause must not care)
    // prod and dev rows under the same app id, plus another request's review row.
    const REQ = 'pubreq_RLSMAINTREQ';
    const OTHER = 'pubreq_RLSMAINTOTHER';
    const SEED: [string, string][] = [
      [REQ, 'prod'],
      [REQ, 'dev:7'],
      [REQ, `rev:${REQ}:7`],
      [REQ, `rev:${REQ}:8`],
      [OTHER, `rev:${OTHER}:7`],
      [OTHER, 'prod'],
    ];
    const begin = (app: string, maintenance: string) =>
      `BEGIN; SELECT set_config('appdata.app_id', '${app}', true), set_config('appdata.ns', '', true), set_config('appdata.review_maintenance', '${maintenance}', true)`;
    const pairs = (rows: Record<string, unknown>[]) =>
      rows.map((r) => `${r.app_id}|${r.ns}`).sort();
    const all = async (t: string) =>
      pairs(
        await h.raw(`SELECT app_id, ns FROM appdata.${t} WHERE app_id IN ($1, $2)`, [REQ, OTHER])
      );

    beforeAll(async () => {
      for (const [app, ns] of SEED) {
        await h.raw(
          `INSERT INTO appdata.doc (app_id, ns, coll, scope_uid, key, data, version, seq, author_kind)
           VALUES ($1, $2, 'c', 0, 'k', '{}', 1, 1, 'app')`,
          [app, ns]
        );
        await h.raw(`INSERT INTO appdata.usage_app (app_id, ns) VALUES ($1, $2)`, [app, ns]);
      }
    });

    it('positive control: the superuser sees every seeded row', async () => {
      const want = SEED.map(([a, n]) => `${a}|${n}`).sort();
      expect(await all('doc')).toEqual(want);
      expect(await all('usage_app')).toEqual(want);
    });

    it('on, bound to a request: reads and deletes ONLY that request’s review rows — never prod or dev', async () => {
      const c = await h.rawAsRole();
      try {
        await c.query(begin(REQ, 'on'));
        expect(pairs(await c.query(`SELECT app_id, ns FROM appdata.doc`))).toEqual([
          `${REQ}|rev:${REQ}:7`,
          `${REQ}|rev:${REQ}:8`,
        ]);
        // usage_app lists every app's review rows (the sweep's listing), still no prod or dev.
        expect(pairs(await c.query(`SELECT app_id, ns FROM appdata.usage_app`))).toEqual([
          `${OTHER}|rev:${OTHER}:7`,
          `${REQ}|rev:${REQ}:7`,
          `${REQ}|rev:${REQ}:8`,
        ]);
        // Predicate-less deletes reach exactly the bound request's review rows.
        expect(pairs(await c.query(`DELETE FROM appdata.doc RETURNING app_id, ns`))).toEqual([
          `${REQ}|rev:${REQ}:7`,
          `${REQ}|rev:${REQ}:8`,
        ]);
        expect(pairs(await c.query(`DELETE FROM appdata.usage_app RETURNING app_id, ns`))).toEqual([
          `${REQ}|rev:${REQ}:7`,
          `${REQ}|rev:${REQ}:8`,
        ]);
        // Read and delete only: no update, no insert.
        expect(await c.query(`UPDATE appdata.usage_app SET bytes = 9 RETURNING 1`)).toEqual([]);
        expect(
          await rejects(
            c.query(`INSERT INTO appdata.usage_app (app_id, ns) VALUES ('${REQ}', 'rev:${REQ}:9')`)
          )
        ).toMatch(/row-level security/);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.close();
      }
      expect(await all('doc')).toHaveLength(SEED.length);
    });

    it('on, bound to no request: lists review rows on usage_app only, and deletes nothing', async () => {
      const c = await h.rawAsRole();
      try {
        await c.query(begin('', 'on'));
        expect(await c.query(`SELECT app_id FROM appdata.doc`)).toEqual([]);
        expect(pairs(await c.query(`SELECT app_id, ns FROM appdata.usage_app`))).toEqual([
          `${OTHER}|rev:${OTHER}:7`,
          `${REQ}|rev:${REQ}:7`,
          `${REQ}|rev:${REQ}:8`,
        ]);
        expect(await c.query(`DELETE FROM appdata.usage_app RETURNING 1`)).toEqual([]);
        expect(await c.query(`DELETE FROM appdata.doc RETURNING 1`)).toEqual([]);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.close();
      }
    });

    it('any other value, or none, admits nothing; and the setting ends with its transaction', async () => {
      const c = await h.rawAsRole();
      try {
        for (const value of ['off', 'true', '1', 'ON']) {
          await c.query(begin(REQ, value));
          expect(await c.query(`SELECT app_id FROM appdata.usage_app`), value).toEqual([]);
          expect(await c.query(`DELETE FROM appdata.doc RETURNING 1`), value).toEqual([]);
          await c.query('ROLLBACK');
        }
        await c.query(begin(REQ, 'on'));
        expect((await c.query(`SELECT app_id FROM appdata.doc`)).length).toBe(2);
        await c.query('COMMIT');
        // Transaction-local: the same connection afterwards carries '' and sees nothing.
        expect(
          await c.query(`SELECT current_setting('appdata.review_maintenance', true) AS v`)
        ).toEqual([{ v: '' }]);
        expect(await c.query(`SELECT app_id FROM appdata.usage_app`)).toEqual([]);
        expect(await c.query(`DELETE FROM appdata.doc RETURNING 1`)).toEqual([]);
      } finally {
        await c.close();
      }
      expect(await all('doc')).toHaveLength(SEED.length);
    });

    it('the ordinary scope is unchanged by the clause: a prod binding of the request sees its prod row only', async () => {
      const c = await h.rawAsRole();
      try {
        await c.query(
          `BEGIN; SELECT set_config('appdata.app_id', '${REQ}', true), set_config('appdata.ns', 'prod', true)`
        );
        expect(pairs(await c.query(`SELECT app_id, ns FROM appdata.doc`))).toEqual([`${REQ}|prod`]);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.close();
      }
    });
  });
}
