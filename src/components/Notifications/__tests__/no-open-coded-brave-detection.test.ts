import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * The `navigator.brave` property must be read in ONE place: `src/utils/device-helpers.ts`.
 *
 * This is not style. The detection was open-coded at two sites — ad-blocking detection and the
 * web-push failure message — and the two copies had DIVERGED: one handled a rejected `isBrave()`,
 * the other left it as an unhandled rejection. Nothing noticed for as long as both existed, because
 * both "worked" and only their failure behaviour differed. `src/components/Ads` has no tests of its
 * own, so without this guard that half of the consolidation is pinned by nothing.
 *
 * 🔴 The pattern matches the property ACCESS in every shape, not the word "Brave" — which appears
 * legitimately in user-facing copy (`pushEnableErrors.ts`) and in unrelated content constants. An
 * earlier version keyed on the optional chain `brave?.isBrave` and so missed a re-inline written with
 * `typeof x.isBrave === 'function'` instead, which is the shape the ORIGINAL duplicate used. Measured
 * at the time of writing: this pattern matches exactly 1 of 4480 production files (the owner), and
 * catches plain access, a cast then `.brave`, single- and double-quoted string keys, and
 * destructuring off `navigator`.
 */

// Resolved from THIS FILE, never from `process.cwd()`. An earlier version used cwd and, run from a
// sibling worktree of this repo, happily graded that tree instead and passed — its existence check
// could not tell, because another checkout has these paths too. Matches the convention the repo's
// other `no-*` guards use.
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SRC = path.join(REPO_ROOT, 'src');
const OWNER = path.join(SRC, 'utils/device-helpers.ts');
/** Reading the property, in any spelling. Not the word "Brave". */
const BRAVE_READ = /\.\s*brave\b|\[\s*['"]brave['"]\s*\]|\{[^}\n]*\bbrave\b[^}\n]*\}\s*=/;
/** Measured 4480. A floor near it catches a scan that silently lost most of the tree. */
const MIN_CORPUS = 4000;

function productionSources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : productionSources(full);
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return [full];
  });
}

describe('navigator.brave is read in exactly one module', () => {
  it('is looking at THIS checkout, and at a tree of the expected size', () => {
    // Asserted before anything is read. Identity, not just existence: a wrong-tree scan would
    // otherwise pass green, which is the same silent-pass failure the guard exists to prevent.
    expect(fs.existsSync(path.join(REPO_ROOT, 'package.json'))).toBe(true);
    expect(fs.existsSync(OWNER)).toBe(true);
    expect(productionSources(SRC).length).toBeGreaterThan(MIN_CORPUS);
  });

  it('positive control: the pattern DOES match the owner', () => {
    // Without this, a pattern that matches nothing anywhere reports a clean sweep forever.
    expect(BRAVE_READ.test(fs.readFileSync(OWNER, 'utf8'))).toBe(true);
  });

  it('positive control: the pattern catches every re-inline shape, and no prose', () => {
    // The shapes are asserted directly rather than trusted, because two of them were misses in an
    // earlier version of this guard.
    const reInlines = [
      'navigator.brave?.isBrave()',
      'const braveApi = (navigator as Navigator & { brave?: { isBrave?: () => Promise<boolean> } }).brave;',
      'const { brave } = navigator as any; if (brave) brave.isBrave();',
      '(navigator as any)["brave"]',
      "(navigator as any)['brave']",
    ];
    for (const shape of reInlines) expect(BRAVE_READ.test(shape), shape).toBe(true);

    // And must NOT fire on the word in copy, or on an unrelated identifier sharing the prefix.
    const innocent = [
      'In Brave, check brave://settings/privacy for "Use Google services for push messaging"',
      'const ua = navigator as Navigator; return config.bravery;',
    ];
    for (const shape of innocent) expect(BRAVE_READ.test(shape), shape).toBe(false);
  });

  it('no other production file reads navigator.brave', () => {
    const offenders = productionSources(SRC)
      .filter((file) => file !== OWNER)
      .filter((file) => BRAVE_READ.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(REPO_ROOT, file));

    expect(offenders).toEqual([]);
  });
});
