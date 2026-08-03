import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type * as RecentsMod from '~/components/Apps/recentlyOpenedAppsStore';
import type { ListingCard, ListingDetail } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * P2c AppListingDetailBody component tests (REPORT-ONLY — the browser project is
 * non-blocking; the blocking gate is appListingDetailView.test.ts). These pin the
 * owner "Edit" deep-link gating (Item 2) + the long-username tooltip fallback
 * (Item 1) on the detail surface. The trpc-consuming children (reviews / report /
 * comments) are mocked to null so this stays network-free and header-focused.
 */

const mocks = vi.hoisted(() => ({
  currentUser: null as null | { id: number; username: string },
  // Items the mocked `appListings.listAvailable` returns to the related rail.
  relatedItems: [] as unknown[],
  // Every `recordRecentlyOpenedApp(...)` argument seen this test, in order.
  recorded: [] as unknown[],
}));

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => mocks.currentUser,
}));

// Recents SPY — spread the real module and wrap only the writer, so the store's
// real behaviour (localStorage, per-kind cap, de-dup) is untouched and every
// other importer keeps working. Used by the hero-banner "records exactly as the
// CTA does" tests below, WITH a positive control (see them) — a bare `0` from a
// counter nobody has proved can count is not evidence.
vi.mock('~/components/Apps/recentlyOpenedAppsStore', async (importOriginal) => {
  const actual = await importOriginal<typeof RecentsMod>();
  return {
    ...actual,
    recordRecentlyOpenedApp: (app: Parameters<typeof actual.recordRecentlyOpenedApp>[0]) => {
      mocks.recorded.push(app);
      return actual.recordRecentlyOpenedApp(app);
    },
  };
});

// The detail body now renders the discovery rail, which reads the feature flags
// + `appListings.listAvailable`. Mock both so the suite stays network-free.
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true, appListings: true, appBlocksPages: false }),
}));
// Spread the REAL module and override only `trpc` (local-rules/no-wholesale-
// module-mock): a hand-written replacement silently breaks every importer the
// day '~/utils/trpc' grows an export this factory omits.
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: {
    appListings: {
      listAvailable: {
        useQuery: (_input: unknown, opts?: { enabled?: boolean }) => ({
          data: opts?.enabled === false ? undefined : { items: mocks.relatedItems },
          isLoading: false,
        }),
      },
    },
  },
}));

// Header-focused: stub the trpc-backed children (reviews/report/comments) so the
// test needs no tRPC wiring. They render identifiable markers (not null) so the
// preview-mode tests below can assert they are OMITTED in preview + PRESENT in the
// live (non-preview) render.
vi.mock('~/components/Apps/ReviewListingButton', () => ({
  ReviewListingButton: () => <div data-testid="mock-review-button" />,
}));
vi.mock('~/components/Apps/ReportListingButton', () => ({
  ReportListingButton: () => <div data-testid="mock-report-button" />,
}));
vi.mock('~/components/Apps/AppListingReviews', () => ({
  AppListingReviews: () => <div data-testid="mock-reviews" />,
}));
vi.mock('~/components/Apps/AppListingComments', () => ({
  AppListingComments: () => <div data-testid="mock-comments" />,
}));

// Import AFTER the mocks are declared (vi.mock is hoisted, imports are not).
const { AppListingDetailBody } = await import('./AppListingDetailBody');

beforeEach(() => {
  mocks.currentUser = null;
  mocks.relatedItems = [];
  mocks.recorded = [];
});

function base(over: Partial<ListingDetail>): ListingDetail {
  return {
    id: 'l1',
    serialId: 1,
    slug: 'my-app',
    kind: 'onsite',
    name: 'My App',
    tagline: 'A handy app',
    description: null,
    category: 'utility',
    contentRating: null,
    iconUrl: null,
    coverUrl: null,
    creator: { id: 5, username: 'alice', image: null },
    recommend: { recommendedCount: 0, notRecommendedCount: 0, recommendPct: null },
    reviewCount: 0,
    screenshots: [],
    kindData: { kind: 'onsite', appBlockId: 'blk-1', hasPage: true, liveUrl: 'https://my-app.civit.ai' },
    ...over,
  };
}

/** A sibling store card as returned by the mocked `listAvailable`. */
function relatedCard(id: string, name: string): ListingCard {
  return {
    id,
    slug: id === 'l1' ? 'my-app' : `slug-${id}`,
    kind: 'onsite',
    name,
    tagline: null,
    category: 'utility',
    contentRating: null,
    iconUrl: null,
    coverUrl: null,
    creator: null,
    recommend: { recommendedCount: 0, notRecommendedCount: 0, recommendPct: null },
    reviewCount: 0,
    kindData: {
      kind: 'onsite',
      appBlockId: `ab-${id}`,
      hasPage: false,
      liveUrl: `https://slug-${id}.civit.ai`,
    },
  };
}

