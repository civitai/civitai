import type { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  APPLY_STATES,
  DECISION_RULINGS,
  DECISION_SOURCES,
  GROUP_RULINGS,
  MEMBER_RULINGS,
  PENDING_RULINGS,
  initialApplyState,
} from '../../decision-rulings';
import {
  applyDecisionsSchema,
  freshDecisionsDb,
  insertRaw,
  readDecisionsSchemaSql,
  v1DecisionsDb,
} from './decision-resolution-pglite.harness';

/**
 * `apps/moderator/decisions/schema.sql` — EXECUTED. The tuples in `$lib/decision-rulings` and the
 * table's CHECK constraints must admit exactly the same values, in both directions: a value in code
 * the database refuses is a 500 on a moderator's click, and a value the database admits that the code
 * never offers is a silent fourth category every count drops.
 */

let open: PGlite[] = [];
const db = async () => {
  const d = await freshDecisionsDb();
  open.push(d);
  return d;
};
const v1db = async () => {
  const d = await v1DecisionsDb();
  open.push(d);
  return d;
};
afterEach(async () => {
  for (const d of open) await d.close();
  open = [];
});

const CHECK_VIOLATION = '23514';

/** The constraint text Postgres itself reports — the only authority on what it admits. */
async function constraintDef(d: PGlite, name: string): Promise<string> {
  const res = await d.query<{ def: string }>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'decision_resolution'::regclass AND conname = $1`,
    [name]
  );
  expect(res.rows, `${name} is missing`).toHaveLength(1);
  return res.rows[0].def;
}

/** The quoted literals inside a constraint's `IN (…)` / `ANY (ARRAY[…])`. */
const literals = (def: string) => [...def.matchAll(/'([^']+)'/g)].map((m) => m[1]);

describe('the DDL applies', () => {
  it('is re-runnable — a second and third apply are clean and add no duplicate constraint', async () => {
    const d = await db();
    await expect(applyDecisionsSchema(d)).resolves.not.toThrow();
    await expect(applyDecisionsSchema(d)).resolves.not.toThrow();
    const n = await d.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'decision_resolution'::regclass
         AND contype = 'c'`
    );
    expect(n.rows[0].n).toBe(8);
  });

  it('keeps `\\set ON_ERROR_STOP on` ahead of the first statement', () => {
    const sql = readDecisionsSchemaSql();
    const directive = sql.indexOf('\\set ON_ERROR_STOP on');
    expect(directive).toBeGreaterThan(-1);
    expect(directive).toBeLessThan(sql.search(/^\s*(CREATE|ALTER|DROP|DO)\b/im));
  });
});

describe('the CHECK constraints admit exactly the tuples in code', () => {
  it('ruling: the DDL set equals DECISION_RULINGS', async () => {
    const d = await db();
    const def = await constraintDef(d, 'decision_resolution_ruling_valid');
    expect(literals(def).sort()).toEqual([...DECISION_RULINGS].sort());
  });

  it('source: the DDL set equals DECISION_SOURCES', async () => {
    const d = await db();
    const def = await constraintDef(d, 'decision_resolution_source_valid');
    expect(literals(def).sort()).toEqual([...DECISION_SOURCES].sort());
  });

  it('apply_state: the DDL set equals APPLY_STATES', async () => {
    const d = await db();
    const def = await constraintDef(d, 'decision_resolution_apply_state_valid');
    expect(literals(def).sort()).toEqual([...APPLY_STATES].sort());
  });

  it('the member-label set in the scope constraint equals MEMBER_RULINGS', async () => {
    const d = await db();
    const def = await constraintDef(d, 'decision_resolution_scope_valid');
    expect(
      literals(def)
        .filter((l) => l !== '')
        .sort()
    ).toEqual([...MEMBER_RULINGS].sort());
  });

  it('the pending set in the apply constraint equals PENDING_RULINGS', async () => {
    const d = await db();
    const def = await constraintDef(d, 'decision_resolution_apply_matches_ruling');
    expect(
      literals(def)
        .filter((l) => l !== 'n/a')
        .sort()
    ).toEqual([...PENDING_RULINGS].sort());
  });

  it('accepts every group ruling with the fields and apply_state code would write', async () => {
    // Driven off the tuple, so a ruling added in code without a DDL change fails HERE.
    const d = await db();
    for (const ruling of GROUP_RULINGS)
      await expect(
        insertRaw(d, {
          ruling,
          target_key: ruling === 'duplicate_of' ? 'g_bbbbbbbbbbbb' : null,
          escalate_to: ruling === 'escalate' ? 'billing-buzz' : null,
          answer_text: ruling === 'resolved' ? 'Clear the cache, then retry.' : null,
          apply_state: initialApplyState(ruling),
        }),
        ruling
      ).resolves.not.toThrow();
  });

  it('accepts every member label on a sub_key', async () => {
    const d = await db();
    for (const ruling of MEMBER_RULINGS)
      await expect(insertRaw(d, { ruling, sub_key: '10001' }), ruling).resolves.not.toThrow();
  });

  it('refuses an unknown ruling, source and apply_state', async () => {
    const d = await db();
    for (const row of [{ ruling: 'merge' }, { source: 'abuse' }, { apply_state: 'done' }])
      await expect(insertRaw(d, row), JSON.stringify(row)).rejects.toMatchObject({
        code: CHECK_VIOLATION,
      });
  });
});

