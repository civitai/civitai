import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
// Type-only namespace import for the `importOriginal` spread below (the repo's
// local-rules/no-wholesale-module-mock cure). NOT `typeof import(...)`, which
// @typescript-eslint/consistent-type-imports rejects.
import type * as TrpcMod from '~/utils/trpc';

/**
 * DOUBLE SCROLLBAR on `/apps/run/<slug>` — the layout regression, measured.
 *
 * THE SYMPTOM. The run page showed TWO vertical scrollbars side by side: the
 * site layout's own `ScrollArea` grew one, and the block's document inside the
 * iframe had another. Only one of them scrolled anything the viewer wanted.
 *
 * THE MECHANISM, and why it was unconditional rather than a race. `PageBlockHost`
 * claimed `min-height: calc(100dvh - 60px)` — the viewport minus the site header
 * ONLY. But in the default (`scrollable: true`) layout the space actually
 * available to the page is
 *
 *     100dvh − header − subNav − subNav's mb-3 − RewardsBonusBanner
 *            − AppFooter − AdhesiveAd
 *
 * Every term after `header` is ≥ 0 and several are > 0 on a normal render, so
 * the host was ALWAYS taller than the scroll viewport it sat in. There is no
 * window size at which the two agree — which is why this could not be tuned
 * away, only removed. The fix is `fit="fill"` (host claims no height of its own)
 * plus `Page(…, { scrollable: false })` on the route (the ancestor chain bounds
 * it instead, `overflow-hidden` throughout).
 *
 * 🔴 WHY THIS TEST MEASURES INSTEAD OF READING STYLES. The defect is a LAYOUT
 * outcome, so a jsdom assertion on `style.minHeight` would restate the
 * implementation and pass whatever the browser then did with it. This runs in
 * real Chromium and asks the only question that matters — does the scroll
 * container overflow? — via `scrollHeight > clientHeight`, which is exactly what
 * makes the browser paint a scrollbar.
 *
 * 🔴 THE `viewport` CASE IS THE RED ARM AND MUST STAY. It is the reproduction:
 * it pins that the OLD styling really does overflow a realistic viewport, so the
 * `fill` case's green is a fact about the fix rather than about the fixture. Both
 * arms render the SAME host into the SAME container, differing only in `fit`.
 * Delete the red arm and the green one stops proving anything.
 *
 * NOTE ON REACH: CI runs the node `unit` project only — the browser suites are
 * not run there. The half of this contract that gates a merge is the source-scan
 * guard in `__tests__/pageRunScrollContract.test.ts`, which pins that the route
 * ships BOTH halves together. This file is the empirical half.
 */

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  // FeatureFlagsProvider (in PageBlockHost's real render graph) statically
  // imports `setTrpcBatchingEnabled`; the spread keeps every other real export
  // so a new one can't silently arrive as `undefined` and take the whole file
  // down to "0 tests collected".
  setTrpcBatchingEnabled: vi.fn(),
  trpc: {
    generation: { resolveWildcardPack: { useMutation: () => ({ mutateAsync: vi.fn() }) } },
    blocks: {
      submitWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyBuzzBalance: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyViewer: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyBuzzTransactions: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyBuzzAccounts: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyDailyCompensation: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      estimateWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      pollWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      cancelWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      queryAppWorkflows: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      cancelAppWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      publishGenerationOutputs: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getImagesByIds: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
    apps: {
      shared: {
        append: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        update: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        vote: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        unvote: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        withdraw: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        report: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      },
      storage: {
        set: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        delete: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      },
    },
    useUtils: () => ({
      apps: {
        shared: {
          list: { fetch: vi.fn() },
          getCount: { fetch: vi.fn() },
          getCounts: { fetch: vi.fn() },
          get: { fetch: vi.fn() },
        },
        storage: {
          get: { fetch: vi.fn() },
          list: { fetch: vi.fn() },
          getQuota: { fetch: vi.fn() },
        },
      },
    }),
  },
}));

// eslint-disable-next-line import/first
import { PageBlockHost } from '~/components/AppBlocks/PageBlockHost';

const SAME_ORIGIN_SRC = `${window.location.origin}/`;

const baseProps = {
  appBlockId: 'apb_scrollfit',
  blockId: 'scroll-fit-app',
  appId: 'app_scrollfit',
  blockInstanceId: 'page_apb_scrollfit',
  appName: 'Scroll Fit App',
  iframeSrc: SAME_ORIGIN_SRC,
  surface: 'page-run' as const,
  sandbox: 'allow-scripts',
  trustTier: 'internal' as const,
  slug: 'scroll-fit-app',
  token: 'tok_scrollfit',
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  declaredScopes: [] as string[],
  missingScopes: [] as string[],
  needsConsent: false,
  tokenError: false,
  viewer: null,
  theme: 'light' as const,
};

/**
 * The layout chain the run page actually sits in, reduced to the two properties
 * that decide overflow:
 *
 *   - `overflow-y: auto` — the scroll container. `AppLayout`'s `ScrollArea` gets
 *     this from `.scroll-area { overflow-x: hidden }` (CSS computes the
 *     unspecified `visible` axis to `auto` when the other is not `visible`).
 *   - a BOUNDED height — the ScrollArea is stretched by its flex-row parent to
 *     `viewport − header`, then further reduced by the sub-nav / banner / footer
 *     rendered inside it.
 *
 * `containerHeight` is deliberately SMALLER than `calc(100dvh - 60px)` would be
 * in this browser, because that gap IS the bug: it is the space the site chrome
 * takes that the old calc never subtracted. Derived from the live viewport at
 * run time rather than hardcoded, so the fixture cannot drift away from the
 * window the runner actually opened.
 */
