import fs from 'fs';
import path from 'path';
import { describe, expect, test } from 'vitest';
import {
  LISTING_CARD_MIN_WIDTH,
  LISTING_GRID_COLUMN_STEPS,
  LISTING_GRID_GUTTER,
  LISTING_GRID_SPAN,
  LISTING_STORE_CONTAINER_SIZE,
  listingCardWidthAt,
  listingGridColumnsAt,
  MANTINE_BREAKPOINT_PX,
  minContentWidthForColumns,
} from '~/components/Apps/appListingGrid';
import { APPS_CONTAINER_GUTTER, APPS_PAGE_CONTAINER_WIDTH } from '~/components/Apps/appsPageWidths';

/**
 * `/apps` store GEOMETRY pins (blocking `unit` project).
 *
 * Two decisions live here and they are a matched pair: how wide a row is (the
 * container) and how many cards sit in it (the ladder). Both are pinned, plus the
 * seam between the ladder and the stylesheet that implements it — the one place the
 * derivation could silently stop being true.
 *
 * The RENDERED column counts are measured in
 * `AppListingsMarketplaceBody.columns.browser.test.tsx`. This file is the tier that
 * gates.
 */

describe('LISTING_GRID_SPAN — the legacy breakpoint spans the narrow ladder is derived from', () => {
  test('xl yields FOUR columns (span 3 of 12) — the larger-cover change', () => {
    expect(LISTING_GRID_SPAN.xl).toBe(3);
    expect(12 / LISTING_GRID_SPAN.xl).toBe(4);
  });

  test('base / sm / md / lg are UNCHANGED (1 / 2 / 3 / 4 columns)', () => {
    expect(LISTING_GRID_SPAN.base).toBe(12);
    expect(LISTING_GRID_SPAN.sm).toBe(6);
    expect(LISTING_GRID_SPAN.md).toBe(4);
    expect(LISTING_GRID_SPAN.lg).toBe(3);
    expect(12 / LISTING_GRID_SPAN.base).toBe(1);
    expect(12 / LISTING_GRID_SPAN.sm).toBe(2);
    expect(12 / LISTING_GRID_SPAN.md).toBe(3);
    expect(12 / LISTING_GRID_SPAN.lg).toBe(4);
  });

  test('every breakpoint is a whole-column span (no fractional 2.4-style spans)', () => {
    // The old `xl: 2.4` was the only fractional span; dropping it means every
    // breakpoint now divides 12 evenly, so no row ever ends on a part-column.
    for (const [bp, span] of Object.entries(LISTING_GRID_SPAN)) {
      expect(Number.isInteger(span), `${bp} span should be a whole number`).toBe(true);
      expect(12 % span, `${bp} span should divide 12`).toBe(0);
    }
  });

  test('the span set is exactly the five expected breakpoints', () => {
    expect(Object.keys(LISTING_GRID_SPAN).sort()).toEqual(['base', 'lg', 'md', 'sm', 'xl']);
  });
});

describe('LISTING_STORE_CONTAINER_SIZE', () => {
  test('the store container is the ULTRAWIDE apps-page width (2560)', () => {
    // Moved 1600 → 1920 by the full-width pass and 1920 → 2560 by the ultrawide
    // pass. The number itself is single-sourced from `appsPageWidths.ts`; the
    // container/ladder arithmetic is pinned in `__tests__/appsPageWidths.test.ts`.
    expect(LISTING_STORE_CONTAINER_SIZE).toBe(2560);
    expect(LISTING_STORE_CONTAINER_SIZE).toBe(APPS_PAGE_CONTAINER_WIDTH);
  });
});

