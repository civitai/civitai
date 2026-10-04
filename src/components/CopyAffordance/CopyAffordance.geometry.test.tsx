import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import {
  NARROW_PHONE_VIEWPORT,
  PHONE_VIEWPORT,
  box,
  cascadeEvidence,
  renderAtViewport,
  type Viewport,
} from '../../../test/geometry-setup';
import {
  AgentOnboardingCard,
  AGENT_COPY_LABEL,
  AGENT_PROMPT_TESTID,
} from '~/components/Apps/AgentOnboardingCard';
import { CopyableCommand } from '~/components/Apps/CopyableCommand';
import { COPY_BODY_PADDING_RIGHT, COPY_ICON_INSET } from './CopyAffordance';

/**
 * 🔒 THE COPY CONTROL DOES NOT SIT ON TOP OF THE TEXT IT COPIES.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS PINS, AND WHY IT NEEDED A NEW FILE
 * ─────────────────────────────────────────────────────────────────────────────
 * `CopyAffordance` positions its control absolutely at the body's right edge, so the body
 * has to reserve clearance for it. There are exactly TWO spellings of that clearance and
 * both have already been wrong in production:
 *
 *   · `COPY_BODY_PADDING_RIGHT` — `COPY_ICON_INSET + COPY_ICON_SIZE + 12`, applied inline by
 *     every `Code`-block consumer (`CopyableCommand`, `AuthorViaGit`, `ApiKeyModal`,
 *     `OAuthAppsCard`). Introduced *because* a body once reserved less than the control's
 *     width and rendered its text under the icon.
 *   · `.prompt { padding-right: 2.75rem }` in `~/components/Apps/AgentOnboardingCard.module.scss`,
 *     for the prose panel whose control sits top-right rather than right-middle. That one
 *     shipped broken — a Tailwind `p-3` shorthand on the same element reset the right padding
 *     to 0.75rem and the clipboard icon landed on the first line's last word ("then tell
 *     m[icon]"). It was caught by a dark/light Ladle screenshot pass, by eye.
 *
 * 🔴 NEITHER WAS MEASURED BY ANYTHING. A mutation making `COPY_BODY_PADDING_RIGHT` wrong
 * SURVIVED a 54-assertion sweep, twice, across three browser suites: every assertion in them
 * reads the accessibility tree, an attribute, or the clipboard, and none reads a box. A
 * constant nothing reads is a comment.
 *
 * 🔴 WHAT IS ASSERTED IS THE CLAIM, NOT THE ARITHMETIC. Re-deriving
 * `COPY_ICON_INSET + COPY_ICON_SIZE + 12` in a test would pass against whatever the
 * implementation computes — the textbook vacuous guard. The claim is geometric: the control's
 * border box must not intrude into the body's text content box. That is measured off real
 * rects, so it fails for a wrong constant, a wrong stylesheet, a `p-3` shorthand, a bigger
 * icon, or a changed inset — every route to the same defect, including the ones nobody has
 * thought of.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 WHY THE `geometry` PROJECT
 * ─────────────────────────────────────────────────────────────────────────────
 * `position: absolute` on the control comes from the Tailwind `absolute` utility, which is
 * INERT in the `component` tier (that tier injects `:root` custom properties only). Without
 * it the control is statically positioned, lands after the body in flow, and can never
 * overlap anything — so the assertion below would pass unconditionally, against a layout
 * production never renders. See `test/geometry-setup.tsx`. The `geometry` job in
 * `.github/workflows/lint.yml` reports on a PR and blocks on a push to `main`.
 */

/** A command long enough to wrap and reach the control at any phone width. */
const LONG_COMMAND = 'npm install -g @civitai/cli && civitai app create my-very-long-app-name';

/**
 * The right edge of an element's TEXT CONTENT box — its border box minus the right padding
 * and right border. `getBoundingClientRect()` is the BORDER box, so comparing that to the
 * control's rect would report an overlap on every correctly-padded body: the padding is
 * exactly the clearance under test.
 */
function textContentRight(el: Element): number {
  const s = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return (
    Math.round((r.right - parseFloat(s.paddingRight) - parseFloat(s.borderRightWidth)) * 100) / 100
  );
}

/**
 * The gap between where the body's text may reach and where the control begins. Positive is
 * clearance, zero is flush, NEGATIVE is the defect — text rendered underneath the icon.
 *
 * Returned rather than asserted, so each test states its own expectation and the measured
 * number appears in the failure message. A helper that both measures and judges is one
 * nobody can watch fail.
 */
function clearance(body: Element, control: Element): number {
  return Math.round((box(control).left - textContentRight(body)) * 100) / 100;
}

/**
 * The `Code block` body, located and asserted present in one place.
 *
 * 🔴 `pre[data-block]`, NOT `code`. Mantine 7's `<Code block>` renders a `<pre>` — there is no
 * `<code>` element in the tree at all, so a `querySelector('code')` returns `null` and every
 * measurement below becomes a `TypeError` rather than a verdict. Measured, not assumed.
 */
function codeBody(): Element {
  const el = document.querySelector('pre[data-block="true"]');
  if (!el) throw new Error('no `Code block` body rendered — the fixture did not mount');
  return el;
}

