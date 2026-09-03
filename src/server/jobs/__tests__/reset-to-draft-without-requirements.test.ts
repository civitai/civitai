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

/**
 * The `UPDATE "Model"` statement's SET clause, parsed into ordered
 * `[target, value]` pairs.
 *
 * Split on commas at paren-depth 0, so the commas inside `jsonb_set(...)` and
 * inside the CASE's `EXISTS (...)` subqueries do not fragment an assignment. No
 * string literal in this statement contains a comma, so quote handling is not
 * needed and is deliberately not attempted — if one is ever added, this helper
 * has to learn about quotes rather than being loosened.
 *
 * 🔴 Reading the assignments as a LIST is the point. A `toContain` guard can only
 * see a clause that was removed; it is blind to one that was ADDED. Injecting
 * `"publishedAt" = now(),` or `"createdAt" = now(),` into this SET clause passed
 * every guard in this file before this existed — and `publishedAt` is a column
 * the codebase guards explicitly against spurious bumps elsewhere.
 */
function modelSetAssignments(): [string, string][] {
  const sql = modelUpdateSql();
  // The CASE and NOT EXISTS subqueries carry their own WHEREs, so the top-level
  // one is located by the column it opens on, not by the first ` WHERE `.
  const whereAt = sql.indexOf(` WHERE m."status"`);
  expect(
    whereAt,
    'could not locate the top-level WHERE; every SET-clause guard would be vacuous'
  ).toBeGreaterThan(0);
  const setClause = sql.slice(sql.indexOf(' SET ') + ' SET '.length, whereAt);

  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of setClause) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);

  return parts.map((part) => {
    const eq = part.indexOf(' = ');
    expect(eq, `SET fragment is not an assignment: ${part.trim()}`).toBeGreaterThan(0);
    return [part.slice(0, eq).trim(), part.slice(eq + 3).trim()] as [string, string];
  });
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

    // 🔴 The ledger. Fails when the SET list GROWS as well as when it shrinks —
    // an added column write is otherwise invisible to every `toContain` above.
    it('writes exactly status, meta and "updatedAt" — no other column', async () => {
      await runJob();

      expect(
        modelSetAssignments().map(([target]) => target),
        'this statement must not acquire another column write without a deliberate decision — "publishedAt" in particular is guarded against spurious bumps elsewhere'
      ).toEqual(['status', 'meta', '"updatedAt"']);
    });

    // The bump is deliberately unconditional across both CASE branches: the
    // Unpublished rows are later flipped to Draft by the backfill in
    // src/pages/api/admin/temp/backfill-swept-trained-models.ts, and a stale clock
    // carried through that hop lands in exactly the same hole. Pinning the VALUE
    // (not just the presence of the target) is what catches a
    // `CASE ... THEN now() ELSE m."updatedAt" END` mutant, and equally a
    // `now() - INTERVAL '31 days'` one.
    it('assigns "updatedAt" exactly now(), unconditionally', async () => {
      await runJob();

      const updatedAt = modelSetAssignments().find(([target]) => target === '"updatedAt"');
      expect(
        updatedAt?.[1],
        'a conditional or offset bump would leave rows carrying a stale clock into the backfill and the reaper'
      ).toBe('now()');
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

    // 🔴 A SCOPE GUARD, not a prohibition — read this before "fixing" it.
    //
    // Bumping ModelVersion."updatedAt" on a system write is NOT forbidden in this
    // codebase. unpublishModelById (src/server/services/model.service.ts) is a
    // system/moderator take-down that raw-SQL-updates "ModelVersion" and sets
    // "updatedAt" = NOW() deliberately, because the column is on the public v1
    // payload via src/server/selectors/modelVersion.selector.ts (returned by
    // src/pages/api/v1/model-versions/[id].ts) and a taken-down version would
    // otherwise serve a pre-take-down timestamp.
    //
    // What this guard pins is that THIS change did not quietly do that too. The
    // sweep's effect on the public payload is a separate decision with its own
    // consequences; it wants its own change and its own review. If you are making
    // that decision on purpose, delete this test — do not work around it.
    //
    // (For the record, the reaper is NOT a reason to keep it out. If the sweep
    // bumped mv."updatedAt" at T, the activity fence would spare the model only
    // until T+30d — and with this change Model."updatedAt" is also T, so the
    // reaper's own age test admits it at T+30d as well. Both expire at the same
    // instant, so the net effect on the reaper is zero. The sweep cannot renew it
    // either: all three of its statements require status = 'Published', which no
    // longer holds after the first pass.)
    it('keeps this change scoped to Model."updatedAt" and leaves ModelVersion alone', async () => {
      await runJob();

      for (const sql of versionUpdateSqls()) {
        expect(
          sql,
          'changing ModelVersion."updatedAt" alters the public v1 payload; that is a separate decision, not a drive-by'
        ).not.toContain('"updatedAt"');
      }
    });
  });
});
