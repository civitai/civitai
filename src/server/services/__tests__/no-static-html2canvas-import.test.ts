import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

/**
 * 🔴 SOURCE GATE — `html2canvas` may only be reached through a dynamic `import()`.
 *
 * WHY. html2canvas is ~200 kB and exists for one control on one prompt: the opt-in
 * page capture in `src/components/Feedback/captureScreenshot.ts`. Behind a dynamic
 * `import()` the bundler code-splits it into its own chunk, so the ~100% of page
 * loads that never open the feedback prompt never download it. A single static
 * `import html2canvas from 'html2canvas'` anywhere in the app graph collapses that
 * — the chunk merges back into whatever entry reaches it — and NOTHING else in the
 * repo would notice: the feature still works, the tests still pass, and the cost
 * lands on every visitor.
 *
 * WHY A SOURCE GATE RATHER THAN A BUNDLE ASSERTION. Measuring the emitted chunks
 * needs a full `next build` (many minutes, and it does not run in the `unit`
 * project). This reads the property that CAUSES the split, deterministically, in
 * the tier that actually gates. It is a claim about the import form, not about the
 * byte count — see the scope note at the end.
 */

const SRC = path.resolve(__dirname, '../../../../src');
const DEPENDENCY = 'html2canvas';

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
 * A STATIC reference: an ESM `import ... from 'html2canvas'`, a bare side-effect
 * `import 'html2canvas'`, an `export ... from 'html2canvas'`, or a CommonJS
 * `require('html2canvas')`. A dynamic `import('html2canvas')` is deliberately NOT
 * matched — the `import` keyword there is followed by `(`, not by a specifier list
 * or a quote.
 */
const staticReference = new RegExp(
  String.raw`(?:^|[\s;}])(?:import|export)\s+(?:[^'"();]*?\sfrom\s+)?['"]${DEPENDENCY}['"]` +
    String.raw`|require\(\s*['"]${DEPENDENCY}['"]\s*\)`,
  'm'
);

const dynamicReference = new RegExp(String.raw`import\(\s*['"]${DEPENDENCY}['"]\s*\)`);

const files = walk(SRC);

describe(`🔴 ${DEPENDENCY} is code-split out of the main bundle`, () => {
  it('the scan actually reached the source tree', () => {
    // A broken walker returning [] would make every assertion below vacuously green.
    // 1000 is far under the real count and far over anything a broken glob returns.
    expect(files.length).toBeGreaterThan(1000);
  });

  /**
   * 🔴 Every fixture below INTERPOLATES `DEPENDENCY` rather than spelling it. The
   * scan runs over `src/` and this file lives in `src/`, so a literal
   * `import x from 'html2canvas'` written here as a control would be found by the
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
  });

  it('no file under src/ imports it statically', () => {
    const offenders = files.filter((file) =>
      staticReference.test(stripComments(readFileSync(file, 'utf8')))
    );

    expect(
      offenders.map((f) => path.relative(SRC, f)),
      `A static import of ${DEPENDENCY} merges its ~200 kB back into the importing entry. ` +
        `Reach it through 'await import()' instead — see src/components/Feedback/captureScreenshot.ts.`
    ).toEqual([]);
  });

  it('is still reached dynamically — the gate is not passing because the dependency vanished', () => {
    // Without this, deleting the feature would leave the file above green forever
    // while claiming to protect a split that no longer exists.
    const dynamicUsers = files.filter((file) =>
      dynamicReference.test(stripComments(readFileSync(file, 'utf8')))
    );

    expect(dynamicUsers.map((f) => path.relative(SRC, f))).toEqual([
      path.join('components', 'Feedback', 'captureScreenshot.ts'),
    ]);
  });
});

/**
 * 🔴 SCOPE, stated honestly. This proves the import FORM across `src/`. It does not
 * measure emitted chunk sizes, and it does not see a static import introduced from
 * `packages/`, `apps/`, or a transitive dependency that happens to bundle
 * html2canvas itself. Those are different failure modes and would need a real build
 * to catch.
 */
