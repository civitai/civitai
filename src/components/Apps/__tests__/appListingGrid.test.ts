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
   * inputs. Literals are the independent witness — move the card-width floor and 2364
   * stops being what the module produces.
   *
   * Each band is probed at THREE points, never on a boundary alone: one pixel below the
   * threshold, on it, and comfortably inside the band. A fixture that sits exactly on a
   * threshold cannot see an off-by-one in the wrong direction.
   *
   * 🔴 THE 1376 / 1887 / 1888 ROWS ARE THE MOST IMPORTANT IN THIS TABLE, and they exist
   * because of an arithmetic COLLISION rather than because anything is near a rung:
   * `4 × 460 + 3 × 16 = 1888`, so at today's floor the four-column rung would land on
   * exactly the retired 1920 container's content width IF the floor governed the narrow
   * half. It does not — but that is a claim about a derivation, and this is the width
   * band where being wrong about it is invisible. 1376 is the `xl` low end: the safe
   * middle of the desktop range, and the first thing a floor-governed narrow half would
   * silently break. See the dedicated describe below.
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
    { contentWidth: 1376, columns: 4, why: 'THE COLLISION GUARD — the xl low end (1408 − 32)' },
    { contentWidth: 1887, columns: 4, why: 'THE COLLISION GUARD — one px below 4 × 460 + 3 × 16' },
    { contentWidth: 1888, columns: 4, why: 'THE COLLISION GUARD — exactly 4 × 460 + 3 × 16' },
    { contentWidth: 2100, columns: 4, why: 'still four — the fifth column is not free' },
    { contentWidth: 2363, columns: 4, why: 'one px below the five-column rung' },
    { contentWidth: 2364, columns: 5, why: '5 × 460 + 4 × 16 — five cards at exactly the floor' },
    { contentWidth: 2450, columns: 5, why: 'inside the five-column band' },
    {
      contentWidth: 2528,
      columns: 5,
      why: 'a 2560 CONTAINER yields this much grid — 492.8px cards',
    },
    { contentWidth: 2839, columns: 5, why: 'one px below the (unreachable) six-column rung' },
    {
      contentWidth: 2840,
      columns: 6,
      why: '6 × 460 + 5 × 16 — declared, but past the container cap',
    },
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
      { minContentWidth: 2364, columns: 5 },
      { minContentWidth: 2840, columns: 6 },
    ]);
    const widths = LISTING_GRID_COLUMN_STEPS.map((s) => s.minContentWidth);
    expect([...widths].sort((a, b) => a - b)).toEqual(widths);
    const columns = LISTING_GRID_COLUMN_STEPS.map((s) => s.columns);
    expect([...columns].sort((a, b) => a - b)).toEqual(columns);
    // No redundant rung — `lg` and `xl` are both four columns and must collapse to one.
    expect(new Set(columns).size).toBe(columns.length);
  });
});

