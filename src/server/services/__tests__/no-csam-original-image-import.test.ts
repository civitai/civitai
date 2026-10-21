import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

/**
 * 🔴 Fails when any module outside `ALLOWED` references `csam-original-image`, so it cannot become
 * a general "serve the original" helper.
 */

const REPO = path.resolve(__dirname, '../../../..');
const ROOTS = ['src', 'scripts', 'apps', 'packages'].map((dir) => path.join(REPO, dir));
const MODULE = 'csam-original-image';

const CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mts',
  '.cts',
  '.mjs',
  '.cjs',
  '.svelte',
]);
const SKIP_DIRS = new Set([
  'node_modules',
  '__screenshots__',
  '.svelte-kit',
  '.next',
  'build',
  'dist',
  '.turbo',
]);

/** Every module allowed to reference it. */
const ALLOWED = [
  'src/server/services/csam.service-new.ts',
  'src/server/services/__tests__/csam-original-image.test.ts',
  // Lists the path in the media-fetch ledger; imports nothing.
  'src/server/services/__tests__/media-fetch-funnel-ledger.test.ts',
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

/**
 * A quoted specifier ending in the module: static, dynamic, `require`, `vi.mock`, re-export.
 * Matched against raw text, comments included: stripping comments is fooled by a `'/*'` inside a
 * string, and a quoted path in a comment is only a false positive.
 */
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
    expect(reference.test(source)).toBe(true);
  });

  it('the matcher ignores a module whose name only starts the same', () => {
    expect(reference.test(`import x from '~/server/services/${MODULE}-helpers';`)).toBe(false);
  });

  it('a block-comment opener in a string does not hide a later import', () => {
    const source = `const route = '/api/*'; await import('../${MODULE}'); /** doc */`;
    expect(reference.test(source)).toBe(true);
  });

  it('only the allowed modules reference it', () => {
    const referencing = files
      .filter((file) => reference.test(readFileSync(file, 'utf8')))
      .map(toRepoPath)
      .sort();

    expect(
      referencing,
      `Only the CSAM archive and NCMEC paths may read stored originals. A new caller needs its ` +
        `own review, not a line added to ALLOWED.`
    ).toEqual([...ALLOWED].sort());
  });

  it('the CSAM service does not hand the reader on to its own importers', () => {
    const service = readFileSync(path.join(REPO, ALLOWED[0]), 'utf8');
    expect(service).not.toMatch(/export\s*\*\s*from\s*['"][^'"]*csam-original-image/);
    expect(service).not.toMatch(/export\s*\{[^}]*\breadOriginalImage\b[^}]*\}/);
    expect(service).not.toMatch(/export\s+(?:const|function|async\s+function)\s+\w*[Oo]riginal/);
  });
});