/** Every CHECK on the table, by name → the definition Postgres reports. */
async function checkDefs(d: PGlite): Promise<Record<string, string>> {
  const res = await d.query<{ name: string; def: string }>(
    `SELECT conname AS name, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'decision_resolution'::regclass AND contype = 'c' ORDER BY conname`
  );
  return Object.fromEntries(res.rows.map((r) => [r.name, r.def]));
}

async function columns(d: PGlite): Promise<string[]> {
  const res = await d.query<{ c: string }>(
    `SELECT column_name AS c FROM information_schema.columns
      WHERE table_name = 'decision_resolution' ORDER BY column_name`
  );
  return res.rows.map((r) => r.c);
}

/**
 * 🔴 THE UPGRADE PATH. Every other test here builds an EMPTY database, and on an empty database a
 * constraint guarded by name is always added with the current body — so an edit that never reaches a
 * database that already has the table passes all of them. This applies the previous version of the
 * file first, the way production meets this one.
 */
describe('applied over the previous version (an existing database)', () => {
  it('ends with exactly the constraints and columns an empty database gets', async () => {
    const upgraded = await v1db();
    await applyDecisionsSchema(upgraded);
    const fresh = await db();
    expect(await checkDefs(upgraded)).toEqual(await checkDefs(fresh));
    expect(await columns(upgraded)).toEqual(await columns(fresh));
  });

  it('admits `resolved` afterwards — the ruling set equals DECISION_RULINGS', async () => {
    const d = await v1db();
    await applyDecisionsSchema(d);
    expect(literals(await constraintDef(d, 'decision_resolution_ruling_valid')).sort()).toEqual(
      [...DECISION_RULINGS].sort()
    );
    await expect(
      insertRaw(d, { ruling: 'resolved', answer_text: 'Reinstall the app.' })
    ).resolves.not.toThrow();
  });

  it('keeps the rows written before it, and re-runs cleanly', async () => {
    const d = await v1db();
    await insertRaw(d, { ruling: 'park', apply_state: 'pending' });
    await insertRaw(d, { ruling: 'unsure', sub_key: '20417' });
    await applyDecisionsSchema(d);
    await applyDecisionsSchema(d);
    const rows = await d.query<{ ruling: string; answer_text: string | null }>(
      'SELECT ruling, answer_text FROM decision_resolution ORDER BY id'
    );
    expect(rows.rows).toEqual([
      { ruling: 'park', answer_text: null },
      { ruling: 'unsure', answer_text: null },
    ]);
  });
});

describe('decision_resolution_answer_valid', () => {
  const TEXT = 'Log out, then sign back in with the same provider.';

  it('accepts a resolved answer, with and without its source', async () => {
    const d = await db();
    await expect(insertRaw(d, { ruling: 'resolved', answer_text: TEXT })).resolves.not.toThrow();
    await expect(
      insertRaw(d, {
        ruling: 'resolved',
        answer_text: TEXT,
        answer_ticket_id: '73618',
        answer_conversation_id: '150003911207',
      })
    ).resolves.not.toThrow();
  });

  // One row per clause; each must be refused by the CHECK, and only that clause is wrong in it.
  const refused: [string, Parameters<typeof insertRaw>[1]][] = [
    ['resolved with no answer', { ruling: 'resolved' }],
    ['resolved with a blank answer', { ruling: 'resolved', answer_text: '  \n ' }],
    ['an answer on another ruling', { ruling: 'correct', answer_text: TEXT }],
    [
      'a source on another ruling',
      { ruling: 'skip', answer_ticket_id: '73618', answer_conversation_id: '150003911207' },
    ],
    ['an answer over 8000 characters', { ruling: 'resolved', answer_text: 'x'.repeat(8001) }],
    [
      'a ticket without its reply',
      { ruling: 'resolved', answer_text: TEXT, answer_ticket_id: '73618' },
    ],
    [
      'a reply without its ticket',
      { ruling: 'resolved', answer_text: TEXT, answer_conversation_id: '150003911207' },
    ],
    [
      'a non-numeric ticket id',
      {
        ruling: 'resolved',
        answer_text: TEXT,
        answer_ticket_id: 'T-73618',
        answer_conversation_id: '150003911207',
      },
    ],
    [
      'a non-numeric reply id',
      {
        ruling: 'resolved',
        answer_text: TEXT,
        answer_ticket_id: '73618',
        answer_conversation_id: 'c150003911207',
      },
    ],
  ];

  it.each(refused)('refuses %s', async (_label, row) => {
    const d = await db();
    await expect(insertRaw(d, row)).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'decision_resolution_answer_valid',
    });
  });

  it('accepts an answer of exactly 8000 characters', async () => {
    const d = await db();
    await expect(
      insertRaw(d, { ruling: 'resolved', answer_text: 'y'.repeat(8000) })
    ).resolves.not.toThrow();
  });
});
