import fs from 'fs';
import path from 'path';
import { describe, expect, test } from 'vitest';

/**
 * 🔒 THE ENROLMENT LEDGER for the app-listing DESCRIPTION presentation rule.
 *
 * WHY THIS FILE EXISTS. The same stored `description` rendered three different
 * ways across four surfaces — full markdown on the listing detail body, `pre-wrap`
 * plain text on the app detail page and the details modal, and a raw-source
 * `line-clamp-3` on the card. Nobody chose that; it accumulated because each call
 * site made its own decision. An author writing a description could not predict
 * what it would look like, so live first-party listings hedge: some use backticks
 * (a markdown idiom, which printed as literal backticks on three of the four), one
 * hard-wraps at ~76 columns (literal under `pre-wrap`, reflowed under markdown).
 *
 * Fixing the four sites does not remove that condition — the NEXT surface can
 * re-open it. So this asserts the RELATIONSHIP rather than any one component: the
 * set of files that present a listing description is exactly the ledger below, and
 * each uses the renderer its role calls for. It fails when the ledger GROWS (a new
 * surface appears) and when it SHRINKS (a site stops using the shared rule).
 *
 * 🔴 WHAT THIS GUARD CANNOT SEE, stated so it is not read as wider than it is: a
 * brand-new surface that open-codes `<Text>{listing.description}</Text>` imports
 * neither module and is therefore invisible here. This guard catches regression of
 * the KNOWN sites and growth through the sanctioned path; it is not a proof that no
 * unenrolled site exists. The behavioural cover in
 * `AppListingDetailBody.browser.test.tsx` and `AppBlockCard.browser.test.tsx` is
 * the other half — it proves the wiring actually renders, which source text cannot.
 */

const SRC = path.resolve(__dirname, '../../..');

const MARKDOWN_MODULE = '~/components/Apps/AppListingDescription';
const PLAINTEXT_MODULE = '~/components/Apps/appListingDescription';

/**
 * Every surface that presents a listing description, and which of the TWO
 * presentations it uses.
 *
 * - `markdown` — a surface whose job is to SHOW the description in full.
 * - `plaintext` — a surface that cannot render markdown (a clamped card in a grid,
 *   a `<meta>` tag), so it shows the markdown's plain-text projection.
 */
const LEDGER: Record<string, 'markdown' | 'plaintext' | 'both'> = {
  'components/Apps/AppListingDetailBody.tsx': 'markdown',
  'components/Apps/AppDetailsModal.tsx': 'markdown',
  // The page renders markdown in the body AND feeds the plain-text projection to
  // its `<meta>`/`og:description`, so it legitimately uses both.
  'pages/apps/[appBlockId]/index.tsx': 'both',
  'components/Apps/AppBlockCard.tsx': 'plaintext',
};

/** Recursively list every .ts/.tsx file under `dir`, excluding tests. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|browser\.test)\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Files that import either half of the shared rule, as SRC-relative paths. */
function findImporters(): Map<string, Set<'markdown' | 'plaintext'>> {
  const found = new Map<string, Set<'markdown' | 'plaintext'>>();
  const roots = [path.join(SRC, 'components'), path.join(SRC, 'pages')];
  for (const root of roots) {
    for (const file of walk(root)) {
      const text = fs.readFileSync(file, 'utf8');
      // The two module specifiers differ only in the leading capital, so match the
      // full quoted specifier — a `includes(PLAINTEXT_MODULE)` would also match the
      // markdown one on a case-insensitive read and silently merge the two sets.
      const usesMarkdown = text.includes(`'${MARKDOWN_MODULE}'`);
      const usesPlaintext = text.includes(`'${PLAINTEXT_MODULE}'`);
      if (!usesMarkdown && !usesPlaintext) continue;
      const rel = path.relative(SRC, file);
      const kinds = found.get(rel) ?? new Set();
      if (usesMarkdown) kinds.add('markdown');
      if (usesPlaintext) kinds.add('plaintext');
      found.set(rel, kinds);
    }
  }
  return found;
}

describe('app-listing description — enrolment ledger', () => {
  test('🔴 the set of enrolled surfaces is EXACTLY the ledger (fails on growth and on shrinkage)', () => {
    const importers = findImporters();
    // Sorted arrays, compared whole — not a subset check. A `toContain` per entry
    // passes while an unlisted fifth surface quietly joins.
    expect([...importers.keys()].sort()).toEqual(Object.keys(LEDGER).sort());
  });

  test('🔴 each surface uses the renderer its ROLE calls for', () => {
    const importers = findImporters();
    for (const [rel, expected] of Object.entries(LEDGER)) {
      const kinds = importers.get(rel);
      expect(kinds, `${rel} imports neither half of the shared rule`).toBeDefined();
      const actual = [...kinds!].sort().join('+');
      const want = expected === 'both' ? 'markdown+plaintext' : expected;
      expect(actual, `${rel} presents its description as "${actual}", ledger says "${want}"`).toBe(
        want
      );
    }
  });

  test('🔴 the page feeds <Meta> the PLAIN-TEXT projection, never the markdown source', () => {
    // The metadata safety property, pinned at the one call site that can violate
    // it. A meta tag cannot render markdown, so shipping the source put literal
    // `**` and backticks into og:description.
    const page = fs.readFileSync(path.join(SRC, 'pages/apps/[appBlockId]/index.tsx'), 'utf8');
    expect(page).toContain('description={metaDescription ||');
    // And the raw value must not be what reaches the tag. Stated as the exact
    // rejected spelling rather than a fuzzy "does not contain description" — the
    // raw `description` identifier legitimately appears all over this file.
    expect(page).not.toContain('description={description ||');
    expect(page).toContain('appListingDescriptionToPlainText(description)');
  });

  test('🔴 no enrolled surface still hand-rolls a pre-wrap description', () => {
    // The exact spelling the two plain-text surfaces used before this change. If it
    // comes back on an enrolled file, the shared rule has been bypassed in place.
    for (const rel of Object.keys(LEDGER)) {
      const text = fs.readFileSync(path.join(SRC, rel), 'utf8');
      const offending = text.includes("whiteSpace: 'pre-wrap'");
      expect(offending, `${rel} re-introduced a hand-rolled pre-wrap description`).toBe(false);
    }
  });

  test('the ledger is non-trivial — a positive control on the scan itself', () => {
    // 🔴 Without this, every assertion above is satisfiable by a `findImporters`
    // that silently returns an empty map (a bad root path, a changed extension
    // filter). The reassuring-zero failure mode: an empty scan compared against an
    // empty expectation would read as a clean pass.
    const importers = findImporters();
    expect(importers.size).toBe(4);
    expect(Object.keys(LEDGER)).toHaveLength(4);
  });
});