describe('🔴 the column LADDER — grid width → column count', () => {
  /**
   * THE TABLE, AS LITERALS.
   *
   * 🔴 THE THRESHOLDS ARE WRITTEN OUT HERE RATHER THAN COMPUTED FROM THE MODULE, and
   * that is the entire value of this test. `LISTING_GRID_COLUMN_STEPS` derives itself
   * from `LISTING_GRID_SPAN` + `MANTINE_BREAKPOINT_PX` + `LISTING_CARD_MIN_WIDTH`; a
   * test that re-ran the same derivation would agree with any mutation of any of those
   * inputs. Literals are the independent witness — move the card-width floor and 1979
   * stops being what the module produces.
   *
   * Each band is probed at THREE points, never on a boundary alone: one pixel below the
   * threshold, on it, and comfortably inside the band. A fixture that sits exactly on a
   * threshold cannot see an off-by-one in the wrong direction.
   */
  const LADDER: { contentWidth: number; columns: number; why: string }[] = [
    { contentWidth: 0, columns: 1, why: 'degenerate — a zero-width grid is still one column' },
    { contentWidth: 390, columns: 1, why: 'a phone, inside the base band' },
    { contentWidth: 735, columns: 1, why: 'one px below the sm rung' },
    { contentWidth: 736, columns: 2, why: 'sm — viewport 768 minus the 32px apps gutter' },
    { contentWidth: 850, columns: 2, why: 'inside the sm band' },
    { contentWidth: 959, columns: 2, why: 'one px below the md rung' },
    { contentWidth: 960, columns: 3, why: 'md — viewport 992 minus the gutter' },
    { contentWidth: 1100, columns: 3, why: 'inside the md band' },
    { contentWidth: 1167, columns: 3, why: 'one px below the lg rung' },
    { contentWidth: 1168, columns: 4, why: 'lg — viewport 1200 minus the gutter' },
    { contentWidth: 1376, columns: 4, why: 'the old xl breakpoint (1408) — still four' },
    { contentWidth: 1888, columns: 4, why: 'what the RETIRED 1920 container reached — unchanged' },
    { contentWidth: 1978, columns: 4, why: 'one px below the five-column rung' },
    { contentWidth: 1979, columns: 5, why: '5 × 383 + 4 × 16 — five cards at exactly the floor' },
    { contentWidth: 2100, columns: 5, why: 'inside the five-column band' },
    { contentWidth: 2377, columns: 5, why: 'one px below the six-column rung' },
    { contentWidth: 2378, columns: 6, why: '6 × 383 + 5 × 16 — six cards at exactly the floor' },
    { contentWidth: 2528, columns: 6, why: 'what /apps reaches at a 2560 container' },
    {
      contentWidth: 4000,
      columns: 6,
      why: 'past the top rung — the ladder stops, it does not wrap',
    },
  ];

  test.each(LADDER)(
    '$contentWidth px of grid → $columns columns ($why)',
    ({ contentWidth, columns }) => {
      expect(listingGridColumnsAt(contentWidth)).toBe(columns);
    }
  );

  test('the table probes both sides of every rung (guard-the-guard)', () => {
    // A table that only ever sampled the middle of a band could not see a threshold
    // move by one. Every rung must appear as a (threshold − 1, threshold) pair.
    const widths = new Set(LADDER.map((r) => r.contentWidth));
    for (const step of LISTING_GRID_COLUMN_STEPS) {
      if (step.minContentWidth === 0) continue;
      expect(widths, `rung ${step.minContentWidth} is not probed ON its threshold`).toContain(
        step.minContentWidth
      );
      expect(widths, `rung ${step.minContentWidth} is not probed one px BELOW`).toContain(
        step.minContentWidth - 1
      );
    }
    // …and it exercises every column count the ladder can produce.
    expect(new Set(LADDER.map((r) => r.columns))).toEqual(new Set([1, 2, 3, 4, 5, 6]));
  });

  test('the ladder is exactly these six rungs, in ascending order', () => {
    // A ledger, not a floor: the loops above iterate it, so a ladder that silently
    // grew a seventh rung (or lost one) would still satisfy them.
    expect(LISTING_GRID_COLUMN_STEPS).toEqual([
      { minContentWidth: 0, columns: 1 },
      { minContentWidth: 736, columns: 2 },
      { minContentWidth: 960, columns: 3 },
      { minContentWidth: 1168, columns: 4 },
      { minContentWidth: 1979, columns: 5 },
      { minContentWidth: 2378, columns: 6 },
    ]);
    const widths = LISTING_GRID_COLUMN_STEPS.map((s) => s.minContentWidth);
    expect([...widths].sort((a, b) => a - b)).toEqual(widths);
    const columns = LISTING_GRID_COLUMN_STEPS.map((s) => s.columns);
    expect([...columns].sort((a, b) => a - b)).toEqual(columns);
    // No redundant rung — `lg` and `xl` are both four columns and must collapse to one.
    expect(new Set(columns).size).toBe(columns.length);
  });
});

