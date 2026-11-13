import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Every window query against `daily_resource_generation_counts` needs an UPPER bound.
 *
 * A legacy import left rows in that table dated decades in the future, each carrying a version's
 * entire all-time generation total. They are not junk to delete: for some models they are the only
 * record of those generations, and `ModelMetric.generationCount` matches them exactly. Counts and
 * dates per database copy: `docs/model-feed-hot-ranking.md` §17.
 *
 * So they stay, and every reader that asks for a window has to exclude them. `createdDate >= X`
 * alone is satisfied by a row dated in the next century, which turns a lifetime total into "this
 * week" — a farming check reads a model as freshly active, and a per-version chart gets a point
 * decades out.
 *
 * Source text rather than behaviour, because the queries are raw ClickHouse strings: no type can
 * catch a missing predicate, and no fixture can either — a test database holds no future-dated rows
 * to be wrong about.
 */
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const SEARCH_ROOTS = ['src', 'apps'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.svelte-kit', '.next', 'coverage']);
const TABLE = 'daily_resource_generation';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|svelte)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Strips comments so a predicate quoted in prose cannot satisfy the check. */
function sourceWithoutComments(contents: string) {
  return contents
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\s*(\/\/|--).*$/, ''))
    .join('\n');
}

const readers = SEARCH_ROOTS.flatMap((root) => sourceFiles(join(REPO_ROOT, root)))
  .map((file) => ({
    path: relative(REPO_ROOT, file).split(sep).join('/'),
    code: sourceWithoutComments(readFileSync(file, 'utf8')),
  }))
  .filter(({ code, path }) => code.includes(TABLE) && !path.includes('__tests__'));

describe('daily_resource_generation_counts window queries', () => {
  // Fails loudly rather than vacuously if the tables are renamed or the readers move: a zero-file
  // scan would otherwise make every assertion below pass.
  it('finds the readers to check', () => {
    expect(readers.length).toBeGreaterThanOrEqual(5);
  });

  it.each(readers.map((r) => r.path))('%s bounds any date range it opens', (path) => {
    const { code } = readers.find((r) => r.path === path)!;

    // `BETWEEN a AND b` is already bounded on both sides; count only one-sided comparisons.
    const between = (code.match(/createdDate\s+BETWEEN/gi) ?? []).length;
    const lower = (code.match(/createdDate\s*>=?[^=]/g) ?? []).length;
    const upper = (code.match(/createdDate\s*<=?[^=]/g) ?? []).length;

    if (lower === 0) {
      expect(between + lower).toBe(between); // all-time reader: nothing to bound
      return;
    }
    expect(upper).toBeGreaterThanOrEqual(lower);
  });
});
