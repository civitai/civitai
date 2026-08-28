import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import { TourPopover } from '~/components/Tour/TourPopover';

// No `ToursProvider` wrapper: `useTourContext` falls back to the context default, where
// `stepBlocked` is false. Mounting the real provider would drag in trpc, the current-user
// hook and the feature flags, none of which this assertion is about.
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

describe('a hideFooter step', () => {
  /**
   * The negative control for the blocked case, which only a real insufficient-Buzz
   * state can produce (e2e scenario 4). Without this, a footer that rendered
   * unconditionally would pass that test for the wrong reason.
   */
  test('shows no Next or Skip while the step is not blocked', async () => {
    await renderWithProviders(
      <TourPopover {...baseProps} step={{ target: 'body', content: 'x', hideFooter: true }} />
    );

    await expect.element(page.getByText('x')).toBeVisible();
    expect(page.getByRole('button', { name: 'Next' }).query()).toBeNull();
    expect(page.getByRole('button', { name: 'Skip' }).query()).toBeNull();
  });

  test('shows them for a step that never hid its footer', async () => {
    await renderWithProviders(
      <TourPopover {...baseProps} step={{ target: 'body', content: 'y' }} />
    );

    await expect.element(page.getByRole('button', { name: 'Next' })).toBeVisible();
  });
});
