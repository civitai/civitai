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
 * 🔴 The pattern targets reads of the property, not the word "Brave" — which appears legitimately in
 * user-facing copy (`pushEnableErrors.ts`) and in unrelated content constants.
 *
 * It is the UNION of two earlier drafts, because each caught a shape the other missed and an
 * intermediate version shipped with only one half:
 *   - draft 1 keyed on `navigator`-then-`.brave` plus the optional chain `brave?.isBrave`. It caught
 *     an INDIRECT read (`const brave = getIt(); if (brave?.isBrave)`) but missed a read assigned to a
 *     local first, because its `navigator…` alternative cannot cross the `)` of a cast containing `()`.
 *   - draft 2 replaced it with literal property/key access. That caught the local-variable and
 *     destructured shapes but DROPPED the optional-chain alternative, losing the indirect read.
 *
 * ⚠️ RETRACTED from draft 2's own docblock: it claimed draft 1 "missed … the shape the ORIGINAL
 * duplicate used". Measured — it did not. `origin/main`'s duplicate was `nav.brave?.isBrave`, which
 * draft 1 matched. The rewrite was still justified (draft 1 genuinely missed the local-variable shape)
 * but not for the reason given, and acting on the wrong reason is what dropped an alternative.
 *
 * Measured at the time of writing: matches exactly 1 of 4480 production files (the owner), and catches
 * plain access, a cast then `.brave`, a read assigned to a local, all three quote styles of a string
 * key (including a template literal), destructuring off `navigator`, and an indirect `brave?.isBrave`.
 *
 * 🔴 WHAT IT DOES NOT CATCH, stated because two earlier docblocks here overclaimed. The indirect-read
 * alternative is NAME-DEPENDENT: it matches `brave?.isBrave`, so a local called anything else
 * (`probe?.isBrave`) walks it — found by writing that mutant and watching it survive. A computed key
 * (`navigator[k]`), `Reflect.get`, and a nested destructure also pass. This guard raises the cost of
 * re-inlining the obvious way; it is not a proof of absence, and "matches every shape" would be false.
 */

// Resolved from THIS FILE, never from `process.cwd()`. An earlier version used cwd and, run from a
// sibling worktree of this repo, happily graded that tree instead and passed — its existence check
// could not tell, because another checkout has these paths too. Matches the convention the repo's
// other `no-*` guards use.
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SRC = path.join(REPO_ROOT, 'src');
const OWNER = path.join(SRC, 'utils/device-helpers.ts');
/** Reading the property, in any spelling. Not the word "Brave". Union of both drafts — see above. */
const BRAVE_READ =
  /\.\s*brave\b|\[\s*['"`]brave['"`]\s*\]|\{[^}\n]*\bbrave\b[^}\n]*\}\s*=|\bbrave\?\.\s*isBrave/;
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
      // The shape `origin/main` actually shipped, and the one draft 2's docblock wrongly said was missed.
      "if (typeof nav.brave?.isBrave === 'function') { nav.brave.isBrave(); }",
      // Assigned to a local first — draft 1 missed this, which is what justified the rewrite.
      'const braveApi = (navigator as Navigator & { brave?: { isBrave?: () => Promise<boolean> } }).brave;',
      'const { brave } = navigator as any; if (brave) brave.isBrave();',
      // Indirect read — draft 2 dropped this, which is what the union restores.
      'const brave = getIt(); if (brave?.isBrave) brave.isBrave();',
      '(navigator as any)["brave"]',
      "(navigator as any)['brave']",
      '(navigator as any)[`brave`]',
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