describe('🔴 the NARROW half is byte-equivalent to the retired Mantine media queries', () => {
  /**
   * The claim this file has to make good on: moving off `<Grid.Col span={…}>` changed
   * WHERE the column count is decided (grid width, not viewport width) but not WHAT it
   * decides at any width `/apps` actually renders at.
   *
   * The conversion is one subtraction: a Mantine breakpoint fires at viewport `V`,
   * `/apps` takes no body measure, and the apps `Container` is full-bleed below its cap
   * — so the grid at that instant is `V − APPS_CONTAINER_GUTTER` wide.
   */
  test('each retired breakpoint maps to its rung by exactly one subtraction', () => {
    const cases: [keyof typeof LISTING_GRID_SPAN, number][] = [
      ['base', 1],
      ['sm', 2],
      ['md', 3],
      ['lg', 4],
      ['xl', 4],
    ];
    for (const [breakpoint, columns] of cases) {
      expect(12 / LISTING_GRID_SPAN[breakpoint], `${breakpoint} span`).toBe(columns);
      const gridWidth = Math.max(0, MANTINE_BREAKPOINT_PX[breakpoint] - APPS_CONTAINER_GUTTER);
      expect(
        listingGridColumnsAt(gridWidth),
        `at the ${breakpoint} breakpoint (viewport ${MANTINE_BREAKPOINT_PX[breakpoint]}, ` +
          `grid ${gridWidth}) the ladder must give what span ${LISTING_GRID_SPAN[breakpoint]} gave`
      ).toBe(columns);
      // …and NOT one px earlier, which is what an off-by-one conversion looks like.
      if (gridWidth > 0) {
        expect(listingGridColumnsAt(gridWidth - 1), `${breakpoint} fires one px early`).toBe(
          columns - (breakpoint === 'xl' ? 0 : 1)
        );
      }
    }
  });

  test('Mantine`s default breakpoints are recorded as the px this app renders them at', () => {
    // The theme declares NO custom breakpoints, so these are Mantine v7's defaults at a
    // 16px root: xs 36em, sm 48em, md 62em, lg 75em, xl 88em. Pinned as literals because
    // the ladder above is derived from them — if a theme ever declares its own, this
    // fails before the derivation silently starts describing a different app.
    expect(MANTINE_BREAKPOINT_PX).toEqual({
      base: 0,
      xs: 576,
      sm: 768,
      md: 992,
      lg: 1200,
      xl: 1408,
    });
    for (const [name, em] of [
      ['xs', 36],
      ['sm', 48],
      ['md', 62],
      ['lg', 75],
      ['xl', 88],
    ] as const) {
      expect(MANTINE_BREAKPOINT_PX[name], `${name} = ${em}em at a 16px root`).toBe(em * 16);
    }
  });
});

