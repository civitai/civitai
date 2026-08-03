import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcModule from '~/utils/trpc';

/**
 * The panel must never render a dashboard out of counters that were never
 * measured. `getMyAppAnalytics` returns all-zero counters both for a real app
 * with no activity and for a caller who was never allowed to query (dark
 * `appBlocks` flag) — only `unavailable` separates them, and rendering the
 * former shape for the latter fabricates a clean zero dashboard.
 */

const mocks = vi.hoisted(() => ({ analytics: { current: undefined as unknown } }));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    blocks: {
      getMyApps: { useQuery: () => ({ data: [], isLoading: false }) },
      getMyAppAnalytics: {
        useQuery: () => ({ data: mocks.analytics.current, isLoading: false, error: null }),
      },
    },
  },
}));

// Chart.js needs a real canvas + sizing; the series rendering isn't under test.
vi.mock('react-chartjs-2', () => ({ Line: () => <div data-testid="chart" /> }));

const { AppAnalyticsPanel } = await import('./AppAnalyticsPanel');

const ZEROED = {
  range: { from: new Date(0), to: new Date(0), granularity: 'day' as const },
  notOwned: false,
  installs: { total: 0, active: 0, series: [] },
  runs: { count: 0, buzzSpent: 0, series: [] },
  buzzPurchased: { count: 0, buzzAmount: 0, grossCents: 0 },
  engagement: { apiCalls: 0, activeUsers: 0, errorRate: 0, topScopes: [], topEndpoints: [] },
};

describe('AppAnalyticsPanel — unavailable vs genuine zero', () => {
  test('dark flag (notEntitled): shows an honest unavailable state, NOT a zero dashboard', async () => {
    mocks.analytics.current = { ...ZEROED, notOwned: true, unavailable: 'notEntitled' };
    renderWithProviders(<AppAnalyticsPanel scopedAppBlockId="apb_1" />);

    await expect.element(page.getByText('Analytics unavailable')).toBeInTheDocument();
    await expect.element(page.getByText(/not a report of zero activity/i)).toBeInTheDocument();
    // The fabricated dashboard must be gone entirely.
    expect(page.getByText('Active installs').elements()).toHaveLength(0);
    expect(page.getByText('Runs (range)').elements()).toHaveLength(0);
  });

  test('notOwned: shows the ownership message rather than zeroed metrics', async () => {
    mocks.analytics.current = { ...ZEROED, notOwned: true, unavailable: 'notOwned' };
    renderWithProviders(<AppAnalyticsPanel scopedAppBlockId="apb_1" />);

    await expect.element(page.getByText('Analytics unavailable')).toBeInTheDocument();
    await expect.element(page.getByText(/do not own this app/i)).toBeInTheDocument();
    expect(page.getByText('Active installs').elements()).toHaveLength(0);
  });

  test('DISCRIMINATOR: a genuine owned-but-empty result still renders the real dashboard', async () => {
    // Byte-identical counters to the two cases above — only `unavailable` is
    // absent. If a later change flags this path too, the author loses a
    // dashboard they are entitled to; if it stops flagging the others, the
    // fabricated zero comes back.
    mocks.analytics.current = { ...ZEROED };
    renderWithProviders(<AppAnalyticsPanel scopedAppBlockId="apb_1" />);

    await expect.element(page.getByText('Active installs')).toBeInTheDocument();
    await expect.element(page.getByText('Runs (range)')).toBeInTheDocument();
    expect(page.getByText('Analytics unavailable').elements()).toHaveLength(0);
  });
});

/**
 * The "Top endpoints" table renders the aggregate's GROUP BY key. #3561 bounded that
 * column, which promoted the internal tokens to the TOP rows — so this table became
 * the most prominent place raw internal strings appear on the panel.
 *
 * `endpointBucketLabel` is unit-tested on its own (endpoint-bucket-label.test.ts);
 * what these two cases pin is the WIRING — that the render site actually calls it.
 * A helper nothing calls is the failure mode this exists to prevent.
 */
describe('AppAnalyticsPanel — Top endpoints are humanised, not raw tokens', () => {
  test('a bounded token renders as an operation name and the raw token is absent', async () => {
    mocks.analytics.current = {
      ...ZEROED,
      engagement: {
        ...ZEROED.engagement,
        apiCalls: 250,
        topEndpoints: [
          { endpoint: 'workflow:submit', count: 245 },
          { endpoint: 'storage:set', count: 5 },
        ],
      },
    };
    renderWithProviders(<AppAnalyticsPanel scopedAppBlockId="apb_1" />);

    await expect.element(page.getByText('Generation submits')).toBeInTheDocument();
    await expect.element(page.getByText('App storage writes')).toBeInTheDocument();
    // The raw tokens must not survive anywhere in the rendered output.
    expect(page.getByText('workflow:submit').elements()).toHaveLength(0);
    expect(page.getByText('storage:set').elements()).toHaveLength(0);
    // And it must not have degraded to the per-row humaniser's no-detail output.
    expect(page.getByText('(no workflow id)').elements()).toHaveLength(0);
  });

  test('a legacy tailed bucket keeps its tail so two such rows stay distinguishable', async () => {
    mocks.analytics.current = {
      ...ZEROED,
      engagement: {
        ...ZEROED.engagement,
        apiCalls: 2,
        topEndpoints: [
          { endpoint: 'workflow:submit:wf_aaa', count: 1 },
          { endpoint: 'workflow:submit:wf_bbb', count: 1 },
        ],
      },
    };
    renderWithProviders(<AppAnalyticsPanel scopedAppBlockId="apb_1" />);

    await expect.element(page.getByText('Generation submits (wf_aaa)')).toBeInTheDocument();
    await expect.element(page.getByText('Generation submits (wf_bbb)')).toBeInTheDocument();
  });
});
