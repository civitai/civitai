import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';
import type * as TrpcModule from '~/utils/trpc';

/**
 * The panel must never render a dashboard out of counters that were never
 * measured. `getMyAppAnalytics` returns all-zero counters both for a real app
 * with no activity and for a caller who was never allowed to query (dark
 * `appBlocks` flag) — only `unavailable` separates them, and rendering the
 * former shape for the latter fabricates a clean zero dashboard.
 */

const mocks = vi.hoisted(() => ({
  analytics: { current: undefined as unknown },
  apps: { current: [] as unknown[] },
  queryInputs: [] as unknown[],
  cardInputs: [] as unknown[],
  cardOptions: [] as unknown[],
  cardError: { current: null as unknown },
  isPlaceholderData: { current: false },
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy({
    'blocks.getMyApps': { useQuery: () => ({ data: mocks.apps.current, isLoading: false }) },
    'blocks.getMyAppAnalytics': {
      useQuery: (input: unknown) => {
        mocks.queryInputs.push(input);
        return { data: mocks.analytics.current, isLoading: false, error: null };
      },
    },
    // The card's own read. Fixtures carry its section under `customEvents` beside the panel
    // payload, so one fixture object drives both reads.
    'blocks.getMyAppCustomEvents': {
      useQuery: (input: unknown, options: unknown) => {
        mocks.cardInputs.push(input);
        mocks.cardOptions.push(options);
        const section = (mocks.analytics.current as { customEvents?: unknown } | undefined)
          ?.customEvents;
        return {
          // A refetch that errors keeps the previous data, so the error must win over it.
          data: section,
          isLoading: false,
          isPlaceholderData: mocks.isPlaceholderData.current,
          error: mocks.cardError.current,
        };
      },
    },
  }),
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
  // A genuinely-MEASURED zero: no `unavailable` key. The impression card
  // branches on that key, so its absence here is meaningful, not filler.
  views: { count: 0, uniqueViewers: 0, anonCount: 0 },
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
 * Impressions are the one card backed by ClickHouse rather than Postgres, so it
 * has a failure mode none of the others do: the store can be unreachable while
 * every neighbouring number is genuinely measured. Rendering "0" there is the
 * fabricated zero #3557/#3581 fixed elsewhere — an author reads "nobody looked
 * at my app" when the truth is "we did not ask".
 *
 * Locators are anchored with `{ exact: true }`: `getByText` is substring +
 * case-insensitive in browser mode, and the card's own tooltip copy contains
 * the word "views". Leaving them unanchored is exactly the strict-mode
 * ambiguity civitai#3593 and civitai#3606 each had to unpick.
 */
describe('AppAnalyticsPanel — impressions: measured vs unmeasured', () => {
  test('a measured impression count renders the number and the unique-viewer breakdown', async () => {
    mocks.analytics.current = {
      ...ZEROED,
      views: { count: 124, uniqueViewers: 12, anonCount: 40 },
    };
    renderWithProviders(<AppAnalyticsPanel scopedAppBlockId="apb_1" />);

    await expect.element(page.getByText('App loads (range)', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText('124', { exact: true })).toBeInTheDocument();
    await expect
      .element(page.getByText('12 unique viewers · 40 signed-out loads', { exact: true }))
      .toBeInTheDocument();
    expect(page.getByText('Not measured right now', { exact: true }).elements()).toHaveLength(0);
  });

  test('a measured ZERO renders 0 — it is a real answer, not an outage', async () => {
    // ZEROED carries views without `unavailable`.
    mocks.analytics.current = { ...ZEROED };
    renderWithProviders(<AppAnalyticsPanel scopedAppBlockId="apb_1" />);

    await expect.element(page.getByText('App loads (range)', { exact: true })).toBeInTheDocument();
    expect(page.getByText('Not measured right now', { exact: true }).elements()).toHaveLength(0);
    // Singular, and no signed-out clause when there are none.
    await expect.element(page.getByText('0 unique viewers', { exact: true })).toBeInTheDocument();
  });

  test('an UNAVAILABLE impression read renders an em dash, never a zero', async () => {
    mocks.analytics.current = {
      ...ZEROED,
      views: { count: 0, uniqueViewers: 0, anonCount: 0, unavailable: true },
    };
    renderWithProviders(<AppAnalyticsPanel scopedAppBlockId="apb_1" />);

    await expect.element(page.getByText('App loads (range)', { exact: true })).toBeInTheDocument();
    // 🔴 Assert the em dash ITSELF, not just the sub-line. Asserting only the
    // sub-line lets the headline silently revert to `views.count` — i.e. a
    // literal "0" above the words "Not measured right now" — and the test
    // still passes. Measured: a mutation doing exactly that SURVIVED until
    // this line existed.
    await expect.element(page.getByText('—', { exact: true })).toBeInTheDocument();
    await expect
      .element(page.getByText('Not measured right now', { exact: true }))
      .toBeInTheDocument();
    // The whole point: no fabricated count anywhere on the card.
    expect(page.getByText('0 unique viewers', { exact: true }).elements()).toHaveLength(0);

    // ...and the OTHER cards must still render. A ClickHouse outage degrades
    // one card; flagging the whole payload would throw away good data.
    await expect.element(page.getByText('Active installs')).toBeInTheDocument();
    await expect.element(page.getByText('Runs (range)')).toBeInTheDocument();
    expect(page.getByText('Analytics unavailable').elements()).toHaveLength(0);
  });

  test('an ABSENT views section (old pod, rolling deploy) renders unknown, not zero', async () => {
    // tRPC output is not zod-validated on the client, so during a rollout a new
    // bundle can receive a payload from an old pod with no `views` key at all.
    // Two failure modes to exclude: an unguarded read throwing in render (the
    // panel would show nothing at all), and the absent section decoding as a
    // measured zero — the fabricated zero, one level down from `notOwned`.
    const { views: _omitted, ...withoutViews } = ZEROED;
    mocks.analytics.current = withoutViews;
    renderWithProviders(<AppAnalyticsPanel scopedAppBlockId="apb_1" />);

    // Rendering at all proves there was no TypeError.
    await expect.element(page.getByText('App loads (range)', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText('—', { exact: true })).toBeInTheDocument();
    await expect
      .element(page.getByText('Not measured right now', { exact: true }))
      .toBeInTheDocument();
    expect(page.getByText('0 unique viewers', { exact: true }).elements()).toHaveLength(0);
    // Everything the old pod DID send is real and must still render.
    await expect.element(page.getByText('Active installs')).toBeInTheDocument();
  });

  test('every container breakpoint is a real CSS length, not a theme key name', async () => {
    /*
     * Regression guard for a defect that shipped and was inert-by-default.
     *
     * Mantine's SimpleGrid `type="container"` branch interpolates the `cols`
     * KEY verbatim into the query — `simple-grid (min-width: ${key})` — while
     * the `media` branch resolves `theme.breakpoints[key]`. So `{ sm: 2 }` in
     * container mode emits `(min-width: sm)`, which is not a valid <length>;
     * the query never matches and EVERY width silently falls back to `base`,
     * i.e. one column everywhere. Measured: named keys rendered 1 column at
     * 1400px where lengths render 5.
     *
     * It reads as a pure styling nit, so it is worth saying why it is pinned:
     * the failure is invisible in this tier (no Mantine stylesheet is loaded,
     * so `grid-template-columns` computes to `none` and any layout assertion
     * would pass either way) AND invisible in review (the diff looks like a
     * normal responsive prop). Asserting on the emitted QUERY TEXT is the one
     * check that can see it, and it needs no stylesheet.
     */
    mocks.analytics.current = { ...ZEROED };
    renderWithProviders(<AppAnalyticsPanel scopedAppBlockId="apb_1" />);
    await expect.element(page.getByText('App loads (range)', { exact: true })).toBeInTheDocument();

    const styles = Array.from(document.querySelectorAll('style'))
      .map((s) => s.textContent ?? '')
      .join('\n');
    const queries = Array.from(new Set(styles.match(/@container[^{]*/g) ?? []));

    // Pin the EXACT set, not a lower bound. `toBeGreaterThan(1)` had far too
    // much slack: reverting only the METRIC grid to named keys — reintroducing
    // precisely the modal squeeze this exists to prevent — still left the two
    // chart grids emitting `62em`, so the count stayed at 2 and the test
    // passed. Only an all-three revert tripped it. An exact set catches a
    // partial revert, and doubles as the positive control: if the panel stops
    // emitting container queries at all (someone reverts to `type="media"`, or
    // Mantine changes how it serialises them) this fails loudly rather than
    // passing over an empty set.
    expect(new Set(queries)).toEqual(
      new Set([
        '@container simple-grid (min-width: base)',
        '@container simple-grid (min-width: 48em)',
        '@container simple-grid (min-width: 62em)',
        '@container simple-grid (min-width: 75em)',
      ])
    );

    for (const q of queries) {
      const value = q.match(/min-width:\s*([^)]+)\)/)?.[1]?.trim();
      expect(value, `no min-width parsed from ${q}`).toBeDefined();
      // `base` is Mantine's own sentinel — its value is applied unconditionally
      // via baseStyles, so that one never-matching query is a harmless no-op.
      if (value === 'base') continue;
      expect(value, `"${value}" is not a CSS length — container queries need units`).toMatch(
        /^\d+(\.\d+)?(em|rem|px)$/
      );
    }
  });

  test('the coverage note no longer claims anonymous viewers are uncounted', async () => {
    mocks.analytics.current = { ...ZEROED };
    renderWithProviders(<AppAnalyticsPanel scopedAppBlockId="apb_1" />);

    await expect.element(page.getByText('What engagement counts')).toBeInTheDocument();
    // That sentence was true before this card existed and is false now. A
    // stale caveat is a claim the implementation contradicts.
    expect(page.getByText(/anonymous viewers are not counted/i).elements()).toHaveLength(0);
  });
});

/**
 * INSTALLS: a page app CANNOT be installed (stateless — Decision 2), so its
 * `Installs 0` is a CATEGORY ERROR sitting next to genuinely-measured run and
 * Buzz numbers. Same defect class as the impressions card above, different
 * cause: there the store could not be asked, here the question is meaningless.
 *
 * THREE states, and the whole value of this block is that it pins all three:
 *   1. measured non-zero — render the number;
 *   2. measured zero     — render `0`. A model-slot app with no installs yet is
 *                          a real, actionable answer;
 *   3. not applicable    — render an em dash.
 * (2) is the one that would regress SILENTLY: every visible symptom of "the fix
 * works" looks identical if a truthful zero starts hiding too.
 *
 * Em dashes are asserted by COUNT, not by `expect.element`. The impressions card
 * renders the same glyph in its own unavailable state, so an unanchored
 * single-element assertion would be ambiguous the moment both fire — and,
 * worse, would pass while attributing the wrong card's dash to installs.
 */
describe('AppAnalyticsPanel — installs: measured vs not applicable', () => {
  const emDashCount = () => page.getByText('—', { exact: true }).elements().length;

  test('(3) a PAGE app renders an em dash and says why — never a 0', async () => {
    mocks.analytics.current = {
      ...ZEROED,
      installs: { total: 0, active: 0, series: [], notApplicable: true },
      // Measured impressions, so any em dash on the page belongs to installs.
      views: { count: 124, uniqueViewers: 12, anonCount: 40 },
    };
    renderWithProviders(<AppAnalyticsPanel scopedAppBlockId="apb_1" />);

    await expect.element(page.getByText('Active installs')).toBeInTheDocument();
    await expect
      .element(page.getByText('Not applicable to page apps', { exact: true }))
      .toBeInTheDocument();
    expect(emDashCount()).toBe(1);
    // The fabricated "0 total (all time)" sub-line must be gone entirely.
    expect(page.getByText('total (all time)').elements()).toHaveLength(0);

    // PER-SECTION: everything else on the panel is measured and still renders.
    await expect.element(page.getByText('Runs (range)')).toBeInTheDocument();
    await expect.element(page.getByText('App loads (range)', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText('124', { exact: true })).toBeInTheDocument();
    expect(page.getByText('Analytics unavailable').elements()).toHaveLength(0);
  });

  // The runs series is deliberately NON-empty in this pair. With both series
  // empty, MiniLineChart's own "No data in this range." fires for both cards and
  // the two states become indistinguishable by that string — the assertion below
  // would then be measuring the runs card, not installs.
  const RUNS_WITH_DATA = {
    count: 7,
    buzzSpent: 7000,
    series: [{ bucket: '2026-06-01T00:00:00.000Z', value: 7 }],
  };

  test('(3) the installs CHART is replaced by the explanation, not left empty', async () => {
    mocks.analytics.current = {
      ...ZEROED,
      installs: { total: 0, active: 0, series: [], notApplicable: true },
      runs: RUNS_WITH_DATA,
    };
    renderWithProviders(<AppAnalyticsPanel scopedAppBlockId="apb_1" />);

    await expect.element(page.getByText('New installs over time')).toBeInTheDocument();
    await expect
      .element(page.getByText('Not applicable — page apps are not installed.', { exact: true }))
      .toBeInTheDocument();
    // "No data in this range." reads as a measurement of a quiet month, which is
    // exactly the claim a page app cannot make. The runs card has data, so the
    // only card that could emit this string is installs.
    expect(page.getByText('No data in this range.').elements()).toHaveLength(0);
    // Structural: the runs chart survives, the installs chart does not.
    await expect.element(page.getByText('Runs over time')).toBeInTheDocument();
    expect(document.querySelectorAll('[data-testid="chart"]')).toHaveLength(1);
  });

  // 🔴 THE SILENT REGRESSION. Byte-identical counters to the case above — only
  // the flag differs. If the em dash is ever driven by `active === 0` instead of
  // the server's flag, this is the only test that goes red.
  test('(2) a measured ZERO still renders 0 — a model-slot app with none yet', async () => {
    mocks.analytics.current = {
      ...ZEROED,
      installs: { total: 0, active: 0, series: [] },
      runs: RUNS_WITH_DATA,
      views: { count: 124, uniqueViewers: 12, anonCount: 40 },
    };
    renderWithProviders(<AppAnalyticsPanel scopedAppBlockId="apb_1" />);

    await expect.element(page.getByText('Active installs')).toBeInTheDocument();
    await expect.element(page.getByText('0 total (all time)', { exact: true })).toBeInTheDocument();
    expect(page.getByText('Not applicable to page apps').elements()).toHaveLength(0);
    // No em dash ANYWHERE — installs is measured and so are impressions.
    expect(emDashCount()).toBe(0);
    // Same fixture as (3) apart from the flag, so the chart card is the
    // structural discriminator: the empty installs series renders the CHART's
    // own empty-state ("no installs this month"), never the n/a explanation.
    await expect.element(page.getByText('No data in this range.')).toBeInTheDocument();
    expect(page.getByText('Not applicable — page apps are not installed.').elements()).toHaveLength(
      0
    );
  });

  test('(1) a measured non-zero count renders the number', async () => {
    mocks.analytics.current = {
      ...ZEROED,
      installs: { total: 3, active: 1, series: [] },
      views: { count: 124, uniqueViewers: 12, anonCount: 40 },
    };
    renderWithProviders(<AppAnalyticsPanel scopedAppBlockId="apb_1" />);

    await expect.element(page.getByText('3 total (all time)', { exact: true })).toBeInTheDocument();
    expect(emDashCount()).toBe(0);
  });

  test('an ABSENT notApplicable key (old pod, rolling deploy) takes the measured branch', async () => {
    // tRPC output is not zod-validated on the client, so a new bundle can be
    // handed an old pod's payload. Absent must behave exactly as today does —
    // this is the no-ordering-hazard claim, asserted rather than assumed.
    mocks.analytics.current = {
      ...ZEROED,
      installs: { total: 7, active: 5, series: [] },
      views: { count: 124, uniqueViewers: 12, anonCount: 40 },
    };
    renderWithProviders(<AppAnalyticsPanel scopedAppBlockId="apb_1" />);

    await expect.element(page.getByText('5', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText('7 total (all time)', { exact: true })).toBeInTheDocument();
    expect(emDashCount()).toBe(0);
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
    // tooltip copy begins *"Generations run through your app by other people within the
    // selected range…"* (AppAnalyticsPanel.tsx — re-quoted 2026-09-29 when the copy gained
    // the self-testing disclosure; the assertion below matches a shorter PREFIX, which is
    // why it kept passing while this quote was stale). Mantine mounts that tooltip only while the
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

/**
 * 🔴 EVERY METRIC-CARD LABEL MUST RESOLVE TO EXACTLY ONE ELEMENT.
 *
 * This is a CLASS guard, not a nit. `getByText` in vitest browser mode is
 * SUBSTRING + CASE-INSENSITIVE, so any other rendered text containing a card's
 * label — most easily the coverage note two rows below it — makes that label's
 * locator resolve to 2 elements, and every assertion using it dies with a
 * strict-mode violation after the matcher timeout.
 *
 * That has now happened three times in this panel's history, twice while
 * FIXING it:
 *   - civitai#3606  `getByText('Generations')` collided with a tooltip whose
 *                   copy contained the word.
 *   - a later edit   put a literal `<strong>—</strong>` in the alert, which
 *                   collided with `getByText('—', { exact: true })`.
 *   - a later edit   put the literal string "Active installs" in the alert,
 *                   which collided with the card label and killed five tests.
 *
 * Each cost a debugging cycle and each was invisible in review, because the
 * copy reads perfectly and the collision only exists at query time. So the rule
 * is pinned here rather than written in a comment somebody has to remember:
 *
 *   Alert/caption/tooltip copy must NOT contain a metric card's label verbatim.
 *   Refer to the metric descriptively instead ("the engagement figures below",
 *   "the installs figure"), or the guard below fails.
 *
 * It also caught a LATENT one when written: the coverage note used to open
 * "Active users, API calls, and error rate…", so `Active users` already
 * resolved to 2 — harmless only because no test happened to use that locator
 * yet. Measured before the fix: `Active users=2`, every other label `=1`.
 */
describe('AppAnalyticsPanel — metric-card labels stay unambiguous', () => {
  const CARD_LABELS = [
    'Active installs',
    'Runs (range)',
    'Buzz purchased',
    'Active users',
    'App loads (range)',
  ];

  test('each card label resolves to exactly one element', async () => {
    mocks.analytics.current = { ...ZEROED };
    renderWithProviders(<AppAnalyticsPanel scopedAppBlockId="apb_1" />);
    await expect.element(page.getByText('Active installs', { exact: true })).toBeInTheDocument();

    for (const label of CARD_LABELS) {
      const n = page.getByText(label).elements().length;
      expect(
        n,
        `"${label}" resolved to ${n} elements. Some other copy on this panel contains it ` +
          `verbatim — getByText is substring+case-insensitive, so every locator using this ` +
          `label is now a strict-mode violation. Reword the copy to refer to the metric ` +
          `descriptively instead of naming it.`
      ).toBe(1);
    }
  });

  test('the label list itself is not silently empty', () => {
    // Positive control: a guard that iterates an empty list passes vacuously
    // and would report green while checking nothing.
    expect(CARD_LABELS.length).toBeGreaterThanOrEqual(5);
  });
});

/**
 * The Custom events card reads ClickHouse like App loads, so it has the same fabricated-zero
 * hazard: an unavailable or absent section must never render a count. Its four states, the
 * drop banner and the two inputs (owner toggle, event selection) are pinned here.
 */
describe('AppAnalyticsPanel — custom events', () => {
  const DECLARED = [
    {
      name: 'generate_clicked',
      description: 'User pressed Generate',
      properties: [
        { name: 'mode', type: 'enum', values: ['txt2img', 'img2img', 'inpaint'] },
        { name: 'batch', type: 'number' },
        { name: 'advanced', type: 'boolean' },
      ],
    },
    { name: 'share_clicked', properties: [] },
  ];
  const RANGE = { from: new Date(0), to: new Date(0), granularity: 'day' as const };
  const MEASURED = {
    range: RANGE,
    declared: DECLARED,
    includeOwner: false,
    topEvents: [
      { eventName: 'generate_clicked', count: 57, signedInViewers: 13, anonymousEvents: 21 },
      { eventName: 'share_clicked', count: 8, signedInViewers: 5, anonymousEvents: 2 },
    ],
    undeclaredDrops: 0,
  };
  const SELECTED = {
    eventName: 'generate_clicked',
    series: [
      { bucket: '2026-07-06T00:00:00.000Z', value: 9 },
      { bucket: '2026-07-13T00:00:00.000Z', value: 4 },
    ],
    properties: [
      {
        name: 'mode',
        type: 'enum',
        values: [
          { value: 'txt2img', count: 12 },
          { value: 'img2img', count: 7 },
          { value: 'inpaint', count: 0 },
        ],
      },
      { name: 'batch', type: 'number', count: 3, sum: 16, avg: 5.25, p50: 4, p95: 10 },
      { name: 'advanced', type: 'boolean', trueCount: 6, falseCount: 1 },
    ],
  };

  function card(): HTMLElement {
    const heading = page.getByText('Custom events', { exact: true }).element();
    const root = heading.closest('.mantine-Card-root');
    if (!(root instanceof HTMLElement)) throw new Error('Custom events card not found');
    return root;
  }
  const lastInput = () => mocks.cardInputs[mocks.cardInputs.length - 1];

  test('requests the section for the scoped app, owner rows excluded by default', async () => {
    mocks.analytics.current = { ...ZEROED, customEvents: MEASURED };
    mocks.cardInputs.length = 0;
    renderWithProviders(<AppAnalyticsPanel scopedAppBlockId="apb_1" />);
    await expect.element(page.getByText('Custom events', { exact: true })).toBeInTheDocument();
    expect(lastInput()).toEqual({
      appBlockId: 'apb_1',
      includeOwner: false,
    });
  });

  test('measured: one row per declared event with events, signed-in viewers and signed-out events', async () => {
    mocks.analytics.current = { ...ZEROED, customEvents: MEASURED };
    renderWithProviders(<AppAnalyticsPanel scopedAppBlockId="apb_1" />);
    await expect
      .element(page.getByRole('row', { name: 'generate_clicked 57 13 21' }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole('row', { name: 'share_clicked 8 5 2' }))
      .toBeInTheDocument();
    await expect.element(page.getByText('Signed-in viewers', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText('Signed-out events', { exact: true })).toBeInTheDocument();
    expect(page.getByText(/were sent with names/).elements()).toHaveLength(0);
  });

  test('(a) nothing declared: points at the manifest docs', async () => {
    mocks.analytics.current = {
      ...ZEROED,
      customEvents: { ...MEASURED, declared: [], topEvents: [] },
    };
    renderWithProviders(<AppAnalyticsPanel scopedAppBlockId="apb_1" />);
    await expect.element(page.getByText(/doesn't declare any custom events/)).toBeInTheDocument();
    await expect
      .element(page.getByRole('link', { name: 'Declare events in your manifest' }))
      .toHaveAttribute('href', 'https://developer.civitai.com/apps/reference/manifest');
    expect(page.getByRole('table').elements()).toHaveLength(0);
  });

  test('(b) declared but nothing recorded: a labelled, measured zero', async () => {
    mocks.analytics.current = {
      ...ZEROED,
      customEvents: {
        ...MEASURED,
        topEvents: MEASURED.topEvents.map((e) => ({
          ...e,
          count: 0,
          signedInViewers: 0,
          anonymousEvents: 0,
        })),
      },
    };
    renderWithProviders(<AppAnalyticsPanel scopedAppBlockId="apb_1" />);
    await expect
      .element(page.getByText('No declared events were recorded in this range.', { exact: true }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole('row', { name: 'generate_clicked 0 0 0' }))
      .toBeInTheDocument();
    expect(page.getByText(/Couldn't load custom events/).elements()).toHaveLength(0);
  });

  test('(c) unavailable: says so and renders no count at all', async () => {
    mocks.analytics.current = {
      ...ZEROED,
      customEvents: {
        range: RANGE,
        declared: DECLARED,
        includeOwner: false,
        topEvents: [],
        undeclaredDrops: 0,
        unavailable: true,
      },
    };
    renderWithProviders(<AppAnalyticsPanel scopedAppBlockId="apb_1" />);
    await expect
      .element(page.getByText(/Couldn't load custom events right now/))
      .toBeInTheDocument();
    expect(page.getByText(/No declared events were recorded/).elements()).toHaveLength(0);
    expect(page.getByRole('table').elements()).toHaveLength(0);
    expect(card().textContent).not.toMatch(/\d/);
  });

  test('(d) no section returned: renders like unavailable, never as zero', async () => {
    mocks.analytics.current = { ...ZEROED };
    renderWithProviders(<AppAnalyticsPanel scopedAppBlockId="apb_1" />);
    await expect
      .element(page.getByText(/Couldn't load custom events right now/))
      .toBeInTheDocument();
    expect(page.getByText(/No declared events were recorded/).elements()).toHaveLength(0);
    expect(card().textContent).not.toMatch(/\d/);
    await expect.element(page.getByText('Active installs', { exact: true })).toBeInTheDocument();
  });

  test('drops banner: counts events sent under undeclared names', async () => {
    mocks.analytics.current = { ...ZEROED, customEvents: { ...MEASURED, undeclaredDrops: 5 } };
    renderWithProviders(<AppAnalyticsPanel scopedAppBlockId="apb_1" />);
    await expect
      .element(
        page.getByText(
          "5 events were sent in this range with names your approved manifest doesn't declare, so they were not recorded by name. Declare an event in your manifest and resubmit to see it here.",
          { exact: true }
        )
      )
      .toBeInTheDocument();
  });

  test('drops banner: singular copy for one event', async () => {
    mocks.analytics.current = { ...ZEROED, customEvents: { ...MEASURED, undeclaredDrops: 1 } };
    renderWithProviders(<AppAnalyticsPanel scopedAppBlockId="apb_1" />);
    await expect
      .element(page.getByText(/^1 event was sent in this range with a name your approved manifest/))
      .toBeInTheDocument();
  });

  test('the team toggle refetches with includeOwner: true', async () => {
    mocks.analytics.current = { ...ZEROED, customEvents: MEASURED };
    mocks.cardInputs.length = 0;
    renderWithProviders(<AppAnalyticsPanel scopedAppBlockId="apb_1" />);
    const toggle = page.getByRole('switch', { name: 'Include team activity' });
    await expect.element(toggle).not.toBeChecked();
    await expect
      .element(
        page.getByText(
          'Events sent while the app owner or an accepted collaborator was signed in.',
          { exact: true }
        )
      )
      .toBeInTheDocument();
    expect(page.getByText(/always counted/).elements()).toHaveLength(0);
    await toggle.click();
    await expect.element(toggle).toBeChecked();
    expect(lastInput()).toEqual({
      appBlockId: 'apb_1',
      includeOwner: true,
    });
  });

  test('selecting an event requests it and renders its series and property breakdown', async () => {
    mocks.analytics.current = { ...ZEROED, customEvents: { ...MEASURED, selected: SELECTED } };
    mocks.cardInputs.length = 0;
    renderWithProviders(<AppAnalyticsPanel scopedAppBlockId="apb_1" />);

    await expect
      .element(page.getByText('Select an event to see it over time and its property breakdown.'))
      .toBeInTheDocument();
    expect(page.getByText('generate_clicked over time').elements()).toHaveLength(0);

    const eventButton = page.getByRole('button', { name: 'generate_clicked' });
    await eventButton.click();
    await expect.element(eventButton).toHaveAttribute('aria-pressed', 'true');

    expect(lastInput()).toEqual({
      appBlockId: 'apb_1',
      includeOwner: false,
      event: 'generate_clicked',
    });
    await expect
      .element(page.getByText('generate_clicked over time', { exact: true }))
      .toBeInTheDocument();
    await expect.element(page.getByRole('row', { name: 'txt2img 12' })).toBeInTheDocument();
    await expect.element(page.getByRole('row', { name: 'inpaint 0' })).toBeInTheDocument();
    await expect
      .element(
        page.getByText('Set on 3 events · sum 16 · avg 5.25 · median 4 · p95 10', { exact: true })
      )
      .toBeInTheDocument();
    await expect.element(page.getByText('true 6 · false 1', { exact: true })).toBeInTheDocument();
    await expect
      .element(page.getByText('Showing generate_clicked', { exact: true }))
      .toHaveAttribute('aria-live', 'polite');
    expect(card().querySelectorAll('[data-testid="chart"]')).toHaveLength(1);
  });

  test('a stale selection from the previous payload never renders under the newly clicked event', async () => {
    // The payload still carries generate_clicked's detail (what a kept placeholder holds).
    mocks.analytics.current = { ...ZEROED, customEvents: { ...MEASURED, selected: SELECTED } };
    renderWithProviders(<AppAnalyticsPanel scopedAppBlockId="apb_1" />);
    const share = page.getByRole('button', { name: 'share_clicked' });
    await share.click();
    await expect.element(share).toHaveAttribute('aria-pressed', 'true');
    await expect
      .element(page.getByText("Couldn't load the details for share_clicked.", { exact: true }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText('Details unavailable for share_clicked', { exact: true }))
      .toHaveAttribute('aria-live', 'polite');
    expect(page.getByText('generate_clicked over time').elements()).toHaveLength(0);
  });

  test('clicking the selected event again deselects it', async () => {
    mocks.analytics.current = { ...ZEROED, customEvents: { ...MEASURED, selected: SELECTED } };
    mocks.cardInputs.length = 0;
    renderWithProviders(<AppAnalyticsPanel scopedAppBlockId="apb_1" />);
    const eventButton = page.getByRole('button', { name: 'generate_clicked' });
    await eventButton.click();
    await expect.element(eventButton).toHaveAttribute('aria-pressed', 'true');
    await eventButton.click();
    await expect.element(eventButton).toHaveAttribute('aria-pressed', 'false');
    expect(lastInput()).toEqual({
      appBlockId: 'apb_1',
      includeOwner: false,
    });
  });

  test('empty breakdowns say so for every property type, and a no-property event says so', async () => {
    mocks.analytics.current = {
      ...ZEROED,
      customEvents: {
        ...MEASURED,
        selected: {
          eventName: 'generate_clicked',
          series: [],
          properties: [
            {
              name: 'mode',
              type: 'enum',
              values: [
                { value: 'txt2img', count: 0 },
                { value: 'img2img', count: 0 },
              ],
            },
            { name: 'batch', type: 'number', count: 0, sum: 0, avg: null, p50: null, p95: null },
            { name: 'advanced', type: 'boolean', trueCount: 0, falseCount: 0 },
          ],
        },
      },
    };
    renderWithProviders(<AppAnalyticsPanel scopedAppBlockId="apb_1" />);
    await page.getByRole('button', { name: 'generate_clicked' }).click();
    await expect.element(page.getByText('generate_clicked over time')).toBeInTheDocument();
    expect(
      page.getByText('Not set on any event in this range.', { exact: true }).elements()
    ).toHaveLength(3);
    expect(page.getByText(/^true 0/).elements()).toHaveLength(0);
  });

  test('a number property set on one event uses the singular and an em dash for a missing stat', async () => {
    mocks.analytics.current = {
      ...ZEROED,
      customEvents: {
        ...MEASURED,
        selected: {
          ...SELECTED,
          properties: [
            { name: 'batch', type: 'number', count: 1, sum: 7, avg: 7, p50: null, p95: 7 },
          ],
        },
      },
    };
    renderWithProviders(<AppAnalyticsPanel scopedAppBlockId="apb_1" />);
    await page.getByRole('button', { name: 'generate_clicked' }).click();
    await expect
      .element(page.getByText('Set on 1 event · sum 7 · avg 7 · median — · p95 7', { exact: true }))
      .toBeInTheDocument();
  });

  test("the card's query keeps previous data while it refetches, and waits for an app", async () => {
    mocks.analytics.current = { ...ZEROED };
    mocks.cardOptions.length = 0;
    renderWithProviders(<AppAnalyticsPanel />);
    await expect.element(page.getByText('Custom events', { exact: true })).toBeInTheDocument();
    const options = mocks.cardOptions[mocks.cardOptions.length - 1] as {
      enabled: boolean;
      placeholderData: (previous: unknown) => unknown;
    };
    expect(options.enabled).toBe(false);
    const previous = { marker: 'previous payload' };
    expect(options.placeholderData(previous)).toBe(previous);
  });

  test('the panel payload is requested exactly as before: no custom-events input', async () => {
    mocks.analytics.current = { ...ZEROED, customEvents: MEASURED };
    mocks.queryInputs.length = 0;
    renderWithProviders(<AppAnalyticsPanel scopedAppBlockId="apb_1" />);
    await page.getByRole('switch', { name: 'Include team activity' }).click();
    await page.getByRole('button', { name: 'generate_clicked' }).click();
    await expect
      .element(page.getByRole('button', { name: 'generate_clicked' }))
      .toHaveAttribute('aria-pressed', 'true');
    expect(new Set(mocks.queryInputs.map((i) => JSON.stringify(i)))).toEqual(
      new Set([JSON.stringify({ appBlockId: 'apb_1' })])
    );
  });

  test('a failed card request (an old pod without the procedure) shows "couldn\'t load", not the panel error', async () => {
    mocks.analytics.current = { ...ZEROED, customEvents: MEASURED };
    mocks.cardError.current = {
      message: 'No "query"-procedure on path "blocks.getMyAppCustomEvents"',
    };
    try {
      renderWithProviders(<AppAnalyticsPanel scopedAppBlockId="apb_1" />);
      await expect
        .element(page.getByText(/Couldn't load custom events right now/))
        .toBeInTheDocument();
      expect(card().textContent).not.toMatch(/\d/);
      expect(page.getByText(/Failed to load analytics/).elements()).toHaveLength(0);
      await expect.element(page.getByText('Active installs', { exact: true })).toBeInTheDocument();
    } finally {
      mocks.cardError.current = null;
    }
  });

  test('when the section is unavailable with an event selected, the selection can be cleared', async () => {
    mocks.analytics.current = { ...ZEROED, customEvents: MEASURED };
    mocks.cardInputs.length = 0;
    renderWithProviders(<AppAnalyticsPanel scopedAppBlockId="apb_1" />);
    const eventButton = page.getByRole('button', { name: 'generate_clicked' });
    await eventButton.click();
    await expect.element(eventButton).toHaveAttribute('aria-pressed', 'true');
    mocks.cardError.current = { message: 'timeout' };
    try {
      await page.getByRole('switch', { name: 'Include team activity' }).click();
      const clear = page.getByRole('button', { name: 'Clear the selected event' });
      await clear.click();
      await expect.element(clear).not.toBeInTheDocument();
      expect(lastInput()).toEqual({ appBlockId: 'apb_1', includeOwner: true });
    } finally {
      mocks.cardError.current = null;
    }
  });

  test('while a selection refetches: a loader in the detail pane, the stale table marked busy', async () => {
    mocks.analytics.current = { ...ZEROED, customEvents: MEASURED };
    mocks.isPlaceholderData.current = true;
    try {
      renderWithProviders(<AppAnalyticsPanel scopedAppBlockId="apb_1" />);
      const eventButton = page.getByRole('button', { name: 'generate_clicked' });
      await eventButton.click();
      await expect
        .element(page.getByRole('status', { name: 'Loading generate_clicked' }))
        .toBeInTheDocument();
      await expect
        .element(page.getByRole('status', { name: 'Refreshing custom events' }))
        .toBeInTheDocument();
      expect(card().querySelector('[aria-busy="true"]')).not.toBeNull();
      expect(page.getByText(/Couldn't load the details/).elements()).toHaveLength(0);
    } finally {
      mocks.isPlaceholderData.current = false;
    }
  });

  test('a boolean set only to false still shows its split, not "Not set"', async () => {
    mocks.analytics.current = {
      ...ZEROED,
      customEvents: {
        ...MEASURED,
        selected: {
          ...SELECTED,
          properties: [{ name: 'advanced', type: 'boolean', trueCount: 0, falseCount: 5 }],
        },
      },
    };
    renderWithProviders(<AppAnalyticsPanel scopedAppBlockId="apb_1" />);
    await page.getByRole('button', { name: 'generate_clicked' }).click();
    await expect.element(page.getByText('true 0 · false 5', { exact: true })).toBeInTheDocument();
    expect(page.getByText('Not set on any event in this range.').elements()).toHaveLength(0);
  });

  test('picking another app starts the card fresh: no selection, owner toggle off', async () => {
    mocks.apps.current = [
      { id: 'apb_1', appName: 'First app', blockId: 'b1' },
      { id: 'apb_2', appName: 'Second app', blockId: 'b2' },
    ];
    mocks.analytics.current = { ...ZEROED, customEvents: MEASURED };
    mocks.cardInputs.length = 0;
    try {
      renderWithProviders(<AppAnalyticsPanel />);
      await page.getByRole('textbox', { name: 'App' }).click();
      await page.getByRole('option', { name: 'First app' }).click();
      const eventButton = page.getByRole('button', { name: 'generate_clicked' });
      await eventButton.click();
      await expect.element(eventButton).toHaveAttribute('aria-pressed', 'true');
      await page.getByRole('switch', { name: 'Include team activity' }).click();
      expect(lastInput()).toEqual({
        appBlockId: 'apb_1',
        includeOwner: true,
        event: 'generate_clicked',
      });

      await page.getByRole('textbox', { name: 'App' }).click();
      await page.getByRole('option', { name: 'Second app' }).click();
      await expect.element(eventButton).toHaveAttribute('aria-pressed', 'false');
      expect(lastInput()).toEqual({
        appBlockId: 'apb_2',
        includeOwner: false,
      });
    } finally {
      mocks.apps.current = [];
    }
  });

  test('"All my apps" asks for no custom events and says to pick an app', async () => {
    mocks.analytics.current = { ...ZEROED };
    mocks.cardOptions.length = 0;
    renderWithProviders(<AppAnalyticsPanel />);
    await expect
      .element(page.getByText('Choose an app to see its custom events.', { exact: true }))
      .toBeInTheDocument();
    expect((mocks.cardOptions[mocks.cardOptions.length - 1] as { enabled: boolean }).enabled).toBe(
      false
    );
    expect(page.getByText(/Couldn't load custom events/).elements()).toHaveLength(0);
  });
});
