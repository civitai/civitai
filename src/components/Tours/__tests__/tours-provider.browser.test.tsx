import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';
// Type-only: gives the `importOriginal` spread below the real module's type
// without an `import()` type annotation (banned by consistent-type-imports).
import type * as TrpcModule from '~/utils/trpc';

const mocks = vi.hoisted(() => ({ setSettings: vi.fn() }));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1 }) }));
vi.mock('~/providers/FeatureFlagsProvider', () => ({ useFeatureFlags: () => ({ appTour: false }) }));
vi.mock('~/components/UserSettings/hooks', () => ({
  useMutateUserSettings: () => ({ mutate: mocks.setSettings }),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/auctions',
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof TrpcModule>();
  return {
    ...actual,
    trpc: {
      user: {
        getSettings: { useQuery: () => ({ data: { tourSettings: {} }, isInitialLoading: false }) },
      },
    },
  };
});

import { ToursProvider, useTourContext } from '~/components/Tours/ToursProvider';

// `appTour: false` keeps LazyTours (and therefore Joyride) unmounted — this file is
// about provider state, and mounting Joyride would add an overlay over the probe.
function Probe() {
  const { runTour, pauseTour, closeTour, run, currentStep } = useTourContext();
  return (
    <div>
      <span data-testid="run">{String(run)}</span>
      <span data-testid="step">{currentStep}</span>
      <button onClick={() => runTour({ key: 'auction', step: 0, forceRun: true })}>start</button>
      <button onClick={() => pauseTour()}>pause</button>
      <button onClick={() => closeTour({ reason: 'failed' })}>fail</button>
    </div>
  );
}

const renderProbe = () =>
  renderWithProviders(
    <ToursProvider>
      <Probe />
    </ToursProvider>
  );

describe('pauseTour', () => {
  beforeEach(() => mocks.setSettings.mockReset());

  /**
   * The step-transition sequence pauses the tour while `onNext` navigates. With
   * `forceRun` set — every help-button re-entry, i.e. the path a human tests with —
   * the old `run` expression kept Joyride rendering against a target the navigation
   * was tearing down, which fired TARGET_NOT_FOUND and advanced mid-await.
   */
  test('stops the render even while forceRun is set', async () => {
    await renderProbe();
    await page.getByText('start').click();
    await expect.element(page.getByTestId('run')).toHaveTextContent('true');

    await page.getByText('pause').click();
    await expect.element(page.getByTestId('run')).toHaveTextContent('false');
  });

  test('persists progress without marking the tour completed', async () => {
    await renderProbe();
    await page.getByText('start').click();
    mocks.setSettings.mockClear();
    await page.getByText('pause').click();

    expect(mocks.setSettings).toHaveBeenCalledWith({
      tourSettings: { auction: expect.objectContaining({ completed: false }) },
    });
  });
});

describe('closeTour', () => {
  beforeEach(() => mocks.setSettings.mockReset());

  /**
   * A failed tour is still persisted as completed — every reachable tour has a
   * re-entry button, and withholding completion would re-fire a broken tour on
   * every page load forever. The reason is what makes the failure findable.
   */
  test('marks completed and records the reason for a failure', async () => {
    await renderProbe();
    await page.getByText('start').click();
    mocks.setSettings.mockClear();
    await page.getByText('fail').click();

    expect(mocks.setSettings).toHaveBeenCalledWith({
      tourSettings: { auction: expect.objectContaining({ completed: true, reason: 'failed' }) },
    });
  });

  test('resets the step so a re-entry starts clean', async () => {
    await renderProbe();
    await page.getByText('start').click();
    await page.getByText('fail').click();

    await expect.element(page.getByTestId('step')).toHaveTextContent('0');
  });
});
