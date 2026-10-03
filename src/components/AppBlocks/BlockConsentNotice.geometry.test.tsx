/**
 * THE MISSING-PERMISSIONS NOTICE AT TWO WIDTHS.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS PINS
 * ─────────────────────────────────────────────────────────────────────────────
 * The notice shipped with NO breakpoint handling of any kind: a
 * `<Group justify="space-between" wrap="nowrap">` holding a full sentence and TWO
 * full-text buttons, on a surface that is sometimes a phone and sometimes a ~320px
 * model sidebar. `wrap="nowrap"` with a non-shrinkable message is the overflow.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 WHY THE `geometry` PROJECT AND NOT `component`
 * ─────────────────────────────────────────────────────────────────────────────
 * Two reasons, and the first alone decides it.
 *
 *  1. THE SWAP IS A CONTAINER QUERY WHOSE BREAKPOINT IS `theme('screens.xs')`. That
 *     function is resolved by Tailwind's PostCSS plugin, and the number it resolves
 *     to is the `xs` key of `src/utils/breakpoints.json`. A tier that does not run
 *     the app cascade is not a tier that can be trusted to agree with production
 *     about which rules exist at all.
 *  2. THE `component` TIER HAS NO VIEWPORT OF ITS OWN. `test/geometry-setup.tsx`
 *     records the runner's silent default as 414x896 — which sits ABOVE the 390/393
 *     band real phones report AND above this notice's own 480px swap point, so a
 *     default-viewport test would measure the WIDE form and call it mobile coverage.
 *     A responsive defect tested at an unstated width is the config-blind suite in
 *     its purest form.
 *
 * `renderAtViewport` SETS the viewport and throws unless the window reports back the
 * size asked for, and every test below also asserts `observed` against its own
 * literal — so the width each claim is made at is in the test, not in a config.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 THE TWO POINTS, AND WHAT MEASURING ONLY ONE WOULD HIDE
 * ─────────────────────────────────────────────────────────────────────────────
 * 390 (PHONE_VIEWPORT, the modal phone width in this app's RUM) and 1280 (a laptop).
 * Both are named in the test titles. Measuring only the narrow one passes on a
 * component that is PERMANENTLY icon-only — i.e. on a desktop regression — and
 * measuring only the wide one is the bug itself. The pair is also what makes the
 * stylesheet non-optional: with the CSS module missing, BOTH forms are visible at
 * BOTH widths, which fails the "exactly one" assertions rather than passing them.
 *
 * ⚠️ WHAT THESE DO NOT MEASURE. The swap point itself (480px) is deliberately NOT
 * probed: both points sit a comfortable distance either side of it, so these tests
 * cannot tell 480 from 460. The claim they carry is "the narrow form is what a phone
 * gets and the wide form is what a laptop gets", which is the product claim. The
 * number lives in one place (`BlockConsentNotice.module.scss`, via `theme()`) and
 * nothing restates it, so there is nothing for a second assertion to catch drifting.
 *
 * ⚠️ AND THEY MEASURE THE VIEWPORT AS A PROXY FOR THE CONTAINER. The swap is a
 * CONTAINER query — the notice asks how wide IT is, not how wide the screen is,
 * because the desktop model sidebar is the narrow case that a viewport query gets
 * wrong (see `.notice` in the stylesheet). The fixture renders the notice as a
 * full-width block, so container width tracks viewport width here and the two
 * coincide. The sidebar case is therefore covered by the MECHANISM, not by a
 * measurement in this file.
 */
import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup } from 'vitest-browser-react';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import {
  box,
  cascadeEvidence,
  PHONE_VIEWPORT,
  renderAtViewport,
} from '../../../test/geometry-setup';
import { BlockConsentNotice } from './BlockConsentNotice';
// The REAL module mapping, so the queries below resolve the same hashed class names the
// component renders. A `[class*="wideOnly"]` substring match would also work and would
// keep passing if the class were renamed on one side only.
import classes from './BlockConsentNotice.module.scss';

/** A laptop. Comfortably above the notice's 480px swap point. */
const LAPTOP_VIEWPORT = { width: 1280, height: 800 } as const;

const APP_NAME = 'Background Remover';

/** The sentence the wide form shows, and the phrase the narrow form shows instead. */
const LONG_MESSAGE = `${APP_NAME} is missing permissions it needs to work fully.`;
const SHORT_MESSAGE = 'Missing permissions';

function render(viewport: { readonly width: number; readonly height: number }) {
  return renderAtViewport(
    <BlockConsentNotice
      appName={APP_NAME}
      onReview={() => undefined}
      onDismiss={() => undefined}
    />,
    viewport
  );
}

