/**
 * THE MISSING-PERMISSIONS NOTICE AT TWO WIDTHS.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS PINS
 * ─────────────────────────────────────────────────────────────────────────────
 * The notice shipped with NO breakpoint handling of any kind: a
 * `<Group justify="space-between" wrap="nowrap">` holding a full sentence and TWO
 * full-text buttons, on a surface that is sometimes a phone and sometimes a ~320px
 * model sidebar. ⚠️ It did NOT overflow — measured, `scrollWidth === clientWidth` at
 * 390 — because a flex item's automatic minimum size is its min-content width, so the
 * browser shrank the sentence and wrapped it instead. The defect is HEIGHT: six lines
 * of text where the bar should be one strip. An overflow assertion is green on the
 * broken component, which is why the load-bearing test here counts LINES.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 WHY THE `geometry` PROJECT AND NOT `component`
 * ─────────────────────────────────────────────────────────────────────────────
 * Two reasons, and the first alone decides it.
 *
 *  1. THE SWAP IS BUILT FROM TAILWIND CONTAINER-QUERY VARIANTS (`@container`,
 *     `@max-xs:`, `@xs:`, `@max-xs:sr-only`), which exist only where Tailwind's
 *     utilities are loaded. In the `component` tier they are inert — `className="flex"`
 *     computes `display: block` there — so every assertion in this file would be
 *     measuring a component with no responsive behaviour at all.
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
 * cascade non-optional: with the utilities missing, BOTH forms are visible at BOTH
 * widths, which fails the "exactly one" assertions rather than passing them.
 *
 * ⚠️ WHAT THESE DO NOT MEASURE. The swap point itself (480px, the `xs` rung of
 * `src/utils/breakpoints.json` via `theme.containers`) is deliberately NOT probed: both
 * points sit a comfortable distance either side of it, so these tests cannot tell 480
 * from 460. The claim they carry is "the narrow form is what a phone gets and the wide
 * form is what a laptop gets", which is the product claim. The number has one home and
 * nothing restates it, so there is nothing for a second assertion to catch drifting.
 *
 * ⚠️ AND THEY MEASURE THE VIEWPORT AS A PROXY FOR THE CONTAINER. The swap is a
 * CONTAINER query — the notice asks how wide IT is, not how wide the screen is,
 * because the desktop model sidebar is the narrow case that a viewport query gets
 * wrong (see the component's docstring). The fixture renders the notice as a
 * full-width block, so container width tracks viewport width here and the two
 * coincide. The sidebar case is therefore covered by the MECHANISM, not by a
 * measurement in this file.
 *
 * ⚠️ AND THE RED-AT-BASE MATRIX IS AGAINST THE PRE-CHANGE COMPONENT, NOT AGAINST A
 * CLEAN `origin/main` CHECKOUT. Several arms here read nodes that only the new markup
 * renders, so at `origin/main` they fail structurally rather than geometrically. The one
 * arm deliberately built to be measurable on BOTH revisions is the line-count test
 * below, which reads the `<p>` both versions render: six lines before, one after. Say
 * "red against the pre-change component" rather than "red at origin/main".
 */
