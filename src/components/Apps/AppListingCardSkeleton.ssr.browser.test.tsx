import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import {
  AppListingCardSkeletonGrid,
  APP_LISTING_SKELETON_ROWS,
  APP_LISTING_SKELETON_SSR_COLUMNS,
} from '~/components/Apps/AppListingCardSkeleton';

/**
 * `/apps` store — WHAT THE SERVER ACTUALLY EMITS FOR THE LOADING STATE.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 THIS FILE EXISTS BECAUSE ITS ABSENCE SHIPPED TWO DEFECTS IN ONE COMMIT
 * ─────────────────────────────────────────────────────────────────────────────
 * The first round of this change replaced `<Center py="xl"><Loader /></Center>` with
 * a skeleton grid whose cell count came from `useState(0)` corrected in a layout
 * effect. `useIsomorphicLayoutEffect` is `useLayoutEffect` only when `window` exists
 * and a plain `useEffect` otherwise — so it does not run during SSR at all — and tRPC
 * runs `ssr: false`, so the server always renders the `isLoading` branch. Net effect:
 * the server emitted an EMPTY grid. A spinner was replaced with nothing, on a page
 * whose own Lighthouse bot reports a 6.4s LCP, and two rows of skeletons popped in at
 * hydration.
 *
 * The component's own docstring asserted the opposite ("the count is set BEFORE the
 * browser paints and the viewer never sees the zero-cell first render") one sentence
 * after correctly naming SSR. Neither the parity suite nor the node guard could see
 * it: one measures a browser render where the effect HAS run, the other reads source
 * text. An adversarial audit found it. This file is the check that should have.
 *
 * The second defect is in the same blind spot for the same reason: Mantine's `Text`
 * renders `<p>` and Mantine's `Skeleton` renders `<div>`, and `<div>` may not descend
 * from `<p>`. A parser auto-closes the `<p>`, so the parsed DOM and React's tree
 * disagree — a hydration mismatch, 16–20 times per store load. The parity suite
 * emitted `validateDOMNesting` warnings on every run and still reported 7 passed,
 * because the offending element is `position: absolute` and contributes no geometry.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY `renderToString` IS THE RIGHT INSTRUMENT
 * ─────────────────────────────────────────────────────────────────────────────
 * It runs NO effects — not `useEffect`, not `useLayoutEffect` — so it reproduces the
 * server's output faithfully even though this suite runs in a browser where `window`
 * exists. That is what makes the assertion below a claim about production SSR rather
 * than about this harness. (`AppsSubNav.ssrHydration.browser.test.tsx` uses the same
 * instrument for the same reason.)
 */

/** The server's markup for the loading grid, under the provider the app uses. */
function serverHtml(): string {
  return renderToString(
    <MantineProvider>
      <AppListingCardSkeletonGrid />
    </MantineProvider>
  );
}

/** How many grid cells that markup contains. */
function cellCount(html: string): number {
  return [...html.matchAll(/data-testid="apps-listing-skeleton-col"/g)].length;
}

/**
 * Every `<div …>` that appears between a `<p …>` and its `</p>`.
 *
 * 🔴 A DELIBERATELY DUMB SCAN, AND IT HAS A POSITIVE CONTROL BELOW. Parsing the
 * string with the browser's own parser would be useless here: the parser is the thing
 * that AUTO-CLOSES the `<p>`, so by the time it hands back a tree the invalid nesting
 * has been silently repaired and the offence is gone. The defect lives in the STRING.
 */
function divsInsideParagraphs(html: string): number {
  let count = 0;
  const openP = /<p\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = openP.exec(html)) !== null) {
    const from = m.index + m[0].length;
    const close = html.indexOf('</p>', from);
    const segment = close === -1 ? html.slice(from) : html.slice(from, close);
    count += [...segment.matchAll(/<div\b/g)].length;
  }
  return count;
}

