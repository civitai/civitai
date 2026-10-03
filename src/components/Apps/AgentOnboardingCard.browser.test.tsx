import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import {
  AGENT_CARET_TESTID,
  AGENT_COPY_LABEL,
  AGENT_ONBOARDING_TESTID,
  AGENT_PROMPT_TESTID,
  AGENT_SHIMMER_TESTID,
  AgentOnboardingCard,
} from '~/components/Apps/AgentOnboardingCard';
import { AGENT_BUILD_PROMPT, AGENT_ONBOARDING_URL } from '~/components/Apps/cliCommands';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * `AgentOnboardingCard` — the copyable agent-onboarding prompt on `/apps/build`.
 *
 * 🔴 THE PIN IS THE WHOLE STRING, NOT KEYWORDS, AND THE COST IS DELIBERATE. A guard that
 * checked for "agent-onboarding" and "civitai login" is walkable by any reword that keeps
 * those two tokens — and a reword is exactly the change that breaks this copy, because the
 * string is an INSTRUCTION an autonomous agent executes, and the repo that owns the URL
 * cannot see this copy at all (see `./cliCommands`'s {@link AGENT_ONBOARDING_URL} note: the
 * upstream checker is repo-local by design, and the URL is a Cloudflare 302 tracked in
 * neither repo). So a cosmetic reword FAILS this file. That is the price of a
 * machine-readable claim about what we hand people's agents, and it is worth paying here.
 *
 * 🔴 AND IT IS PINNED AT THE CLIPBOARD, NOT AT THE CONSTANT. Asserting
 * `AGENT_BUILD_PROMPT === <literal>` alone would be satisfied by a card that renders a
 * different string, or copies the rendered text (which carries the decorative caret as a
 * sibling node) instead of the constant. The authoritative read is the bytes Mantine hands
 * `navigator.clipboard.writeText` — stubbed by `test/component-setup` as a `vi.fn()`
 * precisely so it is readable here.
 */

/**
 * The expected prompt, written from the spec rather than copied off the implementation.
 *
 * Concatenated with an explicit `'\n' + '\n'` so the blank line between the two paragraphs
 * is unambiguous in the source: it is part of the bytes the clipboard receives, and the
 * stylesheet's `white-space: pre-line` exists to render it.
 */
const EXPECTED_PROMPT =
  'Read https://civitai.com/agent-onboarding and complete the setup, then tell me if I need to run `civitai login`.\n' +
  '\n' +
  'Then ask me clarifying questions about my app idea and build it — with a custom theme built on @civitai/theme tokens, and complete test coverage.';

/** The stub installed by `test/component-setup`; a real `vi.fn()`, so its calls are readable. */
const writeText = () => vi.mocked(navigator.clipboard.writeText);

beforeEach(() => {
  writeText().mockClear();
});

describe('AgentOnboardingCard — the prompt bytes', () => {
  test('🔴 the constant is this exact string, blank line and em dash included', () => {
    expect(AGENT_BUILD_PROMPT).toBe(EXPECTED_PROMPT);
  });

  test('🔴 the prompt carries the onboarding URL, so the two constants cannot disagree', () => {
    expect(AGENT_BUILD_PROMPT).toContain(AGENT_ONBOARDING_URL);
    expect(AGENT_ONBOARDING_URL).toBe('https://civitai.com/agent-onboarding');
  });

  test('🔴 clicking the panel copies the prompt BYTE-IDENTICALLY', async () => {
    const onCopy = vi.fn();
    renderWithProviders(<AgentOnboardingCard onCopy={onCopy} />);

    await page.getByTestId(AGENT_PROMPT_TESTID).click();

    // The bytes, from the clipboard call — not from the rendered text, which also contains
    // the decorative caret node.
    expect(writeText()).toHaveBeenCalledTimes(1);
    expect(writeText()).toHaveBeenCalledWith(EXPECTED_PROMPT);
    // And the callback the funnel is threaded through receives the same bytes.
    expect(onCopy).toHaveBeenCalledWith(EXPECTED_PROMPT);
  });

  test('the rendered panel shows the prompt text a human can read before copying', async () => {
    renderWithProviders(<AgentOnboardingCard />);
    // Scoped to the panel and matched loosely, because the caret is a sibling node inside
    // the same block — the byte-exact claim is the clipboard assertion above.
    await expect
      .element(
        page.getByText('complete the setup, then tell me if I need to run', { exact: false })
      )
      .toBeInTheDocument();
    await expect
      .element(page.getByText('built on @civitai/theme tokens', { exact: false }))
      .toBeInTheDocument();
  });
});

