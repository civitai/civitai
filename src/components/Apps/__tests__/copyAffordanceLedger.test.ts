import { readFileSync } from 'fs';
import { join, relative } from 'path';
import { describe, expect, it } from 'vitest';
import { EXCLUDE_TEST_FILES, walk } from '../../../../test/source-scan';

/**
 * 🔒 THE CALL-SITE LEDGER for the copy affordance under `src/components/Apps/`.
 *
 * `CopyableCommand` was extracted because three byte-identical private copies of a copy
 * button had drifted. Its header then asserted there was "not a fourth copy" — and a review
 * found a fifth, `AuthorViaGit.tsx`'s private `CopyableCode`, already drifted to
 * `aria-label="Copy"` on both of its instances on one panel. The correction said "a fifth",
 * and that was wrong too. A count maintained by hand in a comment is wrong by default, so
 * this is a check instead: within this directory, exactly one module may import Mantine's
 * `CopyButton`. It fails when the set GROWS (a sixth copy) and when it SHRINKS (the seam
 * moved and this ledger is stale).
 *
 * ⚠️ SCOPE IS THIS DIRECTORY, NOT THE REPO. The same shell also sits in
 * `Account/ApiKeyModal.tsx`, `Account/OAuthAppsCard.tsx` (×3) and
 * `Collections/CollectionEditModal.tsx`, some secret-bearing with no accessible name at all.
 * Widening this would be red on arrival, and a permanently-red gate is worse than none.
 * Consolidating those is a separate change.
 *
 * Structural only — it proves no other module imports the primitive, not that the shared one
 * wires it correctly. That lives in the three browser suites.
 */

const APPS_DIR = join(process.cwd(), 'src/components/Apps');

/**
 * The scanned population: every non-test `.ts`/`.tsx` directly under `src/components/Apps/`
 * and below.
 *
 * 🔴 `walk` + the SHARED `EXCLUDE_TEST_FILES`, NOT `sourceFiles`. `sourceFiles(root)` joins
 * `src` onto its argument — it is built for `root = <repo>` — so passing it a directory
 * scans `<dir>/src`, which here does not exist. That is a population definition silently
 * narrowing to nothing, the exact failure `source-scan.ts`'s own header warns about, and it
 * is why the positive control below asserts a FLOOR on the file count rather than trusting
 * the walk. Reusing the exclude regex keeps this ledger's idea of "a test file" the same as
 * every other ledger's.
 */
function appsSourceFiles(): string[] {
  return walk(APPS_DIR).filter(
    (file) => !EXCLUDE_TEST_FILES.test(relative(process.cwd(), file).split('\\').join('/'))
  );
}

/** Modules under `src/components/Apps/` that import `CopyButton` from `@mantine/core`. */
function mantineCopyButtonImporters(): string[] {
  return appsSourceFiles()
    .filter((file) => {
      const text = readFileSync(file, 'utf8');
      // The import statement specifically — not a mention in prose, and not this repo's own
      // `~/components/CopyButton`, which is a different wrapper.
      const mantineImport = /import\s*\{[^}]*\bCopyButton\b[^}]*\}\s*from\s*'@mantine\/core'/;
      return mantineImport.test(text);
    })
    .map((file) => relative(APPS_DIR, file))
    .sort();
}

describe('🔒 only the shared affordance reaches for Mantine CopyButton under Apps/', () => {
  it('the ledger is exactly this', () => {
    expect(mantineCopyButtonImporters()).toEqual(['CopyAffordance.tsx']);
  });

  it('POSITIVE CONTROL: the scan reads real files and can see the importer it names', () => {
    // Without this, an empty-equals-empty pass is indistinguishable from a walk pointed at
    // the wrong directory or a regex that matches nothing. Assert the population is real and
    // that the one file the ledger names genuinely contains the import.
    const files = appsSourceFiles();
    expect(files.length, 'the walk found no source files at all').toBeGreaterThan(50);
    const shared = readFileSync(join(APPS_DIR, 'CopyAffordance.tsx'), 'utf8');
    expect(shared).toMatch(/import\s*\{[^}]*\bCopyButton\b[^}]*\}\s*from\s*'@mantine\/core'/);
  });
});