describe('🔴 the server emits a real skeleton grid, not an empty one', () => {
  test('POSITIVE CONTROLS — the instrument produces markup and the scanners can see it', () => {
    const html = serverHtml();
    // The render happened at all.
    expect(html.length, 'renderToString produced nothing').toBeGreaterThan(200);
    expect(html).toContain('apps-listing-skeleton-grid');

    // 🔴 THE SCANNERS THEMSELVES, FED A CASE THEY MUST FLAG. A reassuring zero from
    // `divsInsideParagraphs` is indistinguishable from a regex wired to nothing, so
    // watch it return a non-zero count before believing the zero it returns below.
    expect(divsInsideParagraphs('<p class="x"><div>bar</div></p>')).toBe(1);
    expect(divsInsideParagraphs('<p>a</p><div>b</div>')).toBe(0);
    expect(cellCount('<i data-testid="apps-listing-skeleton-col"></i>')).toBe(1);
    expect(cellCount('<i></i>')).toBe(0);
  });

  /**
   * 🔴 THE ASSERTION THE DEFECT WOULD HAVE FAILED. It is deliberately an EXACT count
   * rather than `> 0`: "some cells" would pass on a seed of 1, which would make every
   * desktop first paint render two full-width cards that become eight quarter-width
   * ones at hydration — a PER-CELL shift, i.e. the thing this whole PR removes.
   */
  test('the server renders exactly two rows at the seeded column count', () => {
    const html = serverHtml();
    const cells = cellCount(html);
    expect(
      cells,
      `the server emitted ${cells} skeleton cells. Zero means the loading state is ` +
        'EMPTY server-side — a spinner replaced with nothing, popping in at hydration. ' +
        'Check that `columns` is seeded from APP_LISTING_SKELETON_SSR_COLUMNS rather ' +
        'than 0: the layout effect that corrects it does NOT run during SSR.'
    ).toBe(APP_LISTING_SKELETON_SSR_COLUMNS * APP_LISTING_SKELETON_ROWS);
    // …and the seed is the derived desktop rung, not something hand-picked. 4 is typed
    // out here and derived there, so a test that reads the value and asserts it equals
    // itself is not what this is.
    expect(APP_LISTING_SKELETON_SSR_COLUMNS).toBe(4);
    expect(cells).toBe(8);
  });

  test('🔴 the server markup contains no <div> inside a <p> — no hydration mismatch', () => {
    const html = serverHtml();
    expect(
      divsInsideParagraphs(html),
      'a <div> is nested inside a <p> in the server markup. An HTML parser auto-closes ' +
        "the <p> at the <div>, so the parsed DOM is `<p></p><div></div>` while React's " +
        'tree is `<p><div/></p>` — a hydration mismatch on every /apps load. Mantine ' +
        '`Text` is a <p> and Mantine `Skeleton` is a <div>: pass `component="span"` to ' +
        'the Skeleton (NOT `component="div"` to the Text — that moves the element the ' +
        'meta line is measured on).'
    ).toBe(0);
    // The offending elements are still THERE — this is not passing by rendering less.
    expect(html).toContain('apps-listing-skeleton-creator');
    expect(html).toContain('apps-listing-skeleton-rollup');
    expect(html).toContain('<p');
  });

  /**
   * 🔴 THE LIVE REGION HAS SOMETHING TO ANNOUNCE, AND IS NOT MARKED BUSY.
   *
   * ⚠️ THIS TEST USED TO BE `expect(html).toContain('aria-label="Loading apps"')` AND
   * IT WAS TITLED "announced, once" — a name wider than its body, over markup that
   * most likely announced NOTHING. The region carried `role="status" aria-busy="true"`
   * with every descendant `aria-hidden`: `aria-busy="true"` on a live region is the
   * standard instruction to withhold announcements (and it was a hardcoded literal
   * that never cleared — the grid unmounts instead), a fully `aria-hidden` subtree has
   * no announceable content, and a live region announces its CONTENT rather than its
   * label. An audit found it in the paragraph rewritten to stop overstating exactly
   * this.
   *
   * So the three things asserted are the three the markup has to satisfy: one live
   * region, NOT busy, with real text inside it.
   *
   * ⚠️ WHAT IS STILL NOT CLAIMED: that any particular screen reader announces it.
   * Nobody has run one — not this PR, not the audit. This is a markup assertion.
   */
  test('the loading grid is a live region with announceable text, and is not marked busy', () => {
    const html = serverHtml();
    expect([...html.matchAll(/role="status"/g)]).toHaveLength(1);
    expect(html).toContain('Loading apps');
    expect(
      html,
      'the live region is marked `aria-busy`, which tells assistive tech to withhold ' +
        'announcements — and nothing ever clears it, because the grid unmounts instead'
    ).not.toContain('aria-busy');
    // …and the text is not itself hidden, which is the other way to announce nothing.
    expect(html).toMatch(/class="[^"]*sr-only[^"]*"[^>]*>Loading apps/);
  });
});
