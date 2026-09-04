import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';
import {
  APPS_ACTIVE_PREVIEWS_COLUMNS,
  APPS_ACTIVITY_COLUMNS,
  APPS_AGENT_REPORT_SCOPE_COLUMNS,
  APPS_FULL_MEASURE_CONTENT_WIDTH,
  APPS_LEGACY_CONTENT_WIDTH,
  APPS_MINE_COLUMNS,
  APPS_MOD_LISTINGS_COLUMNS,
  APPS_OFFSITE_REPORTS_COLUMNS,
  APPS_REVENUE_COLUMNS,
  APPS_REVIEW_QUEUE_COLUMNS,
  APPS_TABLE_COLUMN_LEDGERS,
  appsCardGridColumnsAt,
  appsTableColumnProblems,
  type AppsTableColumns,
} from '~/components/Apps/appsWideLayout';
import * as LEDGER_EXPORTS from '~/components/Apps/appsWideLayout';

/**
 * `appsWideLayout` — the RULE and the LEDGERS, in the blocking `unit` project.
 *
 * WHAT THIS FILE OWNS: the DATA (one primary per ledger, the percentages leave room for
 * it, the card ladder steps where it should), the COVERAGE (every headed table under the
 * apps components has a ledger or a verified exemption), the PLACEMENT (the colgroup is
 * its table's first child) and the ledger↔table COLUMN COUNT.
 *
 * WHAT `AppsWideLayout.geometry.test.tsx` OWNS: the resolved WIDTHS.
 *
 * ⚠️ THAT SPLIT IS NOT THE ONE IT LOOKS LIKE, AND IT WAS MEASURED RATHER THAN ASSUMED.
 * The ordering guard here was written believing a misplaced `<colgroup>` is ignored by the
 * browser — i.e. that geometry would be the real catch. Two mutations settled it on
 * 2026-09-04. Moving the element after `<Table.Tbody>` left all eight geometry assertions
 * GREEN and turned only this file red: React inserts nodes through the DOM API, so the HTML
 * parser's table foster-parenting never runs and Chromium honours the columns wherever the
 * element sits. DELETING the colgroup outright turns the geometry assertions red — the
 * positive control proving that green was about placement, not about that tier being blind.
 * So placement and column count are enforced HERE and only here.
 */

const repoFile = (rel: string) => path.resolve(__dirname, '../../../..', rel);
const srcOf = (rel: string) => fs.readFileSync(repoFile(rel), 'utf8');

/**
 * Every file under `src` that RENDERS `<Component …>`, excluding tests.
 *
 * Used to verify the exemption allowlist below, so a "nothing renders this" claim is
 * re-derived rather than believed. Text-scanned rather than parsed on purpose: this is a
 * search for a live call site, and being over-inclusive (a commented-out render would
 * count) fails CLOSED — it would refuse an exemption, never grant one.
 */
function renderSitesOf(component: string): string[] {
  const hits: string[] = [];
  const needle = new RegExp(`<${component}[\\s/>]`);
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(full);
        continue;
      }
      if (!entry.name.endsWith('.tsx') || entry.name.includes('.test.')) continue;
      if (needle.test(fs.readFileSync(full, 'utf8'))) {
        hits.push(path.relative(repoFile('.'), full).replace(/\\/g, '/'));
      }
    }
  };
  walk(repoFile('src'));
  return hits.sort();
}

/**
 * The file with every BLOCK COMMENT removed.
 *
 * 🔴 A COMMENT IS NOT A RENDER, AND THIS FILE LEARNED IT THE EXPENSIVE WAY ROUND. An
 * earlier ordering guard read `indexOf('<Table.Thead')`, and the JSX comment that EXPLAINS
 * why the colgroup must precede the head contains that exact string — so it reported the
 * elements in the wrong order on a file that was perfectly correct. That guard is gone
 * (the AST walk below cannot be fooled by prose at all), but the text-matching checks that
 * remain still need this: the hazard in the other direction — a guard matching a
 * COMMENTED-OUT element and calling it a render — is the one this repo keeps hitting.
 */
const stripBlockComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '');
const codeOf = (rel: string) => stripBlockComments(srcOf(rel));

