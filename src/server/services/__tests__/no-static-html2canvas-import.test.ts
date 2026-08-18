import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

/**
 * 🔴 SOURCE GATE — the DOM-capture renderer may only be reached through a dynamic
 * `import()`.
 *
 * WHY. It is ~250 kB and exists for one control on one prompt: the opt-in page
 * capture in `src/components/Feedback/captureScreenshot.ts`. Behind a dynamic
 * `import()` the bundler code-splits it into its own chunk, so the ~100% of page
 * loads that never open the feedback prompt never download it. A single static
 * `import html2canvas from 'html2canvas-pro'` anywhere in the app graph collapses
 * that — the chunk merges back into whatever entry reaches it — and NOTHING else in
 * the repo would notice: the feature still works, the tests still pass, and the
 * cost lands on every visitor.
 *
 * WHY THERE ARE TWO NAMES HERE. The renderer used to be `html2canvas`, which throws
 * on any CSS Color Level 4 computed value and so could not capture this site at all;
 * it was replaced by the maintained fork `html2canvas-pro`. `RETIRED` keeps the dead
 * name from creeping back in through a stale snippet or a half-finished migration —
 * in ANY import form, static or dynamic, since neither works once the package is
 * gone from `package.json`.
 *
 * WHY A SOURCE GATE RATHER THAN A BUNDLE ASSERTION. Measuring the emitted chunks
 * needs a full `next build` (many minutes, and it does not run in the `unit`
 * project). This reads the property that CAUSES the split, deterministically, in
 * the tier that actually gates. It is a claim about the import form, not about the
 * byte count — see the scope note at the end.
 */

const SRC = path.resolve(__dirname, '../../../../src');
const DEPENDENCY = 'html2canvas-pro';
const RETIRED = 'html2canvas';

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts']);
const SKIP_DIRS = new Set(['node_modules', '__screenshots__']);

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
 * Strip comments before matching. This very file, and the header of
 * `captureScreenshot.ts`, both write the forbidden form out in prose; an unstripped
 * scan would find the counter-example in a comment and fail on documentation.
 */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/**
 * A STATIC reference to `dep`: an ESM `import ... from '<dep>'`, a bare side-effect
 * `import '<dep>'`, an `export ... from '<dep>'`, or a CommonJS `require('<dep>')`.
 * A dynamic `import('<dep>')` is deliberately NOT matched — the `import` keyword
 * there is followed by `(`, not by a specifier list or a quote.
 *
 * The closing `['"]` is what keeps `RETIRED` from matching `DEPENDENCY`, which is a
 * prefix relationship rather than a coincidence. Pinned below.
 */
const staticFor = (dep: string) =>
  new RegExp(
    String.raw`(?:^|[\s;}])(?:import|export)\s+(?:[^'"();]*?\sfrom\s+)?['"]${dep}['"]` +
      String.raw`|require\(\s*['"]${dep}['"]\s*\)`,
    'm'
  );

const dynamicFor = (dep: string) => new RegExp(String.raw`import\(\s*['"]${dep}['"]\s*\)`);

const staticReference = staticFor(DEPENDENCY);
const dynamicReference = dynamicFor(DEPENDENCY);
const retiredStatic = staticFor(RETIRED);
const retiredDynamic = dynamicFor(RETIRED);

const files = walk(SRC);

