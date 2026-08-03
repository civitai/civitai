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

/** Collapse whitespace so the value assertion is not markup-indentation-sensitive. */
const normalize = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim();

/**
 * Walk up from the `runs` label to the nearest ancestor whose text contains the
 * WHOLE stat (both counts and both words). Structure-tolerant: an extra wrapper
 * element around the label changes which ancestor matches, not whether one does,
 * so a cosmetic markup change can no longer masquerade as a value regression.
 * Bounded so a broken tree fails fast instead of walking to <html>.
 */
function findStatRow(label: Element): Element | null {
  let node: Element | null = label;
  for (let hops = 0; node && hops < 6; hops++, node = node.parentElement) {
    const text = normalize(node.textContent);
    if (/runs/.test(text) && /users/.test(text)) return node;
  }
  return null;
}

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
    // violation.
    //
    // 🔴 The real failure mode is OSCILLATION, not a permanent red — and that is
    // worse. Vitest's BaseSequencer sorts failed-first, then longest-duration
    // first, from a cache persisted on the preview workspace's reused volume. So
    // a run in which this file times out promotes it to run FIRST next time,
    // where the pointer is still at (0,0) and nothing is hovered — and it passes.
    // Measured on the 5 most recent PRs containing #3557: 3 had
    // `preview / component-tests` green. So since #3557 this test has alternated
    // between a ~20s strict-mode timeout and a pass that asserted nothing about
    // the value. "Sometimes green, never meaningful" is exactly the shape that
    // survives review.
    const runsLabels = page.getByText('runs', { exact: true }).elements();
    expect(runsLabels).toHaveLength(1);

    // The VALUE is the point, not the word. #3557's fix must keep rendering the
    // real, measured `0` — asserting only that "runs"/"users" appear somewhere
    // would still pass if the component rendered the labels with no number at all.
    //
    // Walk UP to the nearest ancestor holding the whole stat rather than using
    // `.parentElement`. The stat is a flat Group of sibling <Text> nodes today,
    // so the direct parent happens to be that row — but wrapping the label in a
    // single <span> (zero visual change) would then make this assert against the
    // text "runs" alone and fail with a message about the VALUE, sending a
    // maintainer hunting a data regression instead of a markup change.
    const statRow = findStatRow(runsLabels[0]);
    expect(
      statRow,
      'could not find an ancestor containing the whole "N runs · N users" stat — ' +
        'the component markup changed shape; this is NOT a value regression'
    ).not.toBeNull();

    // Separator-tolerant on purpose (`·` vs `•` is cosmetic), but the two zeros
    // are mandatory — that is the entire claim under test.
    expect(normalize(statRow!.textContent)).toMatch(/^0\s*runs\s*[^\d]*0\s*users$/);

    expect(page.getByText('Analytics unavailable').elements()).toHaveLength(0);
  });
});
