import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * The model feed and the model search index derive the SAME card badge from the SAME table, in two
 * places, and for a long time they held two near-identical copies of the query. A change landing in
 * one and not the other is invisible: the badge appears in the feed and not in search, both look
 * correct on their own, and nothing fails. That is the defect this guard exists to prevent coming
 * back, not a style preference.
 *
 * The fix was structural — one exported helper, `getModelPaidAccessGates`, called by both — so what
 * is left to protect is that nobody re-inlines a second copy.
 */

const repoRoot = path.resolve(__dirname, '../../../..');
const HELPER = 'src/server/services/model-paid-access.ts';

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
  // Tests quote the SQL they pin — including this file, which named itself on the first run.
  .filter((f) => !f.rel.includes('__tests__') && !/\.(test|browser\.test)\.tsx?$/.test(f.rel));

describe('paid-gate derivation lives in exactly one place', () => {
  it('only the shared helper aggregates a paid-access deadline', () => {
    const offenders = sourceFiles
      .filter((f) => f.text.includes('MAX(pa."endsAt")'))
      .map((f) => f.rel)
      .filter((rel) => rel !== HELPER);

    expect(
      offenders,
      `These files aggregate a PaidAccess deadline themselves instead of calling getModelPaidAccessGates(). ` +
        `The feed and the search index must not each carry their own copy — that is how the badge ends up ` +
        `correct on one surface and missing on the other, with nothing failing.`
    ).toEqual([]);
  });

  it('every surface that reports a permanent gate reads it from the shared helper', () => {
    const offenders = sourceFiles
      .filter((f) => f.rel !== HELPER)
      .filter((f) => f.text.includes('hasPermanentPaidAccess'))
      // A consumer that only READS the field off a prop (the card) never derives it; a file that
      // derives it must go through the helper.
      .filter((f) => f.text.includes('hasPermanentPaidAccess:'))
      .filter((f) => !f.text.includes("from '~/server/services/model-paid-access'"))
      .map((f) => f.rel);

    expect(
      offenders,
      `These files build a hasPermanentPaidAccess value without calling getModelPaidAccessGates().`
    ).toEqual([]);
  });

  it('the row predicate still excludes tombstones', () => {
    const helper = readFileSync(path.join(repoRoot, HELPER), 'utf8');

    // This is the load-bearing clause and the reason it is pinned by spelling, the same trade as
    // no-lint-rules-script-drift: a reword goes red for a non-defect, which is cheaper than the
    // alternative. An EXPIRED timed gate is not deleted — `process-ending-early-access` leaves the
    // row as a tombstone with `timeframeDays` set and `endsAt` in the past. This predicate is what
    // keeps it out: it admits a row only if the window is still open OR the gate is permanent.
    // Dropping either half readmits tombstones, and the card would advertise a window that closed.
    expect(
      helper,
      'getModelPaidAccessGates must keep (endsAt > NOW() OR timeframeDays IS NULL) — it is the only ' +
        'thing excluding an expired early-access tombstone from the aggregate.'
    ).toContain('(pa."endsAt" > NOW() OR pa."timeframeDays" IS NULL)');
  });
});
