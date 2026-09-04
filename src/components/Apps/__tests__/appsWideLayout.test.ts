import fs from 'fs';
import path from 'path';
import { describe, expect, test } from 'vitest';
import {
  APPS_FULL_MEASURE_CONTENT_WIDTH,
  APPS_LEGACY_CONTENT_WIDTH,
  APPS_MINE_COLUMNS,
  APPS_MOD_LISTINGS_COLUMNS,
  APPS_REVENUE_COLUMNS,
  APPS_REVIEW_QUEUE_COLUMNS,
  APPS_TABLE_COLUMN_LEDGERS,
  appsCardGridColumnsAt,
  appsTableColumnProblems,
  type AppsTableColumns,
} from '~/components/Apps/appsWideLayout';

/**
 * `appsWideLayout` — the RULE and the LEDGERS, in the blocking `unit` project.
 *
 * What this file can and cannot see, stated up front because the split is the whole
 * design: it pins the DATA (one primary per ledger, the percentages leave room for it,
 * the card ladder steps where it should) and the WIRING (each table renders its own
 * ledger, as its table's first child). It cannot see whether a browser then lays the
 * columns out that way. That claim is `AppsWideLayout.geometry.test.tsx`, which measures
 * rendered boxes at two container widths.
 *
 * ⚠️ THE DIVISION OF LABOUR IS NOT THE ONE IT LOOKS LIKE, AND IT WAS MEASURED RATHER THAN
 * ASSUMED. The ordering guard below was written believing a misplaced `<colgroup>` is
 * ignored by the browser, i.e. that the geometry file would be the real catch. Mutating it
 * on 2026-09-04 — moving the element after `<Table.Tbody>` — left all eight geometry
 * assertions GREEN and turned only the structural guard here red. React inserts nodes via
 * the DOM API, so the HTML parser's table foster-parenting never runs and Chromium honours
 * the columns wherever the element sits. So the ordering rule is enforced HERE and only
 * here, on validity grounds; the geometry file owns the widths, not the placement.
 */

const repoFile = (rel: string) => path.resolve(__dirname, '../../../..', rel);
const srcOf = (rel: string) => fs.readFileSync(repoFile(rel), 'utf8');

/**
 * The file with every BLOCK COMMENT removed.
 *
 * 🔴 A COMMENT IS NOT A RENDER, AND THIS FILE LEARNED IT THE EXPENSIVE WAY ROUND.
 * The ordering guard below reads `indexOf('<Table.Thead')`, and the JSX comment that
 * EXPLAINS why the colgroup must precede the head contains that exact string — so the
 * guard reported the elements in the wrong order on a file that was perfectly correct.
 * The same shape in the other direction is the real hazard the whole repo keeps hitting:
 * a text guard matching a commented-out element and calling it a render.
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
    expect(Object.keys(APPS_TABLE_COLUMN_LEDGERS)).toHaveLength(6);
  });

  test('no ledger has a problem', () => {
    const problems = Object.entries(APPS_TABLE_COLUMN_LEDGERS).flatMap(([label, columns]) =>
      appsTableColumnProblems(label, columns)
    );
    expect(problems).toEqual([]);
  });

  test('🔴 each ledger has the column COUNT its table renders', () => {
    // The failure this catches is the silent one: a `<colgroup>` with the wrong number of
    // `<col>`s does not error — the extra columns simply take no width, or a real column
    // gets the width meant for its neighbour. Stated as literals, per table shape.
    expect(APPS_REVIEW_QUEUE_COLUMNS.withoutDeploy).toHaveLength(5); // Kind App Submitter date action
    expect(APPS_REVIEW_QUEUE_COLUMNS.withDeploy).toHaveLength(6); // …plus Deploy
    expect(APPS_MINE_COLUMNS).toHaveLength(4); // App Cover Status Updated
    expect(APPS_MOD_LISTINGS_COLUMNS).toHaveLength(5); // App Owner Category Reviews actions
    expect(APPS_REVENUE_COLUMNS.withApp).toHaveLength(7); // Date App Scope Buzz Gross Share Status
    expect(APPS_REVENUE_COLUMNS.scoped).toHaveLength(6); // …minus App
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

describe('🔴 every ledger is actually WIRED to its table', () => {
  /**
   * A ledger nobody renders is dead data that reads as a decision — the same failure the
   * widths module's "every measure is consumed by its page" guard exists for. Each row
   * names the file, the ledger expression it must render, and the fact that the
   * `<colgroup>` precedes the head.
   */
  const WIRED: { file: string; renders: RegExp }[] = [
    {
      file: 'src/components/Apps/UnifiedReviewList.tsx',
      renders: /APPS_REVIEW_QUEUE_COLUMNS\.withDeploy[\s\S]{0,120}APPS_REVIEW_QUEUE_COLUMNS\.withoutDeploy/,
    },
    {
      file: 'src/components/Apps/MyAppsBody.tsx',
      renders: /<AppsTableColgroup\s+columns=\{APPS_MINE_COLUMNS\}\s*\/>/,
    },
    {
      file: 'src/components/Apps/AppListingsModerationTable.tsx',
      renders: /<AppsTableColgroup\s+columns=\{APPS_MOD_LISTINGS_COLUMNS\}\s*\/>/,
    },
    {
      file: 'src/components/AppBlocks/RevenuePanel.tsx',
      renders: /APPS_REVENUE_COLUMNS\.scoped\s*:\s*APPS_REVENUE_COLUMNS\.withApp/,
    },
  ];

  test('the wiring ledger is not empty (guards a vacuous loop)', () => {
    expect(WIRED).toHaveLength(4);
  });

  test.each(WIRED)('$file renders its ledger', ({ file, renders }) => {
    // Comments stripped: a ledger named only in a comment is not a render.
    const src = codeOf(file);
    expect(src.length, `${file} read empty`).toBeGreaterThan(500);
    expect(src).toMatch(renders);
  });

  test('🔴 the colgroup precedes the head in every table that has one', () => {
    // THE SILENT ONE. HTML requires `<colgroup>` before any row group; a browser ignores
    // a later one with no error, so the table lays out exactly as if the ledger were
    // absent and every structural assertion above still passes.
    for (const { file } of WIRED) {
      const src = codeOf(file);
      const colgroupAt = src.indexOf('<AppsTableColgroup');
      const theadAt = src.indexOf('<Table.Thead');
      expect(colgroupAt, `${file} renders no <AppsTableColgroup>`).toBeGreaterThan(-1);
      expect(theadAt, `${file} renders no <Table.Thead>`).toBeGreaterThan(-1);
      expect(colgroupAt, `${file}: the colgroup must come BEFORE the head`).toBeLessThan(theadAt);
    }
  });

  test('🔴 /apps/installed uses the card GRID, and no longer caps its body', () => {
    // Both halves of the fix, as one claim: the page spends the surplus on a column, and
    // it does NOT solve the gap by refusing the width. A `measure=` here would be the
    // regression, and it is the natural "fix" for anyone who finds the page too wide.
    const src = codeOf('src/pages/apps/installed.tsx');
    expect(src).toMatch(/<AppsCardGrid\b/);
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
