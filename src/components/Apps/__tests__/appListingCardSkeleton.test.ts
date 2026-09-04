import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as geometry from '~/components/Apps/appListingCardGeometry';
// 🔴 THE SKELETON COMPONENT ITSELF IS DELIBERATELY **NOT** IMPORTED. It pulls in
// `@mantine/core` and a `.module.scss`, neither of which the node `unit` project is
// set up for — an import failure there reports as `Tests no tests`, i.e. as nothing
// to see rather than as a failure. Every claim below is therefore made against the
// SOURCE, and `appListingCardGeometry` (React-free and pure, by its own design note)
// is the only module actually imported.

/**
 * ── THE SKELETON ⇄ CARD SINGLE SOURCE ───────────────────────────────────────
 *
 * 🔴 WHAT THIS TIER CAN CLAIM. Nothing about pixels: that the skeleton and the
 * card occupy the SAME BOX is a measurement, and it lives in
 * `AppListingCardSkeleton.geometry.test.tsx`, which renders both grids against the
 * real cascade. What this file checks is the mechanism that makes that
 * measurement stay true: the skeleton READS `appListingCardGeometry.ts` rather
 * than copying it.
 *
 * 🔴 WHY THAT IS WORTH A TEST AT ALL. The card already has this guard
 * (`appListingCardView.test.ts` → "AppListingCard reads every geometry constant
 * the module exports"), and it is only half the relationship. A skeleton that
 * spells `40` where the card reads `LISTING_CARD_ICON_SIZE_PX` is correct on the
 * day it is written and silently wrong the day the constant moves — both files
 * individually reasonable, the grid reflowing on every store load, and no test
 * anywhere red. That is the exact failure the geometry module was extracted to
 * make impossible, and it is impossible only while BOTH ends are pinned.
 *
 * 🔴 "NODE", NOT "BLOCKING". `.github/workflows/lint.yml` carries
 * `continue-on-error: ${{ github.event_name == 'pull_request' }}` at JOB level on
 * `unit` (line 405) and on `geometry` (line 830), so on a PR neither tier gates a
 * merge; they block a `main` push. The canonical statement of this is in
 * `appListingCardGeometry.ts` — do not restate a different severity here.
 */

const SKELETON = path.resolve(__dirname, '../AppListingCardSkeleton.tsx');
const BODY = path.resolve(__dirname, '../AppListingsMarketplaceBody.tsx');
const GEOMETRY_MODULE = '~/components/Apps/appListingCardGeometry';

/**
 * 🔴 THE ONE CONSTANT THE SKELETON IS NOT REQUIRED TO READ — NAMED, SO IT CANNOT
 * BECOME A SILENT HOLE.
 *
 * `LISTING_ACTION_ROW_GAP_PX` is the gap between the CTA and the `⋮` overflow
 * trigger. A card renders that trigger only for an owner or a moderator, which a
 * loading state cannot know, so the skeleton's action row holds exactly ONE child
 * and the gap has nothing to apply to. Importing it to satisfy a set-equality
 * check would be an unread declaration that the next reader has to prove unused —
 * the same shape this component family deleted a `@container` rule and a hook for.
 *
 * It costs no geometry, and that is MEASURED rather than promised — a carve-out
 * justified by "it costs nothing" has to have the cost measured or it is a
 * promise. `AppListingCardSkeleton.geometry.test.tsx` renders the same listings at
 * the same width for a signed-out viewer and for their OWNER, and pins that the
 * CTA gives up exactly `LISTING_ACTION_ROW_CONTROL_PX + LISTING_ACTION_ROW_GAP_PX`
 * of WIDTH to the trigger while the card's box is byte-identical across the two
 * arms ("the ⋮ trigger takes width from the CTA and NOTHING from the card box").
 *
 * The test below still asserts this name IS an export, so the exclusion cannot rot
 * into a reference to a constant that no longer exists.
 */
const NOT_REQUIRED_IN_SKELETON = ['LISTING_ACTION_ROW_GAP_PX'] as const;

const read = (p: string) => fs.readFileSync(p, 'utf8');

/**
 * 🔴 COMMENTS STRIPPED, AND THE STRIP IS ITSELF CONTROLLED BELOW. Every file in
 * this component family quotes its own symbols in prose — this one names
 * `LISTING_CARD_ICON_SIZE_PX` and `keepPreviousData` in docblocks — so an
 * unstripped scan reads the documentation and stays green with the code deleted.
 */
