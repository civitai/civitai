import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('~/server/jobs/job', () => ({ createJob: (_n: string, _c: string, fn: unknown) => fn }));
vi.mock('~/utils/logging', () => ({ createLogger: () => () => undefined }));

import { resetToDraftWithoutRequirements } from '~/server/jobs/reset-to-draft-without-requirements';
import { dbMock } from '~/__tests__/mocks/db.mock';

const mockDbWrite = dbMock.dbWrite;

const runJob = () => (resetToDraftWithoutRequirements as unknown as () => Promise<void>)();

// Fixture version ids. Deliberately distinct from each other, from every batch
// boundary in the job (500), and from any literal these guards assert on, so a
// mutant cannot pass by landing on a constant one of them happens to equal.
const NO_POSTS_VERSION_IDS = [101, 102];
const NO_FILES_VERSION_IDS = [203];

/**
 * Every `$executeRaw` statement the job issued, with `--` comments stripped and
 * whitespace collapsed.
 *
 * 🔴 EVERY guard below reads THIS, never the raw template text. These are SPELLED
 * guards over SQL source, and a `--` comment is not a clause — matching against
 * un-stripped text is wrong in both directions. A comment that merely quotes a
 * clause SATISFIES a `toContain` guard with the real clause deleted (so a future
 * `-- also sets "updatedAt" = now()` would green the fix guard over unfixed SQL),
 * and a comment that mentions a clause gets COUNTED as one. Both hazards are live
 * here, not hypothetical: the final `UPDATE "Model"` statement already carries a
 * `--` comment inside its own WHERE clause, as do both SELECTs.
 *
 * ⚠ This is an approximation of what Postgres executes, not a SQL parser. A `--`
 * inside a quoted string literal is stripped here but is not a comment to the
 * database, so a clause written after one on the same line would be invisible to
 * every guard below. Nothing in this job is near that shape.
 */
