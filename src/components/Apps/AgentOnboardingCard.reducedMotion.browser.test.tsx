import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
// Type-only namespace import, so the spread below keeps the real module's type.
//
// NOT `typeof import('@mantine/hooks')`, which is the form the sibling
// `ExternalSubmitForm.reducedMotion.browser.test.tsx` uses: measured 2026-10-03, that file
// reports `@typescript-eslint/consistent-type-imports` — "`import()` type annotations are
// forbidden" — under `pnpm eslint`, whose scope is all of `src/`. So it is a pre-existing
// violation rather than an exempt pattern, and copying it would have added a second one.
import type * as MantineHooks from '@mantine/hooks';

/**
 * `AgentOnboardingCard` must honour `prefers-reduced-motion`.
 *
 * With the shared `useReducedMotion` hook forced true, the card short-circuits to a plain
 * tree: no `LazyMotion`, no `m` components, no caret, no stagger wrappers, no glyph pop and
 * no shimmer animation — the pattern `wizardMotion.tsx` established and
 * `ExternalSubmitForm.reducedMotion.browser.test.tsx` already pins for the submit wizard.
 *
 * 🔴 EVERY RENDER IS AWAITED, AND WITHOUT THAT THIS WHOLE FILE IS VACUOUS. `useReducedMotion`
 * returns its initial value on the first render and reads the media query in an effect, so
 * `motionOn` is false in the first commit of an ANIMATED card too — every absence below is
 * the default state of the thing it claims to be denying. Awaiting `renderWithProviders`
 * drains that effect through `act`, so these assertions are made against a settled card.
 * Found by the test review; before it, the only thing separating these from vacuous was
 * `expect.element`'s 50ms retry gap.
 *
 * 🔴 AND IT ASSERTS THE AFFORDANCE STILL WORKS, which is the half that matters. "No
 * animation runs" is satisfied by a card that renders nothing at all. The copy path — same
 * bytes, same accessible name, same single fire, reachable by Tab — is what makes the static
 * tree a degradation rather than a removal.
 *
 * Only `useReducedMotion` is overridden; every other `@mantine/hooks` export stays real so
 * Mantine core keeps working (mirrors the `ExternalSubmitForm` suite).
 */

vi.mock('@mantine/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof MantineHooks>();
  return { ...actual, useReducedMotion: () => true };
});

const {
  AgentOnboardingCard,
  AGENT_CARET_TESTID,
  AGENT_COPY_LABEL,
  AGENT_GLYPH_TESTID,
  AGENT_ONBOARDING_TESTID,
  AGENT_PROMPT_TESTID,
  AGENT_ROW_TESTID,
  AGENT_SHIMMER_TESTID,
} = await import('./AgentOnboardingCard');
const { AGENT_BUILD_PROMPT } = await import('./cliCommands');

const writeText = () => vi.mocked(navigator.clipboard.writeText);

beforeEach(() => {
  writeText().mockClear();
  window.getSelection()?.removeAllRanges();
});

describe('AgentOnboardingCard — reduced motion', () => {
  test('🔴 nothing animates: ring still, no caret, no stagger wrappers, no glyph pop', async () => {
    await renderWithProviders(<AgentOnboardingCard />);

    const root = page.getByTestId(AGENT_ONBOARDING_TESTID);
    await expect.element(root).toBeInTheDocument();

    // The ring exists in BOTH trees, so read its computed animation — the state, not the
    // presence of a node and not a class-name spelling.
    const ring = page.getByTestId(AGENT_SHIMMER_TESTID).element();
    expect(getComputedStyle(ring).animationName).toBe('none');
    // The three motion-only nodes.
    expect(page.getByTestId(AGENT_CARET_TESTID).elements()).toHaveLength(0);
    expect(page.getByTestId(AGENT_ROW_TESTID).elements()).toHaveLength(0);
    expect(page.getByTestId(AGENT_GLYPH_TESTID).elements()).toHaveLength(0);
    // The attribute is a convenience on top of the four reads above, not the claim.
    expect(root.element().getAttribute('data-motion')).toBe('off');
  });

  test('🔴 the copy affordance is FULLY USABLE with motion disabled', async () => {
    const onCopy = vi.fn();
    await renderWithProviders(<AgentOnboardingCard onCopy={onCopy} />);

    // The control is the copy path in BOTH trees — the prose body is deliberately not a click
    // target (see `CopyAffordance`'s `bodyClickCopies`). Asserted here as well as in the
    // animated suite, so a future change cannot make the static tree's affordance differ.
    await page.getByRole('button', { name: AGENT_COPY_LABEL }).click();
    expect(writeText()).toHaveBeenCalledWith(AGENT_BUILD_PROMPT);
    expect(onCopy).toHaveBeenCalledTimes(1);

    // And the body still is not one.
    writeText().mockClear();
    await page.getByTestId(AGENT_PROMPT_TESTID).click();
    expect(writeText()).not.toHaveBeenCalled();
  });

  test('🔴 and by keyboard, still exactly once per press', async () => {
    const onCopy = vi.fn();
    await renderWithProviders(<AgentOnboardingCard onCopy={onCopy} />);

    const button = page.getByRole('button', { name: AGENT_COPY_LABEL });
    await expect.element(button).toBeInTheDocument();
    (document.activeElement as HTMLElement | null)?.blur();
    let reached = false;
    for (let i = 0; i < 10 && !reached; i += 1) {
      await userEvent.tab();
      reached = document.activeElement === button.element();
    }
    expect(reached, 'the copy control was not reachable by tabbing').toBe(true);

    await userEvent.keyboard('{Enter}');
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(writeText()).toHaveBeenCalledTimes(1);
    expect(writeText()).toHaveBeenCalledWith(AGENT_BUILD_PROMPT);
  });

  test('the prompt is still fully rendered — static is a degradation, not a removal', async () => {
    await renderWithProviders(<AgentOnboardingCard />);
    const panel = page.getByTestId(AGENT_PROMPT_TESTID);
    await expect.element(panel).toBeInTheDocument();
    expect(panel.element().textContent ?? '').toContain(AGENT_BUILD_PROMPT);
  });
});