const notice = () => page.getByTestId('block-consent-notice');
const reviewByTestId = () => page.getByTestId('block-consent-notice-review');
const dismissByTestId = () => page.getByTestId('block-consent-notice-dismiss');

/**
 * The two SWAPPED node groups, and whether each node in them is displayed.
 *
 * 🔴 SCOPED TO THE NODES THAT CARRY THE SWAP CLASSES, NOT TO "every span in the
 * notice". The first draft of this helper read every span and was wrong in the way
 * that matters: Mantine's `Button` wraps its children in `.mantine-Button-inner` /
 * `.mantine-Button-label` spans, which are NOT display:none and whose `textContent`
 * is their hidden child's — so a correctly hidden label still reported as visible
 * text, and the file failed against a working component (and would have passed
 * against several broken ones).
 */
function swapNodes() {
  const el = notice().element() as HTMLElement;
  const group = (className: string) =>
    Array.from(el.querySelectorAll<HTMLElement>(`.${className}`)).map((node) => ({
      node,
      shown: getComputedStyle(node).display !== 'none',
      text: (node.textContent ?? '').trim(),
    }));
  return { wide: group(classes.wideOnly), narrow: group(classes.narrowOnly) };
}

/**
 * Which form is on screen — `'narrow'`, `'wide'`, or a diagnosis.
 *
 * 🔴 IT REPORTS `'both'` AND `'neither'` RATHER THAN THROWING, so an assertion against
 * a literal names what actually happened. `'both'` is what a MISSING stylesheet
 * produces (neither at-rule exists, so nothing is hidden) and `'neither'` is what the
 * first implementation of this component produced (the wide half hidden
 * unconditionally, the narrow half hidden by the query) — two different defects that a
 * bare "the short message is visible" check cannot tell apart, and one of which it
 * would pass.
 */
function shownForm(): 'narrow' | 'wide' | 'both' | 'neither' | 'mixed' {
  const { wide, narrow } = swapNodes();
  expect(wide.length, 'no wide-form nodes rendered at all').toBeGreaterThan(0);
  expect(narrow.length, 'no narrow-form nodes rendered at all').toBeGreaterThan(0);
  const allWide = wide.every((n) => n.shown);
  const noWide = wide.every((n) => !n.shown);
  const allNarrow = narrow.every((n) => n.shown);
  const noNarrow = narrow.every((n) => !n.shown);
  if (allWide && noNarrow) return 'wide';
  if (allNarrow && noWide) return 'narrow';
  if (allWide && allNarrow) return 'both';
  if (noWide && noNarrow) return 'neither';
  return 'mixed';
}

/** The text actually on screen, from the swapped nodes only (icons contribute none). */
function visibleTexts(): string[] {
  const { wide, narrow } = swapNodes();
  return [...wide, ...narrow]
    .filter((n) => n.shown)
    .map((n) => n.text)
    .filter(Boolean);
}

/**
 * 🔴 THE CASCADE CONTROL, ASSERTED FIRST IN EVERY TEST.
 *
 * Without the app stylesheet the container query does not exist, every `display:
 * none` is absent, and BOTH forms render — which this file's "exactly one" shape
 * catches. But it catches it as a confusing double-match rather than as "your
 * stylesheet did not load", so the diagnosis is made explicit here. `ruleCount` and
 * the Tailwind probe are the two readings `geometry-setup` measured as DISAGREEING
 * between the tiers, so they attribute rather than reassure.
 */
function expectCascade() {
  const evidence = cascadeEvidence();
  expect(evidence.ruleCount, 'the app cascade did not load').toBeGreaterThan(1000);
  expect(
    evidence.tailwindFlexUtilityResolves,
    'Tailwind did not load, so `theme()` in the module stylesheet cannot be trusted either'
  ).toBe(true);
}