function executableStatements(): string[] {
  return mockDbWrite.$executeRaw.mock.calls.map(([strings]) =>
    (strings as string[])
      .join('?')
      .replace(/--[^\n]*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * The single `UPDATE "Model"` statement — the one that flips the parent model to
 * Draft/Unpublished. Asserting there is exactly one is the positive control for
 * every guard built on it: without it a job that stopped issuing the statement
 * (or a mock wired to nothing) would satisfy them by returning `undefined`.
 */
function modelUpdateSql(): string {
  const matches = executableStatements().filter((sql) => sql.startsWith('UPDATE "Model" '));
  expect(matches, 'expected exactly one UPDATE "Model" statement to have been issued').toHaveLength(
    1
  );
  return matches[0];
}

/** Every `UPDATE "ModelVersion"` statement the job issued. */
function versionUpdateSqls(): string[] {
  return executableStatements().filter((sql) => sql.startsWith('UPDATE "ModelVersion" '));
}

beforeEach(() => {
  vi.clearAllMocks();
  // The job logs a per-batch progress line in the no-files branch.
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  // Two SELECTs, in order: versions without posts, then versions without files.
  // Both return rows so BOTH ModelVersion UPDATE statements actually execute —
  // otherwise the "must not bump ModelVersion.updatedAt" guard below would pass
  // over an empty list, which is the same green as a harness wired to nothing.
  mockDbWrite.$queryRaw
    .mockResolvedValueOnce(NO_POSTS_VERSION_IDS.map((modelVersionId) => ({ modelVersionId })))
    .mockResolvedValueOnce(NO_FILES_VERSION_IDS.map((modelVersionId) => ({ modelVersionId })));
  mockDbWrite.$executeRaw.mockResolvedValue(1);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resetToDraftWithoutRequirements', () => {
  describe('the final UPDATE "Model" statement', () => {
    // 🔴 THE FIX. This statement is `$executeRaw`, so Prisma's `@updatedAt` does
    // NOT fire and the row keeps whatever `updatedAt` it carried while it was
    // Published — measured as far back as 2023 on live rows. `remove-old-drafts`
    // reaps `status IN ('Draft','Deleted') AND m."updatedAt" < now() - INTERVAL
    // '30 days'` and cascade-deletes the model with its versions, files and
    // training data, irreversibly. Without this bump a model this sweep flips to
    // Draft arrives with its entire 30-day grace period already spent, and both
    // jobs share the same cron minute.
    it('bumps "updatedAt" so a swept model gets a real grace period before the reaper', async () => {
      await runJob();

      expect(
        modelUpdateSql(),
        'a model swept to Draft with a stale "updatedAt" is immediately reapable by remove-old-drafts'
      ).toContain('"updatedAt" = now()');
    });

    // The fix must be ADDITIVE. These pin the behaviour it sits next to, so a
    // change that satisfies the guard above by replacing the SET list rather than
    // extending it cannot pass.
    it('still flips a pure-trained model to Draft and everything else to Unpublished', async () => {
      await runJob();

      const sql = modelUpdateSql();
      expect(sql, 'the status CASE must survive the "updatedAt" bump').toContain('status = CASE');
      expect(sql).toContain(`THEN 'Draft'::"ModelStatus"`);
      expect(sql).toContain(`ELSE 'Unpublished'::"ModelStatus"`);
    });

    it('still stamps the no-versions unpublish reason into meta', async () => {
      await runJob();

      expect(modelUpdateSql(), 'the meta jsonb_set must survive the "updatedAt" bump').toContain(
        `jsonb_set(jsonb_set(iif(jsonb_typeof(meta) != 'object', '{}', meta), '{unpublishedReason}', '"no-versions"'), '{unpublishedAt}', to_jsonb(now()))`
      );
    });

    // The bump is deliberately unconditional across both CASE branches: the
    // Unpublished rows are later flipped to Draft by the backfill in
    // src/pages/api/admin/temp/backfill-swept-trained-models.ts, and a stale clock
    // carried through that hop lands in exactly the same hole. A `CASE ... THEN
    // now() ELSE "updatedAt" END` mutant is what this catches.
    it('assigns "updatedAt" in the SET clause, unconditionally', async () => {
      await runJob();

      const sql = modelUpdateSql();
      // The statement's CASE and NOT EXISTS subqueries carry their own WHEREs, so
      // the top-level one is located by the column it opens on rather than by the
      // first ` WHERE ` in the text.
      const whereAt = sql.indexOf(` WHERE m."status"`);
      expect(
        whereAt,
        'could not locate the top-level WHERE; the guards below would be vacuous'
      ).toBeGreaterThan(0);
      const setClause = sql.slice(sql.indexOf(' SET '), whereAt);
      expect(
        setClause.match(/"updatedAt" = CASE/),
        'a conditional bump would leave the Unpublished rows carrying a stale clock into the backfill'
      ).toBeNull();
      expect(
        setClause,
        'the bump must be an assignment in the SET clause, not a term somewhere else in the statement'
      ).toContain('"updatedAt" = now()');
    });
  });

  describe('the ModelVersion statements', () => {
    // POSITIVE CONTROL for the guard below. Without it, "no ModelVersion statement
    // sets updatedAt" is satisfied by a run that issued no ModelVersion statements
    // at all — a reassuring zero indistinguishable from a probe wired to nothing.
    it('issues both ModelVersion updates for these fixtures', async () => {
      await runJob();

      const sqls = versionUpdateSqls();
      expect(
        sqls,
        'both the no-posts and no-files branches must run, or the guard below is vacuous'
      ).toHaveLength(2);
      expect(sqls[0]).toContain(`'{unpublishedReason}', '"no-posts"'`);
      expect(sqls[1]).toContain(`'{unpublishedReason}', '"no-files"'`);
    });

    // 🔴 A GUARD AGAINST A WELL-MEANING FUTURE EDIT, not a description of a bug.
    //
    // ModelVersion."updatedAt" means "a CREATOR edited this version". The codebase
    // uses raw SQL specifically to keep Prisma's @updatedAt from firing on system
    // writes — see the comment in src/server/services/model-version.service.ts
    // ("a blurb re-materialization is not a creator edit"). remove-old-drafts'
    // activity fence reads mv."updatedAt" as a creator-activity signal and SPARES
    // any model whose version moved inside the window.
    //
    // So mirroring the Model fix onto these statements would not be a harmless
    // symmetry: it would make every system-swept version look freshly edited by
    // its creator, permanently sparing rows the reaper is supposed to be able to
    // collect — corrupting the fence rather than the clock.
    it('does NOT bump ModelVersion."updatedAt" — that column is a creator-activity signal', async () => {
      await runJob();

      for (const sql of versionUpdateSqls()) {
        expect(
          sql,
          'bumping ModelVersion."updatedAt" on a system sweep corrupts the remove-old-drafts activity fence'
        ).not.toContain('"updatedAt"');
      }
    });
  });
});
