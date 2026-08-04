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
 * The two "top N" cards render the aggregates' GROUP BY keys. #3561 bounded the endpoint
 * column, which promoted the internal tokens to the TOP rows — so those cards became the
 * most prominent place raw internal strings appear on the panel.
 *
 * The label functions are unit-tested on their own (analytics-bucket-labels.test.ts);
 * what these cases pin is the WIRING — that both render sites actually call them. A
 * helper nothing calls is the failure mode this exists to prevent.
 *
 * `getByText` matches on SUBSTRING, which makes the negative assertions stronger, not
 * weaker: `getByText('workflow:submit')` would also match a leaked `workflow:submit:wf_x`.
 */
describe('AppAnalyticsPanel — top-N cards are humanised, not raw tokens', () => {
  test('bounded endpoint tokens render as operation names and the raw tokens are absent', async () => {
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

    // Await the panel's always-rendered heading first, so a regression that stops
    // rendering the table fails on an assertion below with a legible message rather
    // than on a locator timeout here.
    await expect.element(page.getByText('Top endpoints')).toBeInTheDocument();

    // 🔴 `{ exact: true }` IS LOAD-BEARING, and its absence is what turned
    // `preview / component-tests` red at this PR's audit-fix round.
    //
    // `getByText` is substring + case-insensitive, and the "Runs (range)" stat's own
    // tooltip copy begins *"Generations run through your app within the selected
    // range…"* (AppAnalyticsPanel.tsx). Mantine mounts that tooltip only while the
    // pointer rests on the stat (hover-only), and vitest browser mode shares ONE
    // browser page across every `.browser.test.tsx` file — so the pointer position
    // left behind by an earlier file can already sit over the stat at mount. The
    // locator then resolves to 2 elements and this dies with a strict-mode violation
    // after the matcher timeout.
    //
    // 🔴 The failure mode is OSCILLATION, not a permanent red, which is worse:
    // vitest's BaseSequencer sorts failed-first from a cache persisted on the preview
    // workspace's reused volume, so a run where this file times out promotes it to
    // run FIRST next time — pointer still at (0,0), nothing hovered, and it passes.
    // Green on some PRs and red on others off the same base is the signature.
    //
    // 🔴 This collision was INTRODUCED by renaming the label. The previous value,
    // 'Generation submits', does not substring-match that tooltip sentence; 'Generations'
    // does. Verified by computation, not by eye. Same defect class as #3593.
    const generationsRows = page.getByText('Generations', { exact: true }).elements();
    expect(generationsRows).toHaveLength(1);
    await expect.element(page.getByText('App-local storage writes')).toBeInTheDocument();
    // The raw tokens must not survive anywhere in the rendered output. These stay
    // SUBSTRING on purpose — that makes a negative assertion stronger, since
    // `getByText('workflow:submit')` also catches a leaked `workflow:submit:wf_x`.
    expect(page.getByText('workflow:submit').elements()).toHaveLength(0);
    expect(page.getByText('storage:set').elements()).toHaveLength(0);
    // And must not have degraded to either Activity-panel labeller's output.
    expect(page.getByText('(no workflow id)').elements()).toHaveLength(0);
    expect(page.getByText('Generated an image').elements()).toHaveLength(0);
  });

  /**
   * 🔴 REGRESSION GUARD for the `{ exact: true }` above — reproduces the exact state that
   * broke `preview / component-tests`, so reverting the anchor fails a test rather than
   * merely contradicting a comment.
   *
   * The condition is: the "Runs (range)" stat's hover-only tooltip is MOUNTED (its copy
   * begins "Generations run through your app…"), which a shared browser page can carry in
   * from an earlier `.browser.test.tsx` file. Here it is produced deliberately by hovering
   * the tooltip's real target.
   *
   * Note the target is the 14px `IconInfoCircle`, NOT the label — hovering the "Runs (range)"
   * text does not mount it, which is why this never reproduced by hovering the obvious thing.
   *
   * Measured: with the tooltip mounted, `getByText('Generations')` (no anchor) resolves to 2
   * elements and dies with `strict mode violation`; the anchored form resolves to 1.
   */
  test('the Generations label stays unambiguous even with the Runs tooltip mounted', async () => {
    mocks.analytics.current = {
      ...ZEROED,
      engagement: {
        ...ZEROED.engagement,
        apiCalls: 245,
        topEndpoints: [{ endpoint: 'workflow:submit', count: 245 }],
      },
    };
    renderWithProviders(<AppAnalyticsPanel scopedAppBlockId="apb_1" />);
    await expect.element(page.getByText('Top endpoints')).toBeInTheDocument();

    // Park the pointer on the tooltip's target: the info icon inside the Runs stat.
    const runsLabel = Array.from(document.querySelectorAll('*')).find(
      (e) => e.textContent?.trim() === 'Runs (range)' && e.children.length === 0
    );
    let icon: Element | null = null;
    let node: Element | null = runsLabel ?? null;
    for (let i = 0; node && i < 5 && !icon; i++, node = node.parentElement) {
      icon = node.querySelector('svg');
    }
    expect(icon, 'the Runs stat should have an info icon to hover').not.toBeNull();
    await page.elementLocator(icon as Element).hover();

    // 🔴 POSITIVE CONTROL, and it is what stops this test passing vacuously. If the hover
    // silently stops working — a markup change, a Mantine upgrade, a renamed tooltip — the
    // ambiguity below can no longer arise and the anchor assertion would pass while testing
    // nothing. Fail loudly on that instead.
    await expect
      .element(page.getByText('Generations run through your app', { exact: false }))
      .toBeInTheDocument();

    // The whole point: with that tooltip mounted, the anchored locator still finds exactly
    // one element. Drop `{ exact: true }` and this is a strict-mode violation.
    expect(page.getByText('Generations', { exact: true }).elements()).toHaveLength(1);
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

    await expect.element(page.getByText('Generations (wf_aaa)')).toBeInTheDocument();
    await expect.element(page.getByText('Generations (wf_bbb)')).toBeInTheDocument();
  });

  test('the `pending` sentinel is never surfaced as a status', async () => {
    mocks.analytics.current = {
      ...ZEROED,
      engagement: {
        ...ZEROED.engagement,
        apiCalls: 3,
        topEndpoints: [{ endpoint: 'workflow:submit:pending', count: 3 }],
      },
    };
    renderWithProviders(<AppAnalyticsPanel scopedAppBlockId="apb_1" />);

    await expect.element(page.getByText('Generations (no id)')).toBeInTheDocument();
    // "pending" would read as "still in flight" — the opposite of what the row means.
    expect(page.getByText('pending').elements()).toHaveLength(0);
  });

  test('the adjacent Top scopes card is humanised too', async () => {
    mocks.analytics.current = {
      ...ZEROED,
      engagement: {
        ...ZEROED.engagement,
        apiCalls: 300,
        topScopes: [
          { scope: 'ai:write:budgeted', count: 245 },
          { scope: '(any-token)', count: 40 },
        ],
      },
    };
    renderWithProviders(<AppAnalyticsPanel scopedAppBlockId="apb_1" />);

    await expect.element(page.getByText('AI workflow submits')).toBeInTheDocument();
    await expect
      .element(page.getByText('Any-token routes (no scope required)'))
      .toBeInTheDocument();
    expect(page.getByText('ai:write:budgeted').elements()).toHaveLength(0);
  });
});
