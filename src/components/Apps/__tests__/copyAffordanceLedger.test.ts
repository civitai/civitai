import { readFileSync } from 'fs';
import { join, relative } from 'path';
import { describe, expect, it } from 'vitest';
import { EXCLUDE_TEST_FILES, walk } from '../../../../test/source-scan';

/**
 * 🔒 THE CALL-SITE LEDGER for the copy-to-clipboard affordance under `src/components/Apps/`.
 *
 * WHY THIS FILE EXISTS — measured twice, in the same change, both times by a human reading
 * rather than by anything mechanical.
 *
 * `CopyableCommand` was extracted because THREE byte-identical private copies of a copy
 * button had drifted. Adding a fourth consumer, the extraction's own header asserted in bold
 * that there was "not a fourth copy" — and a review found a FIFTH, `AuthorViaGit.tsx`'s
 * private `CopyableCode`, which had already drifted to `aria-label="Copy"` on both of its
 * instances on one panel. The correction then stated "a fifth", and a second review found
 * that number was also wrong, because it had been derived over this directory alone.
 *
 * So the lesson is not "the count was wrong", it is that **a count maintained by hand in a
 * comment is wrong by default**. This replaces the claim with a check.
 *
 * 🔴 WHAT IT ASSERTS, AND THE SCOPE IT HONESTLY CLAIMS. Within `src/components/Apps/`,
 * exactly ONE module may reach for Mantine's `CopyButton`: `CopyAffordance.tsx`, which owns
 * the wiring, the accessible name, the copied-state feedback and the `stopPropagation()` that
 * stops an icon press double-firing the funnel. It fails when the set GROWS (a sixth private
 * copy) and when it SHRINKS (the shared one stops using it, i.e. the seam moved and this
 * ledger is stale).
 *
 * ⚠️ IT DOES NOT COVER THE REPO. The same shell exists in `Account/ApiKeyModal.tsx`,
 * `Account/OAuthAppsCard.tsx` (three times) and `Collections/CollectionEditModal.tsx`, some
 * secret-bearing with no accessible name at all. Widening this ledger to `src/` would be RED
 * on arrival, and a permanently-red gate is worse than none — so the scope is the directory
 * where the extraction lives and where the convention is enforced. Consolidating the rest is
 * a separate change; this file is the thing that will notice if the problem grows HERE again.
 *
 * 🔴 A STRUCTURAL CHECK IS NOT A BEHAVIOURAL ONE. It proves no other module imports the
 * primitive; it cannot prove `CopyAffordance` wires it correctly. That lives in
 * `../AgentOnboardingCard.browser.test.tsx`, `../CopyableCommand`'s consumers' suites and
 * `../AuthorViaGit.browser.test.tsx` — none of which this replaces.
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

  it('NEGATIVE CONTROL: the matcher does not fire on this repo’s own CopyButton wrapper', () => {
    // `~/components/CopyButton/CopyButton` is a DIFFERENT component with the same name. A
    // matcher that counted it would make the ledger red for the wrong reason, and a matcher
    // that counted any mention of the word would match this test file.
    const ownWrapper = "import { CopyButton } from '~/components/CopyButton/CopyButton';";
    expect(/import\s*\{[^}]*\bCopyButton\b[^}]*\}\s*from\s*'@mantine\/core'/.test(ownWrapper)).toBe(
      false
    );
  });
});