describe(`🔴 ${DEPENDENCY} is code-split out of the main bundle`, () => {
  it('the scan actually reached the source tree', () => {
    // A broken walker returning [] would make every assertion below vacuously green.
    // 1000 is far under the real count and far over anything a broken glob returns.
    expect(files.length).toBeGreaterThan(1000);
  });

  /**
   * 🔴 Every fixture below INTERPOLATES `DEPENDENCY`/`RETIRED` rather than spelling
   * either out. The scan runs over `src/` and this file lives in `src/`, so a
   * literal `import x from '<dep>'` written here as a control would be found by the
   * scan and reported as a real offender. Interpolating keeps the file honest
   * without an exclusion list — and an exclusion list is exactly where a genuine
   * offender would eventually hide.
   */
  describe('positive controls — the matcher can see what it is looking for', () => {
    it.each([
      [`import h from '${DEPENDENCY}';`],
      [`import h from "${DEPENDENCY}";`],
      [`import '${DEPENDENCY}';`],
      [`import { foo } from '${DEPENDENCY}';`],
      [`export { default } from '${DEPENDENCY}';`],
      [`const h = require('${DEPENDENCY}');`],
      [`import type H from '${DEPENDENCY}';`],
    ])('flags %s', (source) => {
      expect(staticReference.test(source)).toBe(true);
    });

    it.each([
      [`const h = await import('${DEPENDENCY}');`],
      [`(await import("${DEPENDENCY}")).default;`],
    ])('does NOT flag the dynamic form %s', (source) => {
      expect(staticReference.test(source)).toBe(false);
      expect(dynamicReference.test(source)).toBe(true);
    });

    it('the comment stripper leaves real code intact', () => {
      const commented = `// import h from '${DEPENDENCY}';`;
      expect(stripComments(`${commented}\nconst a = 1;`)).toContain('const a = 1;');
      expect(staticReference.test(stripComments(commented))).toBe(false);
    });

    /**
     * 🔴 `RETIRED` is a PREFIX of `DEPENDENCY`, so the two matcher pairs only stay
     * distinct because each requires the closing quote immediately after the name.
     * That is invisible at the call site and load-bearing in both directions: a
     * looser `RETIRED` matcher would flag every legitimate fork import as a revival
     * of the dead package, and a looser `DEPENDENCY` matcher would accept the dead
     * package as the fork. Neither mistake produces a wrong-looking regex.
     */
    it('the retired name does not match the fork, and the fork does not match the retired name', () => {
      expect(retiredStatic.test(`import h from '${DEPENDENCY}';`)).toBe(false);
      expect(retiredDynamic.test(`await import('${DEPENDENCY}');`)).toBe(false);
      expect(staticReference.test(`import h from '${RETIRED}';`)).toBe(false);
      expect(dynamicReference.test(`await import('${RETIRED}');`)).toBe(false);

      // …and each still sees its own, so the four negatives above are not vacuous.
      expect(retiredStatic.test(`import h from '${RETIRED}';`)).toBe(true);
      expect(retiredDynamic.test(`await import('${RETIRED}');`)).toBe(true);
      expect(staticReference.test(`import h from '${DEPENDENCY}';`)).toBe(true);
      expect(dynamicReference.test(`await import('${DEPENDENCY}');`)).toBe(true);
    });
  });

  it('no file under src/ imports it statically', () => {
    const offenders = files.filter((file) =>
      staticReference.test(stripComments(readFileSync(file, 'utf8')))
    );

    expect(
      offenders.map((f) => path.relative(SRC, f)),
      `A static import of ${DEPENDENCY} merges its ~250 kB back into the importing entry. ` +
        `Reach it through 'await import()' instead — see src/components/Feedback/captureScreenshot.ts.`
    ).toEqual([]);
  });

  it(`the retired ${RETIRED} package is gone from src/ entirely, in every import form`, () => {
    // Not merely "not static": the package is no longer in package.json, so a
    // dynamic import of it is a runtime failure rather than a bundle-size problem —
    // which is how the capture broke in the first place. Both forms are offences.
    const offenders = files.filter((file) => {
      const source = stripComments(readFileSync(file, 'utf8'));
      return retiredStatic.test(source) || retiredDynamic.test(source);
    });

    expect(
      offenders.map((f) => path.relative(SRC, f)),
      `'${RETIRED}' was replaced by '${DEPENDENCY}' because it throws on every CSS ` +
        `Color Level 4 computed value. It is not an installed dependency any more.`
    ).toEqual([]);
  });

  it('is still reached dynamically — the gate is not passing because the dependency vanished', () => {
    // Without this, deleting the feature would leave the file above green forever
    // while claiming to protect a split that no longer exists.
    //
    // An EXACT set, not a `toContain`. Both entries are deliberate and each has a
    // different reason to exist, so a third one should have to be justified:
    //   - captureScreenshot.ts — the production lazy load. This is the one the split
    //     is about.
    //   - captureScreenshot.render.browser.test.ts(x) — the render-seam test's
    //     NEGATIVE CONTROL, which drives the renderer directly with the historical
    //     `scrollX/scrollY: 0` defect to prove the fixture discriminates. Test files
    //     are not in the app bundle, so this costs a user nothing; it is listed
    //     rather than filtered out so the set stays honest about what the scan saw.
    //   - captureScreenshot.color4.browser.test.tsx is deliberately NOT here: it
    //     goes through `captureConsentedScreenshot`, so it exercises the PRODUCTION
    //     loader rather than reaching past it.
    const dynamicUsers = files
      .filter((file) => dynamicReference.test(stripComments(readFileSync(file, 'utf8'))))
      .map((f) => path.relative(SRC, f))
      .sort();

    expect(dynamicUsers).toEqual(
      [
        path.join('components', 'Feedback', 'captureScreenshot.render.browser.test.tsx'),
        path.join('components', 'Feedback', 'captureScreenshot.ts'),
      ].sort()
    );
  });

  it('the PRODUCTION module is one of them (not just the test)', () => {
    // Guards the set above from being "satisfied" by test files alone if the
    // production lazy load were ever deleted or made static.
    const production = path.join(SRC, 'components', 'Feedback', 'captureScreenshot.ts');
    const source = stripComments(readFileSync(production, 'utf8'));

    expect(dynamicReference.test(source)).toBe(true);
    expect(staticReference.test(source)).toBe(false);
  });
});

/**
 * 🔴 SCOPE, stated honestly. This proves the import FORM across `src/`. It does not
 * measure emitted chunk sizes, and it does not see a static import introduced from
 * `packages/`, `apps/`, or a transitive dependency that happens to bundle the
 * renderer itself. Those are different failure modes and would need a real build
 * to catch.
 */