/**
 * The agent prompt's padded text element — the `<p>` inside the panel.
 *
 * Scoped by the prompt's own exported testid, because the card renders a second `<p>` (the
 * subtitle) as a sibling one level up, and that one carries no clearance.
 */
function promptBody(): Element {
  const scope = document.querySelector(`[data-testid="${AGENT_PROMPT_TESTID}"]`);
  if (!scope) throw new Error('the agent prompt did not mount');
  const paragraphs = scope.querySelectorAll('p');
  if (paragraphs.length !== 1) {
    throw new Error(
      `expected exactly one paragraph inside the prompt panel, found ${paragraphs.length} — ` +
        'the selector no longer identifies the padded element'
    );
  }
  return paragraphs[0];
}

/** The harness's own positive control — these values are impossible without the cascade. */
function assertCascadeIsReal() {
  const evidence = cascadeEvidence();
  expect(evidence.ruleCount, 'the real stylesheet did not load').toBeGreaterThan(1000);
  expect(evidence.tailwindFlexUtilityResolves, 'Tailwind utilities are inert here').toBe(true);
  expect(evidence.probeBoxSizing).toBe('border-box');
}

describe('🔒 a `Code`-block body reserves the control`s width — `COPY_BODY_PADDING_RIGHT`', () => {
  for (const viewport of [PHONE_VIEWPORT, NARROW_PHONE_VIEWPORT] as Viewport[]) {
    // Two widths, because the body wraps and the control does not: a clearance that holds at
    // 390 and not at 360 is a real defect, and one measurement could not tell.
    test(`at ${viewport.width}x${viewport.height} the control clears the command text`, async () => {
      const { observed } = await renderAtViewport(
        <CopyableCommand command={LONG_COMMAND} />,
        viewport
      );
      expect(observed).toEqual({ width: viewport.width, height: viewport.height });
      assertCascadeIsReal();

      const control = page.getByRole('button', { name: `Copy command: ${LONG_COMMAND}` });
      await expect.element(control).toBeInTheDocument();
      const code = codeBody();

      const gap = clearance(code, control.element());
      expect(
        gap,
        `the copy control overlaps the command text by ${-gap}px — the body reserved ` +
          `${getComputedStyle(code).paddingRight} on the right`
      ).toBeGreaterThanOrEqual(0);
    });
  }

  /**
   * POSITIVE CONTROL FOR THE ASSERTION ABOVE. A non-negative gap is also what an unstyled
   * body would report if the control were never absolutely positioned (it would follow the
   * body in flow, far to its right) — so prove the control is actually INSIDE the body's
   * border box and only clear of its text, which is the whole geometry under test.
   */
  test('POSITIVE CONTROL: the control sits INSIDE the body`s border box', async () => {
    const { observed } = await renderAtViewport(<CopyableCommand command={LONG_COMMAND} />);
    expect(observed).toEqual({ width: 390, height: 844 });
    assertCascadeIsReal();

    const control = page.getByRole('button', { name: `Copy command: ${LONG_COMMAND}` });
    await expect.element(control).toBeInTheDocument();
    const code = codeBody();

    const controlBox = box(control.element());
    const bodyBox = box(code);
    expect(getComputedStyle(control.element()).position).toBe('absolute');
    expect(controlBox.right).toBeLessThanOrEqual(bodyBox.right);
    expect(controlBox.left).toBeGreaterThan(bodyBox.left);
    // And the reserved padding is the thing creating the gap, not an accident of wrapping.
    expect(parseFloat(getComputedStyle(code).paddingRight)).toBe(COPY_BODY_PADDING_RIGHT);
    // The inset the clearance is derived FROM, read off the rendered control rather than
    // restated: a change to it that did not reach the padding is the documented failure.
    expect(bodyBox.right - controlBox.right).toBeCloseTo(COPY_ICON_INSET, 0);
  });
});

describe('🔒 the agent prompt`s prose panel reserves its control`s width — the SCSS spelling', () => {
  for (const viewport of [PHONE_VIEWPORT, NARROW_PHONE_VIEWPORT] as Viewport[]) {
    test(`at ${viewport.width}x${viewport.height} the control clears the prompt text`, async () => {
      // `animated={false}`: the static tree, so no `LazyMotion` chunk has to resolve before
      // the layout settles. The panel's padding is identical in both trees — the stylesheet
      // does not branch on motion — and this is the same code path reduced motion takes.
      const { observed } = await renderAtViewport(
        <AgentOnboardingCard tone="prominent" animated={false} />,
        viewport
      );
      expect(observed).toEqual({ width: viewport.width, height: viewport.height });
      assertCascadeIsReal();

      const control = page.getByRole('button', { name: AGENT_COPY_LABEL });
      await expect.element(control).toBeInTheDocument();

      // The prompt `Text`, which is the element the stylesheet pads — not the panel around it.
      const prompt = promptBody();

      const gap = clearance(prompt, control.element());
      expect(
        gap,
        `the copy control overlaps the prompt text by ${-gap}px — the panel reserved ` +
          `${getComputedStyle(prompt).paddingRight} on the right. A Tailwind ` +
          '`p-3` shorthand on this element is the known cause.'
      ).toBeGreaterThanOrEqual(0);
    });
  }
});
