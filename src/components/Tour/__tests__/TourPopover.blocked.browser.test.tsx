import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as ToursProvider from '~/components/Tours/ToursProvider';

// `TourPopover` reads `blockedTarget` from `useTourContext()`, not from a prop — Joyride
// builds the tooltip element itself, so there is no prop seam to drive this from.
// Mounting a real `ToursProvider` to make it non-null needs a genuine insufficient-Buzz
// state, which only a running app can produce (e2e scenario 4); mocking the hook reaches
// the same branch without one.
//
// See ToursProvider's `blockedTarget` doc for why it's scoped by target, not a boolean.
vi.mock('~/components/Tours/ToursProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof ToursProvider>()),
  useTourContext: () => ({ blockedTarget: '[data-tour="gen:submit"]' }),
}));

import { TourPopover } from '~/components/Tour/TourPopover';

const baseProps = {
  index: 0,
  size: 3,
  continuous: true,
  isLastStep: false,
  backProps: { title: 'Back' },
  closeProps: { title: 'Close', onClick: () => undefined },
  primaryProps: { title: 'Next' },
  skipProps: { title: 'Skip' },
  tooltipProps: {},
} as never;

describe('a hideFooter step while the tour reports gen:submit blocked', () => {
  test('the blocked step shows its footer', async () => {
    await renderWithProviders(
      <TourPopover
        {...baseProps}
        step={{ target: '[data-tour="gen:submit"]', content: 'x', hideFooter: true }}
      />
    );

    await expect.element(page.getByRole('button', { name: 'Next' })).toBeVisible();
  });

  /**
   * Anti-bypass assertion: the terms step's real target and its real hideFooter reasons
   * (disableCloseOnEsc, disableOverlayClose, hideCloseButton — see content-gen.tour.tsx),
   * with a DIFFERENT step reported as blocked. A global boolean instead of a target match
   * makes this fail, because it would show a generic Next here too — advancing the tour
   * without the terms step's own button ever calling `setReviewed(true)`.
   */
  test('an unrelated step (the terms gate) still shows no Next or Skip', async () => {
    await renderWithProviders(
      <TourPopover
        {...baseProps}
        step={{ target: '[data-tour="gen:terms"]', content: 'y', hideFooter: true }}
      />
    );

    await expect.element(page.getByText('y')).toBeVisible();
    expect(page.getByRole('button', { name: 'Next' }).query()).toBeNull();
    expect(page.getByRole('button', { name: 'Skip' }).query()).toBeNull();
  });
});
