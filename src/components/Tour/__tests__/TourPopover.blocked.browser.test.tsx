import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as ToursProvider from '~/components/Tours/ToursProvider';

// `TourPopover` reads `stepBlocked` from `useTourContext()`, not from a prop — Joyride
// builds the tooltip element itself, so there is no prop seam to drive this from.
// Mounting a real `ToursProvider` to make `stepBlocked` true needs a genuine
// insufficient-Buzz state, which only a running app can produce (e2e scenario 4);
// mocking the hook reaches the same branch without one.
vi.mock('~/components/Tours/ToursProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof ToursProvider>()),
  useTourContext: () => ({ stepBlocked: true }),
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

describe('a hideFooter step whose tour reports it blocked', () => {
  test('shows its footer anyway', async () => {
    await renderWithProviders(
      <TourPopover
        {...baseProps}
        step={{ target: 'body', content: 'x', hideFooter: true }}
      />
    );

    await expect.element(page.getByRole('button', { name: 'Next' })).toBeVisible();
  });
});
