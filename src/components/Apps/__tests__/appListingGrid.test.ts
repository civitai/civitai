import fs from 'fs';
import path from 'path';
import { describe, expect, test } from 'vitest';
import {
  LISTING_CARD_MIN_WIDTH,
  LISTING_FOUR_COLUMN_MIN_WIDTH,
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
import { APPS_RESERVED_SCROLLBAR, appsRailChromeWidth } from '~/components/Apps/appsRailGeometry';

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
  /**
   * 🔴 THE RAIL RE-TUNE'S HEADLINE ASSERTION, AND THE ONE A DESIGNER IS SIGNING OFF.
   *
   * `lg`/`xl` moved 3 → 4 (four columns → THREE), so the legacy breakpoint half tops out
   * at three and the 1600–2240 band renders three store columns where it rendered four.
   * The reason is the 276px left rail: against the OLD ladder the rail kept four columns
   * at 1600 and 1920 and shrank each card by 69px (377.5 → 308.5 and 457.5 → 388.5),
   * partially undoing the 2026-07 "larger covers" pass at the two commonest desktop
   * widths. Dropping a column spends the loss on wider cards instead, which is the
   * direction both prior passes chose.
   *
   * RED AT `origin/main` BY CONSTRUCTION: this file's previous revision asserted
   * `LISTING_GRID_SPAN.xl === 3`, i.e. exactly the opposite value.
   */
  test('🔴 lg and xl yield THREE columns (span 4 of 12) — the rail re-tune', () => {
    expect(LISTING_GRID_SPAN.lg).toBe(4);
    expect(LISTING_GRID_SPAN.xl).toBe(4);
    expect(12 / LISTING_GRID_SPAN.xl).toBe(3);
    expect(12 / LISTING_GRID_SPAN.lg).toBe(3);
  });

  test('base / sm / md are UNCHANGED (1 / 2 / 3 columns)', () => {
    // ⚠️ These spans are NOT rail-gated, and an earlier revision of this comment said
    // they were ("nothing below `lg` renders the rail, so nothing below `lg` had a
    // reason to move"). That rationale is refuted by this file's own cost table below:
    // `LISTING_GRID_SPAN` is a global constant on GRID width, applied to every viewer,
    // and the rail is only one of the things that can consume width. A viewer below
    // 1300px has no rail and is still governed by these spans. They are unchanged here
    // because the re-tune deliberately scoped itself to `lg`/`xl`, not because anything
    // structurally exempts the narrow breakpoints.
    expect(LISTING_GRID_SPAN.base).toBe(12);
    expect(LISTING_GRID_SPAN.sm).toBe(6);
    expect(LISTING_GRID_SPAN.md).toBe(4);
    expect(12 / LISTING_GRID_SPAN.base).toBe(1);
    expect(12 / LISTING_GRID_SPAN.sm).toBe(2);
    expect(12 / LISTING_GRID_SPAN.md).toBe(3);
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
   * 🔴 THE ROW WITH THE MOST DISCRIMINATING POWER IS 1376 — it is the `xl` low end, the
   * safe middle of the desktop range, and the first row that would silently change if
   * the narrow half of the ladder were ever floor-governed rather than breakpoint-
   * governed. The rows that move under that mutation are 960 / 1100 / 1167 / 1168 /
   * 1376; prune those last.
   *
   * ⚠️ 1888 and 2100 read THREE COLUMNS EITHER WAY and are therefore NOT the load-
   * bearing rows — an earlier revision of this header named them alongside 1376 as "the
   * most important in this table", which pointed a pruner at the two rows that cannot
   * fail. They are kept for band coverage, not as witnesses. The COLLISION describe
   * below states the same thing outright: 1412 itself would read three, and the browser
   * fixtures at 1888 / 2450 / 2528 would all stay green under that mutation.
   *
   * The collision is still worth recording, because it is why 1888 looks significant
   * and is not: `4 × 460 + 3 × 16 = 1888`, so a floor-governed four-column rung would
   * land on exactly the retired 1920 container's content width. That coincidence makes
   * the row a natural place to assume coverage exists. It does not.
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
    { contentWidth: 1167, columns: 3, why: 'inside the md band — there is no lg rung any more' },
    { contentWidth: 1168, columns: 3, why: 'THE RE-TUNE GUARD — the RETIRED lg rung; still three' },
    { contentWidth: 1376, columns: 3, why: 'THE RE-TUNE GUARD — the old xl low end (1408 − 32)' },
    { contentWidth: 1568, columns: 3, why: 'a 1600 viewport with NO rail — the band that dropped' },
    { contentWidth: 1888, columns: 3, why: 'the retired 1920 container content width' },
    { contentWidth: 2100, columns: 3, why: 'still three — the fourth column is not free' },
    { contentWidth: 2241, columns: 3, why: 'one px below the four-column rung' },
    {
      contentWidth: 2242,
      columns: 4,
      why: '2560 − scrollbar − gutter − open rail: the widest desktop, rail open',
    },
    { contentWidth: 2450, columns: 4, why: 'inside the four-column band' },
    {
      contentWidth: 2528,
      columns: 4,
      why: 'a 2560 CONTAINER with NO rail yields this much grid',
    },
    { contentWidth: 2839, columns: 4, why: 'one px below the (unreachable) five-column rung' },
    {
      contentWidth: 2840,
      columns: 5,
      why: 'declared, but past the container cap in every rail state',
    },
    {
      contentWidth: 4000,
      columns: 5,
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
    expect(new Set(LADDER.map((r) => r.columns))).toEqual(new Set([1, 2, 3, 4, 5]));
  });

  test('🔴 the ladder is exactly these five rungs, in ascending order', () => {
    // A ledger, not a floor: the loops above iterate it, so a ladder that silently
    // grew a rung (or lost one) would still satisfy them.
    //
    // 🔴 RED AT `origin/main`: this literal read six rungs ending `{1168,4} {2364,5}
    // {2840,6}`. The rail re-tune retired the 1168 rung (md/lg/xl all mean three columns
    // now), moved four columns to 2242 (derived from the page chrome — see
    // `LISTING_FOUR_COLUMN_MIN_WIDTH`) and re-assigned 2840 from six columns to five.
    expect(LISTING_GRID_COLUMN_STEPS).toEqual([
      { minContentWidth: 0, columns: 1 },
      { minContentWidth: 736, columns: 2 },
      { minContentWidth: 960, columns: 3 },
      { minContentWidth: 2242, columns: 4 },
      { minContentWidth: 2840, columns: 5 },
    ]);
    const widths = LISTING_GRID_COLUMN_STEPS.map((s) => s.minContentWidth);
    expect([...widths].sort((a, b) => a - b)).toEqual(widths);
    const columns = LISTING_GRID_COLUMN_STEPS.map((s) => s.columns);
    expect([...columns].sort((a, b) => a - b)).toEqual(columns);
    // No redundant rung — `lg` and `xl` are both THREE columns (span 4 of 12) since the
    // rail re-tune, so they must collapse to a single rung. (This said "four columns"
    // until the re-tune landed; it was correct at `origin/main` and stale after.)
    expect(new Set(columns).size).toBe(columns.length);
  });
});

