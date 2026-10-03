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
 * tree: no `LazyMotion`, no `m` components, no shimmer animation and no caret — the pattern
 * `wizardMotion.tsx` established and `ExternalSubmitForm.reducedMotion.browser.test.tsx`
 * already pins for the submit wizard. The point of the short-circuit is that the
 * reduced-motion DOM is identical to a plain render and therefore cheap to assert, so this
 * file asserts the ABSENCES structurally rather than trusting the `data-motion` attribute.
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
  AGENT_ONBOARDING_TESTID,
  AGENT_PROMPT_TESTID,
  AGENT_SHIMMER_TESTID,
} = await import('./AgentOnboardingCard');
const { AGENT_BUILD_PROMPT } = await import('./cliCommands');

const writeText = () => vi.mocked(navigator.clipboard.writeText);

beforeEach(() => {
  writeText().mockClear();
});

describe('AgentOnboardingCard — reduced motion', () => {
  test('🔴 nothing animates: no shimmer ring, no caret, and the root says so', async () => {
    renderWithProviders(<AgentOnboardingCard />);

    const root = page.getByTestId(AGENT_ONBOARDING_TESTID);
    await expect.element(root).toBeInTheDocument();
    // Structural, not spelled: the two animated-only nodes are the thing being denied.
    expect(page.getByTestId(AGENT_SHIMMER_TESTID).elements()).toHaveLength(0);
    expect(page.getByTestId(AGENT_CARET_TESTID).elements()).toHaveLength(0);
    // The attribute is a convenience on top of the two absences above, not the claim.
    expect(root.element().getAttribute('data-motion')).toBe('off');
  });

  test('🔴 the copy affordance is FULLY USABLE with motion disabled', async () => {
    const onCopy = vi.fn();
    renderWithProviders(<AgentOnboardingCard onCopy={onCopy} />);

    // By mouse, on the panel.
    await page.getByTestId(AGENT_PROMPT_TESTID).click();
    expect(writeText()).toHaveBeenCalledWith(AGENT_BUILD_PROMPT);
    expect(onCopy).toHaveBeenCalledTimes(1);
  });

  test('🔴 and by keyboard, still exactly once per press', async () => {
    const onCopy = vi.fn();
    renderWithProviders(<AgentOnboardingCard onCopy={onCopy} />);

    const button = page.getByRole('button', { name: AGENT_COPY_LABEL });
    await expect.element(button).toBeInTheDocument();
    (document.activeElement as HTMLElement | null)?.blur();
    await userEvent.tab();
    expect(document.activeElement).toBe(button.element());

    await userEvent.keyboard('{Enter}');
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(writeText()).toHaveBeenCalledTimes(1);
    expect(writeText()).toHaveBeenCalledWith(AGENT_BUILD_PROMPT);
  });

  test('the prompt is still fully rendered — static is a degradation, not a removal', async () => {
    renderWithProviders(<AgentOnboardingCard />);
    const panel = page.getByTestId(AGENT_PROMPT_TESTID);
    await expect.element(panel).toBeInTheDocument();
    expect(panel.element().textContent ?? '').toContain(AGENT_BUILD_PROMPT);
  });
});