describe('appsTableColumnProblems — the rule, on inputs it must REJECT', () => {
  // 🔴 THE VALIDATOR'S ONLY REAL INPUTS ALL PASS, so without these it could be gutted
  // and the suite would stay green. Each row below is a ledger that must be reported.
  const cases: { name: string; columns: AppsTableColumns; offends: boolean }[] = [
    { name: 'a valid ledger', columns: [10, null, 14, 16, 12], offends: false },
    { name: 'a two-column ledger', columns: [null, 30], offends: false },
    { name: 'NO primary — nothing absorbs the slack', columns: [10, 20, 30], offends: true },
    { name: 'TWO primaries — the slack splits', columns: [null, 20, null], offends: true },
    { name: 'a zero-width column', columns: [null, 0, 20], offends: true },
    { name: 'a negative width', columns: [null, -5, 20], offends: true },
    { name: 'a non-finite width', columns: [null, Number.NaN], offends: true },
    { name: 'the percentages claim exactly 100', columns: [null, 50, 50], offends: true },
    { name: 'the percentages claim more than 100', columns: [null, 60, 60], offends: true },
    { name: 'an empty ledger', columns: [], offends: true },
  ];

  test.each(cases)('$name', ({ columns, offends }) => {
    expect(appsTableColumnProblems('fixture', columns).length > 0).toBe(offends);
  });

  test('the table exercises both verdicts and no row is a duplicate', () => {
    // Guard-the-guard: duplicated rows inflate the table without adding coverage, and a
    // table of only-bad rows is satisfied by a validator that rejects everything.
    const keys = cases.map((c) => JSON.stringify(c.columns));
    expect(new Set(keys).size).toBe(keys.length);
    expect(cases.some((c) => c.offends)).toBe(true);
    expect(cases.some((c) => !c.offends)).toBe(true);
  });

  test('the message names WHICH ledger and WHAT is wrong', () => {
    // A guard whose message does not say what is wrong sends the next reader hunting.
    const [msg] = appsTableColumnProblems('my apps', [10, 20, 30]);
    expect(msg).toContain('my apps');
    expect(msg).toContain('exactly ONE');
    const [over] = appsTableColumnProblems('my apps', [null, 60, 60]);
    expect(over).toContain('120%');
    // …and the two defects do not print the same sentence.
    expect(over).not.toContain('exactly ONE');
  });
});

