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
import { SecretDisplay } from '~/components/Account/OAuthAppsCard';
// 🔴 `COPY_ICON_SIZE` IS DELIBERATELY NOT IMPORTED. The glyph assertion below pins a literal
// 16: its box is that constant, so importing it would make the measurement check itself.
import { COPY_BODY_PADDING_RIGHT, COPY_CONTROL_SIZE, COPY_ICON_INSET } from './CopyAffordance';

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
 *   · `COPY_BODY_PADDING_RIGHT` — `COPY_ICON_INSET + COPY_CONTROL_SIZE`, applied inline by
 *     every `Code`-block consumer: `CopyableCommand`, `AuthorViaGit`, and the four bodies in
 *     `Account/ApiKeyModal.tsx` and `Account/OAuthAppsCard.tsx`. Introduced *because* a body
 *     once reserved less than the control's width and rendered its text under the icon.
 *
 *     ⚠️ THOSE FOUR DID NOT CARRY IT WHEN THIS LINE FIRST CLAIMED THEY DID. Measured then:
 *     clearance −26px at 390 and at 360 on a routed `Account/` body, with the value's last
 *     characters under the clipboard icon. The claim was made true by adding the padding
 *     rather than by narrowing the sentence, and the `SecretDisplay` block at the bottom of
 *     this file is what holds it true now.
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
 * `COPY_ICON_INSET + COPY_CONTROL_SIZE` in a test would pass against whatever the
 * implementation computes — the textbook vacuous guard. The claim is geometric: the control's
 * border box must not intrude into the body's text content box. That is measured off real
 * rects, so it fails for a wrong constant, a wrong stylesheet, a `p-3` shorthand, a WIDER
 * CONTROL, or a changed inset — every route to the same defect, including the ones nobody has
 * thought of.
 *
 * ⚠️ "A BIGGER ICON" IS NOT ON THAT LIST, THOUGH AN EARLIER DRAFT PUT IT THERE. The glyph
 * sits INSIDE the button, so changing `COPY_ICON_SIZE` moves no box this file measures and
 * the clearance assertions would stay green through it — which is exactly how the four
 * `Account/` controls went from a 24px glyph to a 16px one with nothing reading the number.
 * The glyph is therefore pinned on its own, by `box()` on the rendered `<svg>`, below.
 *
 * ⚠️ AND THE CLEARANCE IS A CLAIM ABOUT A VALUE THAT *FITS*. `<Code block>` computes
 * `white-space: pre` / `text-wrap-mode: nowrap` / `overflow-x: auto`, so a value wider than
 * the content box scrolls instead of wrapping and paints across the right padding —
 * `CopyableCommand`'s own fixture here overflows that way (`scrollWidth` 572 against
 * `clientWidth` 390). A green run means "the body reserves the control's width", never "no
 * value can be under the icon". `COPY_BODY_PADDING_RIGHT`'s own doc carries the same caveat.
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
    // 🔴 THE OTHER HALF OF THE DERIVATION, AND THE ONE NOTHING READ. `COPY_BODY_PADDING_RIGHT`
    // used to spell itself `INSET + ICON_SIZE + 12` and call the 12 breathing room; the
    // control's border box is 28, so that sum was this width re-derived by coincidence. Read
    // the WIDTH off the rendered button and the relation stops depending on either story.
    expect(
      controlBox.width,
      `the control's border box measured ${controlBox.width}px, not COPY_CONTROL_SIZE ` +
        `(${COPY_CONTROL_SIZE}). Mantine's default ActionIcon size moved; the body padding is ` +
        'derived from it, so update the constant rather than the padding.'
    ).toBe(COPY_CONTROL_SIZE);
    expect(
      COPY_BODY_PADDING_RIGHT,
      'the reserved padding is no longer the inset plus the measured control width'
    ).toBe(COPY_ICON_INSET + controlBox.width);
  });
});

/**
 * 🔒 THE FOUR `Account/` CREDENTIAL BODIES — the sites the clearance doc claimed and did not
 * have.
 *
 * `SecretDisplay` is `OAuthAppsCard.tsx`'s props-only registration panel and renders two of
 * the four (`clientId`, `clientSecret`); the rotated secret in the same file and the key in
 * `ApiKeyModal.tsx` are the same `<Code block>` spelling. It is EXPORTED for this file —
 * mounting the other two means driving a tRPC mutation to reach the branch that shows them,
 * and a fixture that re-typed the JSX instead would be measuring the fixture.
 *
 * 🔴 WHY A SECOND BLOCK RATHER THAN A PARAMETER ON THE FIRST. The claim differs: above, one
 * body whose clearance has always held; here, two bodies that measured −26px at both widths
 * until the padding was added, on a panel whose values are a live client secret. A shared
 * loop would report one failure for either.
 */