describe('🔴 THE COLLISION — the card-width floor must NOT govern the narrow half', () => {
  /**
   * 🔴 WHY THIS DESCRIBE EXISTS, AND WHY IT DID NOT NEED TO AT THE OLD FLOOR.
   *
   * `LISTING_CARD_MIN_WIDTH` is 460, and `4 × 460 + 3 × 16 = 1888` — EXACTLY the content
   * width of the retired 1920 container. So the four-column rung's floor-derived value
   * and one of the most-quoted widths in this change are now the same number, and the
   * two halves of the ladder are one refactor away from being confused for each other.
   *
   * If the floor ever governed the narrow half, four columns would start at 1888 and the
   * ENTIRE 1168–1887 band would drop to three — including 1376, the `xl` low end, which
   * is the middle of the ordinary desktop range and the last width anyone would think to
   * re-check. Every other assertion in this file would still pass: 1888 itself would
   * still read four (the floor's own rung), 2364 would still read five, the stylesheet
   * seam would still agree, and the browser fixtures at 1888 / 2450 / 2528 would all be
   * green. The defect would be invisible everywhere except here.
   *
   * At the old 383 floor `4 × 383 + 3 × 16 = 1580`, comfortably away from every number in
   * play, and a floor-governed narrow half would have broken loudly. It is the NEW value
   * that makes the failure quiet, so these assertions are a consequence of the product
   * decision rather than general hygiene — do not delete them as redundant with the table.
   */
  test('🔴 four columns at 1376 — the `xl` low end, the width a floor-governed ladder breaks', () => {
    const XL_LOW_END = MANTINE_BREAKPOINT_PX.xl - APPS_CONTAINER_GUTTER;
    expect(XL_LOW_END).toBe(1376);
    expect(
      listingGridColumnsAt(XL_LOW_END),
      'the xl low end fell below four columns. The most likely cause is that the narrow ' +
        'half of LISTING_GRID_COLUMN_STEPS started deriving from LISTING_CARD_MIN_WIDTH: ' +
        `minContentWidthForColumns(4) is ${minContentWidthForColumns(4)}, so four columns ` +
        'would not begin until then and this whole band would render three.'
    ).toBe(4);
  });

  test('🔴 four columns at 1887 AND at 1888 — one below the collision point and on it', () => {
    const COLLISION = minContentWidthForColumns(4);
    // The collision is real, not hypothetical: state it, so the reader can see why the
    // two assertions below are interesting rather than arbitrary.
    expect(COLLISION).toBe(1888);
    expect(COLLISION).toBe(1920 - APPS_CONTAINER_GUTTER);
    expect(listingGridColumnsAt(COLLISION - 1), 'one px below the collision point').toBe(4);
    expect(listingGridColumnsAt(COLLISION), 'exactly at the collision point').toBe(4);
    // 🔴 AND THE POINT: 1888 reads four for the RIGHT reason. It must be four because the
    // lg rung (1168) has been in force for 720px, NOT because the floor happens to place
    // a four-column rung there. Those two produce the same answer at 1888 and different
    // answers everywhere below it — which is exactly what makes 1376 the load-bearing
    // assertion and 1888 the one that would have reassured you.
    expect(listingGridColumnsAt(1168)).toBe(4);
  });

  test('🔴 no narrow rung equals its own floor-derived value (the derivations are separate)', () => {
    // The structural half of the claim. Each of 1/2/3/4 must come from a Mantine
    // breakpoint minus the gutter and NOT from `minContentWidthForColumns`, so the two
    // sets must disagree at every narrow column count.
    const narrow = LISTING_GRID_COLUMN_STEPS.filter((s) => s.columns <= 4);
    expect(narrow.map((s) => s.minContentWidth)).toEqual([0, 736, 960, 1168]);
    for (const step of narrow) {
      if (step.columns === 1) continue; // one column starts at 0 under either rule
      expect(
        step.minContentWidth,
        `the ${step.columns}-column rung is at its floor-derived value ` +
          `(${minContentWidthForColumns(step.columns)}) — the narrow half is being ` +
          'governed by LISTING_CARD_MIN_WIDTH, which it must never be'
      ).not.toBe(minContentWidthForColumns(step.columns));
    }
    // Guard-the-guard: the loop must actually have compared something, and the numbers it
    // compared must be the ones this test is about.
    expect(narrow.filter((s) => s.columns > 1)).toHaveLength(3);
    expect(minContentWidthForColumns(2)).toBe(936);
    expect(minContentWidthForColumns(3)).toBe(1412);
    expect(minContentWidthForColumns(4)).toBe(1888);
  });

  test('the narrow rungs are BELOW every floor-derived rung of the same column count', () => {
    // Stated as a direction, not just inequality: a narrow rung must fire EARLIER than
    // the floor would allow, because the narrow half deliberately ships cards under the
    // floor (four columns at 1376 is a 332px card). That asymmetry is the design — the
    // floor governs only where a column is ADDED beyond what Mantine's scale reached.
    for (const step of LISTING_GRID_COLUMN_STEPS.filter((s) => s.columns > 1 && s.columns <= 4)) {
      expect(step.minContentWidth).toBeLessThan(minContentWidthForColumns(step.columns));
    }
    expect(listingCardWidthAt(1376, 4)).toBe(332);
    expect(332).toBeLessThan(LISTING_CARD_MIN_WIDTH);
  });
});

