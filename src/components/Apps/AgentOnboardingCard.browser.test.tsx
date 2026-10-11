import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
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
} from '~/components/Apps/AgentOnboardingCard';
import { CLI_INSTALL_NPM, AGENT_BUILD_PROMPT } from '~/components/Apps/cliCommands';
import { CopyableCommand } from '~/components/Apps/CopyableCommand';
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

/**
 * Virtual-clock helpers, mirroring `CliSubmitCta.browser.test.tsx`'s — which carries the
 * measured justification for them. ⚠️ A FOURTH per-file copy in this directory; they belong
 * in `test/`, which is a reuse question for whoever hoists them, not for this change.
 */
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
/** Mantine `CopyButton`'s `defaultProps = { timeout: 1e3 }`. Pinned, not slept past. */
const COPIED_RESET_MS = 1000;
function useVirtualClock() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
}
async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 5; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
    await new Promise((resolve) => realSetTimeout(resolve, 0));
  }
}
/** The copy itself is genuinely async; give it a bounded budget of REAL time to land. */
async function settleCopy() {
  const deadline = Date.now() + 2000;
  do {
    await new Promise((resolve) => realSetTimeout(resolve, 10));
    if (vi.mocked(navigator.clipboard.writeText).mock.calls.length > 0) return;
  } while (Date.now() < deadline);
}

