import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../../../test/strip-comments';

/**
 * SOURCE GATE: the held copies of deleted storylines ("HeldStoryline" and the
 * "HeldStorylineChapter*" tables) are named only by the code that writes them, purges them, and
 * shows them to moderators. A copy outlives its owner's delete, so a reader anywhere else could
 * show a deleted storyline again, or tell its owner that something was kept.
 *
 * Non-test code under src/, apps/ and packages/, comments stripped. Migrations are not code.
 */

const repoRoot = path.resolve(__dirname, '../../../..');
const ROOTS = ['src', 'apps', 'packages'];
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.svelte', '.sql']);
const SKIP_DIRS = new Set([
  'node_modules',
  '.svelte-kit',
  '.next',
  'build',
  'dist',
  'generated',
  'migrations',
]);
const isTestFile = (file: string) => /\.test\.|[\\/]__tests__[\\/]/.test(file);

/** Every file allowed to name the tables, and why. */
const ALLOWED: Record<string, string> = {
  'src/server/services/storyline.service.ts': 'the delete writes the copy (`deleteStoryline`)',
  'src/server/services/held-review.service.ts': 'the purge releases it (`purgeReleasedHeldCopies`)',
  'apps/moderator/src/lib/server/storyline-takedown.service.ts':
    'the report page shows it (`getDeletedReportStorylines`)',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (CODE_EXTENSIONS.has(path.extname(entry)) && !isTestFile(full)) out.push(full);
  }
  return out;
}

const NAMES_A_COPY = /HeldStoryline/;
// Svelte markup comments too, and SQL line comments in a .sql file.
const stripAllComments = (s: string, sql: boolean) => {
  const code = stripComments(s).replace(/<!--[\s\S]*?-->/g, ' ');
  return sql ? code.replace(/--[^\n]*/g, ' ') : code;
};

const offends = (source: string, file = 'x.ts') =>
  NAMES_A_COPY.test(stripAllComments(source, file.endsWith('.sql')));

const files = ROOTS.flatMap((root) => walk(path.join(repoRoot, root)));
const relative = (file: string) => path.relative(repoRoot, file).split(path.sep).join('/');

describe('no-held-storyline-reader', () => {
  it('scans the code', () => {
    expect(files.length).toBeGreaterThan(1000);
    for (const file of Object.keys(ALLOWED))
      expect(files.map(relative), `${file} moved: update ALLOWED`).toContain(file);
  });

  it('names a held storyline copy only where it is written, purged or shown to moderators', () => {
    const offenders = files
      .map(relative)
      .filter((file) => !(file in ALLOWED))
      .filter((file) => offends(readFileSync(path.join(repoRoot, file), 'utf8'), file));
    expect(offenders).toEqual([]);
  });

  it('every allowed file still names one, so the list does not go stale', () => {
    for (const file of Object.keys(ALLOWED))
      expect(offends(readFileSync(path.join(repoRoot, file), 'utf8'), file), file).toBe(true);
  });

  it('catches a reader in code, but not in a comment', () => {
    expect(offends('db.$queryRaw`SELECT * FROM "HeldStoryline"`')).toBe(true);
    expect(offends('sql`SELECT 1 FROM "HeldStorylineChapterEdge"`')).toBe(true);
    expect(offends('// copied into "HeldStoryline" by the delete')).toBe(false);
    expect(offends('-- kept in "HeldStoryline"', 'q.sql')).toBe(false);
    expect(offends('SELECT * FROM "HeldStoryline"', 'q.sql')).toBe(true);
  });
});