describe('🔴 the WIDE half holds the card-width floor', () => {
  test('the floor is 383px, and the thresholds are what it produces', () => {
    // 🔴 THE FLOOR IS THE MUTATION TARGET. Lowering it moves both thresholds, and the
    // literals below are what notice. Without them the derivation would agree with any
    // floor at all.
    expect(LISTING_CARD_MIN_WIDTH).toBe(383);
    expect(LISTING_GRID_GUTTER).toBe(16);
    expect(minContentWidthForColumns(5)).toBe(1979); // 5 × 383 + 4 × 16
    expect(minContentWidthForColumns(6)).toBe(2378); // 6 × 383 + 5 × 16
    // A seventh column would need this much grid — stated so the next person adding one
    // can see the cost rather than picking a threshold by eye.
    expect(minContentWidthForColumns(7)).toBe(2777); // 7 × 383 + 6 × 16
  });

  test('every FLOOR-DERIVED rung gives cards at least the floor wide, at its threshold', () => {
    // 🔴 THIS IS THE PIN THAT STOPS A SEVENTH COLUMN GOING UNDER THE FLOOR. It reads the
    // ladder, not the derivation, so a rung added with a hand-picked threshold fails here.
    const wide = LISTING_GRID_COLUMN_STEPS.filter((s) => s.columns >= 5);
    expect(wide.length, 'no wide rungs to check — the loop would pass vacuously').toBe(2);
    for (const step of wide) {
      const cardWidth = listingCardWidthAt(step.minContentWidth, step.columns);
      expect(
        cardWidth,
        `${step.columns} columns at ${step.minContentWidth}px of grid gives ${cardWidth}px cards`
      ).toBeGreaterThanOrEqual(LISTING_CARD_MIN_WIDTH);
      // …and the threshold is MINIMAL: one px narrower and it would not.
      expect(
        listingCardWidthAt(step.minContentWidth - 1, step.columns),
        `${step.columns} columns is placed later than it needs to be`
      ).toBeLessThan(LISTING_CARD_MIN_WIDTH);
    }
  });

  test('adding a column never makes a card narrower than the one below it did at ITS threshold', () => {
    // The ladder's whole promise, stated as a relationship rather than per-rung numbers:
    // a column is added only where each card is still at least the floor, so the sequence
    // of card widths AT THE THRESHOLDS is flat at the floor rather than decreasing.
    for (const step of LISTING_GRID_COLUMN_STEPS.filter((s) => s.columns >= 5)) {
      const here = listingCardWidthAt(step.minContentWidth, step.columns);
      const ifWeHadNotAdded = listingCardWidthAt(step.minContentWidth, step.columns - 1);
      expect(here).toBeLessThan(ifWeHadNotAdded);
      expect(here).toBeGreaterThanOrEqual(LISTING_CARD_MIN_WIDTH);
    }
  });

  test('🔴 an intrinsic auto-fill grid CANNOT express this ladder (the derivation, checked)', () => {
    // The reason `repeat(auto-fill, minmax(X, 1fr))` was rejected, as arithmetic rather
    // than as prose. `auto-fill` fits `floor((W + gap) / (X + gap))` columns.
    const autoFillColumns = (gridWidth: number, floor: number) =>
      Math.max(1, Math.floor((gridWidth + LISTING_GRID_GUTTER) / (floor + LISTING_GRID_GUTTER)));

    const XL_LOW_END = MANTINE_BREAKPOINT_PX.xl - APPS_CONTAINER_GUTTER; // 1376
    const OLD_CONTAINER_CONTENT = 1920 - APPS_CONTAINER_GUTTER; // 1888
    expect(XL_LOW_END).toBe(1376);
    expect(OLD_CONTAINER_CONTENT).toBe(1888);

    // Keeping FOUR at 1376 needs a floor of at most 332…
    expect(autoFillColumns(XL_LOW_END, 332)).toBe(4);
    expect(autoFillColumns(XL_LOW_END, 333)).toBe(3);
    // …and any floor that low gives FIVE at 1888, at 364.8px per card — narrower than
    // the ~380px the covers pass moved TO when it went five columns → four.
    expect(autoFillColumns(OLD_CONTAINER_CONTENT, 332)).toBe(5);
    expect(listingCardWidthAt(OLD_CONTAINER_CONTENT, 5)).toBeCloseTo(364.8, 5);
    expect(364.8).toBeLessThan(LISTING_CARD_MIN_WIDTH);
    // Holding four at 1888 needs a floor above 364.8 — which then gives THREE at 1376.
    expect(autoFillColumns(OLD_CONTAINER_CONTENT, 365)).toBe(4);
    expect(autoFillColumns(XL_LOW_END, 365)).toBe(3);
    // The two requirements have no overlap. That is the whole argument.
    expect(332).toBeLessThan(365);
  });
});

