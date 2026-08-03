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

    // Await the "Analytics" trigger rather than the stat itself: it is the ONE
    // element this component renders in EVERY branch (stat / unavailable / "—"),
    // so a regression that stops rendering the stat fails on the assertions
    // below with a legible message instead of a locator timeout.
    await expect.element(page.getByRole('button', { name: /^analytics$/i })).toBeInTheDocument();

    // 🔴 `{ exact: true }` is load-bearing. `getByText('runs')` is substring +
    // case-insensitive, so it ALSO matches this stat's own tooltip copy ("Runs
    // and unique users in the last 30 days…") — which Mantine mounts whenever
    // the pointer rests on the stat (`mounted: !!tooltip.opened`, hover-only).
    // Vitest browser mode shares ONE browser page across every `.browser.test.tsx`
    // file, so in the full-suite CI run the pointer position left behind by an
    // earlier file can already sit over this stat at mount — the locator then
    // resolves to 2 elements and the assertion dies with a strict-mode
    // violation. That is why this discriminator has never once completed since
    // it was added in #3557: it reported safety while asserting nothing.
    const runsLabels = page.getByText('runs', { exact: true }).elements();
    expect(runsLabels).toHaveLength(1);

    // The VALUE is the point, not the word. #3557's fix must keep rendering the
    // real, measured `0` — asserting only that "runs"/"users" appear somewhere
    // would still pass if the component rendered the labels with no number at
    // all. The stat is one flat row: `0` `runs` `·` `0` `users` (+ an info icon
    // with no text), so its container's text is the whole claim under test.
    const statRow = runsLabels[0].parentElement;
    expect(statRow).not.toBeNull();
    expect(statRow?.textContent).toMatch(/^\s*0\s*runs\s*·\s*0\s*users\s*$/);

    expect(page.getByText('Analytics unavailable').elements()).toHaveLength(0);
  });
});