// Reverse registration order puts this BEFORE the setup file's `await cleanup()`, so the
// unmount never sees a frozen clock.
afterEach(() => {
  vi.useRealTimers();
});

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
  test('🔴 copying hands the clipboard the prompt BYTE-IDENTICALLY', async () => {
    const onCopy = vi.fn();
    await renderWithProviders(<AgentOnboardingCard onCopy={onCopy} />);

    await page.getByRole('button', { name: AGENT_COPY_LABEL }).click();

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
    // Lower-cased: `Copy Command: …` would walk a case-sensitive `not.toContain`.
    expect(AGENT_COPY_LABEL.toLowerCase()).not.toContain('command');
  });

  test('🔴 pressing the INNER ICON fires the copy callback exactly ONCE', async () => {
    // This asserts one press → one `onCopy` and one clipboard write, and nothing more. It is
    // NOT a guard on `CopyAffordance`'s `stopPropagation()`: this card passes
    // `bodyClickCopies={false}`, so the Box carries no handler and nothing here can
    // double-fire. Measured over this file plus `AppsBuildBody.agentPrompt` and
    // `AuthorViaGit`: deleting that `stopPropagation()` leaves this green, and the test it
    // reds is `🔴 POSITIVE CONTROL: a CLI copy still posts cli_copy` in
    // `AppsBuildBody.agentPrompt.browser.test.tsx`, where the body click IS live.
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
   * 🔴 THE BODY IS NOT A CLICK TARGET, AND THAT IS THE FIX RATHER THAN A LIMITATION. A
   * body-wide click target fights text selection: the `mouseup` ending a drag-select is
   * followed by a `click` on the same element, so the panel copied over the user's selection
   * and posted a funnel event they never asked for. Guarding it was tried and abandoned —
   * three timing-dependent failure modes, including one that silently disabled the panel for
   * anyone with a stale selection. `CopyAffordance`'s `bodyClickCopies` note has the detail.
   *
   * One-line COMMAND blocks keep the body click; prose does not — and both branches are
   * pinned, the default one immediately below.
   */
  /**
   * 🔴 THE OTHER BRANCH OF THE SAME SWITCH. `bodyClickCopies` defaults to TRUE, and the three
   * pre-existing `CopyableCommand` call sites rely on that default — the prop's own doc says
   * leaving it is "what keeps `onCopy`'s contract exactly as documented for them". Nothing
   * read it: flipping the default to `false` left 67 tests green across seven files, because
   * every existing suite clicks the `Copy command: …` BUTTON and none clicks a block body.
   * This change introduced the switch, so it owns both branches.
   */
  test('🔴 a COMMAND block keeps its body click — the default branch', async () => {
    await renderWithProviders(<CopyableCommand command={CLI_INSTALL_NPM} />);
    await page.getByText(`$ ${CLI_INSTALL_NPM}`).click();
    expect(writeText()).toHaveBeenCalledWith(CLI_INSTALL_NPM);
  });

  test('🔴 clicking the prompt text does NOT copy — only the control does', async () => {
    const onCopy = vi.fn();
    await renderWithProviders(<AgentOnboardingCard onCopy={onCopy} />);

    await page.getByTestId(AGENT_PROMPT_TESTID).click();
    expect(onCopy, 'the prose body should not be a copy target').not.toHaveBeenCalled();
    expect(writeText()).not.toHaveBeenCalled();

    // POSITIVE CONTROL for the absence above: the same render DOES copy from the control, so
    // this is not satisfied by a card that never copies at all.
    await page.getByRole('button', { name: AGENT_COPY_LABEL }).click();
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(writeText()).toHaveBeenCalledWith(AGENT_BUILD_PROMPT);
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

    // 🔴 AND THE ROWS ARE ACTUALLY VISIBLE. This is the seam the other guards leave open:
    // `agentOnboardingMotion.test.ts` pins the VALUES and the index set above pins the
    // WRAPPERS, but nothing pinned that the wrapper CONSUMES the values — so replacing
    // `initial={REVEAL_INITIAL}` with `initial={{ opacity: 0 }}` right here rendered all
    // three rows at computed opacity 0 and left 28 component + 6 unit tests GREEN. Measured,
    // not imagined. `toBeVisible()` cannot catch it — the browser matcher ignores opacity,
    // which this change already documents in `AppsBuildBody.agentPrompt.browser.test.tsx`.
    // Reading the computed value is the same move the ring's `animationName` read makes.
    for (const row of page.getByTestId(AGENT_ROW_TESTID).elements()) {
      expect(getComputedStyle(row).opacity, 'an entrance row rendered transparent').toBe('1');
    }

    expect(page.getByTestId(AGENT_ONBOARDING_TESTID).element().getAttribute('data-motion')).toBe(
      'on'
    );
  });

  /**
   * 🔴 THE CLOCK IS VIRTUAL, THE BEHAVIOUR IS NOT — and this is the repo's existing fix, not
   * a new idea. `copied` is TRANSIENT: Mantine's `CopyButton` arms
   * `setTimeout(() => setCopied(false), 1000)` the moment the clipboard promise resolves, so
   * a real-clock `vi.waitFor` is racing a ~1s window with a ~1s budget.
   * `CliSubmitCta.browser.test.tsx` records that the identical assertion went red on
   * civitai#3653's preview run after passing 1280/1280 ten minutes earlier, and measures the
   * window at 976.7-1001.2ms. Shrinking what precedes the poll — which is what this test did
   * before — narrows the race without removing it.
   *
   * Freezing `setTimeout` removes the dependency, and buys the half this test did not have:
   * the RESET. Without it, a `copied` state that never ends passes.
   */
  test('copying morphs the clipboard glyph to a check, and the morph ends', async () => {
    await renderWithProviders(<AgentOnboardingCard />);
    const button = page.getByRole('button', { name: AGENT_COPY_LABEL });
    await expect.element(button).toBeInTheDocument();
    expect(
      button.element().querySelector('.tabler-icon-clipboard'),
      'the pre-copy glyph should be the clipboard'
    ).not.toBeNull();

    // Freeze BEFORE the interaction: the reset timer is armed by the copy itself, and
    // `useFakeTimers` does not retroactively capture an already-scheduled real timer.
    useVirtualClock();
    await button.click();
    await settleCopy();

    expect(button.element().querySelector('.tabler-icon-check')).not.toBeNull();

    // 1ms inside the window: still the check, so this is the live copied STATE.
    await advance(COPIED_RESET_MS - 1);
    expect(button.element().querySelector('.tabler-icon-check')).not.toBeNull();

    // Crossing it reverts. Without this half the two above also pass on a stuck state.
    await advance(1);
    expect(button.element().querySelector('.tabler-icon-clipboard')).not.toBeNull();
  });

  test('🔴 the panel PRESERVES the blank line the clipboard sends', async () => {
    // The only assertable form of "the panel agrees with the button". Every other assertion
    // in this file reads `textContent` or the clipboard, and both keep `\n\n` whatever the CSS
    // does — so deleting `white-space: pre-line` from the stylesheet left all 27 green while
    // the rendered prompt collapsed to one paragraph. Same move as the ring's
    // `animationName` read: the computed STATE, not a class-name spelling.
    //
    // Read at the caret's parent, which is the prompt element itself (the caret is rendered
    // inside that `Text`); `white-space` inherits, so this answers for the whole panel.
    await renderWithProviders(<AgentOnboardingCard />);
    const caret = page.getByTestId(AGENT_CARET_TESTID);
    await expect.element(caret).toBeInTheDocument();
    expect(
      getComputedStyle(caret.element().parentElement!).whiteSpace,
      'the panel collapses the blank line that is part of the copied bytes'
    ).toBe('pre-line');
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
});

describe('AgentOnboardingCard — tone', () => {
  test('prominent renders a real heading; inline does not inject one', async () => {
    const { rerender } = await renderWithProviders(<AgentOnboardingCard tone="prominent" />);
    await expect
      .element(page.getByRole('heading', { name: 'Let your agent build it' }))
      .toBeInTheDocument();

    // `inline` sits inside the workbench's collapsed strip, which has no heading hierarchy
    // for an `h3` to belong to, so it uses emphasised text instead of inventing one.
    await rerender(<AgentOnboardingCard tone="inline" />);
    await expect
      .element(page.getByText('Let your agent do it', { exact: true }))
      .toBeInTheDocument();
    expect(page.getByRole('heading', { name: 'Let your agent build it' }).elements()).toHaveLength(
      0
    );
  });

  test('🔴 BOTH tones disclose what the prompt makes an agent do', async () => {
    // Both tones hand the agent byte-identical instructions. A short variant that says only
    // "it runs the setup" describes none of it.
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