describe('the notice at 390x844 — a phone', () => {
  test('🔴 shows the SHORT message and ICON-ONLY actions', async () => {
    const { observed } = await render(PHONE_VIEWPORT);
    expect(observed).toEqual({ width: 390, height: 844 });
    expectCascade();

    // EXACTLY the narrow form — not "the short message is somewhere on screen", which a
    // notice showing BOTH forms also satisfies.
    expect(shownForm()).toBe('narrow');

    const texts = visibleTexts();
    expect(texts).toEqual([SHORT_MESSAGE]);
    expect(texts).not.toContain(LONG_MESSAGE);

    // The buttons carry NO visible word — their labels are the two `wideOnly` spans,
    // and the icons are what is left.
    for (const label of ['Review permissions', 'Dismiss']) {
      expect(texts, `"${label}" is still rendered as text at 390px`).not.toContain(label);
    }
    const review = reviewByTestId().element() as HTMLElement;
    expect(
      review.querySelectorAll('svg').length,
      'the review button has no icon to stand in for its missing label'
    ).toBeGreaterThan(0);
    const dismiss = dismissByTestId().element() as HTMLElement;
    expect(dismiss.querySelectorAll('svg').length).toBeGreaterThan(0);
  });

  test('🔴 the icon-only buttons still expose an ACCESSIBLE NAME — queried by role, not testid', async () => {
    // 🔴 BY ROLE + NAME DELIBERATELY. A testid resolves an icon-only button whose
    // accessible name is the empty string just as happily as a named one, so it cannot
    // see the regression this is about: the review button's name came from its visible
    // text, and removing that text at narrow widths leaves it named by its icon, i.e.
    // by nothing.
    //
    // ⚠️ THIS IS AN INVARIANT GUARD, NOT REGRESSION COVERAGE, AND IT IS LABELLED BECAUSE
    // IT LOOKS LIKE THE OPPOSITE. It is GREEN on pre-change code — where both buttons
    // carried a visible word, so both were named — so it was never shown to fail on the
    // defect. The defect it pins did not exist until the narrow form did. What it IS
    // demonstrably able to catch is the `aria-label` being dropped as redundant once the
    // wide form shows the same words: mutation-tested by deleting
    // `aria-label="Review permissions"` from the review button, which reds this arm with
    // `Cannot find element with locator: getByRole('button', { name: 'Review permissions' })`
    // while the other seven tests in this file stay green — i.e. it dies for THIS guard's
    // own reason, not as collateral from a different assertion.
    const { observed } = await render(PHONE_VIEWPORT);
    expect(observed).toEqual({ width: 390, height: 844 });
    expectCascade();

    await expect.element(page.getByRole('button', { name: 'Review permissions' })).toBeVisible();
    await expect
      .element(page.getByRole('button', { name: 'Dismiss the missing-permissions notice' }))
      .toBeVisible();
  });

  test('🔴 the message occupies ONE line at 390 — the "too big on mobile" defect itself', async () => {
    // 🔴 THE DEFECT WAS NEVER AN OVERFLOW, AND SAYING SO IS WHAT MAKES THIS THE RIGHT
    // ASSERTION. Measured on pre-change code at 390: `scrollWidth === clientWidth` — the
    // row did NOT overflow, because the message is a flex item whose automatic minimum
    // size is its MIN-CONTENT width, so the browser shrank the sentence and wrapped it
    // instead. An overflow assertion is therefore GREEN on the broken component. What was
    // actually wrong is the height: a full sentence squeezed beside two text buttons in a
    // 390px bar wraps onto several lines, and the notice becomes a block of text where it
    // should be one strip.
    //
    // Line COUNT, derived from the element's own resolved `line-height` rather than from a
    // pinned pixel height, so a type-scale change cannot make this stale. Measured in this
    // harness at 390: SIX lines on pre-change code, one after.
    const { observed } = await render(PHONE_VIEWPORT);
    expect(observed).toEqual({ width: 390, height: 844 });
    expectCascade();

    const el = notice().element() as HTMLElement;
    // The `<p>` Mantine's `Text` renders — present in BOTH the pre- and post-change
    // markup, which is what lets this one assertion be measured on either.
    const paragraph = el.querySelector('p') as HTMLElement | null;
    expect(paragraph, 'the notice renders no message paragraph').not.toBeNull();
    const lineHeight = parseFloat(getComputedStyle(paragraph as HTMLElement).lineHeight);
    expect(lineHeight, 'line-height did not resolve — the cascade is not loaded').toBeGreaterThan(
      0
    );
    const lines = Math.round(
      (paragraph as HTMLElement).getBoundingClientRect().height / lineHeight
    );
    expect(
      lines,
      `the message wraps onto ${lines} lines at 390px — the narrow copy is not being used`
    ).toBe(1);

    // ⚠️ INVARIANT GUARD, and labelled because it is GREEN ON THE PRE-CHANGE CODE for the
    // reason above. It is kept because the narrow form introduces a `min-width: 0` on the
    // message, and `min-width: 0` is exactly what makes an unwrappable child (a long
    // unbroken app name, say) overflow instead of floor the row.
    const noticeBox = box(el);
    expect(noticeBox.width).toBeLessThanOrEqual(390);
    expect(
      el.scrollWidth,
      `the notice's content is ${el.scrollWidth}px wide inside a ${el.clientWidth}px box`
    ).toBeLessThanOrEqual(el.clientWidth);
    for (const [label, locator] of [
      ['review', reviewByTestId()],
      ['dismiss', dismissByTestId()],
    ] as const) {
      const b = box(locator.element());
      expect(b.right, `the ${label} action is past the notice's right edge`).toBeLessThanOrEqual(
        noticeBox.right + 0.5
      );
      expect(b.width, `the ${label} action collapsed to nothing`).toBeGreaterThan(0);
    }
  });

  test('🔴 role="status" survives the responsive rewrite — it is NOT an alert', async () => {
    // INVARIANT GUARD, labelled as one: `role="alert"` was never present, so this is not
    // regression coverage. It is here because the contract ("an offer the viewer can
    // ignore, so it must not seize a screen reader mid-sentence") is prose in the
    // component and a rewrite of the markup is exactly when prose gets lost.
    const { observed } = await render(PHONE_VIEWPORT);
    expect(observed).toEqual({ width: 390, height: 844 });
    const el = notice().element() as HTMLElement;
    expect(el.getAttribute('role')).toBe('status');
  });
});