import { describe, expect, test, vi } from 'vitest';
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
 * The two SWAPPED node groups, each node read on TWO independent axes.
 *
 * 🔴 SELECTED BY `data-form`, NOT BY A CLASS. The swap is now the repo's Tailwind
 * container-query variants (`@max-xs:` / `@xs:`), whose generated class names carry
 * escaped `@` and `:` characters; selecting on those would make the test a claim about
 * a utility spelling. `data-form` is the component's own statement of which half a node
 * belongs to.
 *
 * 🔴 AND IT IS SCOPED TO THOSE NODES, NOT TO "every span in the notice". The first draft
 * read every span and was wrong in the way that matters: Mantine's `Button` wraps its
 * children in `.mantine-Button-inner` / `.mantine-Button-label` spans, which are NOT
 * display:none and whose `textContent` is their hidden child's — so a correctly hidden
 * label still reported as visible text, and the file failed against a working component.
 *
 * 🔴 `visible` IS A RECT, NOT `display !== 'none'`, AND THE DIFFERENCE IS THE WHOLE
 * `sr-only` CASE. Below the rung the long sentence is CLIPPED rather than hidden, so it
 * stays in the accessibility tree — and a display-based reading would score that as
 * "visible" and the narrow form as showing both messages. `sr-only` renders a 1px box;
 * `display: none` renders a 0px one; a real line of text is tens of px wide. The 2px
 * threshold separates the three.
 *
 * ⚠️ THAT 2px THRESHOLD DEPENDS ON THESE SPANS CARRYING NO PADDING, AND THE SIBLING FILE
 * PAID FOR LEARNING SO. `AppsRailHeaderRow.geometry.test.tsx` records that Mantine's
 * `px` style prop lands as an INLINE `padding-inline` which outranks `sr-only`'s
 * `padding: 0`, so a clipped node with a Mantine pad measures ~24px and reads as VISIBLE.
 * The notice's spans are plain `<span>`s with no style props, so the rect genuinely is
 * 1px — but add one and this helper reports a correct component as broken. The
 * screen-reader test therefore also pins the MECHANISM (`position: absolute`), which is
 * padding-independent, so a future failure here is diagnosable rather than just red.
 *
 * 🔴 `announced` READS `getClientRects()`, NOT THE NODE'S OWN `display`. An ancestor's
 * `display: none` removes a node from the accessibility tree while leaving its OWN
 * computed `display` at `inline` — so the node-local reading scored a sentence hidden by
 * a WRAPPER as announced, and the screen-reader test below stayed green on exactly the
 * defect it is named for. A clipped node has one client rect; a node hidden at any depth
 * has none.
 */
function swapNodes() {
  const el = notice().element() as HTMLElement;
  const group = (form: 'wide' | 'narrow') =>
    Array.from(el.querySelectorAll<HTMLElement>(`[data-form="${form}"]`)).map((node) => ({
      node,
      /**
       * Laid out at a size a sighted viewer could read it at. ⚠️ A RECT CANNOT SEE
       * `visibility: hidden` OR `opacity: 0` — those score as visible here. The claim is
       * "it occupies space", not "it is perceivable"; nothing in this component uses
       * either property, and widening to a perceivability check is its own change.
       */
      visible: box(node).width > 2,
      /** In the accessibility tree: rendered at ANY depth, and not hidden from AT. */
      announced: node.getClientRects().length > 0 && node.closest('[aria-hidden="true"]') == null,
      text: (node.textContent ?? '').trim(),
    }));
  return { wide: group('wide'), narrow: group('narrow') };
}

/**
 * Which form is VISIBLE — `'narrow'`, `'wide'`, or a diagnosis.
 *
 * 🔴 IT REPORTS `'both'`, `'neither'` AND `'mixed'` RATHER THAN THROWING, so an
 * assertion against a literal names what actually happened. `'both'` is what a MISSING
 * cascade produces (no variant rules exist, so nothing is hidden); `'neither'` is what
 * an earlier implementation of this component produced (one half hidden unconditionally,
 * the other hidden by the query); `'mixed'` is one node of a pair losing its class.
 * Three different defects that a bare "the short message is visible" check cannot tell
 * apart, and two of which it would pass.
 */
function shownForm(): 'narrow' | 'wide' | 'both' | 'neither' | 'mixed' {
  const { wide, narrow } = swapNodes();
  expect(wide.length, 'no wide-form nodes rendered at all').toBeGreaterThan(0);
  expect(narrow.length, 'no narrow-form nodes rendered at all').toBeGreaterThan(0);
  const allWide = wide.every((n) => n.visible);
  const noWide = wide.every((n) => !n.visible);
  const allNarrow = narrow.every((n) => n.visible);
  const noNarrow = narrow.every((n) => !n.visible);
  if (allWide && noNarrow) return 'wide';
  if (allNarrow && noWide) return 'narrow';
  if (allWide && allNarrow) return 'both';
  if (noWide && noNarrow) return 'neither';
  return 'mixed';
}

