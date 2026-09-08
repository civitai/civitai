import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { paidAccessLiveSql } from '~/server/services/paid-access-sql';

/**
 * "Is this paid gate live right now" decides both the card badge and the feed's Hide Paid filter. It
 * was written out four times across two services before 868m1r2u7, and the first three versions of
 * this guard each pinned what had just been written rather than the property:
 *   1. pinned the two SQL spellings the refactor had DELETED, so inverting the discriminator was green
 *   2. every assertion a prohibition, so deleting the feature outright was green
 *   3. exempted a whole file by name and counted one table alias — and the next commit put a second
 *      copy inside the exempt file, under a different alias
 *
 * So the rule now lives in ONE exported `Prisma.sql` fragment and this file guards the only property
 * that can still be violated: nobody hand-writes the predicate anywhere else. That is a textual
 * property, which is the one kind a text guard checks well.
 *
 * Before trusting a green run here, ask the question the three dead versions failed: would this still
 * pass if the feature were deleted, renamed, or copied into an exempt file?
 */

const repoRoot = path.resolve(__dirname, '../../../..');
const FRAGMENT_MODULE = 'src/server/services/paid-access-sql.ts';

// Exactly one file may contain the predicate: the one that defines it. Exempting a whole SERVICE by
// name is what let the last copy be written unseen, so the allowlist is a single exact path and its
// length is asserted below — widening it by a line is the change that must be visible.
const ALLOWLIST = [FRAGMENT_MODULE] as const;

// The WHOLE predicate, not the endsAt disjunct alone. That disjunct also appears in
// src/pages/api/v1/model-versions/mini/[id].ts, which asks a genuinely different question — one
// version, no entityType or published scope — and flagging it would be the guard crying wolf on its
// first run. What must not be restated is this three-conjunct rule.
const PREDICATE = `pa."entityType" = 'ModelVersion'
      AND (pa."endsAt" IS NULL OR pa."endsAt" > NOW())
      AND mv.status = 'Published'::"ModelStatus"`;

function walk(dir: string, out: string[] = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const sourceFiles = walk(path.join(repoRoot, 'src'))
  .map((full) => ({
    rel: path.relative(repoRoot, full).split(path.sep).join('/'),
    text: readFileSync(full, 'utf8'),
  }))
  // Tests quote the SQL they pin, including this file.
  .filter((f) => !/(^|\/)__tests__(\/|$)/.test(f.rel) && !/\.(browser\.)?test\.tsx?$/.test(f.rel));

describe('the live-gate predicate has exactly one definition', () => {
  it('the allowlist is one file — widening it must be a visible change', () => {
    expect(ALLOWLIST).toHaveLength(1);
  });

  it('no other module hand-writes the predicate', () => {
    const offenders = sourceFiles
      .filter((f) => !ALLOWLIST.includes(f.rel as (typeof ALLOWLIST)[number]))
      .filter((f) => f.text.includes(PREDICATE))
      .map((f) => f.rel);

    expect(
      offenders,
      `These files restate the live-gate predicate instead of interpolating paidAccessLiveSql. ` +
        `Every hand-written copy is one the next edit can miss — which is how the feed filter and the ` +
        `card badge came to disagree about which models are paid.`
    ).toEqual([]);
  });

  it('every query splicing the fragment aliases PaidAccess as `pa`', () => {
    // The fragment hardcodes `pa`. Spliced beside a differently-aliased table it is silently wrong
    // SQL that still parses, so pin the alias directly rather than counting joins.
    const offenders = sourceFiles
      .filter((f) => f.text.includes('paidAccessLiveSql'))
      .filter((f) => /FROM "PaidAccess" (?!pa\b)\w+/.test(f.text))
      .map((f) => f.rel);

    expect(offenders, 'paidAccessLiveSql only works where PaidAccess is aliased `pa`.').toEqual([]);
  });
});

describe('the fragment says what it means', () => {
  it('is a Prisma sql fragment, not a string a caller could bind as a value', () => {
    expect(typeof paidAccessLiveSql).toBe('object');
    expect(paidAccessLiveSql).toHaveProperty('strings');
    expect(paidAccessLiveSql).toHaveProperty('values');
  });

  it('carries no bound values', () => {
    // Load-bearing for every substring assertion downstream: the moment any part of this predicate
    // becomes an interpolation it leaves `.sql` for `.values`, and every `toContain` over an emitted
    // statement goes blind while staying green.
    expect(paidAccessLiveSql.values).toEqual([]);
  });

  it('admits a gate with no end date and one still ahead, and nothing else', () => {
    expect(paidAccessLiveSql.sql).toContain(PREDICATE);
    expect(paidAccessLiveSql.sql).toContain(`mv.status = 'Published'::"ModelStatus"`);
    expect(paidAccessLiveSql.sql).toContain(`pa."entityType" = 'ModelVersion'`);
  });

  it('does not narrow on timeframeDays', () => {
    // Not `IS NULL` — the whole column. `not.toContain('"timeframeDays" IS NULL')` is satisfied by
    // `IS NOT NULL`, which silently stops the filter hiding permanent gates: measured green across
    // the whole file before this was tightened.
    expect(paidAccessLiveSql.sql).not.toContain('"timeframeDays"');
  });
});
