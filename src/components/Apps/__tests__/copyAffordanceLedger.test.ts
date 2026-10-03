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
 * this is a check instead: the set of modules in this directory that reach for a clipboard
 * primitive is pinned by enumerated equality. It fails when the set GROWS (a new private
 * copy) and when it SHRINKS (the seam moved and this ledger is stale).
 *
 * 🔴 BOTH ROUTES, NOT JUST `CopyButton`. An earlier version matched Mantine's `CopyButton`
 * alone and said it caught "a sixth copy" — it pinned one SPELLING. A copy affordance built
 * on `useClipboard` walks it, and one already exists in this directory: `ReportTabs.tsx` is
 * the same `copy` + copied-icon-swap shell by the other route. It is listed rather than
 * converted — converting it is not this change's job — but it is listed, so a seventh by
 * either route is loud instead of silent.
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

/**
 * The import statements specifically — not a mention in prose, and not this repo's own
 * `~/components/CopyButton`, which is a different wrapper with the same name.
 */
const CLIPBOARD_PRIMITIVE =
  /import\s*\{[^}]*\b(?:CopyButton|useClipboard)\b[^}]*\}\s*from\s*'@mantine\/(?:core|hooks)'/;

/** Modules under `src/components/Apps/` that reach for a Mantine clipboard primitive. */
function clipboardPrimitiveImporters(): string[] {
  return appsSourceFiles()
    .filter((file) => CLIPBOARD_PRIMITIVE.test(readFileSync(file, 'utf8')))
    .map((file) => relative(APPS_DIR, file))
    .sort();
}

describe('🔒 the clipboard-primitive importers under Apps/ are exactly these', () => {
  it('the ledger is exactly this', () => {
    // `ReportTabs.tsx` is a pre-existing `useClipboard` copy, listed so it cannot grow a
    // sibling unnoticed. `CopyAffordance.tsx` is the shared seam.
    expect(clipboardPrimitiveImporters()).toEqual(['CopyAffordance.tsx', 'ReportTabs.tsx']);
  });

  it('POSITIVE CONTROL: the scan reads real files and can see the importer it names', () => {
    // Without this, an empty-equals-empty pass is indistinguishable from a walk pointed at
    // the wrong directory or a regex that matches nothing. Assert the population is real and
    // that the one file the ledger names genuinely contains the import.
    const files = appsSourceFiles();
    expect(files.length, 'the walk found no source files at all').toBeGreaterThan(50);
    const shared = readFileSync(join(APPS_DIR, 'CopyAffordance.tsx'), 'utf8');
    expect(shared).toMatch(CLIPBOARD_PRIMITIVE);
  });
});