const strip = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * The named bindings the file imports from `moduleSpecifier`, parsed rather than
 * regexed.
 *
 * 🔴 PARSED BECAUSE THE CLAIM IS ABOUT THE IMPORT GRAPH, NOT ABOUT TEXT. A regex
 * over the import statement cannot tell an import from a mention of one inside a
 * string or a comment, and — the case that matters — cannot distinguish
 * `import { X } from 'geometry'` from `import { X } from 'somewhere-else'`. The
 * whole assertion is "these identifiers resolve to THAT module".
 */
function namedImportsFrom(file: string, moduleSpecifier: string): string[] {
  const sf = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names: string[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    if (stmt.moduleSpecifier.text !== moduleSpecifier) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) names.push(el.name.text);
    }
  }
  return names;
}

describe('AppListingCardSkeleton reads the card geometry rather than copying it', () => {
  it('POSITIVE CONTROL — the file was found and the comment strip did not eat the code', () => {
    const code = strip(read(SKELETON));
    expect(code).toContain('export function AppListingCardSkeleton');
    expect(code).toContain('export function AppListingCardSkeletonGrid');
    // …and the strip really removed prose. This sentence exists ONLY in a
    // docblock in that file, so it is a witness that cannot become code.
    expect(read(SKELETON)).toContain('IT IS THE MEASUREMENT');
    expect(code).not.toContain('IT IS THE MEASUREMENT');
  });

  /**
   * 🔴 THE ASSERTION THE WHOLE ARRANGEMENT RESTS ON, AND IT IS AN IMPORT-IDENTITY
   * ONE. Not "the file mentions the constant" and not "the values are equal" — a
   * value comparison between two copies of the same literal passes for every
   * possible value of both, which is why `appListingCardView.test.ts` has a
   * standing rule against it. The set of names imported FROM the geometry module
   * must equal the set of names the geometry module EXPORTS.
   *
   * It fails in both directions on purpose: a constant dropped from the import
   * list (because someone inlined its value) and a constant ADDED to the module
   * that the skeleton does not reserve.
   */
  it('🔴 imports EXACTLY the geometry module’s exports — no more, no fewer', () => {
    const allExports = Object.keys(geometry);
    // The exclusion must still name a real export, or it is silently excusing
    // nothing while reading as a deliberate carve-out.
    for (const name of NOT_REQUIRED_IN_SKELETON) {
      expect(
        allExports,
        `${name} is on the skeleton's exclusion list but appListingCardGeometry no longer ` +
          'exports it — the carve-out has rotted; delete it or repoint it.'
      ).toContain(name);
    }
    const exported = allExports
      .filter((n) => !(NOT_REQUIRED_IN_SKELETON as readonly string[]).includes(n))
      .sort();
    const imported = namedImportsFrom(SKELETON, GEOMETRY_MODULE).sort();

    // Positive control on the parse BEFORE the comparison: a resolver that found
    // no import at all would otherwise report a plain set difference and read as
    // "the skeleton is missing everything" rather than "the scan is broken".
    expect(
      imported.length,
      `no named imports parsed from '${GEOMETRY_MODULE}' in AppListingCardSkeleton.tsx — ` +
        'either the import moved, the specifier changed, or this parser is broken'
    ).toBeGreaterThan(0);
    expect(exported.length, 'appListingCardGeometry exports nothing').toBeGreaterThan(0);

    expect(
      imported,
      'AppListingCardSkeleton and appListingCardGeometry disagree about the geometry set. ' +
        'A constant missing here is a number the skeleton is now spelling itself, which is ' +
        'exactly the drift that module exists to prevent; a constant missing THERE is one ' +
        'the skeleton reserves for a card that no longer has it.'
    ).toEqual(exported);
  });

  /**
   * 🔴 AN IMPORT IS NOT A READ. The mutation this catches is the realistic one:
   * keep the import line intact (so nothing looks wrong) and replace the use site
   * with a literal. The name then occurs exactly ONCE in the file, and the set
   * equality above still holds.
   *
   * Two occurrences is the floor — once in the import clause, once at a use site.
   * `LISTING_CARD_TITLE_LINE_HEIGHT` is read three times; the floor is what is
   * assertable for every constant.
   */
  it('🔴 …and READS each of them — an imported-but-unused constant is a re-literalised one', () => {
    const code = strip(read(SKELETON));
    for (const name of Object.keys(geometry)) {
      if ((NOT_REQUIRED_IN_SKELETON as readonly string[]).includes(name)) continue;
      const uses = [...code.matchAll(new RegExp(name, 'g'))].length;
      expect(
        uses,
        `${name} is imported by AppListingCardSkeleton.tsx but never read ` +
          `(found ${uses} occurrence(s); an import with no use site counts as 1). ` +
          'Its value is presumably spelled inline somewhere below — put the constant back.'
      ).toBeGreaterThanOrEqual(2);
    }
  });

  /**
   * The column ladder is the OTHER single source this file must not copy. The
   * skeleton renders two rows at the CURRENT column count, and that count is the
   * grid's own — `listingGridColumnsAt` in `appListingGrid.ts`, whose thresholds
   * the stylesheet is already pinned against. A second ladder here (a hardcoded
   * count, or `@container` rules hiding surplus cells) would be a third copy.
   */
  it('reads the column ladder from appListingGrid, not from a second copy', () => {
    expect(namedImportsFrom(SKELETON, '~/components/Apps/appListingGrid')).toContain(
      'listingGridColumnsAt'
    );
    const code = strip(read(SKELETON));
    expect(code).toContain('listingGridColumnsAt(');
    // No stylesheet ladder of its own: the skeleton uses the STORE grid's classes,
    // so a skeleton cell and a card cell get the same track from the same rules.
    expect(code).toContain('AppListingsMarketplaceBody.module.scss');
    const container = code.indexOf('gridClasses.gridContainer');
    const grid = code.indexOf('gridClasses.grid}');
    expect(container, 'the skeleton grid does not render the query container').toBeGreaterThan(-1);
    expect(grid, 'the skeleton grid does not render the grid class').toBeGreaterThan(-1);
    expect(container, 'the container must WRAP the grid, not sit inside it').toBeLessThan(grid);
  });

  it('reserves TWO rows, and multiplies the measured column count by that constant', () => {
    const code = strip(read(SKELETON));
    // 2 is typed out here and declared there — a test that read the value out of
    // the module and asserted it equals itself could not fail. That the count the
    // grid RENDERS really is `2 × columns` is measured in the geometry tier.
    expect(code).toMatch(/APP_LISTING_SKELETON_ROWS = 2\b/);
    expect(code).toMatch(/columns \* APP_LISTING_SKELETON_ROWS/);
  });
});

