import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

/**
 * 🔴 `csam-original-image` reads a user's stored upload past every delivery-side control (edge,
 * browsing level, moderation). It exists for CSAM evidence only: the report archive and the
 * NCMEC upload, both in `csam.service-new.ts`. This fails when any other module reaches it, so it
 * cannot quietly become a general "serve the original" helper.
 */

const REPO = path.resolve(__dirname, '../../../..');
const ROOTS = ['src', 'scripts'].map((dir) => path.join(REPO, dir));
const MODULE = 'csam-original-image';

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);
const SKIP_DIRS = new Set(['node_modules', '__screenshots__']);

/** Every module allowed to reference it. Production callers first; then the tests that drive them. */
const ALLOWED = [
  'src/server/services/csam.service-new.ts',
  'src/server/services/__tests__/csam-original-image.test.ts',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (CODE_EXTENSIONS.has(path.extname(entry))) out.push(full);
  }
  return out;
}

const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/** A quoted specifier ending in the module: static, dynamic, `require`, `vi.mock`, re-export. */
const reference = new RegExp(String.raw`['"\`][^'"\`\n]*/${MODULE}(?:\.[cm]?[jt]sx?)?['"\`]`);

const files = ROOTS.flatMap((root) => walk(root));
const toRepoPath = (file: string) => path.relative(REPO, file).split(path.sep).join('/');

describe(`🔴 ${MODULE} is reachable only from the CSAM evidence paths`, () => {
  it('the scan reached the source tree', () => {
    expect(files.length).toBeGreaterThan(1000);
  });

  it.each([
    [`import { readOriginalImage } from '~/server/services/${MODULE}';`],
    [`import type { OriginalImage } from "../${MODULE}";`],
    [`const m = await import('~/server/services/${MODULE}');`],
    [`export * from './${MODULE}';`],
    [`const m = require('../services/${MODULE}.ts');`],
    [`vi.mock('~/server/services/${MODULE}', () => ({}));`],
  ])('the matcher sees %s', (source) => {
    expect(reference.test(stripComments(source))).toBe(true);
  });

  it.each([
    [`import x from '~/server/services/${MODULE}-helpers';`],
    [`// import { readOriginalImage } from '~/server/services/${MODULE}';`],
  ])('the matcher ignores %s', (source) => {
    expect(reference.test(stripComments(source))).toBe(false);
  });

  it('only the allowed modules reference it', () => {
    const referencing = files
      .filter((file) => reference.test(stripComments(readFileSync(file, 'utf8'))))
      .map(toRepoPath)
      .sort();

    expect(
      referencing,
      `Only the CSAM archive and NCMEC paths may read stored originals. A new caller needs its ` +
        `own review, not a line added to ALLOWED.`
    ).toEqual([...ALLOWED].sort());
  });
});
