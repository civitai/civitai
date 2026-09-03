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
 * at the call site too. Confirmed by mutation, 2026-09-03.
 *
 * There were three such call sites, not one: the page, `ImageDetailModal` (which
 * `.omit({ tags: true })` first, so the chained form counts), and a raw cast of
 * `browserRouter.query` in `ImageDetailProvider` that was never a parse at all.
 *
 * If this fails: use `parseImageQueryParams` from `~/components/Image/image.utils`,
 * which safeParses and degrades to `{}`. It takes an optional schema for the
 * `.omit(...)` variants.
 *
 * 🔴 The scan runs over the WHOLE SOURCE, not line by line, and that is not a
 * stylistic choice. The first version of this guard tested one line at a time while
 * its pattern spanned from the schema name to `.parse(`, so it missed every call
 * prettier had wrapped — including the shape of the modal's own call, which already
 * spans four lines. A guard that a formatting pass can blind is worse than none,
 * because it reports clean. Do not refactor this back to `split('\n').forEach`.
 *
 * ⚠️ WHAT THIS GUARD CANNOT SEE, stated so nobody reads it as covering the class:
 *
 * - **A cast.** The third site in the incident was `ImageDetailProvider` reading
 *   `browserRouter.query as { postId?: number }` — no parse, no throw, no runtime
 *   behaviour whatsoever, so it appears in no grep for `.parse(` and this matcher
 *   would never flag it. A reviewer found it by following the data flow. The pattern
 *   a future guard would key on is *a type assertion applied to a router-query
 *   expression*, which an AST walk can find and a regex cannot.
 * - **Indirection.** `const S = imagesQueryParamSchema; S.parse(q)`, an aliased
 *   import, or a destructured `const { parse } = schema` all defeat a text matcher
 *   by construction. Measured, not assumed: those three shapes pass this guard.
 *
 * Both classes need an AST rather than a wider regex — `typescript` is already a
 * devDependency and `no-server-infra-in-app-graph.test.ts` uses it exactly that way.
 * That was left undone deliberately: the shapes above are what a person writes by
 * accident, indirection is not, and a guard nobody can read gets deleted. Widening
 * the regex will not reach either class.
 */

const SRC_DIR = path.resolve(__dirname, '../../..');

/**
 * `imagesQueryParamSchema` … `.parse(` / `.parseAsync(`, across newlines, through any
 * chain of `.omit(...)`-style calls, tolerating `?.`.
 *
 * `safeParse` must NOT match: the chain arm requires a following `.`, and the tail
 * alternation is anchored on the literal `parse`, so `.safeParse(` fails both.
 */
const THROWING_PARSE =
  /imagesQueryParamSchema\s*(?:\?\.|\.)\s*(?:\w+\s*\([^;]*?\)\s*(?:\?\.|\.)\s*)*(?:parse|parseAsync)\s*\(/g;

/**
 * Strip comments while PRESERVING newlines, so a reported line number still refers to
 * the real file. Deleting a block comment outright shifted every line after it — on
 * `image.utils.ts` a violation on line 170 was reported as line 125, and that is the
 * file this guard's own failure message sends people to.
 */
function stripComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
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
    const source = stripComments(fs.readFileSync(file, 'utf-8'));
    for (const match of source.matchAll(THROWING_PARSE)) {
      const line = source.slice(0, match.index).split('\n').length;
      const rel = path.relative(SRC_DIR, file).split('\\').join('/');
      hits.push(`${rel}:${line}: ${match[0].replace(/\s+/g, ' ').trim()}`);
    }
  }
  return hits;
}

/**
 * 🔴 Reach, not count. A file COUNT cannot fail in the way that matters: measured,
 * a walk that had lost `components/` and `pages/` entirely — every one of the three
 * call sites from the incident — still returned 3,077 files and cleared a floor of
 * 2,000 with room to spare. The natural way that happens is someone adding a third
 * `continue` to `walk` above.
 *
 * So assert the walk actually reaches the files this guard exists to watch. Note the
 * negative-control test below hands its paths to `findViolations` DIRECTLY, which
 * proves the matcher is quiet on them and proves nothing about the walk.
 */
const MUST_REACH = [
  'pages/images/[imageId].tsx',
  'components/Image/Detail/ImageDetailModal.tsx',
  'components/Image/Detail/ImageDetailProvider.tsx',
  'components/Image/image.utils.ts',
];

const FIXTURE = path.join(__dirname, '__fixtures__/throwing-image-query-parse-fixture.ts');

describe('no bare imagesQueryParamSchema.parse', () => {
  it('reaches the files it exists to watch', () => {
    expect(fs.existsSync(SRC_DIR)).toBe(true);
    const scanned = walk(SRC_DIR);
    for (const rel of MUST_REACH) {
      expect(scanned, `the walk no longer reaches ${rel}`).toContain(path.resolve(SRC_DIR, rel));
    }
  });

  it('detects every shape a person would call the same defect', () => {
    // Without this, every assertion below is satisfiable by a matcher matching nothing.
    const detected = findViolations([FIXTURE]);
    const forms = detected.map((d) => d.replace(/^.*?: /, ''));

    // The multi-line ones are why the scan is not line-based.
    expect(forms).toEqual([
      'imagesQueryParamSchema.parse(',
      'imagesQueryParamSchema.omit({ tags: true }).parse(',
      'imagesQueryParamSchema .omit({ tags: true }) .parse(',
      'imagesQueryParamSchema .parse(',
      'imagesQueryParamSchema.parseAsync(',
      'imagesQueryParamSchema?.parse(',
    ]);
  });

  it('does not flag safeParse, which is the thing it tells people to use', () => {
    const detected = findViolations([FIXTURE]);
    expect(detected.some((d) => d.includes('safeParse'))).toBe(false);
  });

  it('ignores the banned call when it appears in a comment', () => {
    // stripComments is load-bearing ONLY here and in this guard's own source — the
    // files the old control named contain no comment the matcher would flag, so it
    // passed with stripComments deleted outright.
    const raw = fs.readFileSync(FIXTURE, 'utf-8');
    expect(raw).toContain('// A commented violation');
    expect(findViolations([FIXTURE])).toHaveLength(6);
  });

  it('reports the real line number, not one shifted by stripped comments', () => {
    const withBlockComment = ['/**', ' * padding', ' */', '', 'x.y;'].join('\n');
    expect(stripComments(withBlockComment).split('\n')).toHaveLength(5);
  });

  it('reports no violations', () => {
    // This file is excluded because the expectations above spell the banned forms out
    // as string literals — code, not comments, so `stripComments` rightly leaves them.
    // Excluding it costs nothing: it is a test file, and `stripComments` is covered by
    // the commented violation in the fixture rather than by this walk. If the guard is
    // ever renamed, this filter stops matching and the file reports itself — loudly,
    // which is the right direction to fail.
    const scanned = walk(SRC_DIR).filter((f) => f !== __filename);
    expect(findViolations(scanned)).toEqual([]);
  });
});
