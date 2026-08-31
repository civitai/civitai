import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type { ResolvedRecentApp } from '~/components/Apps/recentAppsRail';
// Type-only NAMESPACE import for the `importOriginal` spread below. The sibling
// `ExternalSubmitForm.reducedMotion.browser.test.tsx` writes
// `importOriginal<typeof import('@mantine/hooks')>()` inline, which
// @typescript-eslint/consistent-type-imports rejects (it is a pre-existing lint
// error on that file) — this is the form that lints clean.
import type * as MantineHooks from '@mantine/hooks';

/**
 * The "Recently opened" rail tile's hover/press animation must honour
 * `prefers-reduced-motion`. Mirrors `ExternalSubmitForm.reducedMotion.browser.test.tsx`
 * and the `wizardMotion.tsx` precedent: with the shared `useReducedMotion` hook
 * forced true the component SHORT-CIRCUITS — it simply omits the motion class —
 * so the reduced-motion DOM is identical to a plain render and is cheap to
 * assert. Only `useReducedMotion` is overridden; every other `@mantine/hooks`
 * export stays real, so Mantine core keeps working.
 *
 * 🔴 THE ASSERTION IS TWO-SIDED ON PURPOSE. Asserting only "no motion class under
 * reduced motion" passes trivially if the class is never applied at all (i.e. if
 * someone deletes the animation) — a guard that reports safety while the feature
 * is gone. Each test below pins BOTH states.
 */

const mocks = vi.hoisted(() => ({ reduceMotion: true }));

vi.mock('@mantine/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof MantineHooks>();
  return { ...actual, useReducedMotion: () => mocks.reduceMotion };
});

const { RecentlyOpenedListingsView } = await import('./RecentlyOpenedApps');

const entry: ResolvedRecentApp = {
  id: 'ab_1',
  slug: 'gen-matrix',
  blockId: 'gen-matrix',
  kind: 'onsite',
  hasPage: true,
  name: 'Gen Matrix',
};

const tile = () => page.getByTestId('apps-recent-rail-tile');

/** The tile's class list — the motion layer is a class, not an inline style. */
function tileClasses(): string {
  return tile().element().className;
}

/**
 * The utilities that ACTUALLY animate. Deliberately not a `/motion/` substring
 * match on the class list: `TILE_MOTION_CLASS` legitimately contains
 * `motion-reduce:` utilities, so `/motion/` would be true for the wrong reason
 * AND would stay true if the real transition/transform utilities were deleted.
 */
const ANIMATING_UTILITIES = ['transition-[transform,box-shadow,border-color]', 'active:scale-'];

describe('RecentlyOpenedListingsView — prefers-reduced-motion', () => {
  test('reduced motion → the tile renders with NO animation utilities', async () => {
    mocks.reduceMotion = true;
    renderWithProviders(<RecentlyOpenedListingsView entries={[entry]} canOpenPage />);
    await expect.element(tile()).toBeInTheDocument();
    await expect.element(tile()).toHaveAttribute('data-motion', 'reduced');
    for (const u of ANIMATING_UTILITIES) expect(tileClasses()).not.toContain(u);
  });

  test('motion allowed → the SAME tile DOES carry them', async () => {
    // The other half of the pair: without this, deleting the animation entirely
    // would leave the test above green.
    mocks.reduceMotion = false;
    renderWithProviders(<RecentlyOpenedListingsView entries={[entry]} canOpenPage />);
    await expect.element(tile()).toBeInTheDocument();
    await expect.element(tile()).toHaveAttribute('data-motion', 'on');
    for (const u of ANIMATING_UTILITIES) expect(tileClasses()).toContain(u);
  });

  test('the hover treatment is gated on (hover: hover) — it must not stick after a tap', async () => {
    // Tailwind only compiles a bare `hover:` to a hover-capability media query
    // when `hoverOnlyWhenSupported` is set, and this repo does not set it. So the
    // arbitrary variant is load-bearing: without it a tapped tile stays visually
    // lifted on touch, which reads as selected state rather than feedback.
    mocks.reduceMotion = false;
    renderWithProviders(<RecentlyOpenedListingsView entries={[entry]} canOpenPage />);
    await expect.element(tile()).toBeInTheDocument();
    const cls = tileClasses();
    expect(cls).toContain('[@media(hover:hover)_and_(pointer:fine)]:hover:');
    // …and NO ungated `hover:` utility slipped in alongside it.
    expect(cls).not.toMatch(/(^|\s)hover:/);
    // Press feedback is NOT gated — `:active` is momentary and is the one
    // affordance a touch viewer gets.
    expect(cls).toMatch(/(^|\s)active:/);
  });

  test('reduced motion changes NOTHING else — both targets still render and work', async () => {
    mocks.reduceMotion = true;
    renderWithProviders(<RecentlyOpenedListingsView entries={[entry]} canOpenPage />);
    await expect
      .element(page.getByTestId('apps-recent-rail-item'))
      .toHaveAttribute('href', '/apps/run/gen-matrix');
    await expect.element(page.getByRole('link', { name: 'Open Gen Matrix' })).toBeInTheDocument();
  });

  test('the empty-rail INVARIANT survives reduced motion (renders null, no spacer)', async () => {
    mocks.reduceMotion = true;
    renderWithProviders(
      <>
        <div data-testid="render-barrier" />
        <RecentlyOpenedListingsView entries={[]} canOpenPage />
      </>
    );
    // Barrier first: `render()` commits on a later task, so a bare "is absent"
    // assertion straight after render observes an empty container and is
    // structurally unfailable. See the same note in RecentlyOpenedApps.browser.test.tsx.
    await expect.element(page.getByTestId('render-barrier')).toBeInTheDocument();
    expect(page.getByTestId('apps-recent-rail').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-recent-rail-tile').elements()).toHaveLength(0);
    expect(page.getByText('Recently opened').elements()).toHaveLength(0);
  });
});
