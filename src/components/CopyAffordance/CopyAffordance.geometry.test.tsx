import { afterEach, describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import {
  NARROW_PHONE_VIEWPORT,
  PHONE_VIEWPORT,
  box,
  cascadeEvidence,
  nextLayout,
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
//
// 🔴 NOR IS `COPY_BODY_PADDING_RIGHT`, ANY LONGER, AND FOR A DIFFERENT REASON: it is now a
// `rem()` CSS STRING rather than a number, so there is nothing to compare a px measurement
// against. Every assertion over it below reads the RENDERED `padding-right` instead, which is
// the stronger claim anyway — it holds at whatever root font size the test runs at.
import { COPY_CONTROL_SIZE, COPY_ICON_INSET } from './CopyAffordance';
import {
  CollectionInviteLink,
  INVITE_LINK_COPY_LABEL,
  INVITE_LINK_TESTID,
} from '~/components/Collections/CollectionInviteLink';
// 🔴 `INVITE_LINK_ICON_INSET` IS DELIBERATELY NOT IMPORTED — and as of this PR it is not even
// EXPORTED, so the convention is now structural. It is BOTH the control's `right=` prop and a
// term in the padding derived from it, so an assertion naming it would be the implementation
// checking itself on both sides. The invite-link block below relates the RENDERED padding to
// the RENDERED inset and the RENDERED control width instead.
//
// ⚠️ THAT BLOCK DOES NAME `COPY_ICON_INSET`, AND AN EARLIER WORDING HERE SAID IT NAMED NO
// REPO-OWNED CONSTANT AT ALL. It names it as a value to EXCLUDE (`.not.toBeCloseTo`), never as
// an expectation — a different thing, but not "none". `COPY_CONTROL_SIZE` is named as an
// expectation, and that one the cascade produces rather than this repo.

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
 *   · `COPY_BODY_PADDING_RIGHT` — `rem(COPY_ICON_INSET + COPY_CONTROL_SIZE)`, applied inline by
 *     every `Code`-block consumer: `CopyableCommand`, `AuthorViaGit`, and the four bodies in
 *     `Account/ApiKeyModal.tsx` and `Account/OAuthAppsCard.tsx`. Introduced *because* a body
 *     once reserved less than the control's width and rendered its text under the icon, and
 *     `rem()`-ified because a raw number stopped tracking a rem-scaled control above a 16px
 *     root font size — the second spelling of the same defect. Both are measured below.
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

/**
 * A command long enough to OVERFLOW the body at any phone width.
 *
 * ⚠️ NOT "long enough to wrap", which is what this line said and what the header's ⚠️ "A CLAIM
 * ABOUT A VALUE THAT *FITS*" caveat refutes: `<Code block>` is `pre`/`nowrap`/`overflow-x: auto`,
 * and for THIS fixture `scrollWidth` is 572 against a `clientWidth` of 390. It scrolls.
 *
 * (Named rather than cited by line. Both cross-references here used to read `:67`, which is a
 * blank comment line — the paragraph moved and the number did not. A line citation inside the
 * file that contains it goes stale on the next edit; a quoted heading does not.)
 */
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

/**
 * The harness's own positive control — these values are impossible without the cascade.
 *
 * 🔴 THE ROOT FONT SIZE IS ONE OF THEM, AND IT WAS COLLECTED BUT NEVER ASSERTED.
 * `cascadeEvidence()` has returned `htmlFontSize` all along; nothing read it, so every
 * clearance number in this file was a measurement at whatever R the browser happened to
 * default to, quoted as if it were unconditional. It is not unconditional: `rem` units in the
 * cascade scale with R, and a clearance built out of a mix of rem and px terms moves with it.
 * Naming the expected value here is what gives each measurement its own scope — and in the
 * root-font-size block at the bottom it doubles as proof the override actually took effect.
 */
function assertCascadeIsReal(expectedRootFontSize = '16px') {
  const evidence = cascadeEvidence();
  expect(evidence.ruleCount, 'the real stylesheet did not load').toBeGreaterThan(1000);
  expect(evidence.tailwindFlexUtilityResolves, 'Tailwind utilities are inert here').toBe(true);
  expect(evidence.probeBoxSizing).toBe('border-box');
  expect(
    evidence.htmlFontSize,
    `the root font size is ${evidence.htmlFontSize}, not ${expectedRootFontSize} — every ` +
      'px clearance measured in this file is a claim at a particular root font size, because ' +
      'the cascade around it is in rem'
  ).toBe(expectedRootFontSize);
}

describe('🔒 a `Code`-block body reserves the control`s width — `COPY_BODY_PADDING_RIGHT`', () => {
  for (const viewport of [PHONE_VIEWPORT, NARROW_PHONE_VIEWPORT] as Viewport[]) {
    // Two widths, because a cascade is not obliged to be width-invariant: these two pin that
    // nothing in it BECOMES width-dependent — a `max-width` media query on the body's padding,
    // a breakpoint that changes the control's size.
    //
    // ⚠️ THEY CANNOT DISCRIMINATE A WIDTH-DEPENDENT CLEARANCE IN *THIS* GEOMETRY, AND THE
    // EARLIER RATIONALE HERE ("the body wraps and the control does not: a clearance that holds
    // at 390 and not at 360 is a real defect") CLAIMED THEY COULD. The body does not wrap —
    // see `LONG_COMMAND`'s doc and the header's *FITS* caveat — and the measured clearance
    // contains no viewport term at all: it is `bodyPaddingRight − inset − controlWidth`, three
    // constants. The numbers say so
    // too, which is the part worth noticing before trusting a pair of measurements: −26px at
    // BOTH widths before the padding was added, 0.00px at both after. Two pairs of identical
    // numbers is what width-invariance looks like, not what a discriminating matrix looks like.
    // The axis this geometry IS sensitive to is the root font size, and it took its own case
    // at the bottom of this file.
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
    expect(parseFloat(getComputedStyle(code).paddingRight)).toBe(
      COPY_ICON_INSET + COPY_CONTROL_SIZE
    );
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
    // 🔴 THE RELATION, BETWEEN TWO RENDERED NUMBERS — NOT BETWEEN TWO CONSTANTS. This line used
    // to read `expect(COPY_BODY_PADDING_RIGHT).toBe(COPY_ICON_INSET + controlBox.width)`, which
    // compared a number the module computed against a measurement; it can no longer, because
    // `COPY_BODY_PADDING_RIGHT` is now a `rem()` CSS STRING (see its doc — the control's box is
    // rem-scaled, so a px padding de-synchronises above a 16px root font size). Comparing the
    // RENDERED padding to the RENDERED control width is both unit-agnostic and the stronger
    // claim: it holds at whatever root font size the harness is at.
    expect(
      parseFloat(getComputedStyle(code).paddingRight),
      'the reserved padding is no longer the inset plus the measured control width'
    ).toBeCloseTo(COPY_ICON_INSET + controlBox.width, 1);
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
            `${box(control.element()).width + COPY_ICON_INSET}px the control needs`
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

/**
 * 🔒 THE CLEARANCE IS UNIT-SYMMETRIC — IT SURVIVES A NON-DEFAULT ROOT FONT SIZE.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS PINS
 * ─────────────────────────────────────────────────────────────────────────────
 * The clearance is a difference of three terms, and TWO of them scale with the root font
 * size while one did not:
 *
 *   · `COPY_ICON_INSET` is passed as Mantine's `right=` STYLE PROP. `right` is
 *     `{type: 'size'}` in `core/Box/style-props/style-props-data.cjs`, so the number goes
 *     through `sizeResolver` → `rem()` and renders `calc(0.5rem * var(--mantine-scale))`.
 *     SCALES: 0.5·R.
 *   · the control's BORDER BOX is `--ai-size-md`, which in the bundle this app imports
 *     (`@mantine/core/styles.layer.css`, per `src/pages/_app.tsx`) is
 *     `calc(1.75rem * var(--mantine-scale))`. SCALES: 1.75·R. 🔴 THE PER-COMPONENT FILE
 *     `@mantine/core/styles/ActionIcon.css` DECLARES A LITERAL `28px` AND IS NOT IN THIS
 *     CASCADE — reading it is exactly how this term got recorded as fixed. Measured here:
 *     **35px at R=20**, which is 1.75 × 20.
 *   · `COPY_BODY_PADDING_RIGHT` reached each body as a raw NUMBER in a React inline style,
 *     so `36px`. DID NOT SCALE.
 *
 * So the clearance was `36 − 2.25R`: exactly 0 at R=16 — which is what every other
 * measurement in this file reports, and why nothing noticed — and NEGATIVE at every larger
 * R: **−9px at R=20, −18px at R=24**, with the tail of a credential rendered under the
 * clipboard icon. Nothing pins R. `src/styles/globals.css` declares no `html { font-size }`
 * (its only 16px is inside an iOS `input:focus` media query) and nothing overrides
 * `--mantine-scale`, so a reader who has set a browser font-size preference got the defect.
 *
 * The fix is `COPY_BODY_PADDING_RIGHT = rem(…)` — Mantine's own converter, the same one the
 * inset's style prop calls — so `2.25rem` tracks `0.5rem + 1.75rem` by construction. Forcing
 * the other two to px instead would have fought the cascade in the wrong direction: the
 * control growing with the root font size is the ACCESSIBILITY behaviour, not the bug.
 *
 * 🔴 WHY THIS AXIS NEEDED ITS OWN BLOCK RATHER THAN A THIRD VIEWPORT. The two widths above
 * cannot see it: the clearance has no viewport term, which their own numbers show (−26px at
 * both widths before the body padding existed, 0.00px at both after). R is a different
 * dimension, the harness pinned it implicitly at the browser default, and a suite whose
 * config pins a dimension is structurally blind to that dimension's bugs.
 *
 * ⚠️ ONE VIEWPORT HERE, DELIBERATELY. Width-invariance is what the blocks above establish;
 * repeating it would add runs without adding a claim. What this block varies is R.
 */
describe('🔒 the clearance survives a non-default root font size', () => {
  /**
   * A root font size a real browser produces, not a stress value.
   *
   * 20px is Chrome/Firefox's "Large" font-size setting. It also OVERSHOOTS rather than sitting
   * on a boundary: the pre-fix clearance here is −9px, so the assertion fails on the defect's
   * own magnitude rather than on a rounding argument about zero. And 20/16 = 1.25 is not a
   * whole multiple of any term, so a term that quietly stayed px cannot coincide with one that
   * scaled.
   */
  const ROOT_FONT_SIZE = '20px';
  const SCALE = 20 / 16;

  afterEach(() => {
    document.documentElement.style.removeProperty('font-size');
  });

  /**
   * Each of the three terms, measured against its OWN expected value at this root font size.
   *
   * 🔴 THE DEFECT IS A DISAGREEMENT BETWEEN THE TERMS, NOT A WRONG VALUE IN ANY ONE — every
   * term was individually defensible and the MIX was the bug. So a bare `clearance < 0` cannot
   * say which one stopped tracking, and these three can: each names itself. `SCALE` is applied
   * to constants this repo owns, compared against numbers the browser resolved out of Mantine's
   * stylesheet, so none of them is the implementation checking itself.
   *
   * 🔴 CALLED **AFTER** THE CLEARANCE ASSERTION, AND BOTH ORDERS WERE WATCHED TO FAIL — BUT
   * ONLY ONE OF THE TWO MESSAGES IS REACHABLE AS SHIPPED, AND THAT QUALIFIER WAS MISSING.
   * Under the pre-fix spelling (`COPY_BODY_PADDING_RIGHT` as a raw number) each assertion goes
   * red on its own terms *when it runs first*: the clearance reports `expected -9 to be greater
   * than or equal to 0` with the three measured values in its message, and the padding term
   * reports `expected 36 to be close to 45`. Only one of the two can report per run, so the
   * clearance — the actual claim — goes first, which means the `36 … 45` message is
   * reproducible ONLY by swapping these two lines. Re-measured both ways: shipped order, both
   * R=20 tests fail on the clearance; swapped, both fail on the term. Do not quote the term
   * message as an observation about the shipped guard.
   *
   * These are NOT a restatement of it, and that was measured rather than argued: under
   * `rem(2 * (COPY_ICON_INSET + COPY_CONTROL_SIZE))` the gap stays comfortably positive at
   * every R, both clearance assertions pass, and this helper is still reached and still goes
   * red (`expected 90 to be close to 45`). A padding that is too LARGE breaks the derivation
   * the constants exist to express and the clearance cannot see it.
   *
   * ⚠️ THAT COMPENSATING MUTANT ALSO REDS A THIRD TEST, AND AN EARLIER RECORD OF IT SAID
   * OTHERWISE BY OMISSION. The R=16 `POSITIVE CONTROL` block's derivation line fails too
   * (`expected 72 to be 36`), so the whole-file run is **3 failed / 8 passed**, not the two
   * failures the term check accounts for. "Both clearance assertions pass" is a true sentence
   * about the clearance assertions and a wrong answer about the run.
   */
  function assertAllThreeTermsScaleTogether(body: Element, control: Element) {
    expect(
      parseFloat(getComputedStyle(control).right),
      'the control`s inset stopped tracking the root font size. It is Mantine`s `right=` style ' +
        'prop, which rem-ifies via `sizeResolver` → `rem()`; a raw px value here would ' +
        'de-synchronise it from the control`s own rem-scaled border box'
    ).toBeCloseTo(COPY_ICON_INSET * SCALE, 1);
    expect(
      parseFloat(getComputedStyle(body).paddingRight),
      'the body`s reserved padding is not the inset plus the control at this root font size. ' +
        'Too SMALL means it stopped scaling — the exact defect `COPY_BODY_PADDING_RIGHT = ' +
        'rem(…)` fixed, since a raw NUMBER in the consumer`s `style={{ paddingRight }}` ' +
        'renders fixed px while the control keeps growing. Too LARGE means the derivation ' +
        'drifted; the clearance assertion above cannot see that one, which is why this runs'
    ).toBeCloseTo((COPY_ICON_INSET + COPY_CONTROL_SIZE) * SCALE, 1);
    expect(
      box(control).width,
      'the control`s border box is not the rem-scaled `--ai-size-md`. If this reports a flat ' +
        '28 the cascade changed to the per-component `styles/ActionIcon.css` spelling, and ' +
        '`COPY_BODY_PADDING_RIGHT` should go back to a plain number'
    ).toBeCloseTo(COPY_CONTROL_SIZE * SCALE, 1);
  }

  test(`at a ${ROOT_FONT_SIZE} root font size the credential bodies still clear their control`, async () => {
    document.documentElement.style.fontSize = ROOT_FONT_SIZE;
    const { observed } = await renderAtViewport(
      <SecretDisplay
        clientId="civitai-oauth-client-abcdef0123456789"
        clientSecret="cs_7f3a9b1c4d2e8f6a0b5c9d3e7f1a2b4c6d8e0f2a4b6c8d0e2f4a6b8c0d2e4f6a"
        onClose={() => undefined}
      />
    );
    expect(observed).toEqual({ width: 390, height: 844 });
    // Doubles as the positive control for the override: if the `font-size` write did not take,
    // this reports 16px and the test below would be measuring R=16 all over again.
    assertCascadeIsReal(ROOT_FONT_SIZE);

    for (const label of ['Copy the client ID', 'Copy the client secret']) {
      const control = page.getByRole('button', { name: label });
      await expect.element(control).toBeInTheDocument();
      const shell = control.element().parentElement;
      const body = shell?.querySelector('pre[data-block="true"]');
      if (!body) throw new Error(`"${label}" is not a sibling of a \`Code block\` body`);

      const gap = clearance(body, control.element());
      expect(
        gap,
        `at a ${ROOT_FONT_SIZE} root font size "${label}" overlaps its credential text by ` +
          `${-gap}px. The body reserved ${getComputedStyle(body).paddingRight} and the ` +
          `control sits ${getComputedStyle(control.element()).right} from the right at ` +
          `${box(control.element()).width}px wide — a clearance that holds at 16px and not ` +
          'here means those three are not all in the same unit.'
      ).toBeGreaterThanOrEqual(0);
      assertAllThreeTermsScaleTogether(body, control.element());
    }
  });

  test(`at a ${ROOT_FONT_SIZE} root font size the command body still clears its control`, async () => {
    document.documentElement.style.fontSize = ROOT_FONT_SIZE;
    const { observed } = await renderAtViewport(<CopyableCommand command={LONG_COMMAND} />);
    expect(observed).toEqual({ width: 390, height: 844 });
    assertCascadeIsReal(ROOT_FONT_SIZE);

    const control = page.getByRole('button', { name: `Copy command: ${LONG_COMMAND}` });
    await expect.element(control).toBeInTheDocument();
    const code = codeBody();

    const gap = clearance(code, control.element());
    expect(
      gap,
      `at a ${ROOT_FONT_SIZE} root font size the copy control overlaps the command text by ` +
        `${-gap}px — the body reserved ${getComputedStyle(code).paddingRight} and the control ` +
        `sits ${getComputedStyle(control.element()).right} from the right`
    ).toBeGreaterThanOrEqual(0);
    assertAllThreeTermsScaleTogether(code, control.element());
  });

  /**
   * 🔴 THE SECOND SPELLING, ON THE SAME AXIS — AND THE ONE THE TWO CASES ABOVE CANNOT REACH.
   *
   * Everything above measures bodies whose clearance comes from `COPY_BODY_PADDING_RIGHT`.
   * `AgentOnboardingCard`'s prose panel reserves its own in
   * `~/components/Apps/AgentOnboardingCard.module.scss` (`.prompt { padding-right: 2.75rem }`),
   * which `CopyAffordance`'s own doc calls "a SECOND spelling of the same idea" — and until
   * this case it was measured at a 16px root font size ONLY, by the block above this one. That
   * is exactly the blind spot `COPY_BODY_PADDING_RIGHT` had: a clearance correct at R=16 and
   * de-synchronised above it, invisible to every viewport.
   *
   * 🔴 WHY THE CLEARANCE ASSERTION ALONE CANNOT CARRY THIS CASE — MEASURED, AND IT CONTRADICTS
   * THE ARITHMETIC THAT MOTIVATED THIS CASE. Planting the de-rem-ified form
   * (`padding-right: 44px`, byte-identical rendering at R=16) and reading the gap off this
   * fixture at three root font sizes gives **9px at R=16, exactly 0.00px at R=20, −9px at
   * R=24** — not the −1px at R=20 the three-term derivation predicts. The missing term is the
   * `.panel` wrapper's own **1px border**, which is px and sits between the prompt's border box
   * and the control's containing block: the real figure is `44 − 0.5·R − 1.75·R + 1`. So at
   * R=20 the defect is FLUSH, `toBeGreaterThanOrEqual(0)` passes, and an overlap-only
   * assertion at this block's R would have let the mutant through — the discriminating claim
   * has to be the second one below: the reserved padding must still TRACK the root font size.
   * A px value cannot, and says so at every R. (Shipped, for scope: 9px at R=16 → 11px at
   * R=20, reserved 44px → 55px.)
   *
   * ⚠️ `assertAllThreeTermsScaleTogether` IS DELIBERATELY NOT REUSED. Its middle term expects
   * `(COPY_ICON_INSET + COPY_CONTROL_SIZE) * SCALE` — 45px — and this panel reserves 2.75rem,
   * i.e. 55px at R=20, half a rem of deliberate breathing room more than the minimum. Calling
   * it here would red on the correct stylesheet.
   *
   * 🔴 ONE RENDER, R VARIED ON THE MOUNTED TREE. The reference measurement is taken at the
   * harness's default R=16 and the override is then applied to the SAME elements, so the two
   * numbers differ in the root font size and in nothing else — no second mount, no second
   * fixture, and no stylesheet number restated as an expectation.
   */
  test(`at a ${ROOT_FONT_SIZE} root font size the prose panel still clears its control`, async () => {
    // `animated={false}` for the same reason as the R=16 case: the static tree settles without
    // a `LazyMotion` chunk, and the stylesheet does not branch on motion.
    const { observed } = await renderAtViewport(
      <AgentOnboardingCard tone="prominent" animated={false} />
    );
    expect(observed).toEqual({ width: 390, height: 844 });
    // The reference point, asserted: R=16 is the harness default and the scope of every
    // measurement the block above this one took.
    assertCascadeIsReal();

    const control = page.getByRole('button', { name: AGENT_COPY_LABEL });
    await expect.element(control).toBeInTheDocument();
    const prompt = promptBody();
    const reservedAtDefaultR = parseFloat(getComputedStyle(prompt).paddingRight);
    const gapAtDefaultR = clearance(prompt, control.element());

    document.documentElement.style.fontSize = ROOT_FONT_SIZE;
    await nextLayout();
    // Doubles as the positive control for the override: without it this reports 16px and
    // everything below would be a second measurement at the root font size already taken.
    assertCascadeIsReal(ROOT_FONT_SIZE);

    const gap = clearance(prompt, control.element());
    expect(
      gap,
      `at a ${ROOT_FONT_SIZE} root font size the copy control overlaps the prompt text by ` +
        `${-gap}px — the panel reserved ${getComputedStyle(prompt).paddingRight} on the right ` +
        `while the control sits ${getComputedStyle(control.element()).right} from the edge at ` +
        `${box(control.element()).width}px wide. A Tailwind \`p-3\` shorthand on this element ` +
        'is the known cause of a clearance that is wrong at EVERY root font size.'
    ).toBeGreaterThanOrEqual(0);

    expect(
      parseFloat(getComputedStyle(prompt).paddingRight),
      `the prose panel's reserved padding did not track the root font size: ` +
        `${reservedAtDefaultR}px at 16px and ${parseFloat(
          getComputedStyle(prompt).paddingRight
        )}px at ${ROOT_FONT_SIZE}, where a rem value would read ` +
        `${reservedAtDefaultR * SCALE}px. ` +
        '`.prompt { padding-right }` in `~/components/Apps/AgentOnboardingCard.module.scss` is ' +
        'de-rem-ified — a px value there holds at a 16px root font size and then stops growing ' +
        'while the control keeps growing (0.5rem inset + 1.75rem border box). The clearance ' +
        `above cannot see it at ${ROOT_FONT_SIZE}: the \`.panel\` wrapper's 1px border lands ` +
        'the gap on exactly 0.00px there — measured — and it only reads as an overlap by R=24 ' +
        '(−9px).'
    ).toBeCloseTo(reservedAtDefaultR * SCALE, 1);

    // And the slack is rem too, so it GROWS with R rather than merely surviving. This is the
    // panel's half-rem of breathing room above the minimum, measured rather than restated.
    expect(
      gap,
      `the prose panel's clearance SHRANK across the root-font-size axis — ${gapAtDefaultR}px ` +
        `at 16px, ${gap}px at ${ROOT_FONT_SIZE}. The panel reserves half a rem more than the ` +
        'control needs, so a correctly rem-expressed clearance widens here.'
    ).toBeGreaterThan(gapAtDefaultR);
  });
});

/**
 * 🔒 THE COLLECTION INVITE-LINK BODY — THE COUNTEREXAMPLE `CopyAffordance`'s DOC NAMED AND
 * NOTHING MOUNTED.
 *
 * That doc recorded this control as reserving no right padding at all against a `right={10}`
 * control, and labelled its own figure "DERIVED from that file's props and the rules above,
 * NOT measured — no fixture mounts it". This block is the fixture, so the number is now a
 * measurement; `~/components/Collections/CollectionInviteLink.tsx` carries the fix.
 *
 * 🔴 ITS OWN CASE, NOT A REUSE OF THE BLOCKS ABOVE — the inset is 10, not `COPY_ICON_INSET`'s
 * 8, so `COPY_BODY_PADDING_RIGHT` is the wrong clearance for it by 2px and a test that
 * asserted that constant here would be asserting the wrong number. What the two share is the
 * RULE (`copyBodyPaddingRight`), which is why that is what the component imports.
 *
 * ⚠️ WHAT THIS CANNOT SEE, same caveat as every block above: `<Code block>` computes
 * `white-space: pre` / `overflow-x: auto`, so a join URL wider than the content box scrolls
 * and paints across its own right padding. A green run here means "the body reserves the
 * control's width", never "no URL can sit under the icon".
 */
describe('🔒 the collection invite-link body reserves the control`s width', () => {
  /**
   * A realistic join URL, and deliberately one that FITS at both viewports below.
   *
   * The clearance is a difference of three BOX terms and contains no text term at all, so the
   * string's length cannot move it — but a fixture that overflowed would make the
   * `overflow-x: auto` caveat above the thing a reader blamed for a failure, which is a
   * diagnosis cost for no extra coverage.
   */
  const JOIN_URL = 'https://example.test/collections/42/join';

  /** The invite block's own `Code` body, scoped by its testid rather than to any `pre`. */
  function inviteBody(): Element {
    const scope = document.querySelector(`[data-testid="${INVITE_LINK_TESTID}"]`);
    if (!scope) throw new Error('the invite-link block did not mount');
    const pre = scope.querySelector('pre[data-block="true"]');
    if (!pre) throw new Error('the invite-link block rendered no `Code block` body');
    return pre;
  }

  for (const viewport of [PHONE_VIEWPORT, NARROW_PHONE_VIEWPORT] as Viewport[]) {
    // Two widths for the same reason the first block gives, and with the same honest limit:
    // this geometry has no viewport term, so an identical pair of numbers is what
    // width-invariance looks like rather than a discriminating matrix.
    test(`at ${viewport.width}x${viewport.height} the control clears the invite URL`, async () => {
      const { observed } = await renderAtViewport(
        <CollectionInviteLink joinUrl={JOIN_URL} />,
        viewport
      );
      expect(observed).toEqual({ width: viewport.width, height: viewport.height });
      assertCascadeIsReal();

      const control = page.getByRole('button', { name: INVITE_LINK_COPY_LABEL });
      await expect.element(control).toBeInTheDocument();
      const body = inviteBody();

      const gap = clearance(body, control.element());
      expect(
        gap,
        `the copy control overlaps the invite URL by ${-gap}px — the body reserved ` +
          `${getComputedStyle(body).paddingRight} on the right while the control sits ` +
          `${getComputedStyle(control.element()).right} from the edge at ` +
          `${box(control.element()).width}px wide`
      ).toBeGreaterThanOrEqual(0);
    });
  }

  /**
   * POSITIVE CONTROL, and the derivation — for the same reason the first block needs one. A
   * non-negative gap is also what an unpositioned control reports (it would follow the body in
   * flow, far to its right), so prove the control is INSIDE the body's border box and only
   * clear of its text.
   *
   * 🔴 THE DERIVATION IS MEASUREMENT-AGAINST-MEASUREMENT HERE. `padding === inset + width`
   * with the inset read off the RENDERED control, not off `INVITE_LINK_ICON_INSET` — see the
   * import note. That makes it a claim about the rendered result at whatever root font size
   * the test runs at, and it cannot be satisfied by the module agreeing with itself.
   */
  test('POSITIVE CONTROL: the control sits INSIDE the body`s border box', async () => {
    const { observed } = await renderAtViewport(<CollectionInviteLink joinUrl={JOIN_URL} />);
    expect(observed).toEqual({ width: 390, height: 844 });
    assertCascadeIsReal();

    const control = page.getByRole('button', { name: INVITE_LINK_COPY_LABEL });
    await expect.element(control).toBeInTheDocument();
    const body = inviteBody();

    const controlBox = box(control.element());
    const bodyBox = box(body);
    expect(getComputedStyle(control.element()).position).toBe('absolute');
    expect(controlBox.right).toBeLessThanOrEqual(bodyBox.right);
    expect(controlBox.left).toBeGreaterThan(bodyBox.left);
    expect(
      controlBox.width,
      `the control's border box measured ${controlBox.width}px, not COPY_CONTROL_SIZE ` +
        `(${COPY_CONTROL_SIZE}). Mantine's default ActionIcon size moved; this body's padding ` +
        'is derived from it, so update the constant rather than the padding.'
    ).toBe(COPY_CONTROL_SIZE);

    // 🔴 THE VERTICAL AXIS, WHICH EVERY OTHER ASSERTION IN THIS BLOCK IS BLIND TO. The three
    // lines above and the clearance tests are all horizontal, so they passed while the control
    // hung 8.7px below the body: `transform: 'translateY(-50%) !important'` was dropped entirely
    // (React assigns non-custom style properties through the CSSOM property setter, which
    // rejects `!important`), leaving `top: 50%` uncorrected. Containment is the user-visible
    // claim — an icon outside the box it belongs to — and centring is the mechanism.
    // ⚠️ ORDERED STATE-FIRST, MECHANISM-LAST, AND THAT ORDER IS THE POINT. An earlier draft put
    // the `transform !== 'none'` check first; it reds on the same mutant, but it is a claim
    // about a CSS property SPELLING, and running first it shadowed the assertions that say what
    // is actually wrong on screen. So containment reports first, centring second, and the
    // spelling last.
    //
    // ⚠️ THE SPELLING CHECK IS A DIAGNOSIS HINT, NOT A GUARD, AND CANNOT BE THE FIRST REPORTER
    // UNDER ANY MUTANT CONSTRUCTED SO FAR — a dropped transform reds containment-bottom, a
    // wrong-but-present one reds centring, so this line is reached only when the others pass.
    // It is kept for the message, which names the mechanism (`!important` is dropped by the
    // CSSOM property setter) that the geometric failures do not.
    //
    // ⚠️ AND WHAT WAS ACTUALLY WATCHED: the `!important` mutant reds containment-bottom
    // ("ends at 47.3, below the body's 38.59") in the SHIPPED order. The claim that all of them
    // were watched to fail "independently" was removed rather than reworded — that is a
    // different run from the shipped ordering, and only the first reporter is observable in it.
    expect(
      controlBox.bottom,
      `the control's box ends at ${controlBox.bottom}, below the body's ${bodyBox.bottom} — it ` +
        'is rendered outside the element it is positioned within'
    ).toBeLessThanOrEqual(bodyBox.bottom);
    expect(controlBox.top, 'the control starts above the body it sits in').toBeGreaterThanOrEqual(
      bodyBox.top
    );
    expect(
      (controlBox.top + controlBox.bottom) / 2,
      `the control's vertical centre (${(controlBox.top + controlBox.bottom) / 2}) is not the ` +
        `body's (${(bodyBox.top + bodyBox.bottom) / 2})`
    ).toBeCloseTo((bodyBox.top + bodyBox.bottom) / 2, 1);
    expect(
      getComputedStyle(control.element()).transform,
      'the control has no transform, so `top: 50%` is uncorrected and it hangs below the body. ' +
        '`!important` in a React `style` value is dropped by the CSSOM property setter.'
    ).not.toBe('none');

    const renderedInset = parseFloat(getComputedStyle(control.element()).right);
    expect(
      parseFloat(getComputedStyle(body).paddingRight),
      `the reserved padding (${getComputedStyle(body).paddingRight}) is not the rendered inset ` +
        `(${renderedInset}px) plus the rendered control width (${controlBox.width}px). Either ` +
        'the inset moved without the padding following, or `copyBodyPaddingRight` stopped ' +
        'expressing the relation.'
    ).toBeCloseTo(renderedInset + controlBox.width, 1);
    // And that the inset is NOT the shared one. ⚠️ THIS EXCLUDES ~8; IT DOES NOT PIN 10, AND
    // THE COMMENT HERE USED TO SAY "10, not 8". Every assertion in this block is
    // self-consistent in the inset, so `INVITE_LINK_ICON_INSET = 0` or `= 24` passes all of
    // them (padding tracks, clearance stays 0.00). That is a cosmetic drift, not an overlap,
    // so it is deliberately not guarded — but the distinction belongs in the comment, because
    // "pins 10" reads as coverage this does not have. What it does catch is the one change
    // with a real consequence: a silent convergence onto `COPY_ICON_INSET`, after which this
    // body should drop its local constant and use `COPY_BODY_PADDING_RIGHT`.
    expect(
      renderedInset,
      `the invite control's inset rendered at ${renderedInset}px. This block is the repo's one ` +
        `caller at an inset other than COPY_ICON_INSET (${COPY_ICON_INSET}); if it has ` +
        'converged onto the shared value, drop the local constant and use ' +
        '`COPY_BODY_PADDING_RIGHT` instead of its own.'
    ).not.toBeCloseTo(COPY_ICON_INSET, 1);
  });

  /**
   * 🔴 THE ROOT-FONT-SIZE AXIS — the one this geometry is actually sensitive to, and the one a
   * raw px padding would fail on while every viewport above stayed green. The block above this
   * describe records the whole arc: `COPY_BODY_PADDING_RIGHT` as a plain `36` measured 0.00px
   * at R=16 and −9px at R=20, invisible to two viewports that agreed with each other at both.
   *
   * ONE RENDER, R VARIED ON THE MOUNTED TREE, so this differs from the two viewport cases above
   * it in the root font size and in nothing else — same fixture, same 390x844, no second mount.
   */
  test('the clearance survives a 20px root font size', async () => {
    const ROOT_FONT_SIZE = '20px';
    const { observed } = await renderAtViewport(<CollectionInviteLink joinUrl={JOIN_URL} />);
    expect(observed).toEqual({ width: 390, height: 844 });
    assertCascadeIsReal();

    const control = page.getByRole('button', { name: INVITE_LINK_COPY_LABEL });
    await expect.element(control).toBeInTheDocument();
    const body = inviteBody();

    try {
      document.documentElement.style.fontSize = ROOT_FONT_SIZE;
      await nextLayout();
      // Doubles as the positive control for the override: without it this reports 16px and
      // everything below is a second measurement at the root font size already taken.
      assertCascadeIsReal(ROOT_FONT_SIZE);

      const gap = clearance(body, control.element());
      expect(
        gap,
        `at a ${ROOT_FONT_SIZE} root font size the control overlaps the invite URL by ${-gap}px ` +
          `— the body reserved ${getComputedStyle(body).paddingRight} while the control sits ` +
          `${getComputedStyle(control.element()).right} from the edge at ` +
          `${box(control.element()).width}px wide`
      ).toBeGreaterThanOrEqual(0);

      // 🔴 THE DERIVATION AGAIN, AT THIS ROOT FONT SIZE — RENDERED AGAINST RENDERED. This
      // replaces a deleted "padding tracked R" check that compared the R=20 padding against the
      // R=16 reading × 1.25. That form was both weaker and partly self-referential, and the
      // comment justifying its deletion claimed "no mutant could be constructed in which it
      // reports" — which is false, and is corrected here rather than reworded: a padding that
      // OVER-tracks R (e.g. `calc(4.75rem - 38px)`, which is 38px at R=16 and 57px at R=20)
      // passes the R=16 derivation AND leaves this clearance at +9.5px, so the clearance above
      // genuinely cannot see it. The true statement is narrower: no PURE px spelling survives,
      // because with 38px pinned at R=16 any fixed value drives this clearance negative.
      //
      // This line closes that gap in both directions at once, and it is strictly stronger than
      // what it replaces: it also pins the control's border box as REM-SCALED at this R. If
      // Mantine's cascade ever switched to the literal `--ai-size-md: 28px` of the
      // per-component stylesheet, the control would measure 28 here instead of 35 and
      // `47.5 ≈ 12.5 + 28` is false. Until now that fact lived only in a transient mutant run.
      expect(
        parseFloat(getComputedStyle(body).paddingRight),
        `at a ${ROOT_FONT_SIZE} root font size the reserved padding ` +
          `(${getComputedStyle(body).paddingRight}) is not the rendered inset ` +
          `(${getComputedStyle(control.element()).right}) plus the rendered control width ` +
          `(${box(control.element()).width}px). Too LARGE means the padding over-scales, which ` +
          'the clearance above cannot see; a flat 28 for the control means the cascade moved to ' +
          'the px spelling of `--ai-size-md`. (Too SMALL is reported by the clearance above, ' +
          'which is strictly tighter in that direction — this message cannot print for it.)'
      ).toBeCloseTo(
        parseFloat(getComputedStyle(control.element()).right) + box(control.element()).width,
        1
      );

      // 🔴 THE VERTICAL AXIS AT THIS ROOT FONT SIZE TOO — the R=16 positive control is not
      // enough, and the survivor is the same px-spelling class this whole block exists for.
      // `transform: 'translateY(-14px)'` is exactly −50% of the 28px control at R=16, so it is
      // byte-equivalent to correct code there and passes all four vertical assertions in the
      // positive control. At R=20 the control is 35px and needs −17.5px: the box lands 10.12→
      // 45.12 inside a body of 0→48.24, so CONTAINMENT still passes with room and only the
      // centre moves — 3.5px low. Centring is therefore the only assertion that can see it,
      // and it has to run at an R where the two spellings disagree.
      const vControl = box(control.element());
      const vBody = box(body);
      expect(
        (vControl.top + vControl.bottom) / 2,
        `at a ${ROOT_FONT_SIZE} root font size the control's vertical centre ` +
          `(${(vControl.top + vControl.bottom) / 2}) is not the body's ` +
          `(${(vBody.top + vBody.bottom) / 2}). A px \`translateY\` holds at a 16px root font ` +
          'size and then stops tracking the control, which grows with R.'
      ).toBeCloseTo((vBody.top + vBody.bottom) / 2, 1);
      // `AgentOnboardingCard`'s prose panel needs a TRACKING check rather than this derivation:
      // it reserves half a rem more than the minimum, so a derivation would red on the correct
      // stylesheet, and its `.panel` 1px border lands its gap on exactly 0.00px at R=20.
    } finally {
      document.documentElement.style.removeProperty('font-size');
    }
  });
});
