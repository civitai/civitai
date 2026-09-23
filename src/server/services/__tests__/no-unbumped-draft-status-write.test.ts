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

/**
 * Files with a raw `UPDATE "Model"` statement that moves a model into Draft, and
 * HOW MANY such statements each one holds.
 *
 * 🔴 The count is not decoration — it is the control that makes a dropped
 * statement impossible to hide. The per-file rule below iterates the drafting
 * statements, so anything that removes one from the list (a broken extractor, a
 * reworded literal, a moved statement) makes the rule iterate a shorter list and
 * pass. "At least one" was the previous control, and it is only sufficient while
 * every ledger file holds exactly one: with two, the guard can silently stop
 * watching one of them and still be green. Pinning the exact number closes that,
 * and it also forces a deliberate decision when a file GAINS a drafting
 * statement, rather than letting it arrive unwatched.
 */
const LEDGER: { file: string; draftingStatements: number }[] = [
  { file: 'src/server/jobs/reset-to-draft-without-requirements.ts', draftingStatements: 1 },
  { file: 'src/pages/api/admin/temp/backfill-swept-trained-models.ts', draftingStatements: 1 },
  { file: 'src/server/services/model.service.ts', draftingStatements: 1 },
];

/**
 * Index of the backtick that CLOSES the tagged template `start` sits inside, or
 * `-1` if it never closes.
 *
 * 🔴 "The next backtick" is WRONG, and the failure mode is TRUNCATION, not
 * over-reading. A template carrying an interpolated expression that is itself a
 * tagged template — `${cond ? Prisma.empty : Prisma.sql`...`}`, which is exactly
 * the shape of the description write in `model.service.ts` — closes on the
 * NESTED opening backtick. The extracted text then stops mid-expression, and
 * because truncation REMOVES text it can drop the `'Draft'` literal and quietly
 * take a statement out of scope entirely. Measured on the previous revision of
 * this file: that statement extracted 156 characters and ended mid-ternary.
 *
 * So the scan tracks `${...}` interpolations by brace depth, recursing through
 * nested templates and skipping quoted strings inside the JS.
 *
 * KNOWN LIMITS, none present in this corpus. 🔴 They are listed WITH THE
 * DIRECTION THEY FAIL, because a limits list that mixes the two is more
 * dangerous than no list — a reader assumes the whole list is as harmless as
 * whichever entry they check first:
 *
 *  - FAILS CLOSED — a brace or backtick inside a regex literal or a `//` comment
 *    within an interpolation confuses the depth count. The scan then runs long
 *    or never terminates, which surfaces as the unterminated-template error or a
 *    wrong count. Loud, and it cannot un-watch a statement.
 *  - 🔴 FAILS OPEN — an `UPDATE "Model"` written INSIDE an interpolation of
 *    another `UPDATE "Model"` template. Because the scan now correctly reads to
 *    the OUTER close, the inner statement is absorbed into the outer one rather
 *    than enumerated separately. Measured: outer bumped, inner drafting and
 *    unbumped gives `drafting=1, bumped=1` and an exact count of 1 — all green
 *    over an unbumped drafting statement. Deliberately NOT engineered around:
 *    nobody nests an `UPDATE "Model"` inside another one, and a parser change to
 *    catch it would cost more risk than the shape is worth. Recorded so the next
 *    person weighing that trade has the measurement rather than a guess.
 */
function templateEnd(source: string, start: number): number {
  let i = start;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') return i;
    if (ch === '$' && source[i + 1] === '{') {
      i = skipInterpolation(source, i + 2);
      continue;
    }
    i++;
  }
  return -1;
}

/** Index just past the `}` closing an interpolation opened before `i`. */
function skipInterpolation(source: string, i: number): number {
  let depth = 1;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') {
      const nested = templateEnd(source, i + 1);
      if (nested < 0) return source.length;
      i = nested + 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      i = skipQuoted(source, i + 1, ch);
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  return i;
}