describe('AgentOnboardingCard — the copy control', () => {
  test('the copy control has an accessible name that is not "Copy command"', async () => {
    renderWithProviders(<AgentOnboardingCard />);
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
    renderWithProviders(<AgentOnboardingCard onCopy={onCopy} />);

    await page.getByRole('button', { name: AGENT_COPY_LABEL }).click();

    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(writeText()).toHaveBeenCalledTimes(1);
  });

  test('🔴 the card is operable by KEYBOARD — Tab reaches the control, Enter copies', async () => {
    const onCopy = vi.fn();
    renderWithProviders(<AgentOnboardingCard onCopy={onCopy} />);

    const button = page.getByRole('button', { name: AGENT_COPY_LABEL });
    await expect.element(button).toBeInTheDocument();
    // Focus from the document, by tabbing — not `.focus()`, which would pass even on an
    // element Tab can never reach (a `div` with `onClick` and no `tabindex`).
    (document.activeElement as HTMLElement | null)?.blur();
    await userEvent.tab();
    expect(document.activeElement).toBe(button.element());

    await userEvent.keyboard('{Enter}');
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(writeText()).toHaveBeenCalledWith(EXPECTED_PROMPT);
  });
});

describe('AgentOnboardingCard — motion, when the viewer has not opted out', () => {
  test('the animated tree mounts: shimmer ring and blinking caret are both present', async () => {
    renderWithProviders(<AgentOnboardingCard />);
    // `useReducedMotion(true)` renders STATIC on the first paint and reads the media query in
    // an effect, so this is a real mount→settle transition rather than a first-render read.
    // The retrying element API is what waits for it.
    await expect.element(page.getByTestId(AGENT_SHIMMER_TESTID)).toBeInTheDocument();
    await expect.element(page.getByTestId(AGENT_CARET_TESTID)).toBeInTheDocument();
    expect(page.getByTestId(AGENT_ONBOARDING_TESTID).element().getAttribute('data-motion')).toBe(
      'on'
    );
  });

  test('🔴 `animated={false}` is the SAME static tree reduced motion gets', async () => {
    // The workbench strip's path. Asserted here as well as in the reducedMotion suite,
    // because this is the arm a reduced-motion mock cannot reach: it must be static for a
    // viewer with NO motion preference at all.
    renderWithProviders(<AgentOnboardingCard animated={false} />);

    const root = page.getByTestId(AGENT_ONBOARDING_TESTID);
    await expect.element(root).toBeInTheDocument();
    expect(root.element().getAttribute('data-motion')).toBe('off');
    expect(page.getByTestId(AGENT_SHIMMER_TESTID).elements()).toHaveLength(0);
    expect(page.getByTestId(AGENT_CARET_TESTID).elements()).toHaveLength(0);

    // Static is not a degraded affordance — it still copies the same bytes.
    await page.getByRole('button', { name: AGENT_COPY_LABEL }).click();
    expect(writeText()).toHaveBeenCalledWith(EXPECTED_PROMPT);
  });

  test('the prompt text is NOT typed out character by character', async () => {
    // The one animation deliberately excluded: this is text the reader has to read and copy.
    // A typewriter effect would mean the panel's text content grows over time, so assert the
    // whole prompt is present in the panel on the very first observable render.
    renderWithProviders(<AgentOnboardingCard />);
    const panel = page.getByTestId(AGENT_PROMPT_TESTID);
    await expect.element(panel).toBeInTheDocument();
    expect(panel.element().textContent ?? '').toContain(EXPECTED_PROMPT);
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
});