/**
 * ── THE STORE BODY'S HALF OF IT ─────────────────────────────────────────────
 *
 * 🔴 STRUCTURAL ONLY, AND SAY SO. These assert that the wiring EXISTS; whether it
 * WORKS — that the grid genuinely does not empty across a filter change — is a
 * behavioural claim and lives in
 * `AppListingsMarketplaceBody.keepPreviousData.browser.test.tsx`, which drives a
 * real `useInfiniteQuery` through a real key change. A source check alone would be
 * satisfied by an option passed to a query that ignores it.
 */
describe('the store body renders the skeleton grid and keeps the previous page', () => {
  const bodyCode = () => strip(read(BODY));

  it('POSITIVE CONTROL — the body was found and stripped without losing its code', () => {
    expect(bodyCode()).toContain('export function AppListingsMarketplaceBody');
  });

  it('🔴 the first-load state is the skeleton grid, and the bare Loader is gone', () => {
    const code = bodyCode();
    expect(code).toMatch(/isLoading \?\s*\(?\s*<AppListingCardSkeletonGrid\s*\/>/);
    // The retired spinner. Left in place beside the skeleton it would be dead
    // markup that reads as the live loading state to the next person here.
    expect(code, 'the store still renders a bare <Loader /> somewhere').not.toMatch(
      /<Loader[\s/>]/
    );
  });

  it('🔴 passes keepPreviousData to the listing query, imported from react-query', () => {
    expect(namedImportsFrom(BODY, '@tanstack/react-query')).toContain('keepPreviousData');
    expect(bodyCode()).toMatch(/placeholderData:\s*keepPreviousData/);
  });

  it('marks the stale grid while the replacement loads', () => {
    const code = bodyCode();
    expect(code).toContain('isPlaceholderData');
    expect(code).toContain('gridClasses.gridPending');
  });

  /**
   * 🔴 THE ONE THIS CHANGE COULD PLAUSIBLY HAVE BROKEN. `keepPreviousData` REDUCES
   * the window in which `items` is empty — it does not remove it (first load,
   * error, cache eviction) — so the rail's monotonic memo is still load-bearing.
   * `recentAppsRail.test.ts` owns that guard; this is a local reminder that the
   * option and the memo are not alternatives, placed where someone deleting the
   * memo "because keepPreviousData handles it" would meet it.
   */
  it('did NOT drop the recents monotonic memo on the strength of keepPreviousData', () => {
    expect(bodyCode()).toMatch(/reconcileRecentApps\(\s*recents,\s*items,\s*[A-Za-z0-9_.]+\s*\)/);
  });
});
