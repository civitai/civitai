import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Convention guard: no `z.coerce.boolean()` under src/pages/api.
 *
 * These handlers parse `req.query`, where every value is a string, and
 * `z.coerce.boolean()` is JS `Boolean()` — so `?flag=false` parses as TRUE and the
 * caller gets the opposite of what it asked for, with no error. It has shipped four
 * separate times (deliver-prepaid-buzz, permission, backfill-theme-elements,
 * backfill-stale-nsfw-rollups), which is why the ban is enforced here rather than
 * fixed one site at a time.
 *
 * If this fails: use `booleanString()` from ~/utils/zod-helpers, which accepts the
 * string spellings and rejects the rest.
 */

const API_DIR = path.resolve(__dirname, '../../../pages/api');

/** Matches `z.coerce.boolean(`, `zod.coerce.boolean(` and a bare destructured `coerce.boolean(`. */
const COERCE_BOOLEAN = /\bcoerce\s*\.\s*boolean\s*\(/;

/**
 * The four fixed sites each carry a comment naming `z.coerce.boolean`, so a scan over raw
 * text reports the documentation as the violation. Line comments are only stripped when the
 * `//` is not preceded by `:`, to leave `https://` inside a string alone.
 */
function stripComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (/\.tsx?$/.test(entry.name)) files.push(full);
  }
  return files;
}

function findViolations(files: string[]) {
  const hits: string[] = [];
  for (const file of files) {
    const lines = stripComments(fs.readFileSync(file, 'utf-8')).split('\n');
    lines.forEach((line, i) => {
      if (COERCE_BOOLEAN.test(line))
        hits.push(`${path.relative(API_DIR, file)}:${i + 1}: ${line.trim()}`);
    });
  }
  return hits;
}

/**
 * A floor on the scan's reach, not a census. A guard whose walk silently stops finding
 * files passes by seeing nothing, which is the failure mode this whole file exists to
 * avoid — so the scan must prove it read the tree before it is allowed to report clean.
 */
const MIN_SCANNED_FILES = 200;

describe('no z.coerce.boolean under src/pages/api', () => {
  it('can read the api tree', () => {
    // Fail closed: a missing or moved directory is a broken guard, not a clean one.
    expect(fs.existsSync(API_DIR)).toBe(true);
    expect(walk(API_DIR).length).toBeGreaterThanOrEqual(MIN_SCANNED_FILES);
  });

  it('detects the pattern it is looking for', () => {
    // Without this, every assertion below is satisfiable by a matcher that matches nothing.
    const detected = findViolations([
      path.join(__dirname, '__fixtures__/coerce-boolean-fixture.ts'),
    ]);
    expect(detected).toHaveLength(1);
  });

  it('does not report the fixed sites, which name the pattern in their comments', () => {
    expect(findViolations([path.resolve(API_DIR, 'admin/permission.ts')])).toEqual([]);
    expect(
      findViolations([path.resolve(API_DIR, 'mod/daily-challenge/backfill-theme-elements.ts')])
    ).toEqual([]);
  });

  it('reports no violations', () => {
    expect(findViolations(walk(API_DIR))).toEqual([]);
  });
});