describe('every shipped ledger is valid', () => {
  test('the sweep found the ledgers (guards a vacuous loop)', () => {
    // A loop over an empty record passes having checked nothing.
    expect(Object.keys(APPS_TABLE_COLUMN_LEDGERS)).toHaveLength(10);
  });

  test('no ledger has a problem', () => {
    const problems = Object.entries(APPS_TABLE_COLUMN_LEDGERS).flatMap(([label, columns]) =>
      appsTableColumnProblems(label, columns)
    );
    expect(problems).toEqual([]);
  });

  test('each ledger has the length we DECIDED (a value pin, not a relationship)', () => {
    // 🔴 THE TITLE USED TO SAY "the column COUNT ITS TABLE RENDERS" — a relationship the
    // body never checked, because it compares `.length` against a literal and never opens
    // a component. Measured: adding a `<Table.Th>` without touching the ledger left this
    // GREEN for every table, and green at BOTH tiers for two of them. The relationship is
    // now checked against the parsed tables, further down; this stays as what it always
    // was — a value pin, honestly labelled, so a silent re-tune is still visible.
    expect(APPS_REVIEW_QUEUE_COLUMNS.withoutDeploy).toHaveLength(5); // Kind App Submitter date action
    expect(APPS_REVIEW_QUEUE_COLUMNS.withDeploy).toHaveLength(6); // …plus Deploy
    expect(APPS_MINE_COLUMNS).toHaveLength(4); // App Cover Status Updated
    expect(APPS_MOD_LISTINGS_COLUMNS).toHaveLength(5); // App Owner Category Reviews actions
    expect(APPS_REVENUE_COLUMNS.withApp).toHaveLength(7); // Date App Scope Buzz Gross Share Status
    expect(APPS_REVENUE_COLUMNS.scoped).toHaveLength(6); // …minus App
    expect(APPS_ACTIVE_PREVIEWS_COLUMNS).toHaveLength(5); // App Version State Age actions
    expect(APPS_OFFSITE_REPORTS_COLUMNS).toHaveLength(6); // App Reason Reporter Reported Status actions
    expect(APPS_ACTIVITY_COLUMNS).toHaveLength(5); // When App Action Detail Status
    expect(APPS_AGENT_REPORT_SCOPE_COLUMNS).toHaveLength(6); // Scope Used Justified Sensitive Evidence Notes
  });

  test('🔴 the two-shape ledgers differ by exactly one column', () => {
    // Both pairs exist because ONE optional column exists. A pair that differed by two
    // would mean a width-conditional column set had crept in, which is the thing the
    // module's docstring forbids.
    expect(
      APPS_REVIEW_QUEUE_COLUMNS.withDeploy.length - APPS_REVIEW_QUEUE_COLUMNS.withoutDeploy.length
    ).toBe(1);
    expect(APPS_REVENUE_COLUMNS.withApp.length - APPS_REVENUE_COLUMNS.scoped.length).toBe(1);
  });

  test('the PRIMARY column is where the ledger says it is', () => {
    // Named positions, so moving the primary to a badge or a date column fails here
    // rather than merely looking odd on screen.
    expect(APPS_REVIEW_QUEUE_COLUMNS.withoutDeploy.indexOf(null)).toBe(1); // App
    expect(APPS_REVIEW_QUEUE_COLUMNS.withDeploy.indexOf(null)).toBe(1); // App
    expect(APPS_MINE_COLUMNS.indexOf(null)).toBe(0); // App
    expect(APPS_MOD_LISTINGS_COLUMNS.indexOf(null)).toBe(0); // App
    expect(APPS_REVENUE_COLUMNS.withApp.indexOf(null)).toBe(1); // App
    expect(APPS_REVENUE_COLUMNS.scoped.indexOf(null)).toBe(1); // Scope — there is no App
  });

  test('🔴 the primary column is left a MEANINGFUL share, not a sliver', () => {
    // `< 100%` alone is satisfied by a ledger claiming 99%. The point of the primary is
    // that it takes the surplus, so it has to be the biggest single share at the current
    // container width — asserted against the real content width rather than a ratio.
    for (const [label, columns] of Object.entries(APPS_TABLE_COLUMN_LEDGERS)) {
      const claimed = columns.reduce<number>((sum, c) => sum + (c ?? 0), 0);
      const primaryPct = 100 - claimed;
      const widest = Math.max(...columns.map((c) => c ?? 0));
      expect(primaryPct, `${label}: the primary column's share`).toBeGreaterThan(widest);
    }
  });
});

