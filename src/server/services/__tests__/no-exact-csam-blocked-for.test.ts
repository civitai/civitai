import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

/**
 * 🔴 Fails on a new exact comparison of `blockedFor` with the CSAM reason. `blockedFor` is a comma list
 * of block reasons, so CSAM anywhere in it is a CSAM block: decide it with `csamBlockedSql` (main app),
 * `csamBlockedForSql` / `csamInBlockedForSql` (SQL elsewhere) or `blockedForNamesCsam` (a value read).
 * An exact match reads 'tos,CSAM' as no CSAM block, and the sites disagree on the same row.
 */

const REPO = path.resolve(__dirname, '../../../..');
const ROOTS = ['src', 'packages', 'apps/moderator/src'];
const SKIP_DIRS = new Set([
  'node_modules',
  '__tests__',
  'migrations',
  'generated',
  'dist',
  'build',
]);

const CSAM = String.raw`(?:'CSAM'|BlockedReason\.CSAM|BLOCKED_REASON_CSAM)`;
const OPERATOR = String.raw`(?:===|!==|IS\s+(?:NOT\s+)?DISTINCT\s+FROM|NOT\s+IN|<>|=(?![=>])|'is distinct from',|'not in',)`;
// A quoted SQL column or a JS property, the operator, then the reason within a short span (it may sit
// on the next line inside a `${...}`).
const EXACT = new RegExp(
  String.raw`(?:"blockedFor"|\bblockedFor\b['\x60]?\)?\}?,?)\s*${OPERATOR}[^;]{0,80}?${CSAM}|${CSAM}\s*(?:===|!==)\s*[\w.?]*blockedFor\b`,
  'g'
);

/**
 * Exact on purpose, with the count per file. Each is one of: a write of the reason, a site whose twin
 * moves only with a database object or another app, a hold that keeps media past its purge (which
 * nothing widens), or an outbound effect awaiting its decision.
 */
const ALLOWED: Record<string, number> = {
  // Holds media out of the purge.
  'src/server/jobs/image-ingestion.ts': 4,
  // Restated in a label_store function and trigger; moves with them.
  'src/server/jobs/appeal-decision-records.ts': 4,
  // Twin of feed-go's training_data_listing.sql; moves with it.
  'src/server/services/training-data-restricted.service.ts': 1,
  // Read by the Knights gate view; moves with a new view migration.
  'packages/civitai-shared/src/held-media.ts': 2,
  // A child-safety case keeps media; image-appeal-flag's clear moves with it.
  'packages/civitai-db-queries/src/child-safety-case.db.ts': 3,
  'src/server/services/image-appeal-flag.ts': 1,
  // The purge of a moderator's delete.
  'packages/civitai-db-queries/src/content-deletion.db.ts': 1,
  // A kept hide's recorded prior state.
  'packages/civitai-db-queries/src/pending-deletes.db.ts': 1,
  // A moderator count of unusual block reasons: a list naming CSAM is worth their look.
  'apps/moderator/src/lib/server/moderation-board.service.ts': 1,
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(?:tsx?|svelte)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const exactMatches = (source: string) => [...source.matchAll(EXACT)].length;

function counts() {
  const found: Record<string, number> = {};
  for (const root of ROOTS)
    for (const file of walk(path.join(REPO, root))) {
      const n = exactMatches(readFileSync(file, 'utf8'));
      if (n) found[path.relative(REPO, file).split(path.sep).join('/')] = n;
    }
  return found;
}

describe('no-exact-csam-blocked-for', () => {
  it('decides a CSAM block with the comma-list predicate, outside the listed exact sites', () => {
    const found = counts();
    const over = Object.entries(found).filter(([file, n]) => n > (ALLOWED[file] ?? 0));
    expect(over).toEqual([]);
  });

  it('lists no file that no longer needs its exact sites', () => {
    const found = counts();
    expect(Object.entries(ALLOWED).filter(([file, n]) => (found[file] ?? 0) < n)).toEqual([]);
  });

  it.each([
    `WHERE "blockedFor" = 'CSAM'`,
    `AND "blockedFor" IS DISTINCT FROM \${BlockedReason.CSAM}`,
    `WHEN "blockedFor" = \${\n  BlockedReason.CSAM\n} THEN`,
    `image.blockedFor === 'CSAM'`,
    `BlockedReason.CSAM !== x.blockedFor`,
    `.where('blockedFor', 'is distinct from', BLOCKED_REASON_CSAM)`,
    `"blockedFor" NOT IN (\${BlockedReason.AiNotVerified}, \${BlockedReason.CSAM})`,
  ])('control: catches %s', (source) => {
    expect(exactMatches(source)).toBe(1);
  });

  it.each([
    `toUpdate.blockedFor = BlockedReason.CSAM;`.replace('=', ':'),
    `blockedFor: BlockedReason.CSAM,`,
    `\${csamBlockedSql()} OR "needsReview" = 'csam'`,
    `blockedForNamesCsam(image.blockedFor)`,
  ])('control: passes %s', (source) => {
    expect(exactMatches(source)).toBe(0);
  });
});
