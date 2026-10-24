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
    it('every appdata table has RLS enabled AND forced, with the scope policy, the two review-maintenance policies, and the account-wipe read on usage_user and doc_mark only', async () => {
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
          policies:
            (t === 'usage_user' || t === 'doc_mark' ? 'appdata_account_wipe_read:SELECT,' : '') +
            'appdata_review_delete:DELETE,appdata_review_read:SELECT,appdata_scope:ALL',
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
        // One row in each of the other five tables too, so every table's policy is probed.
        await h.raw(
          `INSERT INTO appdata.doc_index (app_id, ns, coll, scope_uid, key, name, v_type, v_text)
           VALUES ($1, $2, 'c', 0, 'k', 'i', 'string', 'v')`,
          [app, ns]
        );
        await h.raw(
          `INSERT INTO appdata.doc_tally (app_id, ns, coll, key, kind, name, count)
           VALUES ($1, $2, 'c', 'k', 'counter', 'n', 1)`,
          [app, ns]
        );
        await h.raw(
          `INSERT INTO appdata.doc_mark (app_id, ns, coll, key, name, user_id) VALUES ($1, $2, 'c', 'k', 'n', 7)`,
          [app, ns]
        );
        await h.raw(
          `INSERT INTO appdata.doc_tomb (app_id, ns, coll, scope_uid, key, seq) VALUES ($1, $2, 'c', 0, 'gone', 1)`,
          [app, ns]
        );
        await h.raw(`INSERT INTO appdata.usage_user (app_id, ns, user_id) VALUES ($1, $2, 7)`, [
          app,
          ns,
        ]);
      }
    });

    const OTHER_TABLES = ['doc_index', 'doc_tally', 'doc_mark', 'doc_tomb', 'usage_user'];

    it('every table: bound to a request, reads only its review rows; bound to none, reads nothing outside doc and usage_app', async () => {
      const c = await h.rawAsRole();
      try {
        for (const t of [...OTHER_TABLES, 'doc', 'usage_app']) {
          await c.query(begin(REQ, 'on'));
          expect({ t, rows: pairs(await c.query(`SELECT app_id, ns FROM appdata.${t}`)) }).toEqual({
            t,
            rows: [`${REQ}|rev:${REQ}:7`, `${REQ}|rev:${REQ}:8`],
          });
          await c.query('ROLLBACK');
        }
        for (const t of OTHER_TABLES) {
          await c.query(begin('', 'on'));
          expect({ t, rows: await c.query(`SELECT app_id FROM appdata.${t}`) }).toEqual({
            t,
            rows: [],
          });
          await c.query('ROLLBACK');
        }
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.close();
      }
    });

    it('positive control: the superuser sees every seeded row', async () => {
      const want = SEED.map(([a, n]) => `${a}|${n}`).sort();
      for (const t of APPDATA_TABLES) expect({ t, rows: await all(t) }).toEqual({ t, rows: want });
    });

    it('on, bound to a request: reads and deletes ONLY that request’s review rows — never prod or dev', async () => {
      const c = await h.rawAsRole();
      try {
        await c.query(begin(REQ, 'on'));
        expect(pairs(await c.query(`SELECT app_id, ns FROM appdata.doc`))).toEqual([
          `${REQ}|rev:${REQ}:7`,
          `${REQ}|rev:${REQ}:8`,
        ]);
        expect(pairs(await c.query(`SELECT app_id, ns FROM appdata.usage_app`))).toEqual([
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

    it('on, bound to no request: reads every app’s review rows on doc and usage_app (the listing) — still no prod or dev — and deletes nothing', async () => {
      const c = await h.rawAsRole();
      try {
        await c.query(begin('', 'on'));
        const reviewRows = [
          `${OTHER}|rev:${OTHER}:7`,
          `${REQ}|rev:${REQ}:7`,
          `${REQ}|rev:${REQ}:8`,
        ];
        expect(pairs(await c.query(`SELECT app_id, ns FROM appdata.doc`))).toEqual(reviewRows);
        expect(pairs(await c.query(`SELECT app_id, ns FROM appdata.usage_app`))).toEqual(
          reviewRows
        );
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

    it('the ordinary scope is unchanged by the review clause: a prod binding of the request sees its prod row only', async () => {
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

  describe('account-wipe enumeration (appdata.account_wipe_uid)', () => {
    // Two users with rows in every table, in two apps and in prod, both users' dev namespaces
    // and a review namespace — every row naming its user in every column that can.
    const WIPED = 7_017;
    const OTHER = 7_029;
    const APP_1 = 'ab_RLSWIPEONE';
    const APP_2 = 'ab_RLSWIPETWO';
    const NAMESPACES = ['prod', `dev:${WIPED}`, `dev:${OTHER}`, `rev:${APP_1}:${WIPED}`];
    const SEEDED: [string, string, number][] = [];
    for (const app of [APP_1, APP_2]) {
      for (const ns of NAMESPACES) for (const uid of [WIPED, OTHER]) SEEDED.push([app, ns, uid]);
    }
    const begin = (uid: string) =>
      `BEGIN; SELECT set_config('appdata.app_id', '', true), set_config('appdata.ns', '', true), set_config('appdata.account_wipe_uid', '${uid}', true)`;
    const rowsOf = (rows: Record<string, unknown>[]) =>
      rows.map((r) => `${r.app_id}|${r.ns}|${r.user_id}`).sort();
    const want = (uid: number) =>
      SEEDED.filter(([, , u]) => u === uid)
        .map(([a, n, u]) => `${a}|${n}|${u}`)
        .sort();
    const PER_USER = ['usage_user', 'doc_mark'];
    const OTHERS = ['doc', 'doc_index', 'doc_tally', 'doc_tomb', 'usage_app'];
    const count = async (t: string) =>
      Number(
        (
          await h.raw(`SELECT count(*)::int AS n FROM appdata.${t} WHERE app_id IN ($1, $2)`, [
            APP_1,
            APP_2,
          ])
        )[0].n
      );

    beforeAll(async () => {
      for (const [app, ns, uid] of SEEDED) {
        const key = `k${uid}`;
        await h.raw(
          `INSERT INTO appdata.doc (app_id, ns, coll, scope_uid, key, data, version, seq, author_uid, author_kind, last_writer_uid)
           VALUES ($1, $2, 'c', $3, $4, '{}', 1, 1, $3, 'user', $3)`,
          [app, ns, uid, key]
        );
        await h.raw(
          `INSERT INTO appdata.doc_index (app_id, ns, coll, scope_uid, key, name, v_type, v_text)
           VALUES ($1, $2, 'c', $3, $4, 'i', 'string', 'v')`,
          [app, ns, uid, key]
        );
        await h.raw(
          `INSERT INTO appdata.doc_tally (app_id, ns, coll, key, kind, name, count)
           VALUES ($1, $2, 'c', $3, 'mark', 'vote', 1)`,
          [app, ns, key]
        );
        await h.raw(
          `INSERT INTO appdata.doc_mark (app_id, ns, coll, key, name, user_id) VALUES ($1, $2, 'c', 'k', 'vote', $3)`,
          [app, ns, uid]
        );
        await h.raw(
          `INSERT INTO appdata.doc_tomb (app_id, ns, coll, scope_uid, key, seq) VALUES ($1, $2, 'c', $3, 'gone', 1)`,
          [app, ns, uid]
        );
        await h.raw(
          `INSERT INTO appdata.usage_user (app_id, ns, user_id, bytes, docs) VALUES ($1, $2, $3, 2, 1)`,
          [app, ns, uid]
        );
      }
      for (const app of [APP_1, APP_2]) {
        for (const ns of NAMESPACES) {
          await h.raw(`INSERT INTO appdata.usage_app (app_id, ns) VALUES ($1, $2)`, [app, ns]);
        }
      }
    });

    it('positive control: the superuser sees both users’ rows in every table', async () => {
      for (const t of PER_USER) {
        expect({
          t,
          rows: rowsOf(
            await h.raw(`SELECT app_id, ns, user_id FROM appdata.${t} WHERE app_id IN ($1, $2)`, [
              APP_1,
              APP_2,
            ])
          ),
        }).toEqual({
          t,
          rows: [...want(WIPED), ...want(OTHER)].sort(),
        });
      }
      for (const t of OTHERS)
        expect({ t, n: await count(t) }).toEqual({ t, n: t === 'usage_app' ? 8 : 16 });
    });

    it('bound to one user: a predicate-less read of usage_user and doc_mark returns exactly that user’s rows in every app and namespace — and nothing of any other table', async () => {
      const c = await h.rawAsRole();
      try {
        for (const uid of [WIPED, OTHER]) {
          for (const t of PER_USER) {
            await c.query(begin(String(uid)));
            expect({
              uid,
              t,
              rows: rowsOf(await c.query(`SELECT app_id, ns, user_id FROM appdata.${t}`)),
            }).toEqual({
              uid,
              t,
              rows: want(uid),
            });
            await c.query('ROLLBACK');
          }
          // The documents, tallies, tombstones and app usage stay invisible, although every
          // seeded document names this user as its scope, author and last writer.
          for (const t of OTHERS) {
            await c.query(begin(String(uid)));
            expect({ uid, t, rows: await c.query(`SELECT 1 FROM appdata.${t}`) }).toEqual({
              uid,
              t,
              rows: [],
            });
            await c.query('ROLLBACK');
          }
        }
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.close();
      }
    });

    it('read only: under the setting a predicate-less update or delete touches nothing and an insert is refused', async () => {
      const c = await h.rawAsRole();
      try {
        await c.query(begin(String(WIPED)));
        for (const t of PER_USER) {
          expect({ t, rows: await c.query(`DELETE FROM appdata.${t} RETURNING 1`) }).toEqual({
            t,
            rows: [],
          });
          expect({
            t,
            rows: await c.query(`UPDATE appdata.${t} SET user_id = user_id RETURNING 1`),
          }).toEqual({
            t,
            rows: [],
          });
        }
        // A row of the bound user itself, in a namespace it has none in: a policy that admitted
        // writes for "the user's rows" would let this through.
        for (const sql of [
          `INSERT INTO appdata.usage_user (app_id, ns, user_id) VALUES ('${APP_2}', 'dev:1', ${WIPED})`,
          `INSERT INTO appdata.doc_mark (app_id, ns, coll, key, name, user_id) VALUES ('${APP_2}', 'dev:1', 'c', 'k', 'vote', ${WIPED})`,
        ]) {
          expect(await rejects(c.query(sql))).toMatch(/row-level security/);
          await c.query('ROLLBACK');
          await c.query(begin(String(WIPED)));
        }
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.close();
      }
      for (const t of PER_USER) expect({ t, n: await count(t) }).toEqual({ t, n: 16 });
    });

    it('any value that is not exactly the user id admits nothing, without an error; and the setting ends with its transaction', async () => {
      const c = await h.rawAsRole();
      try {
        for (const value of [
          '',
          `0${WIPED}`,
          ` ${WIPED}`,
          `${WIPED} `,
          `+${WIPED}`,
          `${WIPED}.0`,
          `-${WIPED}`,
          'abc',
          '%',
        ]) {
          await c.query(begin(value));
          for (const t of PER_USER) {
            expect({ value, t, rows: await c.query(`SELECT 1 FROM appdata.${t}`) }).toEqual({
              value,
              t,
              rows: [],
            });
          }
          await c.query('ROLLBACK');
        }
        await c.query(begin(String(WIPED)));
        expect((await c.query(`SELECT 1 FROM appdata.usage_user`)).length).toBe(want(WIPED).length);
        await c.query('COMMIT');
        expect(
          await c.query(`SELECT current_setting('appdata.account_wipe_uid', true) AS v`)
        ).toEqual([{ v: '' }]);
        expect(await c.query(`SELECT 1 FROM appdata.usage_user`)).toEqual([]);
        expect(await c.query(`SELECT 1 FROM appdata.doc_mark`)).toEqual([]);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.close();
      }
    });

    it('the ordinary scope is unchanged by the wipe clause: a prod binding sees that app’s prod rows of both users, no other app', async () => {
      const c = await h.rawAsRole();
      try {
        await c.query(
          `BEGIN; SELECT set_config('appdata.app_id', '${APP_1}', true), set_config('appdata.ns', 'prod', true)`
        );
        expect(rowsOf(await c.query(`SELECT app_id, ns, user_id FROM appdata.usage_user`))).toEqual(
          [`${APP_1}|prod|${WIPED}`, `${APP_1}|prod|${OTHER}`].sort()
        );
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.close();
      }
    });
  });
}
