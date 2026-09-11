import type { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import { ABUSE_VERDICTS } from '../../abuse-verdicts';
import {
  allFindings,
  applySchema,
  executableSchemaSql,
  freshDb,
  readSchemaSql,
  seedFinding,
  seedRun,
} from './abuse-detection-pglite.harness';

/**
 * `apps/moderator/abuse-detection/schema.sql` — EXECUTED, not read.
 *
 * See the harness for why this tier exists. In short: the two older tiers fake or compile, so before
 * this file nothing in the app had any claim on the DDL, and a CHECK admitting the wrong set or a
 * file that could not be re-run would pass both of them.
 */

let open: PGlite[] = [];
const db = async () => {
  const next = await freshDb();
  open.push(next);
  return next;
};
afterEach(async () => {
  for (const d of open) await d.close();
  open = [];
});

/** The constraint definition Postgres itself reports, which is the only authority on what it admits. */
async function verdictConstraintDef(d: PGlite): Promise<string | null> {
  const res = await d.query<{ def: string }>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'abuse_detection_finding'::regclass
        AND conname = 'abuse_detection_finding_verdict_valid'`
  );
  return res.rows[0]?.def ?? null;
}

const columnNames = async (d: PGlite, table: string) => {
  const res = await d.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = $1 ORDER BY column_name`,
    [table]
  );
  return res.rows.map((r) => r.column_name);
};

