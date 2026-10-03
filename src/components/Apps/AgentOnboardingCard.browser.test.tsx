import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import {
  AGENT_CARET_TESTID,
  AGENT_COPY_LABEL,
  AGENT_GLYPH_TESTID,
  AGENT_ONBOARDING_TESTID,
  AGENT_PROMPT_TESTID,
  AGENT_ROW_TESTID,
  AGENT_SHIMMER_TESTID,
  AgentOnboardingCard,
  STAGGER_SECONDS,
} from '~/components/Apps/AgentOnboardingCard';
import { AGENT_BUILD_PROMPT } from '~/components/Apps/cliCommands';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * `AgentOnboardingCard` — the copyable agent-onboarding prompt on `/apps/build`.
 *
 * The prompt's exact bytes are pinned in `__tests__/agentPrompt.test.ts`, in the `unit` tier,
 * because `.github/workflows/lint.yml` runs no `component` job and a claim about what we hand
 * people's coding agents should be reported by a check a human reads. THIS file owns the half
 * that needs a DOM: that those bytes are what reaches the clipboard, and that the affordance
 * around them works.
 *
 * 🔴 EVERY RENDER IS AWAITED, AND THAT IS LOAD-BEARING RATHER THAN TIDINESS.
 * `useReducedMotion(true)` returns `true` on the FIRST render and commits the real media
 * value in an effect (`@mantine/hooks`' `useMediaQuery` with its default
 * `getInitialValueInEffect: true`), so `motionOn` is false in the first commit of an ANIMATED
 * card too. Every "this card is static" assertion is therefore satisfied by the first-render
 * default unless the effect has been drained first — which is exactly what awaiting
 * `renderWithProviders` does, since `vitest-browser-react`'s `render` is `async` and wraps
 * the root render in `await act(async () => …)`. Measured by the test review: the only thing
 * separating three such assertions from vacuous was `expect.element`'s 50ms retry gap, and a
 * sibling test in this file resolved its first poll in 12ms. Do not drop an `await` here.
 */

/** The stub installed by `test/component-setup`; a real `vi.fn()`, so its calls are readable. */
const writeText = () => vi.mocked(navigator.clipboard.writeText);

beforeEach(() => {
  writeText().mockClear();
  window.getSelection()?.removeAllRanges();
});

/** Reads the ring's computed animation — the STATE, not the class name spelling. */
const ringAnimation = () =>
  getComputedStyle(page.getByTestId(AGENT_SHIMMER_TESTID).element()).animationName;

describe('AgentOnboardingCard — the prompt bytes reach the clipboard', () => {
  test('🔴 clicking the panel copies the prompt BYTE-IDENTICALLY', async () => {
    const onCopy = vi.fn();
    await renderWithProviders(<AgentOnboardingCard onCopy={onCopy} />);

    await page.getByTestId(AGENT_PROMPT_TESTID).click();

    // From the clipboard call — not from the rendered text, which also contains the
    // decorative caret node.
    expect(writeText()).toHaveBeenCalledTimes(1);
    expect(writeText()).toHaveBeenCalledWith(AGENT_BUILD_PROMPT);
    // And the callback the funnel is threaded through receives the same bytes.
    expect(onCopy).toHaveBeenCalledWith(AGENT_BUILD_PROMPT);
  });

  test('the rendered panel shows the prompt text a human can read before copying', async () => {
    await renderWithProviders(<AgentOnboardingCard />);
    const panel = page.getByTestId(AGENT_PROMPT_TESTID);
    await expect.element(panel).toBeInTheDocument();
    expect(panel.element().textContent ?? '').toContain(AGENT_BUILD_PROMPT);
  });
});