describe('🔴 SEAM — the store page size fits the ladder AND the server cap', () => {
  /**
   * The page size is a CONSEQUENCE of the ladder: 24 was six rows at the old four-column
   * maximum and only four at the six columns the grid now reaches, so the widest screen
   * the container supports would have met "Load more" after the least content.
   *
   * It is also bounded by something this component cannot see. `listAppListingsSchema`
   * caps `limit` at 50, and exceeding it is a request-time zod error rather than a bigger
   * page — a failure that shows up as a broken store, not as a build error, because the
   * two live in different files with no type relating them. Hence a seam test rather than
   * two independent claims.
   */
  const BODY = path.resolve(__dirname, '../AppListingsMarketplaceBody.tsx');
  const bodyCode = fs
    .readFileSync(BODY, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

  /** The `limit:` the store body actually requests. */
  function requestedLimit(): number {
    const m = bodyCode.match(/limit:\s*(\d+)/);
    if (!m) throw new Error('no `limit:` found in AppListingsMarketplaceBody.tsx');
    return Number(m[1]);
  }

  test('the store requests 48 per page', () => {
    // 🔴 The comment strip is load-bearing here too: the prose beside this call names
    // both 48 and 50, so an unstripped scan could read either out of a docstring.
    expect(bodyCode).not.toContain('THE SERVER CAPS THIS AT');
    expect(requestedLimit()).toBe(48);
  });

  test('…which is eight rows at the ladder`s top rung, and twelve at the one below', () => {
    const top = LISTING_GRID_COLUMN_STEPS[LISTING_GRID_COLUMN_STEPS.length - 1].columns;
    expect(top).toBe(6);
    expect(requestedLimit() / top).toBe(8);
    expect(requestedLimit() / 4).toBe(12);
  });

  test('🔴 …and it is inside the SERVER`s own cap, read from the schema', () => {
    // The cap is parsed rather than restated: `listAppListingsSchema` is the authority,
    // and a schema change that lowered it would otherwise leave this test asserting a
    // number the server no longer accepts.
    const schemaSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../server/schema/blocks/app-listing-read.schema.ts'),
      'utf8'
    );
    const decl = schemaSrc.match(
      /export const listAppListingsSchema[\s\S]*?limit:\s*z\.number\(\)[^;\n]*?\.max\((\d+)\)/
    );
    expect(decl, 'could not read the limit cap out of listAppListingsSchema').not.toBeNull();
    const cap = Number(decl![1]);
    expect(cap).toBe(50); // positive control on the parse
    expect(requestedLimit()).toBeLessThanOrEqual(cap);
  });
});