describe('AppListingDetailBody', () => {
  test('kind + category badges are NOT rendered on the detail header (round-2 truncation fix)', async () => {
    // "App" was formerly the on-site kind badge's exact-match text; "utility" is
    // base()'s category → labeled "Utility". Neither should render now — the
    // kind signal instead lives in the primary-action CTA + the off-site
    // disclosure Alert.
    renderWithProviders(<AppListingDetailBody detail={base({})} />);
    await expect.element(page.getByText('My App')).toBeInTheDocument();
    await expect.element(page.getByText('App', { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByText('Utility', { exact: true })).not.toBeInTheDocument();
  });

  test('contentRating badge STILL renders (not removed — it is not a kind/category badge)', async () => {
    renderWithProviders(<AppListingDetailBody detail={base({ contentRating: 'PG' })} />);
    await expect.element(page.getByText('PG', { exact: true })).toBeInTheDocument();
  });

  test('owner sees the Edit deep-link → on-site manifest editor', async () => {
    mocks.currentUser = { id: 5, username: 'alice' }; // matches base().creator.id
    renderWithProviders(<AppListingDetailBody detail={base({})} />);
    const edit = page.getByTestId('apps-listing-owner-edit');
    await expect.element(edit).toBeInTheDocument();
    await expect.element(edit).toHaveAttribute('href', '/apps/blk-1/edit');
  });

  test('owner of an off-site listing → Edit routes to the submit editor by listing id', async () => {
    mocks.currentUser = { id: 5, username: 'alice' };
    renderWithProviders(
      <AppListingDetailBody
        detail={base({
          kind: 'offsite',
          kindData: {
            kind: 'offsite',
            subKind: 'external-link',
            externalUrl: 'https://ext.app',
            connectClientId: null,
          },
        })}
      />
    );
    await expect
      .element(page.getByTestId('apps-listing-owner-edit'))
      .toHaveAttribute('href', '/apps/submit?edit=l1');
  });

  // 🔴 The two absence tests below RENDER-BARRIER first, then assert with
  // `.elements()`. `await expect.element(x).not.toBeInTheDocument()` polls until
  // the assertion passes — with `.not`, the still-empty pre-commit DOM satisfies
  // it on poll #0, so the test passed even when the Edit button was rendered.
  test('non-owner does NOT see the Edit deep-link', async () => {
    mocks.currentUser = { id: 999, username: 'bob' };
    renderWithProviders(<AppListingDetailBody detail={base({})} />);
    await expect.element(page.getByText('My App')).toBeInTheDocument();
    expect(page.getByTestId('apps-listing-owner-edit').elements()).toHaveLength(0);
  });

  test('signed-out viewer does NOT see the Edit deep-link', async () => {
    mocks.currentUser = null;
    renderWithProviders(<AppListingDetailBody detail={base({})} />);
    await expect.element(page.getByText('My App')).toBeInTheDocument();
    expect(page.getByTestId('apps-listing-owner-edit').elements()).toHaveLength(0);
  });

  test('preview mode renders presentational parts and OMITS comments/reviews/report/review-button/primary-action', async () => {
    // Owner viewing — so even the owner Edit affordance must be absent in preview.
    mocks.currentUser = { id: 5, username: 'alice' };
    renderWithProviders(
      <AppListingDetailBody
        detail={base({
          description: 'About **this** app.',
          screenshots: [{ url: 'https://cdn.example/shot-1.png', caption: 'a shot' }],
        })}
        preview
      />
    );

    // Presentational parts still render: name, content-rating, screenshot gallery,
    // description body.
    await expect.element(page.getByText('My App')).toBeInTheDocument();
    await expect.element(page.getByText('Screenshots')).toBeInTheDocument();
    await expect.element(page.getByText('About', { exact: true })).toBeInTheDocument();

    // Interactive / review surfaces are all OMITTED.
    expect(page.getByTestId('mock-comments').elements().length).toBe(0);
    expect(page.getByTestId('mock-reviews').elements().length).toBe(0);
    expect(page.getByTestId('mock-report-button').elements().length).toBe(0);
    expect(page.getByTestId('mock-review-button').elements().length).toBe(0);
    expect(page.getByTestId('apps-listing-owner-edit').elements().length).toBe(0);
    // The primary action is gone too.
    expect(page.getByTestId('apps-listing-open-live').elements().length).toBe(0);
    // …as is the discovery rail (a live, tRPC-backed surface).
    expect(page.getByTestId('apps-related-rail').elements().length).toBe(0);
    // Back-to-store nav is gone.
    expect(page.getByText('Back to store').elements().length).toBe(0);
  });

  test('non-preview (live) still renders comments/reviews/report/review-button + primary action (regression)', async () => {
    renderWithProviders(<AppListingDetailBody detail={base({})} />);
    // The live surfaces are all present.
    await expect.element(page.getByTestId('mock-comments')).toBeInTheDocument();
    await expect.element(page.getByTestId('mock-reviews')).toBeInTheDocument();
    await expect.element(page.getByTestId('mock-report-button')).toBeInTheDocument();
    await expect.element(page.getByTestId('mock-review-button')).toBeInTheDocument();
    // Primary action present. base() is an on-site page app whose viewer CAN'T
    // open the in-host page route (appBlocksPages is false in the mocked flags),
    // so the raw-origin "Open live" escape hatch is the primary action — and,
    // with the in-page preview removed, the only way to run the app from here.
    const openLive = page.getByTestId('apps-listing-open-live');
    await expect.element(openLive).toBeInTheDocument();
    await expect.element(openLive).toHaveAttribute('href', 'https://my-app.civit.ai');
    await expect.element(openLive).toHaveAttribute('target', '_blank');
    await expect.element(openLive).toHaveAttribute('rel', 'noopener noreferrer');
  });

  // ── The in-page live preview is REMOVED ─────────────────────────────────────
  //
  // 🔴 THIS IS AN INVARIANT GUARD, NOT REGRESSION COVERAGE. It pins an invariant
  // the original defect never violated — the old code rendered the section and
  // the frame, so this assertion could not have caught the bug it documents. It
  // exists to stop the pattern being reinstated, nothing more.
  //
  // What was actually wrong: `LivePreview` mounted a bare
  // `<iframe src={liveUrl}>` at `<slug>.civit.ai`. A block does not boot from
  // its URL — it waits for a host to post `BLOCK_INIT` over the block bridge,
  // and nothing posted it to that frame, so it painted the block's pre-init
  // LIGHT-theme shell (#FEFEFE) on a dark page and stopped. The two escape
  // hatches are both frame-blind: the build-recipe edge redirect keys on
  // `Sec-Fetch-Dest: document` (a frame sends `iframe`) and the SDK
  // `<BlockGate>` landing keys on `window.self === window.top` (false in a
  // frame). The moderator review preview (`ReviewBlockPreviewHost`) is a
  // different, working surface with a real bridge and is untouched.

  test('🔴 renders NO in-page preview section and NO iframe (invariant guard)', async () => {
    // The live posture (not `preview`), on the on-site page app that used to
    // render the preview — i.e. the exact case that previously mounted it.
    renderWithProviders(<AppListingDetailBody detail={base({})} />);
    // Anchor on a real awaited element first, so the sync DOM reads below are
    // not racing the mount.
    await expect.element(page.getByTestId('apps-listing-open-live')).toBeInTheDocument();

    expect(page.getByTestId('apps-listing-preview').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-listing-preview-activate').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-listing-preview-frame').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-listing-preview-poster').elements()).toHaveLength(0);
    // No third-party frame of any kind, however it might be re-added.
    expect(document.querySelectorAll('iframe')).toHaveLength(0);
    // …and no copy pointing at a section that does not exist.
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('Live preview');
    expect(text).not.toContain('Run live preview');
    expect(text).not.toContain('live preview below');
  });

  test('a listing with NO cover and NO screenshots renders no preview either', async () => {
    // The poster-fallback path was the last thing that could still have mounted
    // a frame for an art-less listing.
    renderWithProviders(
      <AppListingDetailBody detail={base({ coverUrl: null, screenshots: [] })} />
    );
    await expect.element(page.getByText('My App')).toBeInTheDocument();
    expect(page.getByTestId('apps-listing-preview').elements()).toHaveLength(0);
    expect(document.querySelectorAll('iframe')).toHaveLength(0);
  });

  test('canOpenPage → the in-host Open button, and the raw-origin escape hatch is HIDDEN', async () => {
    // The redundancy the removal was actually about: once /apps/run works there
    // is no reason to also ship the viewer to <slug>.civit.ai.
    renderWithProviders(<AppListingDetailBody detail={base({})} canOpenPage />);
    await expect.element(page.getByText('Open', { exact: true })).toBeInTheDocument();
    expect(page.getByTestId('apps-listing-open-live').elements()).toHaveLength(0);
  });

  test('the VERBOSE legacy preview copy is gone (the escape-hatch button is not)', async () => {
    renderWithProviders(<AppListingDetailBody detail={base({})} />);
    await expect.element(page.getByTestId('apps-listing-open-live')).toBeInTheDocument();
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('Preview of the standalone block at');
    expect(text).not.toContain('The live block on a model page runs with your granted permissions');
    expect(text).not.toContain('this standalone preview does not');
    // The button itself STAYS in this state — it is the only route for a block
    // the sandboxed frame can't run. Only the wall of caveat text was removed.
    expect(page.getByTestId('apps-listing-open-live').elements()).toHaveLength(1);
  });

  // ── Primary-action glyph (S6a) ─────────────────────────────────────────────
  //
  // 🔴 THIS is the gate for the component wiring. The node suite
  // (`__tests__/appListingActionGlyph.test.ts`) proves the MAPPING is correct —
  // it stays fully green if someone hard-codes an icon back into a branch of
  // `PrimaryAction`, because it never renders the component. Only these tests
  // fail on that.
  //
  // Marker choice: Tabler renders `class="tabler-icon tabler-icon-<name>"`
  // (`tabler-icon-${iconName}` in the package's `createReactComponent`). That is
  // stable across a patch bump in a way the raw path `d` is not, and it survives
  // in browser mode — unlike `data-testid`, which the production compiler strips
  // (`reactRemoveProperties`), so it must never be the marker on a preview.

  /** The `tabler-icon-*` modifier class on the button's glyph, e.g. `player-play`. */
  function glyphOf(button: Element): string {
    const svg = button.querySelector('svg');
    if (!svg) throw new Error('primary action button rendered no glyph at all');
    const modifier = Array.from(svg.classList).find(
      (c) => c.startsWith('tabler-icon-') && c !== 'tabler-icon'
    );
    if (!modifier)
      throw new Error(`glyph carried no tabler-icon-* class: ${svg.getAttribute('class')}`);
    return modifier.replace('tabler-icon-', '');
  }

  /** The off-site (external-link) variant of `base()`. */
  const offsite = () =>
    base({
      kind: 'offsite',
      kindData: {
        kind: 'offsite',
        subKind: 'external-link',
        externalUrl: 'https://ext.app',
        connectClientId: null,
      },
    });

  /**
   * Render barrier. Measured: a bare `document.querySelector` immediately after
   * an awaited `renderWithProviders` DID return null here — the same trap the
   * `.not` comment above describes, in its positive form. Retrying removes it.
   *
   * Polls for the CTA itself rather than a text barrier: these tests render
   * TWICE in one body, so a `page.getByText('My App')` locator would match both
   * mounts and throw on strict mode. Each variant's href is unique, so each wait
   * can only be satisfied by its own mount.
   *
   * 🔴 `[class*="Button-root"]` is load-bearing. The click-to-launch hero banner
   * is an anchor to the SAME `/apps/run/<slug>` href and sits EARLIER in the
   * tree, so a bare `a[href=…]` returns the banner and `glyphOf` then reads the
   * cover placeholder's category icon instead of the CTA's. That is a real
   * failure for the glyph test — and, worse, a silent FALSE PASS for the
   * link-semantics test below, whose assertions (no `target`, no `rel`) the
   * banner happens to satisfy too. These tests are about the BUTTON; say so in
   * the selector.
   *
   * Discriminate on what the CTA IS, not on what it is not: an earlier revision
   * excluded the banner's `data-testid`, which works here but is a trap to copy —
   * `next.config.mjs` strips `data-testid` in production builds
   * (`reactRemoveProperties`), so that shape matches nothing in a prod-build
   * harness. Mirrors `waitForCta` in AppListingCard.browser.test.tsx.
   *
   * Timeout matches the 10s that `test/component-setup.tsx` deliberately sets as
   * the project-wide `vi.waitFor` default — its comment names the saturated
   * preview CI box, where these browser tests share a host with the image build.
   * `vi.waitUntil` is not covered by that patch, so it is set explicitly.
   */
  async function renderAndSettle(
    ui: Parameters<typeof renderWithProviders>[0],
    ctaHref: string
  ): Promise<HTMLAnchorElement> {
    await renderWithProviders(ui);
    const cta = await vi.waitUntil(
      () =>
        // 🔴 Discriminate STRUCTURALLY (the CTA is the Button), not by excluding
        // the banner's `data-testid`. `next.config.mjs` strips `data-testid` in
        // production builds via `reactRemoveProperties`, so a testid-based
        // selector is correct in vitest (dev transform) but silently matches
        // nothing in any prod-build harness. This mirrors the existing precedent
        // at AppListingCard.browser.test.tsx's `waitForCta`, and it is
        // self-describing: it says what the CTA IS rather than what it is not.
        document.body.querySelector(`a[href="${ctaHref}"][class*="Button-root"]`),
      { timeout: 10000, interval: 25 }
    );
    return cta as HTMLAnchorElement;
  }

  test('🔴 the in-site Open CTA and the off-site Visit CTA render DIFFERENT glyphs', async () => {
    // The premise civitai #3391 removed the kind + category badges on: that the
    // on-site/off-site signal rides the CTA. Before S6a both branches rendered
    // the byte-identical IconExternalLink, so it did not.
    const openBtn = await renderAndSettle(
      <AppListingDetailBody detail={base({})} canOpenPage />,
      '/apps/run/my-app'
    );
    const openGlyph = glyphOf(openBtn);

    const visitBtn = await renderAndSettle(
      <AppListingDetailBody detail={offsite()} />,
      'https://ext.app'
    );
    const visitGlyph = glyphOf(visitBtn);

    expect(openGlyph).not.toBe(visitGlyph);
    // Pin the actual values too, so "different" can't be satisfied by regressing
    // the off-site branch instead of fixing the in-site one.
    expect(openGlyph).toBe('player-play');
    expect(visitGlyph).toBe('external-link');
  });

  test('the glyph change does NOT touch link semantics', async () => {
    // S6a is iconography only. The in-site CTA must stay a same-tab internal
    // link, and the off-site one must keep its new-tab + rel hardening.
    const openBtn = await renderAndSettle(
      <AppListingDetailBody detail={base({})} canOpenPage />,
      '/apps/run/my-app'
    );
    expect(openBtn.getAttribute('target')).toBeNull();
    expect(openBtn.getAttribute('rel')).toBeNull();

    const visitBtn = await renderAndSettle(
      <AppListingDetailBody detail={offsite()} />,
      'https://ext.app'
    );
    expect(visitBtn.getAttribute('target')).toBe('_blank');
    expect(visitBtn.getAttribute('rel')).toBe('noopener noreferrer');
  });

  /**
   * Glyph of the CTA whose visible text is exactly `label`.
   *
   * The `connect` and `info` affordances render no anchor — connect is a
   * DISABLED button and info is a plain `Group` of icon + text — so
   * `renderAndSettle`'s href key can't reach them. Matching on exact
   * `textContent` plus "has an svg child" is unambiguous here: the enclosing
   * `Stack` also carries the note text, so its textContent is longer, and the
   * inner `<Text>` has the right text but no icon.
   */
  async function waitForCtaGlyph(label: string): Promise<string> {
    const host = await vi.waitUntil(
      () =>
        Array.from(document.body.querySelectorAll('button, div')).find(
          (n) => n.textContent?.trim() === label && n.querySelector('svg')
        ) ?? null,
      { timeout: 10000, interval: 25 }
    );
    return glyphOf(host as Element);
  }

  // Regression guards for the per-branch glyph refactor: the four call sites pass
  // hard-coded mode literals rather than `action.mode`, so a literal copied into
  // the wrong branch would otherwise be caught by nothing. The open/visit pair is
  // value-pinned above; these are the other two.
  //
  // 🔴 ONE render per test, deliberately. `waitForCtaGlyph` scans the whole
  // document and takes the first hit, and `afterEach(cleanup)` does NOT run
  // between two renders inside a single test — so a shared test body would bias
  // the match toward the OLDER mount if a label ever collided. Separate tests
  // make each scan unambiguous by construction, and let a connect-branch
  // mutation and an info-branch mutation each be observed on the same run
  // instead of the first one short-circuiting the second.

  test('the connect branch keeps its own glyph', async () => {
    // off-site OAuth → the `connect` stub (disabled button + note).
    await renderWithProviders(
      <AppListingDetailBody
        detail={base({
          kind: 'offsite',
          kindData: {
            kind: 'offsite',
            subKind: 'connect',
            externalUrl: null,
            connectClientId: 'oauth-client-1',
          },
        })}
      />
    );
    expect(await waitForCtaGlyph('Connect')).toBe('plug-connected');
  });

  test('the info (model-slot) branch keeps its own glyph', async () => {
    // on-site app with NO launch page → the informational model-slot affordance.
    // `liveUrl` is read only inside the `hasPage` guards, so `hasPage: false`
    // reaches the model-slot return regardless of it — this fixture cannot
    // silently land on the "Open live" visit branch.
    await renderWithProviders(
      <AppListingDetailBody
        detail={base({
          kindData: {
            kind: 'onsite',
            appBlockId: 'blk-1',
            hasPage: false,
            liveUrl: 'https://my-app.civit.ai',
          },
        })}
      />
    );
    expect(await waitForCtaGlyph('Runs on model pages')).toBe('info-circle');
  });

  // ── Discovery rail ─────────────────────────────────────────────────────────

  test('the related rail renders siblings and EXCLUDES the listing being viewed', async () => {
    mocks.relatedItems = [
      relatedCard('l1', 'My App'), // self — must not appear as a related card
      relatedCard('l2', 'Sibling One'),
      relatedCard('l3', 'Sibling Two'),
    ];
    renderWithProviders(<AppListingDetailBody detail={base({})} />);

    await expect.element(page.getByTestId('apps-related-rail')).toBeInTheDocument();
    await expect.element(page.getByText('Sibling One')).toBeInTheDocument();
    await expect.element(page.getByText('Sibling Two')).toBeInTheDocument();
    // Two related cards, not three — self was dropped.
    expect(page.getByTestId('apps-related-grid-col').elements()).toHaveLength(2);
    // No related card links back to this very listing.
    const hrefs = page
      .getByTestId('apps-related-grid-col')
      .elements()
      .flatMap((col) => Array.from(col.querySelectorAll('a')).map((a) => a.getAttribute('href')));
    expect(hrefs).not.toContain('/apps/store-preview/my-app');
  });

  test('the "Browse all apps" link is present even when the rail is empty', async () => {
    mocks.relatedItems = [];
    renderWithProviders(<AppListingDetailBody detail={base({})} />);
    const browse = page.getByTestId('apps-browse-all');
    await expect.element(browse).toBeInTheDocument();
    await expect.element(browse).toHaveAttribute('href', '/apps');
  });

  test('a long username reveals the full value in a tooltip on hover (clip fallback)', async () => {
    const longName = 'a-really-long-creator-username-that-will-definitely-overflow-the-header-column';
    // The tooltip is overflow-GATED (TruncatedText disables it unless the label
    // actually clips — a runtime scrollWidth/scrollHeight measurement). Constrain
    // the header to a narrow column so the long username really overflows; without a
    // width bound the label never clips and the tooltip stays disabled.
    renderWithProviders(
      <div style={{ width: 200 }}>
        <AppListingDetailBody detail={base({ creator: { id: 5, username: longName, image: null } })} />
      </div>
    );
    const label = page.getByText(`by ${longName}`);
    await expect.element(label).toBeInTheDocument();
    await label.hover();
    await expect.element(page.getByText(longName, { exact: true })).toBeInTheDocument();
  });

  // ── Hero banner click-to-launch ────────────────────────────────────────────
  //
  // The banner is a SECOND affordance for the primary `open` action — an
  // ordinary `<a href="/apps/run/<slug>">` wrapping the cover art. Not a frame,
  // not a div-with-onClick.
  //
  // 🔴 RED-AT-BASE STATUS, stated per test rather than implied. Measured by
  // running each test in isolation (`-t`) against the pristine parent commit:
  //   RED   — "is a real link", "NO cover art still launches", "keyboard
  //           focusable and Enter activates", "records recents exactly as the
  //           Open CTA does". These are genuine regression coverage.
  //   GREEN — the four negative tests (preview, off-site, the on-site "Open
  //           live" escape hatch, the model-slot info branch) and the positive
  //           control. Base renders no banner link at all, so the negatives pass
  //           there VACUOUSLY: they are INVARIANT GUARDS, not coverage. What
  //           they are worth is mutation-proof against THIS change's own guard —
  //           drop a clause from `heroLaunchHref` and each goes red for its own
  //           reason. Do not count them as regression coverage.

  /** The banner's launch anchor, when there is one. */
  const HERO = 'apps-listing-hero-launch';

  /**
   * Render, and return a locator scoped to THIS mount's container.
   *
   * 🔴 Every query below goes through `within`, never the page-wide `page.*` or
   * `document.body`. Measured while establishing the red-at-base matrix (on the
   * pre-#3556 base, where the `afterEach` `cleanup()` was not awaited): a test
   * that FAILS could leave its mounted tree in `document.body`, so with three
   * neighbours red the next test saw three extra copies — a body-wide
   * `getByText('My App')` hit "strict mode violation: resolved to 3 elements"
   * and a body-wide `querySelectorAll('a[href="/apps/run/my-app"]')` counted the
   * previous mount's CTA and reported "expected 0, got 1". Both were FALSE reds
   * about this change: run in isolation the same tests passed. #3556 has since
   * fixed that root cause; the scoping stays anyway, because whether this test
   * passes should not depend on whether its neighbours did.
   *
   * (`renderWithProviders`'s own returned selectors do NOT do this — vitest-
   * browser-react binds them to `baseElement`, which defaults to
   * `document.body`. `page.elementLocator(container)` is the scoped one.)
   */
  async function renderScoped(ui: Parameters<typeof renderWithProviders>[0]) {
    const { container } = await renderWithProviders(ui);
    return { container, within: page.elementLocator(container) };
  }

  /**
   * Swallow a real activation: capture-phase `preventDefault()` on `document`.
   *
   * Runs BEFORE React's root-container listeners, so (a) the browser performs no
   * navigation and opens no tab, and (b) `next/link`'s own handler sees
   * `e.defaultPrevented` and bails out of `router.push`. A plain `<a onClick>`
   * (the off-site Visit CTA) still runs its React handler — which is exactly
   * what the positive control below needs: the side effect fires, the
   * navigation does not.
   */
  async function withoutNavigating<T>(fn: () => Promise<T>): Promise<T> {
    const stop = (e: Event) => e.preventDefault();
    document.addEventListener('click', stop, true);
    try {
      return await fn();
    } finally {
      document.removeEventListener('click', stop, true);
    }
  }

  test('🔴 on-site + canOpenPage → the banner is a real link to the SAME target as the Open CTA', async () => {
    const { container, within } = await renderScoped(
      <AppListingDetailBody detail={base({})} canOpenPage />
    );
    const hero = within.getByTestId(HERO);
    await expect.element(hero).toBeInTheDocument();

    const el = hero.element() as HTMLElement;
    // Semantics, not a click handler on a box: a real anchor, same-tab.
    expect(el.tagName).toBe('A');
    expect(el.getAttribute('href')).toBe('/apps/run/my-app');
    expect(el.getAttribute('target')).toBeNull();
    // Accessible NAME — neither the cover `alt` ("… cover image") nor the
    // aria-hidden placeholder can supply one, so it is explicit.
    expect(el.getAttribute('aria-label')).toBe('Open My App');
    // No nested interactive: the banner wraps art only.
    expect(el.querySelectorAll('a, button, input, select, textarea')).toHaveLength(0);

    // "Same destination as the CTA" asserted as a fact about the DOM, not by
    // restating the string: exactly two anchors point at the run route — the
    // banner and the button. If the banner ever aims somewhere else this is 1.
    expect(container.querySelectorAll('a[href="/apps/run/my-app"]')).toHaveLength(2);
  });

  test('🔴 a listing with NO cover art still gets the launch affordance', async () => {
    // The placeholder-gradient branch. An owner who has not uploaded a cover yet
    // must not silently lose the way into their own app.
    const { within } = await renderScoped(<AppListingDetailBody detail={base({ coverUrl: null })} canOpenPage />);
    const hero = within.getByTestId(HERO);
    await expect.element(hero).toBeInTheDocument();
    expect(hero.element().getAttribute('href')).toBe('/apps/run/my-app');
    // …and it really is the seeded-gradient placeholder inside, not a cover
    // image — otherwise this test would pass on the wrong branch.
    expect(hero.element().querySelector('[data-listing-cover-placeholder]')).not.toBeNull();
  });

  test('🔴 the banner is keyboard focusable and Enter activates it', async () => {
    const { within } = await renderScoped(<AppListingDetailBody detail={base({})} canOpenPage />);
    const hero = within.getByTestId(HERO);
    await expect.element(hero).toBeInTheDocument();
    const el = hero.element() as HTMLElement;

    const activated: (string | null)[] = [];
    await withoutNavigating(async () => {
      el.focus();
      // A `<div onClick>` is not focusable without an explicit tabIndex, so this
      // line alone discriminates the real-semantics requirement.
      expect(document.activeElement).toBe(el);
      document.addEventListener(
        'click',
        (e) => activated.push((e.target as Element).closest('a')?.getAttribute('href') ?? null),
        { capture: true, once: true }
      );
      await userEvent.keyboard('{Enter}');
    });
    // The browser synthesised an activation click from the keypress, and it came
    // from the banner anchor.
    expect(activated).toEqual(['/apps/run/my-app']);
  });

  test('preview mode renders NO launchable banner (invariant guard — see the block note)', async () => {
    // The moderator listing-media review posture. `canOpenPage` is passed TRUE
    // on purpose: the only thing suppressing the banner here must be `preview`.
    const { container, within } = await renderScoped(
      <AppListingDetailBody detail={base({})} canOpenPage preview />
    );
    await expect.element(within.getByText('My App')).toBeInTheDocument(); // render barrier
    expect(container.querySelectorAll(`[data-testid="${HERO}"]`)).toHaveLength(0);
    // Nothing anywhere in the read-only body links to the run route.
    expect(container.querySelectorAll('a[href="/apps/run/my-app"]')).toHaveLength(0);
  });

  test('off-site (Visit) → the banner is NOT interactive (invariant guard)', async () => {
    // Design call: an off-site destination is never reached from decorative art.
    const { container, within } = await renderScoped(
      <AppListingDetailBody detail={offsite()} />
    );
    await expect.element(within.getByTestId('apps-listing-open-live')).toBeInTheDocument();
    expect(container.querySelectorAll(`[data-testid="${HERO}"]`)).toHaveLength(0);
    // Exactly one route off-platform: the labelled button.
    expect(container.querySelectorAll('a[href="https://ext.app"]')).toHaveLength(1);
  });

  test('the on-site raw-origin escape hatch does NOT make the banner interactive (invariant guard)', async () => {
    // on-site page app, viewer WITHOUT `appBlocksPages` → the action is `visit`
    // to <slug>.civit.ai. Same off-platform reasoning as the off-site case, and
    // the branch a `mode !== 'visit'`-shaped guard would most easily get wrong.
    const { container, within } = await renderScoped(<AppListingDetailBody detail={base({})} />);
    await expect.element(within.getByTestId('apps-listing-open-live')).toBeInTheDocument();
    expect(container.querySelectorAll(`[data-testid="${HERO}"]`)).toHaveLength(0);
    expect(container.querySelectorAll('a[href="https://my-app.civit.ai"]')).toHaveLength(1);
  });

  test('the model-slot info branch (no href at all) leaves the banner inert (invariant guard)', async () => {
    const { container, within } = await renderScoped(
      <AppListingDetailBody
        detail={base({
          kindData: {
            kind: 'onsite',
            appBlockId: 'blk-1',
            hasPage: false,
            liveUrl: 'https://my-app.civit.ai',
          },
        })}
        canOpenPage
      />
    );
    await expect.element(within.getByText('Runs on model pages')).toBeInTheDocument();
    expect(container.querySelectorAll(`[data-testid="${HERO}"]`)).toHaveLength(0);
  });

  // ── Recents: exactly once, matching the CTA ────────────────────────────────
  //
  // 🔴 The claim under test is a ZERO ("the banner adds no recents write"), and
  // a zero from a counter that has never been shown to count is indistinguishable
  // from a counter wired to nothing. So the control comes FIRST and must read 1.

  test('POSITIVE CONTROL — the off-site Visit CTA records exactly 1 through this counter', async () => {
    const { within } = await renderScoped(<AppListingDetailBody detail={offsite()} />);
    const cta = within.getByTestId('apps-listing-open-live');
    await expect.element(cta).toBeInTheDocument();
    expect(mocks.recorded).toHaveLength(0); // a VIEW records nothing
    await withoutNavigating(() => userEvent.click(cta));
    expect(mocks.recorded).toHaveLength(1);
  });

  test('🔴 the banner records recents exactly as the Open CTA does — i.e. not on click at all', async () => {
    // `/apps/run/<slug>` records the open in its own mount effect, which is why
    // the `open` CTA has no onClick. The banner must match it: 0 here, 1 there.
    // The control above proves this counter CAN observe a write, so these zeros
    // are evidence rather than an absence of wiring.
    const { container, within } = await renderScoped(
      <AppListingDetailBody detail={base({})} canOpenPage />
    );
    await expect.element(within.getByTestId(HERO)).toBeInTheDocument();

    const links = Array.from(
      container.querySelectorAll<HTMLAnchorElement>('a[href="/apps/run/my-app"]')
    );
    expect(links).toHaveLength(2);
    const [heroEl, ctaEl] = links;
    expect(heroEl.getAttribute('data-testid')).toBe(HERO); // the banner is first in the tree

    await withoutNavigating(async () => {
      await userEvent.click(ctaEl);
      const afterCta = mocks.recorded.length;
      await userEvent.click(heroEl);
      const afterHero = mocks.recorded.length;

      expect(afterCta).toBe(0); // the CTA's own behaviour, re-measured not assumed
      expect(afterHero - afterCta).toBe(0); // the banner adds nothing on top of it
    });
  });
});
