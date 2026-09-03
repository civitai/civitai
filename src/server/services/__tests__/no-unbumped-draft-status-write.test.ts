import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * A raw-SQL write that moves a `Model` into `Draft` must also set
 * `"updatedAt" = now()`.
 *
 * `Model."updatedAt"` is a Prisma `@updatedAt` column, so it moves only on a
 * client-side write. `$executeRaw` / `$queryRaw` bypass that, and the row keeps
 * whatever timestamp it carried before — routinely years old.
 * `src/server/jobs/remove-old-drafts.ts` reaps
 * `status IN ('Draft','Deleted') AND m."updatedAt" < now() - INTERVAL '30 days'`
 * and cascade-deletes the model with its versions, files and training data,
 * irreversibly. A model drafted by raw SQL without the bump therefore enters the
 * reapable state with its entire 30-day grace period already spent.
 *
 * These sites are checked as SOURCE TEXT rather than by executing them, because
 * one is an admin `temp/` endpoint whose handler stack would have to be stood up
 * to reach the statement. Two of the three are additionally covered
 * behaviourally: the job's statement in
 * `src/server/jobs/__tests__/reset-to-draft-without-requirements.test.ts`, and
 * `restoreModelById`'s in
 * `src/server/services/__tests__/restore-model-updated-at.service.test.ts`. This
 * guard exists so the endpoint is not the untested half of one fix, and so all
 * three sites are held to one rule in one place.
 *
 * ⚠ SCOPE, stated so this is not read as wider than it is: this is a LEDGER of
 * named files, not a repo-wide scan. It cannot see a fourth site that starts
 * drafting models by raw SQL tomorrow. As of this writing the ledger is
 * complete — an enumeration of every raw `UPDATE "Model"` in the tree found
 * exactly these three writing `Draft`; `republish-orphaned-drafts.ts` and
 * `process-scheduled-publishing.ts` write `Published` and are out of scope.
 * Adding a site here is part of adding one to the tree.
 */
const repoRoot = path.resolve(__dirname, '../../../..');

/** Files with a raw `UPDATE "Model"` statement that moves a model into Draft. */
const LEDGER = [
  'src/server/jobs/reset-to-draft-without-requirements.ts',
  'src/pages/api/admin/temp/backfill-swept-trained-models.ts',
  'src/server/services/model.service.ts',
];

/**
 * EVERY raw `UPDATE "Model"` statement in a file, `--` comments stripped.
 *
 * 🔴 All of them, not the first one — and the anchor includes the CLOSING quote
 * rather than a trailing space. Both details are load-bearing and both were
 * wrong here before `restoreModelById` joined the ledger:
 *
 *  - a trailing-space anchor (`UPDATE "Model" `) cannot see a statement that
 *    breaks the line after the table name, which is how `restoreModelById`
 *    writes it. The closing quote is what excludes `UPDATE "ModelVersion"`;
 *    the space was never doing that job.
 *  - `model.service.ts` holds SEVEN raw `UPDATE "Model"` statements and only
 *    one of them drafts. Taking the first match would have anchored this guard
 *    on `captureMinorFlagSnapshot`'s meta write — a different statement, in a
 *    different function, with nothing to do with the reaper.
 *
 * 🔴 The two defects COMPOSE, which is why neither was visible on its own. The
 * drafting statement is the FIRST of the seven, so a first-match rule alone
 * would have found it; it is the space anchor that skips it, and only then does
 * first-match land on the meta write. Fixing either half in isolation would have
 * produced a guard that happened to be right for the wrong reason.
 *
 * 🔴 And the reason no review round could have caught this: both files this
 * extractor was originally written against hold EXACTLY ONE raw `UPDATE "Model"`
 * each, and both spell it `UPDATE "Model" m` — with a space, because of the
 * alias. Both assumptions were therefore true of the entire corpus the guard
 * could see. A guard's doc comment states a RULE ("a raw-SQL write that drafts a
 * Model"); its implementation covered two files that happened to satisfy two
 * unstated assumptions. Nothing short of pointing it at a file it was not
 * written for can tell those apart — which is exactly what adding the third site
 * did. When extending a ledger like this, re-derive the extractor against the
 * NEW file before trusting the green it reports.
 *
 * Each statement is read to the end of its tagged template (the next backtick).
 * That over-reads on a template carrying an interpolated expression, which is
 * deliberate: it can only pull MORE text into scope, so it fails closed.
 * Comment stripping is load-bearing too — these statements carry `--` comments,
 * and a `-- "updatedAt" = now()` would otherwise satisfy this guard over SQL
 * that does not do it.
 */
function modelUpdateStatements(relPath: string): string[] {
  const source = readFileSync(path.join(repoRoot, relPath), 'utf8');
  const statements: string[] = [];
  for (let start = source.indexOf('UPDATE "Model"'); start >= 0; ) {
    const end = source.indexOf('`', start);
    expect(end, `${relPath}: could not find the end of the tagged template`).toBeGreaterThan(start);
    statements.push(source.slice(start, end).replace(/--[^\n]*/g, ' '));
    start = source.indexOf('UPDATE "Model"', end);
  }
  expect(
    statements.length,
    `${relPath} no longer contains a raw UPDATE "Model" statement`
  ).toBeGreaterThan(0);
  return statements;
}

/** Of those, the ones that write `Draft` status — the only ones this rule binds. */
function draftingStatements(relPath: string): string[] {
  return modelUpdateStatements(relPath).filter((sql) => sql.includes(`'Draft'`));
}

describe('a raw SQL write that drafts a Model bumps its "updatedAt"', () => {
  it.each(LEDGER)('%s sets "updatedAt" = now() on every drafting statement', (relPath) => {
    for (const statement of draftingStatements(relPath)) {
      expect(
        statement,
        `${relPath}: without the bump this model is immediately reapable by remove-old-drafts, which cascade-deletes it`
      ).toContain('"updatedAt" = now()');
    }
  });

  // POSITIVE CONTROL. Without it, a renamed file, a moved statement or a
  // reworded `Draft` literal would make the assertion above vacuous rather than
  // red — it iterates an empty list and passes. A ledger that silently checks
  // nothing is the failure mode this whole class of guard is prone to.
  it.each(LEDGER)('%s actually drafts a model, so the guard above is not vacuous', (relPath) => {
    expect(
      draftingStatements(relPath).length,
      `${relPath} no longer writes Draft status in a raw UPDATE "Model"; if that is intended, remove it from the ledger`
    ).toBeGreaterThan(0);
  });
});
