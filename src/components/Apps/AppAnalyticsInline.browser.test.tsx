import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcModule from '~/utils/trpc';

/**
 * The inline stat read `runs.count` / `engagement.activeUsers` straight off the
 * payload, so a never-measured (dark-flag) response rendered a confident
 * "0 runs · 0 users" on every approved app row. It must show the counters only
 * when they are an actual measurement.
 */

const mocks = vi.hoisted(() => ({ analytics: { current: undefined as unknown } }));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    blocks: {
      getMyAppAnalytics: {
        useQuery: () => ({ data: mocks.analytics.current, isLoading: false, error: null }),
      },
    },
  },
}));

vi.mock('~/components/AppBlocks/AppAnalyticsPanel', () => ({
  AppAnalyticsPanel: () => <div data-testid="analytics-panel" />,
}));

const { AppAnalyticsInline } = await import('./AppAnalyticsInline');

describe('AppAnalyticsInline — unavailable vs genuine zero', () => {
  test('dark flag: renders "Analytics unavailable", never a fabricated 0 runs / 0 users', async () => {
    mocks.analytics.current = {
      runs: { count: 0 },
      engagement: { activeUsers: 0 },
      unavailable: 'notEntitled',
    };
    renderWithProviders(<AppAnalyticsInline appBlockId="apb_1" appLabel="My App" />);

    await expect.element(page.getByText('Analytics unavailable')).toBeInTheDocument();
    expect(page.getByText('runs').elements()).toHaveLength(0);
    expect(page.getByText('users').elements()).toHaveLength(0);
  });

  test('DISCRIMINATOR: a genuine measured zero still renders the 0 runs / 0 users stat', async () => {
    // Identical counters to the case above — only `unavailable` differs. A real
    // app with no activity yet must keep showing its (accurate) zeros.
    mocks.analytics.current = { runs: { count: 0 }, engagement: { activeUsers: 0 } };
    renderWithProviders(<AppAnalyticsInline appBlockId="apb_1" appLabel="My App" />);

    await expect.element(page.getByText('runs')).toBeInTheDocument();
    await expect.element(page.getByText('users')).toBeInTheDocument();
    expect(page.getByText('Analytics unavailable').elements()).toHaveLength(0);
  });
});
