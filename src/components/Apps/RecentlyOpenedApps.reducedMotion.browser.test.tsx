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

/** The tile's class list — the motion layer is a class, not an inline style. */
function tileClasses(): string {
  return page.getByTestId('apps-recent-rail-tile').element().className;
}

/** Mantine/CSS-module class names are hashed, so match the stable stem. */
const MOTION_CLASS = /motion/;

describe('RecentlyOpenedListingsView — prefers-reduced-motion', () => {
  test('reduced motion → the tile renders WITHOUT the motion class', async () => {
    mocks.reduceMotion = true;
    renderWithProviders(<RecentlyOpenedListingsView entries={[entry]} canOpenPage />);
    await expect.element(page.getByTestId('apps-recent-rail-tile')).toBeInTheDocument();
    expect(tileClasses()).not.toMatch(MOTION_CLASS);
  });

  test('motion allowed → the SAME tile DOES carry the motion class', async () => {
    // The other half of the pair: without this, deleting the animation entirely
    // would leave the test above green.
    mocks.reduceMotion = false;
    renderWithProviders(<RecentlyOpenedListingsView entries={[entry]} canOpenPage />);
    await expect.element(page.getByTestId('apps-recent-rail-tile')).toBeInTheDocument();
    expect(tileClasses()).toMatch(MOTION_CLASS);
  });

  test('reduced motion changes NOTHING else — both targets still render and work', async () => {
    mocks.reduceMotion = true;
    renderWithProviders(<RecentlyOpenedListingsView entries={[entry]} canOpenPage />);
    await expect
      .element(page.getByTestId('apps-recent-rail-item'))
      .toHaveAttribute('href', '/apps/run/gen-matrix');
    await expect
      .element(page.getByRole('link', { name: 'Open Gen Matrix' }))
      .toBeInTheDocument();
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
