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
 * NOTE ON REACH: this suite DOES run in CI — `pnpm run test:component`, surfaced
 * as the `preview / component-tests` commit status — but REPORT-ONLY, so a break
 * here is visible without blocking a merge. The source-scan half of this contract
 * is `__tests__/pageRunScrollContract.test.ts`, in the node `unit` project —
 * report-only on a pull request too (`continue-on-error`), and an honest verdict
 * on a push to `main` or a `workflow_dispatch`. NEITHER TIER BLOCKS A MERGE:
 * `main` requires no status check at all in this repo. This file is the empirical
 * half, and it is the one that can see layout at all.
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
    // Collection follow/unfollow host bridge (SET_COLLECTION_FOLLOW). Both
    // hosts register the handler, so every host-rendering suite needs these
    // two session-authed mutations present on the mocked client.
    collection: {
      follow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      unfollow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
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
import { FILL_MIN_HEIGHT_PX, PageBlockHost } from '~/components/AppBlocks/PageBlockHost';

const SAME_ORIGIN_SRC = `${window.location.origin}/`;

const baseProps = {
  appBlockId: 'apb_scrollfit',
  blockId: 'scroll-fit-app',
  appId: 'app_scrollfit',
  blockInstanceId: 'page_apb_scrollfit',
  appName: 'Scroll Fit App',
  iframeSrc: SAME_ORIGIN_SRC,
  surface: 'page-run' as const,
  // Required. These suites cover the DEFAULT (host-veil) presentation;
  // the bootSkeleton path is covered in PageBlockHostLaunchReveal.
  bootSkeleton: false,
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
  // What the OLD host claimed, restated by the old style exactly as the bug did.
  // 🔴 The 60 is a DELIBERATE historical literal, intentionally NOT
  // `HEADER_HEIGHT_PX`: this arm reproduces the bug as it shipped, so it must not
  // move when the live header is resized. Importing the constant here would make
  // the reproduction track the header and quietly stop reproducing the original
  // defect. (The red arm holds for any header height below ~180; the fixture
  // subtracts a further 120 of chrome from a real viewport.)
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
      {/* 🔴 DELIBERATELY *NOT* THE CURRENT PRODUCTION WRAPPER — do not "sync"
          this with `[[...path]].tsx`. This helper models the PRE-FIX page (a
          scrolling `ScrollArea` layout, wrapper `{ width: '100%' }`), because
          that is the state the RED ARM has to reproduce. `renderInNoScrollChain`
          below is the one that mirrors production.

          Adding production's `overflowY: 'auto'` here was tried and reverted: it
          moves the scroll to this inner wrapper, so `scroll-chain` stops
          overflowing and the RED ARM fails with `expected 716 to be greater
          than 716` — i.e. the reproduction quietly stops reproducing. The two
          fixtures model two different points in time and are supposed to
          differ. */}
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <PageBlockHost {...baseProps} fit={fit} />
      </div>
    </div>
  );
}

/**
 * The `scrollable: false` chain at a SHORT viewport — the squeeze case.
 *
 * `Page(…, { scrollable: false })` puts `overflow-hidden` on every ancestor, so
 * whatever the page renders is the ONLY thing that can offer a scrollbar. That
 * is the whole point of the fix at normal sizes, and the hazard at small ones:
 * the site's fixed chrome (header 60 + AppFooter 45 + its mt-3 12 + AdhesiveAd
 * 90 desktop / 50 mobile) cannot shrink, so on a short viewport the app absorbs
 * the entire shortfall.
 *
 * `available` is what is left for the page after that chrome. The `available =
 * 153` the tests below use is 360 − 60 − 57 − 90, i.e. a short DESKTOP window
 * (and the headless fixture, whose UA is not mobile).
 *
 * ⚠️ It is NOT a phone in landscape, which an earlier version of this comment
 * claimed. `isMobileDevice()` (`~/hooks/useIsMobile`) keys on UA/`ontouchstart`,
 * NOT on width, so a phone is mobile in landscape too and gets the 50px ad, not
 * the 90px one: ~360 CSS px tall lands at 193 (161 with the RewardsBonusBanner),
 * which is what `FILL_MIN_HEIGHT_PX`'s own table says. Both are below the floor,
 * so the tests' conclusion is unaffected — but the two docs must not disagree by
 * 40px about one scenario. A 1366×768 laptop at 200% zoom lands LOWER, around 86–118:
 * its `innerHeight` is ~325, not 768/2 = 384 (the panel-height error corrected
 * on `FILL_MIN_HEIGHT_PX`; the old 384 is where a second "~150px" came from).
 * Either way it is far too little to use, and with `overflow-hidden` above there
 * would be nothing to scroll to reach the rest.
 */