describe('the notice at 1280x800 — a laptop', () => {
  test('🔴 shows the FULL sentence and both actions as WORDS', async () => {
    const { observed } = await render(LAPTOP_VIEWPORT);
    expect(observed).toEqual({ width: 1280, height: 800 });
    expectCascade();

    expect(shownForm()).toBe('wide');

    const texts = visibleTexts();
    expect(texts).toContain(LONG_MESSAGE);
    expect(texts).not.toContain(SHORT_MESSAGE);
    expect(texts).toContain('Review permissions');
    expect(texts).toContain('Dismiss');
  });

  test('the accessible names are the SAME at both widths', async () => {
    // 🔴 THE PAIR IS THE CLAIM. `aria-label` overrides visible text, so a label that
    // merely paraphrased the word on the button would break "label in name" for anyone
    // driving this by voice at the wide width — while every assertion in the narrow
    // block above would still pass. Asserting the identity here is what rules that out.
    const { observed } = await render(LAPTOP_VIEWPORT);
    expect(observed).toEqual({ width: 1280, height: 800 });
    expectCascade();

    await expect.element(page.getByRole('button', { name: 'Review permissions' })).toBeVisible();
    await expect
      .element(page.getByRole('button', { name: 'Dismiss the missing-permissions notice' }))
      .toBeVisible();
    // …and the visible word on the review button is that exact string, not a paraphrase.
    const review = reviewByTestId().element() as HTMLElement;
    expect((review.textContent ?? '').trim()).toBe('Review permissions');
  });

  test('the actions are still on ONE row, right of the message', async () => {
    const { observed } = await render(LAPTOP_VIEWPORT);
    expect(observed).toEqual({ width: 1280, height: 800 });
    expectCascade();

    const sentence = swapNodes().wide.find((n) => n.text === LONG_MESSAGE);
    expect(sentence, 'the wide sentence did not render').toBeTruthy();
    const messageBox = box((sentence as { node: HTMLElement }).node);
    const reviewBox = box(reviewByTestId().element());
    const dismissBox = box(dismissByTestId().element());
    // Right of the sentence…
    expect(reviewBox.left).toBeGreaterThan(messageBox.right);
    // …and the two actions share a row with each other.
    expect(dismissBox.top).toBeCloseTo(reviewBox.top, 0);
  });
});

describe('🔴 the two widths genuinely DIFFER — the control for both blocks above', () => {
  test('the same component renders a different visible-text set at 390 and at 1280', async () => {
    // Without this, "narrow shows the short form" and "wide shows the long form" are two
    // independent claims either of which could be passing for the wrong reason (a
    // stylesheet that happens to hide the right span at one width only). Measuring the
    // SAME component at both points and requiring the sets to be unequal is what makes
    // this a statement about the swap.
    const narrow = await render(PHONE_VIEWPORT);
    expect(narrow.observed.width).toBe(390);
    expectCascade();
    const atNarrow = visibleTexts().sort();

    // 🔴 BETWEEN THE TWO RENDERS, NOT ONLY AFTER THE TEST. The harness cleans up in
    // `afterEach`, so a second render inside ONE test leaves two notices mounted and
    // every `getByTestId` below is a strict-mode violation rather than a measurement.
    await cleanup();

    const wide = await render(LAPTOP_VIEWPORT);
    expect(wide.observed.width).toBe(1280);
    const atWide = visibleTexts().sort();

    expect(atNarrow.length, 'nothing was visible at 390px').toBeGreaterThan(0);
    expect(atWide.length, 'nothing was visible at 1280px').toBeGreaterThan(0);
    expect(
      atWide,
      'the notice renders identically at 390 and 1280 — the swap is inert'
    ).not.toEqual(atNarrow);
  });
});