/** The text a sighted viewer can read, from the swapped nodes only. */
function visibleTexts(): string[] {
  const { wide, narrow } = swapNodes();
  return [...wide, ...narrow]
    .filter((n) => n.visible)
    .map((n) => n.text)
    .filter(Boolean);
}

/**
 * The RENDERED text inside a control, as the browser computes it.
 *
 * 🔴 THE ORACLE `visibleTexts()` CANNOT BE. That helper is scoped to the nodes carrying
 * `data-form`, which is exactly what makes it blind to a label that LOST its attribute:
 * drop `data-form`/`@max-xs:hidden` from the review button's span and the word renders
 * at 390px while every swap-set assertion stays green, because the node is no longer in
 * the set being read. `innerText` is defined over rendered text — a `display: none`
 * descendant contributes nothing — so it solves the Mantine-wrapper problem that forced
 * the scoping AND sees text that escaped the swap entirely.
 *
 * 🔴 CALL IT ONLY ON A NODE THAT DOES NOT CONTAIN THE CLIPPED SENTENCE. `innerText`
 * skips a `display: none` subtree but NOT an `sr-only` one — clipped text is still
 * rendered text. The two buttons are safe because the sentence lives in the `<p>` the
 * `Text` renders, outside both of them; widen this to the notice element and the narrow
 * `toBe('')` assertions become wrong rather than merely loose.
 */
function renderedLabel(locator: ReturnType<typeof reviewByTestId>): string {
  return ((locator.element() as HTMLElement).innerText ?? '').trim();
}

/**
 * Is the control's SWAP icon actually LAID OUT, rather than merely present in the DOM?
 *
 * 🔴 SELECTED BY `data-form="narrow"`, NOT BY `querySelector('svg')`. The bare form takes
 * the first svg in tree order, which is sound only while the button has exactly one —
 * and Mantine renders `leftSection` / `rightSection` / loading content BEFORE the label,
 * so adding any decorative icon would let a hidden swap icon be satisfied by the wrong
 * element. That is a false green on precisely the mutation this helper exists to kill.
 */
function iconIsRendered(locator: ReturnType<typeof reviewByTestId>): boolean {
  const icon = (locator.element() as HTMLElement).querySelector('svg[data-form="narrow"]');
  return icon != null && box(icon).width > 0;
}

/**
 * How many svgs inside the control are actually LAID OUT — ATTRIBUTE-INDEPENDENT.
 *
 * 🔴 IT EXISTS BECAUSE `iconIsRendered` TRADED ONE BLIND SPOT FOR ANOTHER, AND NEITHER
 * SELECTOR COVERS BOTH. Scoping to `data-form="narrow"` fixed the case where a decorative
 * icon stood in for a hidden swap icon — but it also made the helper unable to SEE an svg
 * outside the swap set, in either direction. Add a `leftSection={<IconInfoCircle />}` to a
 * control and it renders at BOTH widths, while `iconIsRendered()` still returns `false` at
 * 1280 and that arm passes vacuously over a button showing its word AND an unintended
 * glyph. A count sees it; the scoped selector cannot. Assert both.
 */