describe('🔴 every HEADED table under /apps is enumerated, not remembered', () => {
  /**
   * 🔴 THIS REPLACED A HAND-WRITTEN LIST OF FOUR FILES, AND THE REPLACEMENT IS THE FIX
   * FOR A REAL DEFECT THIS PR SHIPPED. The first pass removed `/apps/review`'s 1368 body
   * cap and gave ledgers to the two tables somebody had in mind. That route renders FOUR
   * tables, and the cap was the only thing holding the other two down: measured on
   * `ActivePreviewsPanel` at 1440 → 2560, the gap between a row's slug and its "Tear
   * down" button grew 609.67 → 1173.55 — half the container delta, i.e. exactly the
   * defect this module exists to remove, newly introduced by removing its workaround.
   *
   * A list of files nobody derives cannot notice a table it never mentioned. So the set
   * is DERIVED by parsing every component under the two directories, and anything without
   * a ledger has to be EXEMPTED BY NAME with a reason.
   *
   * ⚠️ WHAT THIS GUARD DOES NOT COVER, stated rather than implied:
   *   · a table with NO header row is out of scope (there is no column ledger to attach
   *     and no header cell to count against one) — `AppAnalyticsPanel`'s two key/value
   *     tables are the live examples;
   *   · it reads `src/components/Apps` and `src/components/AppBlocks` only, so a table
   *     defined outside those directories and rendered on an apps route is invisible to
   *     it. Both limits are deliberate; neither is measured to be empty.
   */
  const SCAN_DIRS = ['src/components/Apps', 'src/components/AppBlocks'];

  /** Tags that are a header CELL. `SortableTh` is a real one, not a naming convention. */
  const HEADER_TAGS = new Set(['Table.Th', 'SortableTh']);

  /**
   * Headed tables that legitimately carry no ledger, each with the reason.
   *
   * 🔴 VERIFIED, NOT TRUSTED — the same rule the chrome allowlist in
   * `appsPageWidths.test.ts` holds itself to. Every entry here claims the component is
   * not rendered on any route, and the test below re-derives that by searching the whole
   * of `src` for a JSX render of it. Adding a name cannot silence the guard.
   */
  const EXEMPT: Record<string, { component: string; why: string }> = {
    'src/components/Apps/OffsiteReviewQueue.tsx#0': {
      component: 'OffsiteReviewQueue',
      why: 'dead — superseded by the unified queue; nothing renders it (the LIVE table in this file is OffsiteReportsQueue, which does carry a ledger)',
    },
    'src/components/Apps/MySubmissionsList.tsx#0': {
      component: 'MySubmissionsList',
      why: 'dead — /apps/my-submissions merged into /apps/mine and 301s there',
    },
    'src/components/Apps/OffsiteSubmissionsList.tsx#0': {
      component: 'OffsiteSubmissionsList',
      why: 'dead — same merge as MySubmissionsList',
    },
  };

  type TableSite = {
    id: string;
    file: string;
    /** Is the FIRST renderable child an `AppsTableColgroup`? */
    colgroupIsFirstChild: boolean;
    /** Is there an `AppsTableColgroup` among the table's children at all? */
    hasColgroup: boolean;
    /** Ledger expressions named on the colgroup's `columns` prop. */
    ledgerRefs: string[];
    /** Header cells that always render. */
    headerCellsAlways: number;
    /** …plus the ones inside a `{cond && …}` / ternary. */
    headerCellsTotal: number;
  };

  const isElement = (n: ts.Node): n is ts.JsxElement | ts.JsxSelfClosingElement =>
    ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n);
  const tagOf = (n: ts.JsxElement | ts.JsxSelfClosingElement, src: ts.SourceFile) =>
    (ts.isJsxElement(n) ? n.openingElement.tagName : n.tagName).getText(src);

  /** Every `<Table>` element in `file` that has a header row, with what it carries. */
  function tableSites(file: string): TableSite[] {
    const abs = repoFile(file);
    const source = ts.createSourceFile(
      abs,
      fs.readFileSync(abs, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    const sites: TableSite[] = [];
    let seen = 0;

    /** Count header cells under `node`, split by whether they are inside an expression. */
    const countHeaders = (node: ts.Node): { always: number; total: number } => {
      let always = 0;
      let total = 0;
      const walkRow = (row: ts.JsxElement) => {
        for (const child of row.children) {
          if (isElement(child) && HEADER_TAGS.has(tagOf(child, source))) {
            always += 1;
            total += 1;
          } else if (ts.isJsxExpression(child) && child.expression) {
            // A conditional header cell — counted toward the TOTAL only.
            const inner = (n: ts.Node): void => {
              if (isElement(n) && HEADER_TAGS.has(tagOf(n, source))) total += 1;
              ts.forEachChild(n, inner);
            };
            inner(child.expression);
          }
        }
      };
      const findRows = (n: ts.Node): void => {
        if (ts.isJsxElement(n) && tagOf(n, source) === 'Table.Tr') walkRow(n);
        ts.forEachChild(n, findRows);
      };
      findRows(node);
      return { always, total };
    };

    const visit = (node: ts.Node): void => {
      if (ts.isJsxElement(node) && tagOf(node, source) === 'Table') {
        // A header row group is what makes a table in scope.
        let thead: ts.Node | null = null;
        const findThead = (n: ts.Node): void => {
          if (thead) return;
          if (ts.isJsxElement(n) && tagOf(n, source) === 'Table.Thead') thead = n;
          else ts.forEachChild(n, findThead);
        };
        node.children.forEach(findThead);
        if (thead) {
          const id = `${file}#${seen}`;
          seen += 1;
          // 🔴 THE FIRST *RENDERABLE* CHILD. JSX text is whitespace and a `{/* … */}`
          // comment is a JsxExpression with no expression — neither renders, and treating
          // either as "the first child" would fail every correctly-written call site,
          // all of which explain themselves in a comment above the colgroup.
          const renderable = node.children.filter(
            (c) => isElement(c) || (ts.isJsxExpression(c) && !!c.expression)
          );
          const first = renderable[0];
          const colgroups = node.children.filter(
            (c): c is ts.JsxSelfClosingElement | ts.JsxElement =>
              isElement(c) && tagOf(c, source) === 'AppsTableColgroup'
          );
          const attrs = colgroups[0]
            ? ts.isJsxElement(colgroups[0])
              ? colgroups[0].openingElement.attributes
              : colgroups[0].attributes
            : null;
          const columnsText =
            attrs?.properties
              .filter(ts.isJsxAttribute)
              .find((a) => a.name.getText(source) === 'columns')
              ?.initializer?.getText(source) ?? '';
          const { always, total } = countHeaders(thead);
          sites.push({
            id,
            file,
            colgroupIsFirstChild:
              !!first && isElement(first) && tagOf(first, source) === 'AppsTableColgroup',
            hasColgroup: colgroups.length > 0,
            ledgerRefs: [...new Set(columnsText.match(/APPS_[A-Z0-9_]+(?:\.\w+)?/g) ?? [])],
            headerCellsAlways: always,
            headerCellsTotal: total,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return sites;
  }

  /** Every `.tsx` under the scan dirs that is not itself a test. */
  function scanFiles(): string[] {
    const out: string[] = [];
    for (const dir of SCAN_DIRS) {
      const abs = repoFile(dir);
      const walk = (d: string) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, entry.name);
          if (entry.isDirectory()) {
            if (entry.name !== '__tests__') walk(full);
            continue;
          }
          if (!entry.name.endsWith('.tsx') || entry.name.includes('.test.')) continue;
          out.push(path.relative(repoFile('.'), full).replace(/\\/g, '/'));
        }
      };
      walk(abs);
    }
    return out.sort();
  }

  const SITES = scanFiles().flatMap((f) => tableSites(f));

  test('🔴 the headed-table set is exactly this (fails when it GROWS or SHRINKS)', () => {
    // A LEDGER, not a floor. A walk that found nothing makes every loop below pass having
    // checked nothing — the failure the hand-written file list had, arrived at by a
    // different route — and a floor cannot see a NEW table either, which is the whole
    // reason this describe block exists. Adding a headed table to these directories is
    // meant to fail here and be classified deliberately.
    expect(scanFiles().length).toBeGreaterThan(40);
    expect(SITES.map((s) => s.id)).toEqual([
      'src/components/AppBlocks/RevenuePanel.tsx#0',
      'src/components/Apps/ActivePreviewsPanel.tsx#0',
      'src/components/Apps/AppActivityPanel.tsx#0',
      'src/components/Apps/AppListingsModerationTable.tsx#0',
      'src/components/Apps/MyAppsBody.tsx#0',
      'src/components/Apps/MySubmissionsList.tsx#0',
      // 🔴 TWO ENTRIES FOR ONE FILE, and this is the row that proves the walk is
      // per-TABLE rather than per-file: `#0` is the dead `OffsiteReviewQueue` and `#1` is
      // the live `OffsiteReportsQueue`. A per-file guard cannot express "one of these
      // needs a ledger and the other does not", and an `indexOf`-based one would have
      // graded the second table against the first one's colgroup.
      'src/components/Apps/OffsiteReviewQueue.tsx#0',
      'src/components/Apps/OffsiteReviewQueue.tsx#1',
      'src/components/Apps/OffsiteSubmissionsList.tsx#0',
      'src/components/Apps/ReportTabs.tsx#0',
      'src/components/Apps/UnifiedReviewList.tsx#0',
    ]);
  });

  test('🔴 every headed table carries a ledger, or is exempted by name', () => {
    const offenders = SITES.filter((s) => !s.hasColgroup && !EXEMPT[s.id]).map(
      (s) => `${s.id} (${s.headerCellsTotal} header cells, no <AppsTableColgroup>)`
    );
    expect(
      offenders,
      'A table with a header row on an /apps surface has no column ledger. Give it one in ' +
        '~/components/Apps/appsWideLayout, or add it to EXEMPT with the reason it needs none.'
    ).toEqual([]);
  });

  test("🔴 the colgroup is the table's FIRST CHILD — not merely somewhere in the file", () => {
    // 🔴 THIS REPLACED AN `indexOf` COMPARISON, WHICH WAS SPELLED RATHER THAN STRUCTURAL,
    // in two ways that both pass it: hoisting the colgroup OUTSIDE the `<Table>` leaves it
    // earlier in the file than the head (green, and it bounds nothing), and `indexOf`
    // reads the FIRST occurrence in the file, so a second table in the same file was
    // graded against the first one's colgroup. Asking the AST which element is the table's
    // own first child cannot be satisfied by either.
    const offenders = SITES.filter((s) => s.hasColgroup && !s.colgroupIsFirstChild).map(
      (s) => `${s.id} (renders a colgroup, but it is not the table's first child)`
    );
    expect(offenders).toEqual([]);
  });

  test('🔴 every EXEMPT table really is unrendered (the allowlist is verified)', () => {
    // An exemption keyed on a name is where a live table would hide. Each entry claims
    // "nothing renders this component"; re-derive that rather than believe it.
    const names = Object.keys(EXEMPT);
    expect(names.length, 'the exempt list is empty — nothing to verify').toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const id of names) {
      const { component } = EXEMPT[id];
      expect(
        SITES.some((s) => s.id === id),
        `${id} is exempted but no such table exists`
      ).toBe(true);
      const hits = renderSitesOf(component);
      if (hits.length > 0) {
        offenders.push(`${component} IS rendered by ${hits.join(', ')} — it needs a ledger`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('🔴 POSITIVE CONTROL — the render search can find a component that IS rendered', () => {
    // Without this, `renderSitesOf` returning `[]` for every exempt entry is
    // indistinguishable from a search wired to nothing, and the allowlist would be
    // verified by a function that always says yes.
    expect(renderSitesOf('ActivePreviewsPanel').length).toBeGreaterThan(0);
    expect(renderSitesOf('AppActivityPanel').length).toBeGreaterThan(0);
    expect(renderSitesOf('NoSuchComponentAnywhere')).toEqual([]);
  });

  test('🔴 the ledger LENGTH matches the header cells the table actually renders', () => {
    // 🔴 THE TITLE USED TO CLAIM THIS AND THE BODY ASSERTED `.length` AGAINST A LITERAL —
    // a docstring naming a RELATIONSHIP over a body inspecting ONE SIDE. Measured then:
    // adding a `<Table.Th>` without touching the ledger left `AppListingsModerationTable`
    // and `RevenuePanel` green at BOTH tiers, and `[null,5,5,5,5]` satisfied every test.
    // Now the table is read.
    //
    // A table with a CONDITIONAL header cell has two shapes, so it names two ledgers: the
    // shortest must equal the always-rendered count and the longest the total.
    const offenders: string[] = [];
    let checked = 0;
    for (const site of SITES) {
      if (!site.hasColgroup) continue;
      const lengths = site.ledgerRefs.map((ref) => {
        const [name, key] = ref.split('.');
        const root = (LEDGER_EXPORTS as Record<string, unknown>)[name];
        const value = key ? (root as Record<string, unknown>)?.[key] : root;
        return Array.isArray(value) ? value.length : NaN;
      });
      if (lengths.length === 0 || lengths.some((n) => Number.isNaN(n))) {
        offenders.push(
          `${site.id}: could not resolve its ledger(s) [${site.ledgerRefs.join(', ')}]`
        );
        continue;
      }
      checked += 1;
      const min = Math.min(...lengths);
      const max = Math.max(...lengths);
      if (min !== site.headerCellsAlways) {
        offenders.push(
          `${site.id}: shortest ledger is ${min} but the table always renders ` +
            `${site.headerCellsAlways} header cell(s) [${site.ledgerRefs.join(', ')}]`
        );
      }
      if (max !== site.headerCellsTotal) {
        offenders.push(
          `${site.id}: longest ledger is ${max} but the table renders at most ` +
            `${site.headerCellsTotal} header cell(s) [${site.ledgerRefs.join(', ')}]`
        );
      }
    }
    expect(offenders).toEqual([]);
    // Guard-the-guard: an empty offender list is indistinguishable from a loop that
    // resolved no ledgers at all.
    expect(checked, 'no table had its ledger resolved').toBeGreaterThanOrEqual(7);
  });

  test('🔴 the header-cell counter can SEE a conditional column (negative control)', () => {
    // The two-shape tables are the only ones where `always` and `total` differ, so if the
    // conditional branch of the counter were dead every assertion above would still pass.
    const twoShaped = SITES.filter((s) => s.headerCellsTotal > s.headerCellsAlways);
    expect(twoShaped.map((s) => s.id).sort()).toEqual([
      'src/components/AppBlocks/RevenuePanel.tsx#0',
      'src/components/Apps/UnifiedReviewList.tsx#0',
    ]);
    for (const s of twoShaped) expect(s.ledgerRefs.length).toBe(2);
  });

  test('🔴 /apps/installed uses the card GRID *on the installed-apps list*, and no longer caps its body', () => {
    // 🔴 THE testId IS LOAD-BEARING, NOT DECORATION. This asserted `/<AppsCardGrid\b/`
    // over the whole file, and the same change added two OTHER `AppsCardGrid` call sites
    // to it (the grants tab and the hidden tab) — so the guard stopped being able to see
    // the case it exists for. Measured: reverting ONLY the installed-apps list to
    // `<Stack gap="md">`, i.e. undoing the headline fix on the one route whose 640px
    // defect was measured, passed unit 124/124 and geometry 27/27.
    const src = codeOf('src/pages/apps/installed.tsx');
    expect(src).toMatch(/<AppsCardGrid\s+testId="apps-installed-apps-grid"/);
    // The other two lists are grids as well, named individually for the same reason.
    expect(src).toMatch(/<AppsCardGrid\s+testId="apps-installed-grants-grid"/);
    expect(src).toMatch(/<AppsCardGrid\s+testId="apps-installed-hidden-grid"/);
    // …and the page does NOT solve the gap by refusing the width, which is the natural
    // "fix" for anyone who finds it too wide.
    expect(src).not.toMatch(/<AppsPageLayout[^>]*\bmeasure=/s);
  });

  test('🔴 /apps/review no longer caps its body either', () => {
    const src = codeOf('src/pages/apps/review.tsx');
    expect(src).not.toMatch(/<AppsPageLayout[^>]*\bmeasure=/s);
    // …and its queue table is the one carrying the columns instead.
    expect(codeOf('src/components/Apps/UnifiedReviewList.tsx')).toMatch(/<AppsTableColgroup/);
  });

  test('🔴 the comment stripper actually strips (positive control on `codeOf`)', () => {
    // Every `not.toMatch` above is satisfied by a stripper that returned an EMPTY string,
    // and every `toMatch` by one that returned the file UNCHANGED. Both directions are
    // pinned on a synthetic input carrying the exact hazard — the element named inside a
    // comment, before the real one — rather than on whatever a real file happens to say
    // today, which is a fixture that quietly stops testing anything when the prose moves.
    const synthetic = [
      'const a = 1;',
      '/* the colgroup must precede <Table.Thead>, always */',
      '<AppsTableColgroup columns={X} />',
      '<Table.Thead />',
    ].join('\n');
    const stripped = stripBlockComments(synthetic);
    expect(synthetic.indexOf('<Table.Thead')).toBeLessThan(synthetic.indexOf('<AppsTableColgroup'));
    expect(stripped.indexOf('<AppsTableColgroup')).toBeLessThan(stripped.indexOf('<Table.Thead'));
    expect(stripped).not.toContain('must precede');
    expect(stripped).toContain('const a = 1;');
    // …and on a real file it removes something without gutting it.
    const raw = srcOf('src/components/Apps/UnifiedReviewList.tsx');
    const realStripped = codeOf('src/components/Apps/UnifiedReviewList.tsx');
    expect(realStripped.length).toBeLessThan(raw.length);
    expect(realStripped.length).toBeGreaterThan(raw.length / 2);
    expect(realStripped).toContain('<AppsTableColgroup');
  });
});

describe('appsCardGridColumnsAt — the auto-fill ladder', () => {
  test('one column at the old container width, two at the current one', () => {
    expect(APPS_LEGACY_CONTENT_WIDTH).toBe(1888);
    expect(APPS_FULL_MEASURE_CONTENT_WIDTH).toBe(2528);
    expect(appsCardGridColumnsAt(APPS_LEGACY_CONTENT_WIDTH)).toBe(1);
    expect(appsCardGridColumnsAt(APPS_FULL_MEASURE_CONTENT_WIDTH)).toBe(2);
  });

  test('never fewer than one, however narrow', () => {
    // `floor()` on a phone width is 0; a grid with zero tracks renders nothing.
    expect(appsCardGridColumnsAt(390)).toBe(1);
    expect(appsCardGridColumnsAt(0)).toBe(1);
  });

  test('the arithmetic is the CSS arithmetic (positive control on the parameters)', () => {
    // Feed a min/gap pair no real call uses and watch the answer move, so the two rungs
    // above cannot be satisfied by a function that returns constants.
    expect(appsCardGridColumnsAt(1000, 240, 10)).toBe(4);
    expect(appsCardGridColumnsAt(1000, 100, 0)).toBe(10);
  });
});
