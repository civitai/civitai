import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
// Type-only namespace import, so the spread below keeps the real module's type. NOT
// `typeof import('@mantine/hooks')` — the sibling `ExternalSubmitForm.reducedMotion.browser.test.tsx`
// uses that form and reports `@typescript-eslint/consistent-type-imports` under `pnpm eslint`
// (measured 2026-10-03), so it is a pre-existing violation rather than an exempt pattern.
import type * as MantineHooks from '@mantine/hooks';

/**
 * `AgentOnboardingCard` must honour `prefers-reduced-motion`.
 *
 * 🔴 ONE TEST, BECAUSE ONE ARM IS ALL THIS FILE CAN REACH THAT THE ANIMATED SUITE CANNOT.
 * `motionOn = animated && !reduceMotion`, so `animated={false}` and `useReducedMotion() === true`
 * are the same code path — the component's own prop doc says so — and the animated suite's
 * `animated={false}` test already pins the four absences and that the affordance still copies.
 * What only a mocked hook can reach is that `useReducedMotion` is the input `motionOn` reads at
 * all; everything else this file used to assert re-ran a path already covered, behind a
 * `vi.mock` whose silent failure would have left every absence passing for the wrong reason.
 *
 * 🔴 THE RENDER IS AWAITED. `off` is also the real hook's first-render default, so awaiting is
 * what makes this assertion about the mocked value rather than about the clock.
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
  AGENT_GLYPH_TESTID,
  AGENT_ONBOARDING_TESTID,
  AGENT_ROW_TESTID,
  AGENT_SHIMMER_TESTID,
} = await import('./AgentOnboardingCard');

describe('AgentOnboardingCard — reduced motion', () => {
  test('🔴 `useReducedMotion` alone turns the card static: ring still, no caret, rows or pop', async () => {
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
});