describe('the DDL applies', () => {
  it('creates the four verdict columns on the findings table', async () => {
    const d = await db();
    const columns = await columnNames(d, 'abuse_detection_finding');
    // Named individually rather than as a set diff, so a failure says WHICH column is missing.
    for (const column of ['verdict', 'verdict_by', 'verdict_at', 'group_key'])
      expect(columns, `${column} is missing from the applied schema`).toContain(column);
  });

  it('leaves the producer columns exactly as they were', async () => {
    // 🔴 The regression that would be easiest to introduce and hardest to notice: a migration that
    // "tidied" `actioned`/`action` away, or renamed one into the verdict family. They are a
    // DIFFERENT record — what the detector did — and the whole board's purpose is comparing them.
    const d = await db();
    const columns = await columnNames(d, 'abuse_detection_finding');
    expect(columns).toContain('actioned');
    expect(columns).toContain('action');
  });

  it('is RE-RUNNABLE — applying it twice is clean and changes nothing', async () => {
    // The file is applied by hand, in two environments, by whoever is standing there. It WILL be run
    // twice. A second run that errors leaves the operator unable to tell a partial apply from a
    // complete one, and `ON_ERROR_STOP` then aborts whatever came after.
    const d = await db();
    const before = await columnNames(d, 'abuse_detection_finding');
    await expect(applySchema(d)).resolves.not.toThrow();
    expect(await columnNames(d, 'abuse_detection_finding')).toEqual(before);

    // And still exactly ONE verdict constraint — a `DO $$ … $$` guard that tested the wrong thing
    // would add a second identical one per run rather than erroring, which no column check sees.
    const constraints = await d.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_constraint
        WHERE conrelid = 'abuse_detection_finding'::regclass
          AND conname = 'abuse_detection_finding_verdict_valid'`
    );
    expect(constraints.rows[0].n).toBe(1);
  });

  it('a THIRD apply is still clean — idempotence is not a one-shot property', async () => {
    const d = await db();
    await applySchema(d);
    await expect(applySchema(d)).resolves.not.toThrow();
  });

  it('keeps `\\set ON_ERROR_STOP on` — the harness strips it, so presence is its own claim', () => {
    // 🔴 THIS CANNOT BE PROVEN BY APPLYING THE FILE. `\set` is a psql instruction and the server
    // rejects it, so the harness blanks it before executing — which means execution says nothing
    // about whether it is still there. Without it psql continues past a failed statement, and the
    // file's own comment names the deployment where that leaves NO unique index at all.
    const sql = readSchemaSql();
    expect(sql).toContain('\\set ON_ERROR_STOP on');
    // Before the first statement, or it does not protect the statements that precede it.
    const directive = sql.indexOf('\\set ON_ERROR_STOP on');
    const firstStatement = sql.search(/^\s*(CREATE|ALTER|DROP|DO)\b/im);
    expect(firstStatement).toBeGreaterThan(-1);
    expect(directive).toBeLessThan(firstStatement);
    // And the stripper removed it rather than leaving a line the server would refuse.
    expect(executableSchemaSql(sql)).not.toContain('ON_ERROR_STOP');
  });
});

describe('the verdict CHECK constraint', () => {
  it('accepts each of the three verdicts', async () => {
    const d = await db();
    const runId = await seedRun(d, 'bot-account-detection', '2026-09-03T03:20:00Z');
    // Driven off the shared tuple so a verdict added in code without a DDL change fails HERE, at the
    // seam, rather than in production on the first click.
    for (const verdict of ABUSE_VERDICTS) {
      const id = await seedFinding(d, { runId, userId: 1 });
      await expect(
        d.query(`UPDATE abuse_detection_finding SET verdict = $1 WHERE id = $2`, [verdict, id])
      ).resolves.toBeTruthy();
    }
  });

  it('accepts NULL — unruled is the state every finding starts in', async () => {
    const d = await db();
    const runId = await seedRun(d, 'bot-account-detection', '2026-09-03T03:20:00Z');
    const id = await seedFinding(d, { runId, userId: 1 });
    const rows = await allFindings(d);
    expect(rows.find((r) => r.id === id)?.verdict).toBeNull();
  });

  it.each([
    ['a capitalised verdict', 'TP'],
    ['a trailing space', 'fp '],
    ['a spelled-out verdict', 'false-positive'],
    ['the empty string', ''],
    ['an invented fourth verdict', 'maybe'],
  ])('rejects %s with a CHECK violation', async (_label, verdict) => {
    // 🔴 THE FAILURE'S OWN CODE, not merely "it threw". `23514` is check_violation; a NOT NULL
    // failure, a type error or a missing column would all also throw, and any of them passing here
    // would report this constraint as working while it does not exist.
    const d = await db();
    const runId = await seedRun(d, 'bot-account-detection', '2026-09-03T03:20:00Z');
    const id = await seedFinding(d, { runId, userId: 1 });
    await expect(
      d.query(`UPDATE abuse_detection_finding SET verdict = $1 WHERE id = $2`, [verdict, id])
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('admits EXACTLY the set the application code offers — both directions', async () => {
    // 🔴 THE SEAM, AND IT IS TWO-SIDED. A value in the DDL that the UI never offers is a state
    // nothing can produce and every count query silently drops; a value in the UI that the DDL
    // refuses is a button that 500s. Parsing the constraint Postgres reports — rather than the file
    // text — means a hand-edit to a live database is what is being compared.
    const d = await db();
    const def = await verdictConstraintDef(d);
    expect(def, 'the verdict constraint is not on the table').toBeTruthy();
    const literals = [...(def as string).matchAll(/'([^']*)'/g)].map((m) => m[1]);
    expect([...literals].sort()).toEqual([...ABUSE_VERDICTS].sort());
  });

  it('the code-side tuple is the three verdicts, spelled out', () => {
    // Pinned as LITERALS, never derived from the constraint this file just read: two assertions that
    // both read the database can only prove it agrees with itself.
    expect([...ABUSE_VERDICTS]).toEqual(['tp', 'fp', 'skip']);
  });
});

describe('🔴 a verdict is not an action — the conflation regression', () => {
  it('recording a verdict leaves `actioned` and `action` untouched', async () => {
    // The single most likely future bug on this table, named in the schema's own comment: the two
    // pairs of columns look alike and mean opposite things. `actioned` is what the DETECTOR did;
    // `verdict` is whether a human thinks it was right. A finding the detector acted on, later ruled
    // a false positive, must still record that the action happened.
    const d = await db();
    const runId = await seedRun(d, 'bot-account-detection', '2026-09-03T03:20:00Z');
    const acted = await seedFinding(d, { runId, userId: 1, actioned: true, action: 'exclude' });
    const untouched = await seedFinding(d, { runId, userId: 2, actioned: false, action: null });

    await d.query(
      `UPDATE abuse_detection_finding SET verdict = 'fp', verdict_by = 'mod', verdict_at = now()
        WHERE run_id = $1`,
      [runId]
    );

    const rows = await allFindings(d);
    const a = rows.find((r) => r.id === acted);
    const b = rows.find((r) => r.id === untouched);
    // Literal expectations, not re-reads of what was seeded.
    expect(a).toMatchObject({ actioned: true, action: 'exclude', verdict: 'fp' });
    expect(b).toMatchObject({ actioned: false, action: null, verdict: 'fp' });
  });

  it('the CHECK pairing `actioned` with `action` still holds alongside the verdict columns', async () => {
    // The older constraint, re-asserted here because the new `DO $$ … $$` block runs an ALTER on the
    // same table and a botched one could drop it. `23514` again: the same class, a different rule.
    const d = await db();
    const runId = await seedRun(d, 'bot-account-detection', '2026-09-03T03:20:00Z');
    await expect(
      seedFinding(d, { runId, userId: 1, actioned: true, action: null })
    ).rejects.toMatchObject({ code: '23514' });
  });
});