describe('🔴 THE COLLISION — the card-width floor must NOT govern the narrow half', () => {
  /**
   * 🔴 WHY THIS DESCRIBE EXISTS, AND WHY IT DID NOT NEED TO AT THE OLD FLOOR.
   *
   * `LISTING_CARD_MIN_WIDTH` is 460, and `4 × 460 + 3 × 16 = 1888` — EXACTLY the content
   * width of the retired 1920 container. So a floor-derived rung and one of the
   * most-quoted widths in this change are the same number, and the two halves of the
   * ladder are one refactor away from being confused for each other.
   *
   * ⚠️ THE CONCRETE FORM MOVED WITH THE RAIL RE-TUNE, AND THIS PARAGRAPH IS CORRECTED
   * RATHER THAN DELETED because the trap it names is unchanged. It used to read: a
   * floor-governed narrow half would start four columns at 1888 and drop the whole
   * 1168–1887 band to three. There is no 1168 rung any more and no five-column rung at
   * 2364, so that sentence describes a ladder this file no longer tests. The live form:
   * the lowest narrow rung is `md` at 960, its floor-derived counterpart is
   * `3 × 460 + 2 × 16 = 1412`, and a floor-governed narrow half would drop the ENTIRE
   * 960–1411 band to two columns. Every other assertion in this file would still pass —
   * 1412 itself would read three (the floor's own rung), the stylesheet seam would still
   * agree, and the browser fixtures at 1888 / 2450 / 2528 would all be green. The defect
   * would be invisible everywhere except here.
   *
   * At the old 383 floor `4 × 383 + 3 × 16 = 1580`, comfortably away from every number in
   * play, and a floor-governed narrow half would have broken loudly. It is the NEW value
   * that makes the failure quiet, so these assertions are a consequence of the product
   * decision rather than general hygiene — do not delete them as redundant with the table.
   */
  test('🔴 THREE columns at 960 — the `md` rung, the width a floor-governed ladder breaks', () => {
    // ⚠️ RE-DERIVED FOR THE RAIL RE-TUNE. This used to assert FOUR columns at 1376 (the
    // `xl` low end), because `lg`/`xl` meant four and the 1168 rung was the thing a
    // floor-governed narrow half would have destroyed. There is no 1168 rung now — md/lg/xl
    // all mean three — so 1376 legitimately renders three and asserting four here would be
    // asserting the defect. The CLAIM is unchanged and so is its shape: the lowest narrow
    // rung a floor-governed ladder would move is `md`, and it must not move.
    const MD_RUNG = MANTINE_BREAKPOINT_PX.md - APPS_CONTAINER_GUTTER;
    expect(MD_RUNG).toBe(960);
    expect(
      listingGridColumnsAt(MD_RUNG),
      'the md rung fell below three columns. The most likely cause is that the narrow ' +
        'half of LISTING_GRID_COLUMN_STEPS started deriving from LISTING_CARD_MIN_WIDTH: ' +
        `minContentWidthForColumns(3) is ${minContentWidthForColumns(3)}, so three columns ` +
        'would not begin until then and this whole band would render two.'
    ).toBe(3);
    // …and the whole band above it holds three, which is where a floor-governed ladder
    // would show up as a silent drop.
    for (const w of [1168, 1376, 1888, 2100]) expect(listingGridColumnsAt(w)).toBe(3);
  });

  test('🔴 three columns at 1411 AND at 1412 — one below the collision point and on it', () => {
    const COLLISION = minContentWidthForColumns(3);
    // The collision is real, not hypothetical: state it, so the reader can see why the
    // two assertions below are interesting rather than arbitrary.
    expect(COLLISION).toBe(1412);
    expect(listingGridColumnsAt(COLLISION - 1), 'one px below the collision point').toBe(3);
    expect(listingGridColumnsAt(COLLISION), 'exactly at the collision point').toBe(3);
    // 🔴 AND THE POINT: 1412 reads three for the RIGHT reason. It must be three because
    // the md rung (960) has been in force for 452px, NOT because the floor happens to
    // place a three-column rung there. Those two produce the same answer at 1412 and
    // different answers everywhere below it — which is exactly what makes 960 the
    // load-bearing assertion and 1412 the one that would have reassured you.
    expect(listingGridColumnsAt(960)).toBe(3);
  });

  test('🔴 no narrow rung equals its own floor-derived value (the derivations are separate)', () => {
    // The structural half of the claim. Each of 1/2/3 must come from a Mantine breakpoint
    // minus the gutter and NOT from `minContentWidthForColumns`, so the two sets must
    // disagree at every narrow column count.
    const narrow = LISTING_GRID_COLUMN_STEPS.filter((s) => s.columns <= 3);
    expect(narrow.map((s) => s.minContentWidth)).toEqual([0, 736, 960]);
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
    expect(narrow.filter((s) => s.columns > 1)).toHaveLength(2);
    expect(minContentWidthForColumns(2)).toBe(936);
    expect(minContentWidthForColumns(3)).toBe(1412);
    expect(minContentWidthForColumns(4)).toBe(1888);
  });

  test('the narrow rungs are BELOW every floor-derived rung of the same column count', () => {
    // Stated as a direction, not just inequality: a narrow rung must fire EARLIER than
    // the floor would allow, because the narrow half deliberately ships cards under the
    // floor (three columns at 960 is a ~309px card). That asymmetry is the design — the
    // floor governs only where a column is ADDED beyond what Mantine's scale reached.
    for (const step of LISTING_GRID_COLUMN_STEPS.filter((s) => s.columns > 1 && s.columns <= 3)) {
      expect(step.minContentWidth).toBeLessThan(minContentWidthForColumns(step.columns));
    }
    expect(listingCardWidthAt(960, 3)).toBeCloseTo(309.33, 2);
    expect(listingCardWidthAt(960, 3)).toBeLessThan(LISTING_CARD_MIN_WIDTH);
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
   * the only SPEC in this PR that exercises the viewport→grid step at all — every other
   * fixture sets the grid's width directly on a wrapper.
   *
   * So everything below is stated in GRID width, which is what it was always measuring.
   */
  test('each retired breakpoint maps to its rung by exactly one subtraction', () => {
    // 🔴 `lg` AND `xl` ARE BOTH THREE SINCE THE RAIL RE-TUNE, so they no longer have rungs
    // of their own: they collapse into `md`'s. The `firesEarlier` column says whether this
    // breakpoint OWNS a rung — only an owner can "fire one px early".
    const cases: [keyof typeof LISTING_GRID_SPAN, number, boolean][] = [
      ['base', 1, false],
      ['sm', 2, true],
      ['md', 3, true],
      ['lg', 3, false],
      ['xl', 3, false],
    ];
    for (const [breakpoint, columns, ownsRung] of cases) {
      expect(12 / LISTING_GRID_SPAN[breakpoint], `${breakpoint} span`).toBe(columns);
      const gridWidth = Math.max(0, MANTINE_BREAKPOINT_PX[breakpoint] - APPS_CONTAINER_GUTTER);
      expect(
        listingGridColumnsAt(gridWidth),
        `at the ${breakpoint} breakpoint (viewport ${MANTINE_BREAKPOINT_PX[breakpoint]}, ` +
          `grid ${gridWidth}) the ladder must give what span ${LISTING_GRID_SPAN[breakpoint]} gave`
      ).toBe(columns);
      // …and NOT one px earlier, which is what an off-by-one conversion looks like.
      expect(listingGridColumnsAt(gridWidth - 1), `${breakpoint} fires one px early`).toBe(
        ownsRung ? columns - 1 : columns
      );
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

  /**
   * 🔴 THE RAIL RE-TUNE'S CENTRAL CLAIM, AS A TABLE. Every viewport gets a card WIDER than
   * it does today — that is the justification for dropping a column in the 1600–2240 band,
   * and it is the thing a designer is being asked to accept.
   *
   * Each row is `[viewport, today's (cols × width) with NO rail, the new (cols × width)
   * with the rail OPEN]`. Grid = `min(viewport − scrollbar, 2560) − gutter − rail`, with
   * the 10px reserved scrollbar the store's own container-query note records.
   *
   * RED AT `origin/main`: at 1600 and 1920 the old ladder held four columns against the
   * open rail, at 308.5px and 388.5px — 69px NARROWER than today, which is the regression
   * the re-tune exists to remove.
   */
  test('🔴 with the rail OPEN, every viewport renders a WIDER card than it does today', () => {
    const grid = (viewport: number, rail: number) =>
      Math.min(viewport - APPS_RESERVED_SCROLLBAR, APPS_PAGE_CONTAINER_WIDTH) -
      APPS_CONTAINER_GUTTER -
      rail;

    const OPEN = appsRailChromeWidth(false);
    expect(OPEN, 'the open rail costs 260 + 16').toBe(276);

    const table: Array<[number, number, number, number, number]> = [
      // viewport, todayCols, todayWidth, railCols, railWidth
      [1300, 4, 302.5, 3, 316.67],
      [1440, 4, 337.5, 3, 363.33],
      [1600, 4, 377.5, 3, 416.67],
      [1920, 4, 457.5, 3, 523.33],
      [2560, 5, 490.8, 4, 548.5],
      [3440, 5, 492.8, 4, 551.0],
    ];

    for (const [viewport, todayCols, todayWidth, railCols, railWidth] of table) {
      const withRail = grid(viewport, OPEN);
      expect(listingGridColumnsAt(withRail), `@${viewport} rail-open columns`).toBe(railCols);
      expect(listingCardWidthAt(withRail, railCols), `@${viewport} rail-open card`).toBeCloseTo(
        railWidth,
        1
      );
      // …and the card is WIDER than today's, which is the claim. `todayCols`/`todayWidth`
      // are LITERALS of the pre-change behaviour rather than a second call to the current
      // ladder — the current ladder cannot be its own witness for what it replaced.
      expect(railWidth, `@${viewport}: the rail made the card NARROWER`).toBeGreaterThan(
        todayWidth
      );
      expect(railCols).toBeLessThanOrEqual(todayCols);
    }
  });

  test('🔴 the four-column rung is derived from the PAGE CHROME, not from the card floor', () => {
    // The one threshold in the module that does not come from `minContentWidthForColumns`.
    // Asserted as the arithmetic rather than as the number, so a rail-width change moves it
    // here too instead of leaving a stale literal.
    expect(LISTING_FOUR_COLUMN_MIN_WIDTH).toBe(2242);
    expect(LISTING_FOUR_COLUMN_MIN_WIDTH).toBe(
      APPS_PAGE_CONTAINER_WIDTH -
        APPS_RESERVED_SCROLLBAR -
        APPS_CONTAINER_GUTTER -
        appsRailChromeWidth(false)
    );
    // …and it is NOT the floor-derived value, which is the separation this test names.
    expect(LISTING_FOUR_COLUMN_MIN_WIDTH).not.toBe(minContentWidthForColumns(4));
    expect(minContentWidthForColumns(4)).toBe(1888);
  });

  test('🔴 FIVE columns is declared but UNREACHABLE in EVERY rail state', () => {
    // Why the ladder a viewer can reach is 1/2/3/4 even though the module declares five.
    // 🔴 THIS IS THE ASSERTION THAT FIRES IF SOMEONE RAISES THE CONTAINER CAP. It is not
    // a statement that five is wrong — it is a statement that engaging it is a DENSITY
    // decision, and it must be made deliberately rather than inherited from a width bump.
    //
    // 🔴 THREE STATES, NOT ONE — which is strictly more than the six-column version of
    // this test had to consider, because before the rail there was only ever one grid
    // width per container.
    const noRail = APPS_PAGE_CONTAINER_WIDTH - APPS_CONTAINER_GUTTER;
    const collapsed = noRail - appsRailChromeWidth(true);
    const open = noRail - appsRailChromeWidth(false);
    expect([noRail, collapsed, open]).toEqual([2528, 2456, 2252]);

    const fiveRung = LISTING_GRID_COLUMN_STEPS.find((s) => s.columns === 5);
    expect(fiveRung, 'the five-column rung was deleted rather than left unreachable').toBeDefined();
    for (const [name, grid] of [
      ['no rail', noRail],
      ['collapsed', collapsed],
      ['open', open],
    ] as const) {
      expect(
        fiveRung!.minContentWidth,
        `five columns is now REACHABLE with the rail ${name} — raising the container cap ` +
          'past the five-column rung shrinks every card. Decide the density on purpose.'
      ).toBeGreaterThan(grid);
      expect(listingGridColumnsAt(grid), `${name} tops out at four`).toBe(4);
    }
    // The rung is still REAL, not decorative — it engages the moment the grid is wide
    // enough, which is what makes keeping it (rather than deleting it) the right call.
    expect(listingGridColumnsAt(fiveRung!.minContentWidth)).toBe(5);
  });

  test('every WIDE rung gives cards at least the floor wide, at its threshold', () => {
    // 🔴 THIS IS THE PIN THAT STOPS A NEW COLUMN GOING UNDER THE FLOOR. It reads the
    // ladder, not the derivation, so a rung added with a hand-picked threshold fails here.
    //
    // ⚠️ THE "…AND THE THRESHOLD IS MINIMAL" HALF IS GONE, AND ITS ABSENCE IS THE RE-TUNE'S
    // ONE REAL LOSS OF RIGOUR — stated rather than quietly dropped. It could be asserted
    // while BOTH wide rungs came from one card floor; the four-column rung is now placed by
    // the page chrome, so it is deliberately NOT minimal (one px narrower still clears 460
    // comfortably). What survives is the direction that actually protects the store: a
    // column is never added where a card would fall under the floor.
    const wide = LISTING_GRID_COLUMN_STEPS.filter((s) => s.columns >= 4);
    expect(wide.length, 'no wide rungs to check — the loop would pass vacuously').toBe(2);
    for (const step of wide) {
      const cardWidth = listingCardWidthAt(step.minContentWidth, step.columns);
      expect(
        cardWidth,
        `${step.columns} columns at ${step.minContentWidth}px of grid gives ${cardWidth}px cards`
      ).toBeGreaterThanOrEqual(LISTING_CARD_MIN_WIDTH);
    }
    // The two live values, as literals, so the loop above cannot pass on a floor that moved.
    expect(listingCardWidthAt(2242, 4)).toBe(548.5);
    expect(listingCardWidthAt(2840, 5)).toBe(555.2);
  });

  test('adding a column never makes a card narrower than the one below it did at ITS threshold', () => {
    // The ladder's whole promise, stated as a relationship rather than per-rung numbers:
    // a column is added only where each card is still at least the floor, so the sequence
    // of card widths AT THE THRESHOLDS is flat at the floor rather than decreasing.
    for (const step of LISTING_GRID_COLUMN_STEPS.filter((s) => s.columns >= 4)) {
      const here = listingCardWidthAt(step.minContentWidth, step.columns);
      const ifWeHadNotAdded = listingCardWidthAt(step.minContentWidth, step.columns - 1);
      expect(here).toBeLessThan(ifWeHadNotAdded);
      expect(here).toBeGreaterThanOrEqual(LISTING_CARD_MIN_WIDTH);
    }
  });

  test('🔴 an intrinsic auto-fill grid CANNOT express this ladder (the derivation, checked)', () => {
    // The reason `repeat(auto-fill, minmax(X, 1fr))` was rejected, as arithmetic rather
    // than as prose. `auto-fill` fits `floor((W + gap) / (X + gap))` columns.
    //
    // ⚠️ RE-DERIVED FOR THE RE-TUNE. The old pair was "four at 1376 vs four at 1888"; the
    // ladder no longer puts four columns at either. The argument is identical in shape at
    // the rungs that DO exist: keeping THREE at the `md` rung and keeping three (not four)
    // at the top of the three-column band need floors with no overlap.
    const autoFillColumns = (gridWidth: number, floor: number) =>
      Math.max(1, Math.floor((gridWidth + LISTING_GRID_GUTTER) / (floor + LISTING_GRID_GUTTER)));

    const MD_RUNG = MANTINE_BREAKPOINT_PX.md - APPS_CONTAINER_GUTTER; // 960
    const TOP_OF_THREE = LISTING_FOUR_COLUMN_MIN_WIDTH - 1; // 2241
    expect(MD_RUNG).toBe(960);
    expect(TOP_OF_THREE).toBe(2241);

    // Keeping THREE at 960 needs a floor of at most 309…
    expect(autoFillColumns(MD_RUNG, 309)).toBe(3);
    expect(autoFillColumns(MD_RUNG, 310)).toBe(2);
    // …and any floor that low gives SIX at 2241, at ~360px per card — far under the 460
    // this grid holds, and under the ~380 the covers pass moved TO.
    expect(autoFillColumns(TOP_OF_THREE, 309)).toBe(6);
    expect(listingCardWidthAt(TOP_OF_THREE, 6)).toBeCloseTo(360.17, 2);
    expect(listingCardWidthAt(TOP_OF_THREE, 6)).toBeLessThan(LISTING_CARD_MIN_WIDTH);
    // Holding three at 2241 needs a floor above 548 — which then gives ONE at 960.
    expect(autoFillColumns(TOP_OF_THREE, 549)).toBe(3);
    expect(autoFillColumns(MD_RUNG, 549)).toBe(1);
    // The two requirements have no overlap. That is the whole argument.
    expect(309).toBeLessThan(549);
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
    // Written against what a viewer can actually reach (FOUR columns since the rail
    // re-tune, at the 2528 of grid this container yields with no rail), not against the
    // declared-but-unreachable fifth rung — and as a `>=` so it stays true if a future cap
    // raise engages that rung (48 / 5 = 9.6 → 9).
    const widestReachable = listingGridColumnsAt(APPS_PAGE_CONTAINER_WIDTH - APPS_CONTAINER_GUTTER);
    expect(widestReachable).toBe(4);
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
    // And the strip really removed the prose. `548.5` is the rendered CARD width at the
    // top of the reachable ladder — a figure that appears only in the docstrings and can
    // never be a threshold, so it cannot stop being a valid witness by becoming a rule.
    // (It was `492.8` before the rail re-tune moved the top of the ladder.)
    expect(source, 'the comment-strip control lost its witness').toContain('548.5');
    expect(code).not.toContain('548.5');
    // 🔴 AND THE ONE THE STRIP EXISTS FOR: both live thresholds are named verbatim in the
    // prose, so a scan that did not strip comments would find them with every real rule
    // deleted. They must survive in the source and vanish from the stripped code's PROSE
    // while remaining in its rules — which is what `parsedRules()` above proves.
    // ⚠️ THESE TWO MOVED WITH THE LADDER. The pair used to be 2364 / 2840; the stylesheet
    // no longer contains 2364 anywhere, so asserting it would fail for the right reason
    // but under a misleading name.
    expect(source).toContain('2242');
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