function laidOutIconCount(locator: ReturnType<typeof reviewByTestId>): number {
  return Array.from((locator.element() as HTMLElement).querySelectorAll('svg')).filter(
    (icon) => box(icon).width > 0
  ).length;
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
    'Tailwind did not load — the whole swap is Tailwind container-query variants'
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

    // 🔴 THE BUTTONS CARRY NO RENDERED WORD, READ OFF `innerText` RATHER THAN OFF THE
    // SWAP SET. `visibleTexts()` only sees nodes carrying `data-form`, which is precisely
    // what makes it blind to a label that LOST the attribute and now renders at 390px —
    // the assertion would pass vacuously on exactly the mutation it is about. `innerText`
    // is the browser's own rendered-text computation and sees it.
    expect(renderedLabel(reviewByTestId()), 'the review button renders a word at 390px').toBe('');
    expect(renderedLabel(dismissByTestId()), 'the dismiss button renders a word at 390px').toBe('');
    for (const label of ['Review permissions', 'Dismiss']) {
      expect(texts, `"${label}" is still in the swap set as visible text`).not.toContain(label);
    }

    // 🔴 AND THE ICON IS LAID OUT, NOT MERELY PRESENT. `querySelectorAll('svg').length > 0`
    // counts the NODE: swap the review icon's variant to the wrong half and the button
    // renders literally nothing at 390px while the count stays 1, the swap set still reads
    // 'narrow', and every other assertion here passes. A rect is the only reading that can
    // tell "the icon stands in for the missing label" from "the icon exists in the DOM".
    expect(
      iconIsRendered(reviewByTestId()),
      'the review button has no RENDERED icon to stand in for its missing label'
    ).toBe(true);
    expect(
      iconIsRendered(dismissByTestId()),
      'the dismiss button has no RENDERED icon to stand in for its missing label'
    ).toBe(true);
    // …and EXACTLY one, counted without reference to the swap attribute — see
    // `laidOutIconCount`. The scoped reading above cannot see a stray icon at all.
    expect(laidOutIconCount(reviewByTestId()), 'the review button renders extra glyphs').toBe(1);
    expect(laidOutIconCount(dismissByTestId()), 'the dismiss button renders extra glyphs').toBe(1);
  });

  test('🔴 the SCREEN READER still hears the full sentence — the swap is visual only', async () => {
    // 🔴 THE HALF A `display: none` SWAP GETS WRONG, AND IT IS NOT VISIBLE IN A
    // SCREENSHOT. Hiding the long sentence outright would remove it from the
    // accessibility tree, leaving an AT user with "Missing permissions" — no app name,
    // no "needs to work fully" — and which of the two announcements they get would
    // depend on a rendered width they cannot perceive. The sentence is therefore
    // CLIPPED (`sr-only`) below the rung rather than hidden, and the short form carries
    // `aria-hidden` so the two are never announced together.
    //
    // This is the claim the `visible` / `announced` split in `swapNodes()` exists for:
    // read on `display` alone, the clipped sentence scores as visible and this whole
    // distinction is invisible.
    const { observed } = await render(PHONE_VIEWPORT);
    expect(observed).toEqual({ width: 390, height: 844 });
    expectCascade();

    const { wide, narrow } = swapNodes();
    const sentence = wide.find((n) => n.text === LONG_MESSAGE);
    const short = narrow.find((n) => n.text === SHORT_MESSAGE);
    expect(sentence, 'the long sentence did not render').toBeTruthy();
    expect(short, 'the short message did not render').toBeTruthy();

    // 🔴 THE MECHANISM, PINNED ALONGSIDE THE EFFECT. `position: absolute` is what `sr-only`
    // does and is independent of padding, so it still diagnoses correctly in the one case
    // the rect reading gets wrong (see `swapNodes()` on the Mantine inline-padding hazard
    // the sibling rail file paid for). It also gives the "`@max-xs:sr-only` deleted
    // outright" mutation a message about THIS claim rather than a bare `'mixed'`.
    expect(
      getComputedStyle(sentence?.node as HTMLElement).position,
      'the sentence is not clipped by `sr-only` — the mechanism changed, not just the result'
    ).toBe('absolute');

    // Announced but not seen…
    expect(sentence?.announced, 'the full sentence left the accessibility tree at 390px').toBe(
      true
    );
    expect(sentence?.visible, 'the full sentence is visible at 390px — it should be clipped').toBe(
      false
    );
    // …and seen but not announced, so exactly ONE of them reaches a screen reader.
    expect(short?.visible).toBe(true);
    expect(short?.announced, 'both messages are announced — the viewer hears it twice').toBe(false);
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

  test('🔴 the icon-only button REVEALS ITS LABEL ON KEYBOARD FOCUS — the tooltip opt-in', async () => {
    // 🔴 THE ONE SIGHTED AFFORDANCE THE NARROW FORM HAS, AND IT WAS PROSE UNTIL NOW.
    // Mantine's `Tooltip` defaults to `{ hover: true, focus: false, touch: false }`, so
    // the component passes an explicit `events` — without which a keyboard or touch user
    // meets an unlabelled glyph on the one control that lets them recover. The component
    // docstring calls that out as "NOT COSMETIC"; deleting the prop turned nothing red,
    // which is what this closes.
    //
    // FOCUS rather than touch, deliberately: it is the arm this harness can drive
    // honestly. Emulating a tap well enough to distinguish "the tooltip opened" from
    // "the click fired" needs pointer-event synthesis this file has no other reason to
    // carry, and `touch` and `focus` are two keys of the same object — a regression that
    // drops one almost certainly drops both.
    //
    // Not a race: `await expect.element` waits for the tooltip to ARRIVE, and the state
    // is absorbing while focus is held, so the 300ms `openDelay` sits far inside the
    // default timeout.
    const { observed } = await render(PHONE_VIEWPORT);
    expect(observed).toEqual({ width: 390, height: 844 });
    expectCascade();

    // 🔴 BOTH CONTROLS, NOT JUST THE REVIEW ONE. `events` is set on two Tooltips and the
    // component's docstring claims it for both; driving only one leaves dropping it from
    // the dismiss Tooltip a silent change. The loop is the whole cost of closing that.
    for (const [label, locator] of [
      ['review', reviewByTestId()],
      ['dismiss', dismissByTestId()],
    ] as const) {
      // Nothing is open before the interaction — otherwise the assertion below is
      // satisfied by a tooltip that is always on screen, or by one left over from the
      // previous iteration.
      await vi.waitFor(() =>
        expect(
          document.querySelectorAll('[role="tooltip"]'),
          `a tooltip was already open before focusing ${label}`
        ).toHaveLength(0)
      );

      const button = locator.element() as HTMLElement;
      button.focus();
      // Attribute the failure: without this, "no tooltip appeared" cannot be told apart
      // from "the focus never landed", and both print the same locator timeout.
      expect(document.activeElement, `focus did not land on the ${label} button`).toBe(button);

      await expect.element(page.getByRole('tooltip')).toBeInTheDocument();
      button.blur();
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

    // The mirror of the narrow block's `innerText` reading: here the words must be
    // RENDERED, and the icons must not. Without this pair, a wide form whose labels
    // escaped the swap set would satisfy every assertion above.
    expect(renderedLabel(reviewByTestId())).toBe('Review permissions');
    expect(renderedLabel(dismissByTestId())).toBe('Dismiss');
    expect(iconIsRendered(reviewByTestId()), 'the swap icon is still laid out at 1280').toBe(false);
    expect(iconIsRendered(dismissByTestId()), 'the swap icon is still laid out at 1280').toBe(
      false
    );
    // 🔴 AND NO GLYPH AT ALL, which is the claim the two assertions above only LOOK like
    // they make: they are scoped to the swap attribute, so an icon outside the swap set is
    // invisible to them and renders at both widths unchallenged.
    expect(laidOutIconCount(reviewByTestId()), 'the review button renders a glyph at 1280').toBe(0);
    expect(laidOutIconCount(dismissByTestId()), 'the dismiss button renders a glyph at 1280').toBe(
      0
    );
  });

  test('⚠️ INVARIANT GUARD — the accessible names are the SAME at both widths', async () => {
    // ⚠️ GREEN ON PRE-CHANGE CODE, so this is not regression coverage: at 1280 the review
    // button's visible text was already `Review permissions` and dismiss already carried
    // `aria-label="Dismiss the missing-permissions notice"`, so both lookups passed.
    //
    // 🔴 THE PAIR IS STILL THE CLAIM. `aria-label` overrides visible text, so a label that
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
    // …and the RENDERED word on the review button is that exact string, not a paraphrase.
    // `innerText`, not `textContent`: the latter concatenates the hidden icon's span too
    // and would keep matching if the wrong half were showing.
    expect(renderedLabel(reviewByTestId())).toBe('Review permissions');
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