describe('AgentOnboardingCard — the copy control', () => {
  test('the copy control has an accessible name that is not "Copy command"', async () => {
    await renderWithProviders(<AgentOnboardingCard />);
    const button = page.getByRole('button', { name: AGENT_COPY_LABEL });
    await expect.element(button).toBeInTheDocument();
    // `CopyableCommand`'s label is `Copy command: <cmd>`; this prompt is prose, not a
    // command, and reusing that component is what would have produced the wrong name.
    expect(AGENT_COPY_LABEL).not.toContain('command');
  });

  test('🔴 pressing the INNER ICON fires the copy callback exactly ONCE', async () => {
    // The regression this component family already fixed once: the icon sits inside the Box
    // that also handles the click, so without `stopPropagation()` one press ran `copy()` and
    // `onCopy()` TWICE — over-counting the funnel by however many users aim at the button.
    const onCopy = vi.fn();
    await renderWithProviders(<AgentOnboardingCard onCopy={onCopy} />);

    await page.getByRole('button', { name: AGENT_COPY_LABEL }).click();

    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(writeText()).toHaveBeenCalledTimes(1);
  });

  test('🔴 the card is operable by KEYBOARD — Tab reaches the control, Enter copies', async () => {
    const onCopy = vi.fn();
    await renderWithProviders(<AgentOnboardingCard onCopy={onCopy} />);

    const button = page.getByRole('button', { name: AGENT_COPY_LABEL });
    await expect.element(button).toBeInTheDocument();

    // 🔴 TAB UNTIL REACHED, NOT ONE TAB. Asserting the control is the FIRST tabbable node
    // claims more than "reachable by keyboard" — it is true only while the card holds exactly
    // one focusable element, so adding a link later would turn a correct component into a red
    // test that reads like a focus bug. The bounded loop pins reachability itself.
    (document.activeElement as HTMLElement | null)?.blur();
    let reached = false;
    for (let i = 0; i < 10 && !reached; i += 1) {
      await userEvent.tab();
      reached = document.activeElement === button.element();
    }
    expect(reached, 'the copy control was not reachable by tabbing').toBe(true);

    await userEvent.keyboard('{Enter}');
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(writeText()).toHaveBeenCalledWith(AGENT_BUILD_PROMPT);
  });

  /**
   * 🔴 SELECTING TEXT INSIDE THE PANEL IS NOT A COPY REQUEST. The whole panel is a click
   * target, so the `click` that follows the `mouseup` ending a drag-select would otherwise
   * overwrite the user's selection with the whole prompt AND post a funnel event they never
   * asked for — and a double-click, which selects a word, would post two. Harmless on a
   * one-line command block; the prompt is two paragraphs of prose on a public page.
   */
  test('🔴 a click that ends a selection inside the panel does NOT copy', async () => {
    const onCopy = vi.fn();
    await renderWithProviders(<AgentOnboardingCard onCopy={onCopy} />);
    const panel = page.getByTestId(AGENT_PROMPT_TESTID);
    await expect.element(panel).toBeInTheDocument();

    // Make a real selection anchored inside the panel, as a drag-select leaves behind.
    const selection = window.getSelection();
    selection?.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(panel.element());
    selection?.addRange(range);

    await panel.click();
    expect(onCopy, 'a click ending a selection copied anyway').not.toHaveBeenCalled();
    expect(writeText()).not.toHaveBeenCalled();

    // The explicit button is the escape hatch, and is deliberately NOT guarded — someone who
    // selected text and then pressed Copy means it.
    await page.getByRole('button', { name: AGENT_COPY_LABEL }).click();
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(writeText()).toHaveBeenCalledWith(AGENT_BUILD_PROMPT);

    selection?.removeAllRanges();
  });

  test('POSITIVE CONTROL: with NO selection, the same panel click does copy', async () => {
    // Without this, the absence above is satisfied by a panel that never copies at all.
    const onCopy = vi.fn();
    await renderWithProviders(<AgentOnboardingCard onCopy={onCopy} />);

    await page.getByTestId(AGENT_PROMPT_TESTID).click();
    expect(onCopy).toHaveBeenCalledTimes(1);
  });
});