/** Index just past the closing `quote`. */
function skipQuoted(source: string, i: number, quote: string): number {
  while (i < source.length) {
    if (source[i] === '\\') {
      i += 2;
      continue;
    }
    if (source[i] === quote) return i + 1;
    i++;
  }
  return i;
}

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
 * Each statement is read to the end of its tagged template via `templateEnd`,
 * which is nesting-aware — see the 🔴 note on that function for why "the next
 * backtick" silently TRUNCATED a statement rather than over-reading it.
 * Comment stripping is load-bearing too — these statements carry `--` comments,
 * and a `-- "updatedAt" = now()` would otherwise satisfy this guard over SQL
 * that does not do it.
 */
function modelUpdateStatements(relPath: string): string[] {
  const source = readFileSync(path.join(repoRoot, relPath), 'utf8');
  const statements: string[] = [];
  for (let start = source.indexOf('UPDATE "Model"'); start >= 0; ) {
    const end = templateEnd(source, start);
    // An unterminated template means the scan is wrong about this file, so every
    // statement after it is suspect. Fail rather than skip: a skipped statement
    // leaves the rule silently unbound, which is the whole hazard here.
    expect(
      end,
      `${relPath}: tagged template starting at offset ${start} never closes — the extractor cannot be trusted on this file`
    ).toBeGreaterThan(start);
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
  it.each(LEDGER)(
    '$file sets "updatedAt" = now() on every drafting statement',
    ({ file }: (typeof LEDGER)[number]) => {
      // Indexed, so a failure names WHICH of a file's drafting statements is
      // unbumped rather than just the file.
      draftingStatements(file).forEach((statement, i) => {
        expect(
          statement,
          `${file}: drafting statement #${
            i + 1
          } does not bump "updatedAt" — a model it drafts carries a spent clock into remove-old-drafts, which cascade-deletes it`
        ).toContain('"updatedAt" = now()');
      });
    }
  );

  // 🔴 POSITIVE CONTROL, and an EXACT count rather than "at least one".
  //
  // The rule above iterates a list, so anything that shortens the list weakens it
  // silently: a broken extractor, a reworded `Draft` literal, a moved statement.
  // "At least one" only catches that while a file holds exactly one drafting
  // statement — true of every ledger file today, which is a property of this
  // corpus and not of the guard. With two, one can drop out and the file still
  // reports a non-empty list.
  //
  // The exact number fails in BOTH directions: a statement that disappears from
  // the extractor's view, and one that ARRIVES unwatched. Bumping the number is
  // how you record a deliberate decision about a new site.
  //
  // 🔴 But an INCREASE has two causes and only one of them is a new site. The
  // extractor anchors on the raw text `UPDATE "Model"`, so a `//` comment or a
  // string that merely QUOTES the statement counts as one. That is not
  // hypothetical here: the comment block on `restoreModelById` already contains
  // `'Draft'` and `"updatedAt" = now()`, so it is one `UPDATE "Model"` mention
  // away from tripping this — and prose about this very guard is exactly the
  // kind of text that would do it. The failure message therefore has to name
  // that cause, because a maintainer who follows a bare "bump the count" would
  // permanently install a phantom statement in the ledger.
  it.each(LEDGER)(
    '$file holds exactly the drafting statements this ledger claims',
    ({ file, draftingStatements: expected }: (typeof LEDGER)[number]) => {
      expect(
        draftingStatements(file).length,
        `${file}: expected ${expected} raw UPDATE "Model" statement(s) writing Draft. FEWER means one dropped out of the extractor's view and is no longer checked. MORE means one of two things: either a real new drafting site arrived, in which case confirm it carries the bump and then raise the count here — or a comment or string literal now quotes the statement text, which this text-anchored extractor cannot tell from real SQL. If it is prose, REWORD THE PROSE; do not raise the count, or you install a phantom statement in this ledger permanently.`
      ).toBe(expected);
    }
  );
});