describe('🔒 the `Account/` credential bodies reserve the control`s width', () => {
  const CLIENT_ID = 'civitai-oauth-client-abcdef0123456789';
  const CLIENT_SECRET = 'cs_7f3a9b1c4d2e8f6a0b5c9d3e7f1a2b4c6d8e0f2a4b6c8d0e2f4a6b8c0d2e4f6a';

  /**
   * The `Code` body belonging to a given control.
   *
   * 🔴 BY STRUCTURE, NOT BY DOCUMENT ORDER. This panel renders two of these, so an
   * index-paired lookup would quietly compare the client ID's control against the secret's
   * body the moment the panel's order changes. `CopyAffordance` renders the control as a
   * SIBLING of the body inside its own `Box`, which is the relationship under test.
   */
  function bodyFor(control: Element): Element {
    const shell = control.parentElement;
    const body = shell?.querySelector('pre[data-block="true"]');
    if (!body) {
      throw new Error(
        'the copy control is not a sibling of a `Code block` body — `CopyAffordance`’s shell ' +
          'changed shape and this file is no longer measuring a pair'
      );
    }
    return body;
  }

  for (const viewport of [PHONE_VIEWPORT, NARROW_PHONE_VIEWPORT] as Viewport[]) {
    test(`at ${viewport.width}x${viewport.height} both credential bodies clear their control`, async () => {
      const { observed } = await renderAtViewport(
        <SecretDisplay
          clientId={CLIENT_ID}
          clientSecret={CLIENT_SECRET}
          onClose={() => undefined}
        />,
        viewport
      );
      expect(observed).toEqual({ width: viewport.width, height: viewport.height });
      assertCascadeIsReal();

      // Both, in one test: the two bodies are different widths of value in the same panel and
      // the defect was identical on each, so a run that measured one would under-report it.
      const bodies = document.querySelectorAll('pre[data-block="true"]');
      expect(
        bodies.length,
        'expected the registration panel to render both credential bodies'
      ).toBe(2);

      for (const label of ['Copy the client ID', 'Copy the client secret']) {
        const control = page.getByRole('button', { name: label });
        await expect.element(control).toBeInTheDocument();
        const body = bodyFor(control.element());

        const gap = clearance(body, control.element());
        expect(
          gap,
          `"${label}" overlaps its credential text by ${-gap}px — that body reserved ` +
            `${getComputedStyle(body).paddingRight} on the right, against the ` +
            `${COPY_BODY_PADDING_RIGHT}px the control needs`
        ).toBeGreaterThanOrEqual(0);
      }
    });
  }

  /**
   * THE GLYPH, PINNED — the rendered-output delta the extraction made at these four controls.
   *
   * Their previous shells rendered a bare `<IconClipboard />`, tabler's default 24, inside the
   * same 28px button; routing them through `CopyAffordance` moved that to `COPY_ICON_SIZE`.
   * Nothing in any tier read a glyph size, so it moved silently. The BUTTON box is asserted
   * alongside it because that is the click target, and it did NOT move — the two numbers
   * together are the whole of what changed and what did not.
   */
  test('the credential control renders a 16px glyph in a `COPY_CONTROL_SIZE` button', async () => {
    const { observed } = await renderAtViewport(
      <SecretDisplay clientId={CLIENT_ID} clientSecret={CLIENT_SECRET} onClose={() => undefined} />
    );
    expect(observed).toEqual({ width: 390, height: 844 });
    assertCascadeIsReal();

    const control = page.getByRole('button', { name: 'Copy the client secret' });
    await expect.element(control).toBeInTheDocument();
    const button = control.element();

    const glyph = button.querySelector('svg');
    if (!glyph) throw new Error('the copy control rendered no glyph at all');
    const glyphBox = box(glyph);
    // 🔴 A LITERAL 16, NOT `COPY_ICON_SIZE`, AND THE FIRST DRAFT GOT THIS WRONG. The glyph's
    // box IS `size={COPY_ICON_SIZE}` on the tabler icon, so comparing the measurement to that
    // constant is the implementation checking itself: measured, setting the constant to 24
    // left this test GREEN at 24x24. A literal is what makes 16 a decision rather than a
    // restatement, and 24 — tabler's default, what these four controls rendered before the
    // extraction — is the value it has to be able to see.
    expect(
      [glyphBox.width, glyphBox.height],
      `the glyph measured ${glyphBox.width}x${glyphBox.height}, not 16x16. 24 is tabler's ` +
        'default and what these four credential controls rendered before the extraction — a ' +
        'change here is a visible change to a credential affordance, not a refactor. If it is ' +
        'deliberate, move this literal and say so in the PR body.'
    ).toEqual([16, 16]);

    // The BUTTON box is a different kind of claim and is NOT vacuous: nothing passes a size to
    // `LegacyActionIcon`, so 28 comes from Mantine's default and `COPY_CONTROL_SIZE` is this
    // repo's record of it. A Mantine default-size change reds here — and must, because
    // `COPY_BODY_PADDING_RIGHT` is derived from the constant.
    const buttonBox = box(button);
    expect(
      [buttonBox.width, buttonBox.height],
      `the control's border box measured ${buttonBox.width}x${buttonBox.height}, not ` +
        `COPY_CONTROL_SIZE (${COPY_CONTROL_SIZE})`
    ).toEqual([COPY_CONTROL_SIZE, COPY_CONTROL_SIZE]);
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