describe('AgentOnboardingCard — motion, when the viewer has not opted out', () => {
  test('🔴 all four treatments are present: shimmer, caret, staggered rows, glyph pop', async () => {
    await renderWithProviders(<AgentOnboardingCard />);

    // 1. The shimmer is a CSS animation on a ring that exists in BOTH trees, so its presence
    //    proves nothing — read the computed animation instead.
    expect(ringAnimation(), 'the ring is not animating').not.toBe('none');
    // 2. The caret exists only in the animated tree.
    await expect.element(page.getByTestId(AGENT_CARET_TESTID)).toBeInTheDocument();
    // 3. One stagger wrapper per row, carrying the index the delay is computed from. Pinned
    //    as the index SET, so deleting the wrappers or silently changing how many rows are
    //    staggered both fail — a mutation that made `Reveal` a passthrough used to print
    //    nothing at all across this suite.
    const indices = page
      .getByTestId(AGENT_ROW_TESTID)
      .elements()
      .map((el) => el.getAttribute('data-reveal-index'));
    expect(indices).toEqual(['0', '1', '2']);
    // 4. The glyph's pop wrapper. Deleting `renderGlyph` leaves the same two icons behind
    //    `CopyAffordance`'s default, so this wrapper is the pop's only structural trace.
    await expect.element(page.getByTestId(AGENT_GLYPH_TESTID)).toBeInTheDocument();

    expect(page.getByTestId(AGENT_ONBOARDING_TESTID).element().getAttribute('data-motion')).toBe(
      'on'
    );
  });

  test('the stagger step is 40ms', () => {
    // The constant the delay is multiplied by. Together with the index set above this pins
    // the stagger itself rather than only that wrappers exist.
    expect(STAGGER_SECONDS).toBe(0.04);
  });

  test('copying morphs the clipboard glyph to a check', async () => {
    await renderWithProviders(<AgentOnboardingCard />);
    const button = page.getByRole('button', { name: AGENT_COPY_LABEL });
    expect(
      button.element().querySelector('.tabler-icon-clipboard'),
      'the pre-copy glyph should be the clipboard'
    ).not.toBeNull();

    await button.click();
    await expect.element(page.getByTestId(AGENT_GLYPH_TESTID)).toBeInTheDocument();
    await vi.waitFor(() =>
      expect(button.element().querySelector('.tabler-icon-check')).not.toBeNull()
    );
  });

  test('🔴 `animated={false}` is the SAME static tree reduced motion gets', async () => {
    // The workbench strip's path, and the arm a reduced-motion mock cannot reach: it must be
    // static for a viewer with NO motion preference at all. Awaited, so the media query has
    // been read — otherwise this passes on the first-render default of an ANIMATED card.
    await renderWithProviders(<AgentOnboardingCard animated={false} />);

    const root = page.getByTestId(AGENT_ONBOARDING_TESTID);
    await expect.element(root).toBeInTheDocument();
    expect(root.element().getAttribute('data-motion')).toBe('off');
    expect(ringAnimation(), 'the ring should not animate in the static tree').toBe('none');
    expect(page.getByTestId(AGENT_CARET_TESTID).elements()).toHaveLength(0);
    expect(page.getByTestId(AGENT_ROW_TESTID).elements()).toHaveLength(0);
    expect(page.getByTestId(AGENT_GLYPH_TESTID).elements()).toHaveLength(0);

    // Static is not a degraded affordance — it still copies the same bytes.
    await page.getByRole('button', { name: AGENT_COPY_LABEL }).click();
    expect(writeText()).toHaveBeenCalledWith(AGENT_BUILD_PROMPT);
  });

  test('the prompt text is NOT typed out character by character', async () => {
    // The one animation deliberately excluded: this is text the reader has to read and copy.
    // A typewriter effect would mean the panel's text content grows over time, so assert the
    // whole prompt is present on the first settled render.
    await renderWithProviders(<AgentOnboardingCard />);
    const panel = page.getByTestId(AGENT_PROMPT_TESTID);
    expect(panel.element().textContent ?? '').toContain(AGENT_BUILD_PROMPT);
  });
});

describe('AgentOnboardingCard — tone', () => {
  test('prominent renders a real heading; inline does not inject one', async () => {
    const { rerender } = await renderWithProviders(<AgentOnboardingCard tone="prominent" />);
    await expect
      .element(page.getByRole('heading', { name: 'Let your agent build it' }))
      .toBeInTheDocument();

    // `inline` sits inside `/apps/build`'s first-app body and inside the workbench's
    // collapsed strip — neither has a heading hierarchy for an `h3` to belong to, so it uses
    // emphasised text instead of inventing one.
    await rerender(<AgentOnboardingCard tone="inline" />);
    await expect.element(page.getByText('Or let your agent do it')).toBeInTheDocument();
    expect(page.getByRole('heading', { name: 'Let your agent build it' }).elements()).toHaveLength(
      0
    );
  });

  test('🔴 BOTH tones disclose what the prompt makes an agent do', async () => {
    // `inline` is what both signed-in placements render, so it is the variant most readers
    // see — and both hand the agent byte-identical instructions. A short variant that says
    // only "it runs the setup" describes none of it.
    const { rerender } = await renderWithProviders(<AgentOnboardingCard tone="prominent" />);
    for (const phrase of ['installs the Civitai CLI', 'MCP servers', 'log in']) {
      await expect.element(page.getByText(phrase, { exact: false })).toBeInTheDocument();
    }
    await rerender(<AgentOnboardingCard tone="inline" />);
    for (const phrase of ['installs the Civitai CLI', 'MCP servers', 'log in']) {
      await expect.element(page.getByText(phrase, { exact: false })).toBeInTheDocument();
    }
  });
});