function renderInNoScrollChain(available: number) {
  return renderWithProviders(
    <div
      data-testid="no-scroll-main"
      // `AppLayout`'s `<main className="flex flex-1 flex-col overflow-hidden">`.
      style={{
        height: `${available}px`,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* The run page's own wrapper Box — kept in sync with
          `src/pages/apps/run/[slug]/[[...path]].tsx`. `overflowY: auto` is the
          scroll-of-last-resort that makes the squeeze recoverable. */}
      <div
        data-testid="page-wrapper"
        style={{
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
        }}
      >
        <PageBlockHost {...baseProps} fit="fill" />
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

  /**
   * 🔴 THE FIX MUST NOT TRADE A COSMETIC SCROLLBAR FOR AN UNREACHABLE ONE.
   *
   * Raised by the pre-merge audit of #4339 and reproduced here before being
   * fixed: with `scrollable: false` every ancestor is `overflow-hidden`, so a
   * host that floors at `minHeight: 0` absorbs the whole shortfall on a short
   * viewport and NOTHING can scroll to what got squeezed out. Phone landscape
   * and heavy desktop zoom both land here, which makes it a WCAG 1.4.4 / 1.4.10
   * problem rather than a cosmetic one — strictly worse than the spare scrollbar
   * this PR set out to remove. (The band is viewport-height driven; see
   * `FILL_MIN_HEIGHT_PX` for who actually falls in it, and note every
   * measurement in this file is taken at the runner's default 414px-WIDE
   * viewport — nothing here exercises a desktop width.)
   *
   * The cure is a real floor (`FILL_MIN_HEIGHT_PX`) plus one scroll container of
   * last resort on the page's own wrapper. Above the floor nothing overflows, so
   * the double-scrollbar fix is untouched; below it, one scrollbar appears and
   * the content is reachable again.
   */
  describe('short viewports — squeezed, but never unreachable', () => {
    test('the app keeps a usable height instead of collapsing toward zero', async () => {
      // A ~360px-tall viewport minus the site's fixed chrome.
      const available = 153;
      renderInNoScrollChain(available);
      await expect.element(page.getByTestId('app-page-frame')).toBeInTheDocument();

      const frame = page.getByTestId('app-page-frame').element() as HTMLElement;

      // 🔴 ABSOLUTE LITERALS, DELIBERATELY NOT `FILL_MIN_HEIGHT_PX`.
      //
      // This assertion used to read `.toBeGreaterThanOrEqual(FILL_MIN_HEIGHT_PX)`,
      // which compares the measured height against the very constant that
      // PRODUCED it — true by construction for every value. Measured: setting
      // the floor to 0 (i.e. fully reverting the WCAG fix) passed all 17 tests
      // across both suites. The unit guard did not help either: it pins the
      // IDENTIFIER `minHeight: FILL_MIN_HEIGHT_PX` in the source, not the number.
      //
      // A literal cannot be satisfied by construction, so this is what actually
      // holds the floor down. It is intentionally a little below the constant so
      // a small deliberate retune does not fail the suite.
      // 270, not 280: the band below PERMITS a floor of 280, and the rendered
      // height equals the constant to the pixel, so a 280 literal would pass with
      // zero slack — the two guards would stop being independent at exactly the
      // value the band allows. 270 keeps the headroom this comment claims.
      expect(frame.getBoundingClientRect().height).toBeGreaterThanOrEqual(270);
    });

    /**
     * The floor's VALUE is a product decision with a viewport population behind
     * it, so it gets its own bounds rather than being free to drift.
     *
     * Lower bound: below ~280 the block's own area (floor minus the host chrome)
     * stops being usable, which is the case the floor exists to prevent.
     *
     * Upper bound: the floor fires whenever `available < FILL_MIN_HEIGHT_PX`, and
     * when it fires the page grows a scrollbar beside the block's own — i.e. the
     * original bug, in a narrower window. Every px added here widens the
     * viewport population that sees it, so the ceiling is what stops "just raise
     * the floor" from quietly undoing this PR. The arithmetic is in the
     * constant's doc comment.
     */
    test('the floor stays inside its documented band — a retune is deliberate, not drift', () => {
      expect(FILL_MIN_HEIGHT_PX).toBeGreaterThanOrEqual(280);
      expect(FILL_MIN_HEIGHT_PX).toBeLessThanOrEqual(340);
    });

    test('and what is squeezed out stays REACHABLE — user-scrollable, not merely overflowing', async () => {
      const available = 153;
      renderInNoScrollChain(available);
      await expect.element(page.getByTestId('app-page-frame')).toBeInTheDocument();

      const wrapper = page.getByTestId('page-wrapper').element() as HTMLElement;

      // 🔴 `scrollHeight > clientHeight` ALONE DOES NOT MEAN "REACHABLE", and
      // this test asserted only that at first. An `overflow: hidden` box still
      // reports `scrollHeight > clientHeight` — it has overflow, it just refuses
      // to let the user get to it. Flipping this fixture's `overflowY` from
      // `auto` to `hidden` left all 8 tests GREEN, i.e. the assertion passed for
      // a reason unrelated to what it claimed. Both halves are needed: there is
      // something to scroll, AND the box is user-scrollable.
      // ⚠️ This half is WEAK ON ITS OWN and is kept only as a precondition: the
      // fixture's `AppBlockChrome` is ~200px tall, so at `available = 153` the
      // wrapper overflows because of the CHROME whether or not the floor exists.
      // It cannot distinguish fixed from reverted — the absolute-height
      // assertion above is what does that. Stated here so nobody reads this line
      // as floor coverage.
      expect(wrapper.scrollHeight).toBeGreaterThan(wrapper.clientHeight);
      // This half is the real one: user-scrollable, not merely overflowing.
      expect(['auto', 'scroll']).toContain(getComputedStyle(wrapper).overflowY);
    });

    test('at a NORMAL viewport the floor is inert — still no outer scrollbar', async () => {
      // The other half of the "measure at >= 2 points" rule: a floor that fires
      // at ordinary sizes would reintroduce the bug for everyone. 900px is
      // comfortably above the floor.
      const available = 900;
      renderInNoScrollChain(available);
      await expect.element(page.getByTestId('app-page-frame')).toBeInTheDocument();

      const wrapper = page.getByTestId('page-wrapper').element() as HTMLElement;
      expect(wrapper.scrollHeight).toBe(wrapper.clientHeight);
      // The host filled the space rather than sitting at its floor.
      const frame = page.getByTestId('app-page-frame').element() as HTMLElement;
      expect(frame.getBoundingClientRect().height).toBe(available);
    });
  });

  test('the DEFAULT is `viewport`, so a mounter that has not opted in is unchanged', async () => {
    // The dev tunnel sits inside a SCROLLING ancestor that does not bound its
    // height; on `fill` it would collapse to the floor. Pinning the default here
    // is what keeps every `fill` opt-in a deliberate one.
    //
    // ⚠️ This comment used to name the mod-review preview alongside the dev
    // tunnel, and that was the wrong reading of that surface: it is not in an
    // unbounded scrolling ancestor, it is in a box that bounds its height and
    // then clips (a 420px modal panel / a `100dvh − header` page box). It is on
    // `fill` as of the fix for that; see `ReviewPreviewFit.browser.test.tsx`.
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