describe('🔴 SEAM — the stylesheet implements exactly the ladder, and nothing else', () => {
  /**
   * 🔴 WHY THIS IS THE LOAD-BEARING TEST IN THE FILE. `LISTING_GRID_COLUMN_STEPS` is a
   * TypeScript value that nothing at runtime reads: the column count is applied by
   * `AppListingsMarketplaceBody.module.scss`, whose thresholds are hand-written CSS
   * literals. Each half is individually correct-looking while disagreeing with the
   * other, and neither throws — the grid would simply render a different number of
   * columns than every constant and comment in the codebase says it does.
   *
   * So the checkable claim is the RELATIONSHIP, checked in BOTH directions: no rung
   * without a rule, no rule without a rung.
   *
   * WHAT THIS CANNOT SEE (stated, so nobody reads it as more than it is): a rule that
   * is present but overridden later in the cascade, a `container-type` that never got
   * applied, or anything about how the grid actually lays out. Those are pixel facts and
   * only `AppListingsMarketplaceBody.columns.browser.test.tsx` can see them.
   */
  const STYLES = path.resolve(__dirname, '../AppListingsMarketplaceBody.module.scss');

  /**
   * 🔴 READ LAZILY, INSIDE EACH TEST, NOT AT COLLECTION TIME. A `readFileSync` in the
   * describe body throws during COLLECTION when the stylesheet is missing, and Vitest
   * reports that as `Tests no tests` — the reassuring-zero shape — rather than as a
   * failure naming the missing file. A deleted stylesheet is precisely the defect this
   * seam exists to catch, so it has to arrive as a red assertion.
   */
  function readStyles(): string {
    if (!fs.existsSync(STYLES)) {
      throw new Error(
        `the store grid's stylesheet is missing at ${STYLES} — the column ladder is ` +
          'declared in TypeScript and applied there, so without it the grid renders one column.'
      );
    }
    return fs.readFileSync(STYLES, 'utf8');
  }

  /**
   * Comments stripped FIRST. Load-bearing rather than tidy: the stylesheet's own
   * docstrings name `736`, `1979` and `2378` verbatim, so an unstripped scan would be
   * reading the prose and would stay green with every real rule deleted.
   */
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  /** Every `@container (min-width: Npx) { … repeat(C, …) }` pair, in file order. */
  function parsedRules(): { minContentWidth: number; columns: number }[] {
    const out: { minContentWidth: number; columns: number }[] = [];
    const re =
      /@container\s*\(\s*min-width:\s*(\d+)px\s*\)\s*\{[\s\S]*?grid-template-columns:\s*repeat\(\s*(\d+)\s*,/g;
    for (const m of strip(readStyles()).matchAll(re)) {
      out.push({ minContentWidth: Number(m[1]), columns: Number(m[2]) });
    }
    return out;
  }

  test('POSITIVE CONTROL — the parser finds rules at all, and the comment strip did not eat them', () => {
    // A reassuring empty set is indistinguishable from a regex that matches nothing.
    const source = readStyles();
    const code = strip(source);
    const rules = parsedRules();
    expect(rules.length, 'no @container rules parsed out of the stylesheet').toBeGreaterThan(0);
    // And the strip really removed the prose: the header names 1600, which is not a rung.
    expect(source).toContain('1600');
    expect(code).not.toContain('1600');
  });

  test('the base rule is ONE column, and it is not inside a container query', () => {
    // The ladder's first rung has no `@container` — it is the default the queries
    // override. Without it a narrow grid would inherit whatever `display: grid` defaults
    // to (a single implicit column), which is right by accident rather than by decision.
    const code = strip(readStyles());
    const base = code.slice(0, code.indexOf('@container'));
    expect(base).toMatch(/grid-template-columns:\s*repeat\(\s*1\s*,/);
    expect(base).toMatch(/display:\s*grid/);
  });

  test('the gap matches LISTING_GRID_GUTTER (it is part of the threshold arithmetic)', () => {
    expect(strip(readStyles())).toMatch(new RegExp(`gap:\\s*${LISTING_GRID_GUTTER}px`));
  });

  test('🔴 the @container rules EQUAL the derived ladder — no rung without a rule, no rule without a rung', () => {
    const expected = LISTING_GRID_COLUMN_STEPS.filter((s) => s.minContentWidth > 0).map((s) => ({
      minContentWidth: s.minContentWidth,
      columns: s.columns,
    }));
    expect(
      parsedRules(),
      'AppListingsMarketplaceBody.module.scss and LISTING_GRID_COLUMN_STEPS disagree. ' +
        'The stylesheet is what actually renders; the constants are what everything else ' +
        'reasons about. Move both or neither.'
    ).toEqual(expected);
  });

  test('the query container is a SEPARATE element from the grid', () => {
    // `@container` resolves against an ANCESTOR container, never the queried element, so
    // `container-type` and `grid-template-columns` on one element matches nothing and the
    // grid silently stays at one column — with no error anywhere.
    const code = strip(readStyles());
    expect(code).toMatch(/\.gridContainer\s*\{[^}]*container-type:\s*inline-size/);
    expect(code).not.toMatch(/\.grid\s*\{[^}]*container-type/);
  });

  test('the component renders BOTH classes, in that nesting order', () => {
    // The other half of the seam: a stylesheet whose classes nothing references changes
    // no pixels, and a `className` naming a class the stylesheet does not declare
    // resolves to `undefined`, renders no attribute and throws nothing.
    const body = fs.readFileSync(
      path.resolve(__dirname, '../AppListingsMarketplaceBody.tsx'),
      'utf8'
    );
    const bodyCode = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    expect(bodyCode).toContain('AppListingsMarketplaceBody.module.scss');
    const container = bodyCode.indexOf('gridClasses.gridContainer');
    const grid = bodyCode.indexOf('gridClasses.grid}');
    expect(container, 'the grid container class is not rendered').toBeGreaterThan(-1);
    expect(grid, 'the grid class is not rendered').toBeGreaterThan(-1);
    expect(container, 'the container must WRAP the grid, not sit inside it').toBeLessThan(grid);
    // And the cells still carry the testid the browser tests select on.
    expect(bodyCode).toContain(`data-testid="apps-listing-grid-col"`);
  });

  test('🔴 the retired Mantine <Grid> is really gone from the store body', () => {
    // Leaving it in place beside the CSS grid would double the columns' worth of markup
    // and make the container query describe a layout nothing renders.
    const body = fs.readFileSync(
      path.resolve(__dirname, '../AppListingsMarketplaceBody.tsx'),
      'utf8'
    );
    const bodyCode = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    expect(bodyCode).not.toMatch(/<Grid[\s>]/);
    expect(bodyCode).not.toMatch(/<Grid\.Col[\s>]/);
  });
});
