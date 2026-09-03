import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Convention guard: never call a bare `.parse` on `imagesQueryParamSchema`.
 *
 * `/images/[imageId]` did, and it returned a 500 in production. Every key in that
 * schema is a `numericString`/`booleanString`, which rejects anything `Number()`
 * turns into NaN — so one junk query param threw, and a throw in a page's render is
 * a 500, not a degraded page. The `image-reaction-milestone` notification minted
 * `?postId=null` for any image with no post (25,135 prod images are article covers
 * with a null postId), so the app mailed users links to its own error page.
 *
 * 🔴 This guard exists because the unit tests could not catch it. The tests around
 * that fix assert `parseImageQueryParams`, the helper — and reverting the PAGE back
 * to `imagesQueryParamSchema.parse(router.query)` while leaving the helper exported
 * and unused left all of them green, typecheck green, lint green, and the page
 * 500ing again. The behaviour lives at the call site, so the assertion has to live
 * at the call site too. Reviewed and confirmed by mutation, 2026-09-03.
 *
 * There were three such call sites, not one: the page, `ImageDetailModal` (which
 * `.omit({ tags: true })` first, so match the chained form too), and a raw cast of
 * `browserRouter.query` in `ImageDetailProvider` that was never a parse at all.
 *
 * If this fails: use `parseImageQueryParams` from `~/components/Image/image.utils`,
 * which safeParses and degrades to `{}`. It takes an optional schema for the
 * `.omit(...)` variants.
 */

const SRC_DIR = path.resolve(__dirname, '../../..');

/**
 * Matches `imagesQueryParamSchema.parse(` and the chained
 * `imagesQueryParamSchema.omit({ ... }).parse(` — anything between the schema name
 * and `.parse(` that is not itself a statement break.
 */
const THROWING_PARSE = /imagesQueryParamSchema\s*(?:\.\w+\([^;]*?\)\s*)*\.\s*parse\s*\(/;

/** The fix's own docblocks quote the banned call, so comments must not read as violations. */
function stripComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__fixtures__') continue;
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
      if (THROWING_PARSE.test(line))
        hits.push(`${path.relative(SRC_DIR, file).split('\\').join('/')}:${i + 1}: ${line.trim()}`);
    });
  }
  return hits;
}

/**
 * A floor on the scan's reach, not a census. A guard whose walk silently stops
 * finding files passes by seeing nothing — the exact failure this guard was written
 * in response to.
 */
const MIN_SCANNED_FILES = 2000;

describe('no bare imagesQueryParamSchema.parse', () => {
  it('can read the src tree', () => {
    // Fail closed: a moved directory is a broken guard, not a clean one.
    expect(fs.existsSync(SRC_DIR)).toBe(true);
    expect(walk(SRC_DIR).length).toBeGreaterThanOrEqual(MIN_SCANNED_FILES);
  });

  it('detects both shapes it is looking for', () => {
    // Without this, every assertion below is satisfiable by a matcher matching nothing.
    const detected = findViolations([
      path.join(__dirname, '__fixtures__/throwing-image-query-parse-fixture.ts'),
    ]);
    expect(detected).toHaveLength(2);
    expect(detected[0]).toMatch(/plain/);
    expect(detected[1]).toMatch(/omit/);
  });

  it('does not report the safe helper, whose comments quote the banned call', () => {
    expect(findViolations([path.resolve(SRC_DIR, 'components/Image/image.utils.ts')])).toEqual([]);
    expect(findViolations([path.resolve(SRC_DIR, 'pages/images/[imageId].tsx')])).toEqual([]);
  });

  it('reports no violations', () => {
    expect(findViolations(walk(SRC_DIR))).toEqual([]);
  });
});
