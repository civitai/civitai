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
 * These two sites are checked as SOURCE TEXT rather than by executing them,
 * because one is an admin `temp/` endpoint whose handler stack would have to be
 * stood up to reach the statement. The job's statement is additionally covered
 * behaviourally-ish in `src/server/jobs/__tests__/reset-to-draft-without-requirements.test.ts`;
 * this guard exists so the endpoint is not the untested half of one fix.
 *
 * ⚠ SCOPE, stated so this is not read as wider than it is: this is a LEDGER of two
 * named files, not a repo-wide scan. It cannot see a third site that starts
 * drafting models by raw SQL tomorrow. `restoreModelById`
 * (`src/server/services/model.service.ts`) is a KNOWN sibling with the same
 * defect — it raw-SQL-sets `status = CASE WHEN "publishedAt" IS NULL THEN 'Draft'`
 * with no bump, so an un-deleted model lands in Draft with a clock older than its
 * deletion. It is deliberately NOT in this ledger: it is pre-existing, needs its
 * own change and its own review, and adding it here would make this guard
 * permanently red, which is how a guard stops being read.
 */
const repoRoot = path.resolve(__dirname, '../../../..');

/** Files whose raw `UPDATE "Model"` statement moves a model into Draft. */
const LEDGER = [
  'src/server/jobs/reset-to-draft-without-requirements.ts',
  'src/pages/api/admin/temp/backfill-swept-trained-models.ts',
];

/**
 * The `UPDATE "Model"` statement's text, `--` comments stripped.
 *
 * Anchored on `UPDATE "Model" ` WITH the trailing space so it cannot match
 * `UPDATE "ModelVersion"`, and read to the end of the tagged template (the next
 * backtick). Comment stripping is load-bearing: both statements carry `--`
 * comments, and a `-- "updatedAt" = now()` would otherwise satisfy this guard
 * over SQL that does not do it.
 */
function modelUpdateStatement(relPath: string) {
  const source = readFileSync(path.join(repoRoot, relPath), 'utf8');
  const start = source.indexOf('UPDATE "Model" ');
  expect(start, `${relPath} no longer contains a raw UPDATE "Model" statement`).toBeGreaterThan(0);
  const end = source.indexOf('`', start);
  expect(end, `${relPath}: could not find the end of the tagged template`).toBeGreaterThan(start);
  return source.slice(start, end).replace(/--[^\n]*/g, ' ');
}

describe('a raw SQL write that drafts a Model bumps its "updatedAt"', () => {
  it.each(LEDGER)('%s sets "updatedAt" = now()', (relPath) => {
    expect(
      modelUpdateStatement(relPath),
      `${relPath}: without the bump this model is immediately reapable by remove-old-drafts, which cascade-deletes it`
    ).toContain('"updatedAt" = now()');
  });

  // POSITIVE CONTROL. Without it, a renamed or deleted file would make the
  // assertion above vacuous rather than red — and a ledger that silently checks
  // nothing is the failure mode this whole class of guard is prone to.
  it.each(LEDGER)('%s actually drafts a model, so the guard above is not vacuous', (relPath) => {
    expect(
      modelUpdateStatement(relPath),
      `${relPath} no longer writes Draft status; if that is intended, remove it from the ledger`
    ).toContain(`'Draft'`);
  });
});
