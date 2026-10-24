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
    // The offending element is still THERE — this is not passing by rendering less.
    //
    // ⚠️ THIS USED TO NAME TWO `MetaLineSkeleton`s, and dropping one of them is a
    // WEAKENING OF THE CONTROL that has to be declared rather than absorbed. The
    // skeleton reserved a creator line AND a rollup line inside the meta block; the
    // card dropped its author chip and moved the rollup below the action row, so
    // `apps-listing-skeleton-creator` no longer exists and asserting it would fail.
    // One `<p>`-wrapping-a-`Skeleton` pairing still renders per cell, which is all
    // this control needs: the check below is `toBe(0)` on the whole document, so its
    // strength does not scale with the number of instances — only its non-vacuity
    // does, and one instance is enough for that.
    expect(html).toContain('apps-listing-skeleton-rollup');
    expect(html).not.toContain('apps-listing-skeleton-creator');
    expect(html).toContain('<p');
  });

  /**
   * 🔴 THE LIVE REGION HAS SOMETHING TO ANNOUNCE, AND IS NOT MARKED BUSY.
   *
   * ⚠️ THIS GUARD HAS NOW BEEN WRONG THREE TIMES IN THE SAME WAY, WHICH IS WHY IT IS
   * BUILT DIFFERENTLY RATHER THAN BUILT BETTER. v1 asserted `aria-label="Loading apps"`
   * — a label, which a live region does not announce. v2 asserted three strings over
   * `serverHtml()`. v3 (this) asserts CONTAINMENT, because the two things the docblock
   * kept promising — "with real text INSIDE it", "the text is not itself hidden" — are
   * facts about a TREE, and a flat string scan cannot express either. Both mutants
   * below were measured passing v2 at 4/4:
   *   · move the `sr-only` span OUT of the region, rendered as a sibling before it —
   *     `role="status"` still occurs once, `Loading apps` is still in the string, no
   *     `aria-busy`, and the class regex still matches;
   *   · put `aria-hidden` on the span — the old `[^>]*` admitted any other attribute.
   * Each restores exactly the defect the file's own headline names.
   *
   * 🔴 WHY THIS ONE PARSES AND THE `<div>`-IN-`<p>` ONE MUST NOT. They ask opposite
   * questions of the same string. The nesting check is about what the SERIALISED markup
   * says, and an HTML parser silently REPAIRS that particular offence (auto-closing the
   * `<p>`), so parsing would destroy the evidence — it stays a string scan. This check
   * is about ancestry, which only exists in a tree. Same input, two instruments, on
   * purpose.
   *
   * ⚠️ WHAT IS STILL NOT CLAIMED: that any particular screen reader announces this.
   * Nobody has run one — not this PR, not either audit. These are markup properties.
   */
  test('the announceable text is INSIDE the live region, unhidden, and the region is not busy', () => {
    const html = serverHtml();
    const doc = new DOMParser().parseFromString(html, 'text/html');

    // POSITIVE CONTROL on the parse itself — a DOMParser handed junk returns a
    // perfectly valid empty document, which would make every query below a confident
    // `null` and every `.toHaveLength(0)` a pass.
    expect(
      doc.querySelectorAll('[data-testid="apps-listing-skeleton-col"]').length,
      'the parsed document holds no skeleton cells — the parse, not the markup, is what failed'
    ).toBe(APP_LISTING_SKELETON_SSR_COLUMNS * APP_LISTING_SKELETON_ROWS);

    const regions = doc.querySelectorAll('[role="status"]');
    expect(regions, 'expected exactly one live region on the loading path').toHaveLength(1);
    const region = regions[0] as HTMLElement;

    // ── NOT BUSY. `aria-busy="true"` instructs assistive tech to withhold
    // announcements, and nothing here ever clears it (the grid unmounts instead).
    expect(
      region.getAttribute('aria-busy'),
      'the live region is marked `aria-busy`, which tells assistive tech to withhold ' +
        'announcements — and nothing ever clears it, because the grid unmounts instead'
    ).toBeNull();

    // ── THE TEXT IS **INSIDE** THE REGION. `region.querySelector` is the containment
    // assertion: a span rendered as a SIBLING of the region satisfies every string
    // check in the document and fails this one.
    const text = region.querySelector('.sr-only');
    expect(
      text,
      'the live region contains no `sr-only` text. A region announces its CONTENT, not ' +
        'its label — text rendered as a SIBLING of the region announces nothing, and ' +
        'that is exactly what an earlier version of this guard could not tell apart.'
    ).not.toBeNull();
    expect(text?.textContent?.trim()).toBe('Loading apps');

    // ── AND NOTHING BETWEEN THE TEXT AND THE REGION HIDES IT. Walked rather than
    // regexed: `aria-hidden` on the span, or on any ancestor up to and including the
    // region, removes it from the accessibility tree just as effectively.
    for (let el: Element | null = text; el; el = el.parentElement) {
      expect(
        el.getAttribute('aria-hidden'),
        `\`aria-hidden\` on <${el.tagName.toLowerCase()}> removes the announceable text ` +
          'from the accessibility tree — a fully hidden subtree has nothing to announce'
      ).toBeNull();
      if (el === region) break;
    }

    // …and the cards themselves ARE still hidden, which is the state this guard is
    // distinguishing from — so a pass is not "nothing is hidden anywhere".
    expect(
      doc.querySelector('[data-testid="apps-listing-card-skeleton"]')?.getAttribute('aria-hidden')
    ).toBe('true');
  });
});