describe('🔴 the NARROW rungs are unchanged as functions of GRID width', () => {
  /**
   * What moving off `<Grid.Col span={…}>` did and did not change.
   *
   * DID NOT: the column count at any given GRID width below the five-column rung. Each
   * narrow rung is the old breakpoint minus one subtraction — a Mantine breakpoint fires
   * at viewport `V`, `/apps` takes no body measure, and the apps `Container` is
   * full-bleed below its cap, so the rung sits at `V − APPS_CONTAINER_GUTTER` of grid.
   *
   * 🔴 DID: the mapping from VIEWPORT to grid width, and therefore the viewport at which
   * a rung fires. This describe was titled "byte-equivalent to the retired Mantine media
   * queries" and that was FALSE in production. The page's scroll container `.scroll-area`
   * is `scrollbar-width: thin` with no document scroll, so the grid is
   * `viewport − scrollbar − 32`; media queries ignored the scrollbar, a container query
   * does not. On platforms that reserve one (~10px) every rung fires ~10px of viewport
   * later than before. Kept deliberately — the content never had those pixels — and
   * driven end-to-end in `AppListingsMarketplaceBody.stretch.geometry.test.tsx`, which is
   * the only test in this PR that exercises the viewport→grid step at all.
   *
   * So everything below is stated in GRID width, which is what it was always measuring.
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
  test('the floor is 460px — the card width the store renders TODAY at its widest', () => {
    // 🔴 THE FLOOR IS THE MUTATION TARGET. Moving it moves every wide threshold, and the
    // literals below are what notice. Without them the derivation would agree with any
    // floor at all.
    //
    // 460 is not "the narrowest card we ever shipped" — it is the width four columns get
    // in the RETIRED 1920 container, asserted here as a relationship rather than as a
    // number so its provenance cannot rot:
    const RETIRED_CONTAINER = 1920;
    expect(listingCardWidthAt(RETIRED_CONTAINER - APPS_CONTAINER_GUTTER, 4)).toBe(460);
    expect(LISTING_CARD_MIN_WIDTH).toBe(460);
    expect(LISTING_GRID_GUTTER).toBe(16);
    expect(minContentWidthForColumns(5)).toBe(2364); // 5 × 460 + 4 × 16
    expect(minContentWidthForColumns(6)).toBe(2840); // 6 × 460 + 5 × 16
    // A seventh column would need this much grid — stated so the next person adding one
    // can see the cost rather than picking a threshold by eye.
    expect(minContentWidthForColumns(7)).toBe(3316); // 7 × 460 + 6 × 16
  });

  test('🔴 the widest REACHABLE rung makes cards BIGGER than the 1920 container did', () => {
    // The product decision this floor encodes, stated as the outcome rather than as the
    // input. A floor at the covers pass's own narrowest (380) would have put SIX columns
    // in this container at 408px — i.e. widening the page would have SHRUNK the cards.
    const grid = APPS_PAGE_CONTAINER_WIDTH - APPS_CONTAINER_GUTTER;
    const columns = listingGridColumnsAt(grid);
    expect(columns).toBe(5);
    expect(listingCardWidthAt(grid, columns)).toBe(492.8);
    // …strictly wider than today's four-up, which is the whole claim.
    expect(listingCardWidthAt(grid, columns)).toBeGreaterThan(460);
    // And the counterfactual, so the test says what it is ruling out: at a 380 floor the
    // same container would have taken six columns at 408px — narrower than today.
    const sixAt380 = 6 * 380 + 5 * LISTING_GRID_GUTTER;
    expect(sixAt380).toBeLessThan(grid);
    expect(listingCardWidthAt(grid, 6)).toBe(408);
    expect(listingCardWidthAt(grid, 6)).toBeLessThan(460);
  });

  test('🔴 SIX columns is declared but UNREACHABLE at the current container cap', () => {
    // Why the ladder a viewer can reach is 1/2/3/4/5 even though the module declares six.
    // 🔴 THIS IS THE ASSERTION THAT FIRES IF SOMEONE RAISES THE CONTAINER CAP. It is not
    // a statement that six is wrong — it is a statement that engaging six is a DENSITY
    // decision, and it must be made deliberately rather than inherited from a width bump.
    const maxGrid = APPS_PAGE_CONTAINER_WIDTH - APPS_CONTAINER_GUTTER;
    expect(maxGrid).toBe(2528);
    const sixRung = LISTING_GRID_COLUMN_STEPS.find((s) => s.columns === 6);
    expect(sixRung, 'the six-column rung was deleted rather than left unreachable').toBeDefined();
    expect(
      sixRung!.minContentWidth,
      'six columns is now REACHABLE — raising the container cap past the six-column rung ' +
        'shrinks every card below LISTING_CARD_MIN_WIDTH-at-five. Decide the density on ' +
        'purpose: either accept six, or raise the floor so the rung moves out again.'
    ).toBeGreaterThan(maxGrid);
    expect(listingGridColumnsAt(maxGrid)).toBe(5);
    // The rung is still REAL, not decorative — it engages the moment the grid is wide
    // enough, which is what makes keeping it (rather than deleting it) the right call.
    expect(listingGridColumnsAt(sixRung!.minContentWidth)).toBe(6);
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
   * The page size is a CONSEQUENCE of the ladder: 24 was six rows at four columns and
   * only 4.8 at the FIVE columns the grid now reaches, so the widest screen the container
   * supports would have met "Load more" after the least content.
   *
   * ⚠️ This paragraph said "the six columns the grid now reaches" until the floor moved
   * from 383 to 460 in this same PR, which made six unreachable — see the
   * `SIX columns is declared but UNREACHABLE` test above. A claim that was true when
   * written and falsified by a LATER commit of its own branch sits inside no review
   * round's diff, which is exactly how it survived.
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

  test('…which is at least eight rows at the widest REACHABLE column count, and twelve at four', () => {
    // Written against what a viewer can actually reach (five columns at the 2528 of grid
    // this container yields), not against the declared-but-unreachable sixth rung — and
    // as a `>=` so it stays true if a future cap raise engages that rung (48 / 6 = 8).
    const widestReachable = listingGridColumnsAt(APPS_PAGE_CONTAINER_WIDTH - APPS_CONTAINER_GUTTER);
    expect(widestReachable).toBe(5);
    expect(Math.floor(requestedLimit() / widestReachable)).toBeGreaterThanOrEqual(8);
    expect(requestedLimit() / 4).toBe(12);
    // The `>=` is not a loophole: 48 is the largest multiple-of-12 page the server cap
    // allows, so this cannot be satisfied by simply shrinking the ladder.
    expect(requestedLimit()).toBeGreaterThanOrEqual(
      8 * LISTING_GRID_COLUMN_STEPS[LISTING_GRID_COLUMN_STEPS.length - 1].columns
    );
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
   * docstrings name `736`, `2364` and `2840` verbatim, so an unstripped scan would be
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
    // And the strip really removed the prose. `492.8` is the rendered CARD width at the
    // top of the reachable ladder — a figure that appears only in the docstrings and can
    // never be a threshold, so it cannot stop being a valid witness by becoming a rule.
    expect(source, 'the comment-strip control lost its witness').toContain('492.8');
    expect(code).not.toContain('492.8');
    // 🔴 AND THE ONE THE STRIP EXISTS FOR: both live thresholds are named verbatim in the
    // prose, so a scan that did not strip comments would find them with every real rule
    // deleted. They must survive in the source and vanish from the stripped code's PROSE
    // while remaining in its rules — which is what `parsedRules()` above proves.
    expect(source).toContain('2364');
    expect(source).toContain('2840');
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