function layoutChainHeights() {
  // What the OLD host claimed. 60 is `HEADER_HEIGHT`, restated by the old style
  // exactly as the bug did.
  const oldClaimedMinHeight = window.innerHeight - 60;
  // What a real run page has left after the site chrome inside the scroll area.
  // 120px stands in for sub-nav + mb-3 + banner + footer; any positive value
  // reproduces it, and this one is comfortably above scrollbar-rounding noise.
  const containerHeight = oldClaimedMinHeight - 120;
  return { oldClaimedMinHeight, containerHeight };
}

/**
 * Render, then WAIT for the host to be in the document before measuring.
 *
 * `render` returns before React has committed, so a synchronous
 * `page.getByTestId(...).element()` throws `Cannot find element` against an
 * empty container — which is how this file first ran: 4 failures that looked
 * like the component rendering nothing. Awaiting the frame is also what gives
 * the browser a chance to lay out, without which every height read is 0.
 */
async function mountAndSettle(fit: 'viewport' | 'fill', containerHeight: number) {
  renderInScrollChain(fit, containerHeight);
  await expect.element(page.getByTestId('app-page-frame')).toBeInTheDocument();
}

function renderInScrollChain(fit: 'viewport' | 'fill', containerHeight: number) {
  return renderWithProviders(
    <div
      data-testid="scroll-chain"
      style={{
        height: `${containerHeight}px`,
        // The property that turns overflow into a visible scrollbar.
        overflowY: 'auto',
        overflowX: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* `fill` needs a growing flex item to resolve against — this is the run
          page's own wrapper Box, same three properties. */}
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <PageBlockHost {...baseProps} fit={fit} />
      </div>
    </div>
  );
}

function scrollChain() {
  return page.getByTestId('scroll-chain').element() as HTMLElement;
}

describe('PageBlockHost — `fit` decides whether the page grows a SECOND scrollbar', () => {
  test('the fixture is a real scroll container, and the old claim really is taller than it', () => {
    // POSITIVE CONTROL on the fixture itself, before either arm is believed.
    // Without this, a container that silently had no bounded height (or no
    // overflow rule) would report "no overflow" in BOTH arms and the fill case
    // would pass for the wrong reason — the reassuring-zero failure mode.
    const { oldClaimedMinHeight, containerHeight } = layoutChainHeights();
    expect(containerHeight).toBeGreaterThan(0);
    expect(oldClaimedMinHeight).toBeGreaterThan(containerHeight);
  });

  test('RED ARM — `fit="viewport"` overflows its scroll container (the reported bug)', async () => {
    const { containerHeight } = layoutChainHeights();
    await mountAndSettle('viewport', containerHeight);

    const chain = scrollChain();
    // The container is bounded as intended...
    expect(chain.clientHeight).toBeLessThanOrEqual(containerHeight);
    // ...and the host pushes past it, which is precisely what paints scrollbar
    // #1 while the iframe paints #2.
    expect(chain.scrollHeight).toBeGreaterThan(chain.clientHeight);
  });

  test('GREEN ARM — `fit="fill"` fits exactly, so the outer scrollbar never appears', async () => {
    const { containerHeight } = layoutChainHeights();
    await mountAndSettle('fill', containerHeight);

    const chain = scrollChain();
    // `scrollHeight` is floored at `clientHeight`, so equality is "nothing to
    // scroll". Assert it directly rather than via a `not.toBeGreaterThan`, which
    // would also pass if the host had collapsed to zero height.
    expect(chain.scrollHeight).toBe(chain.clientHeight);
    // Guard the OTHER failure direction: `fill` must not collapse the host. A
    // zero-height host would also produce "no overflow" — and a 0px iframe is a
    // worse bug than a spare scrollbar.
    const frame = page.getByTestId('app-page-frame').element() as HTMLElement;
    expect(frame.getBoundingClientRect().height).toBeGreaterThan(containerHeight / 2);
  });

  test('`data-fit` reports which branch a surface took', async () => {
    const { containerHeight } = layoutChainHeights();
    await mountAndSettle('fill', containerHeight);
    expect(page.getByTestId('app-page-frame').element().getAttribute('data-fit')).toBe('fill');
  });

  test('the DEFAULT is `viewport`, so the three non-page mounters are unchanged', async () => {
    // The dev tunnel and the mod-review preview both sit inside a SCROLLING
    // ancestor that does not bound their height; on `fill` they would collapse.
    // Pinning the default here is what lets this change be page-only.
    const { containerHeight } = layoutChainHeights();
    renderWithProviders(
      <div style={{ height: `${containerHeight}px`, overflowY: 'auto' }}>
        <PageBlockHost {...baseProps} />
      </div>
    );
    await expect.element(page.getByTestId('app-page-frame')).toBeInTheDocument();
    expect(page.getByTestId('app-page-frame').element().getAttribute('data-fit')).toBe('viewport');
  });
});
