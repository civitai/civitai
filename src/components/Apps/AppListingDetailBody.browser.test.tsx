import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
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
}));

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => mocks.currentUser,
}));

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
    // …as is the in-page preview and the discovery rail (both live surfaces).
    expect(page.getByTestId('apps-listing-preview').elements().length).toBe(0);
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
    // so the raw-origin "Open live" escape hatch is the primary action — the
    // sandboxed in-page preview alone can't run a block that needs a form /
    // popup / download.
    const openLive = page.getByTestId('apps-listing-open-live');
    await expect.element(openLive).toBeInTheDocument();
    await expect.element(openLive).toHaveAttribute('href', 'https://my-app.civit.ai');
    await expect.element(openLive).toHaveAttribute('target', '_blank');
    await expect.element(openLive).toHaveAttribute('rel', 'noopener noreferrer');
  });

  // ── In-page live preview (poster → click to activate) ───────────────────────

  test('🔴 does NOT mount an iframe before the click, and DOES after', async () => {
    renderWithProviders(<AppListingDetailBody detail={base({})} />);

    await expect.element(page.getByTestId('apps-listing-preview')).toBeInTheDocument();
    // Before activation: a poster + activate control, and NO iframe anywhere in
    // the document (the direct encoding of "no third-party frame boots on load").
    await expect.element(page.getByTestId('apps-listing-preview-activate')).toBeInTheDocument();
    expect(page.getByTestId('apps-listing-preview-frame').elements()).toHaveLength(0);
    expect(document.querySelectorAll('iframe')).toHaveLength(0);

    await userEvent.click(page.getByTestId('apps-listing-preview-activate'));

    const frame = page.getByTestId('apps-listing-preview-frame');
    await expect.element(frame).toBeInTheDocument();
    await expect.element(frame).toHaveAttribute('src', 'https://my-app.civit.ai');
    await expect.element(frame).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin');
    await expect.element(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
    await expect.element(frame).toHaveAttribute('loading', 'lazy');
  });

  test('a listing with NO cover and NO screenshots still gets an activatable preview', async () => {
    renderWithProviders(
      <AppListingDetailBody detail={base({ coverUrl: null, screenshots: [] })} />
    );
    await userEvent.click(page.getByTestId('apps-listing-preview-activate'));
    await expect.element(page.getByTestId('apps-listing-preview-frame')).toBeInTheDocument();
  });

  test('an OFF-SITE listing gets no preview section at all', async () => {
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
    await expect.element(page.getByText('My App')).toBeInTheDocument();
    expect(page.getByTestId('apps-listing-preview').elements()).toHaveLength(0);
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
    await expect.element(page.getByTestId('apps-listing-preview')).toBeInTheDocument();
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
    if (!modifier) throw new Error(`glyph carried no tabler-icon-* class: ${svg.getAttribute('class')}`);
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
    const cta = await vi.waitUntil(() => document.body.querySelector(`a[href="${ctaHref}"]`), {
      timeout: 10000,
      interval: 25,
    });
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

  test('the connect and info branches keep their own glyphs', async () => {
    // Regression guard for the per-branch glyph refactor: the four call sites
    // now pass hard-coded mode literals rather than `action.mode`, so a copied
    // literal in the wrong branch would otherwise be caught by nothing. The
    // open/visit pair is value-pinned above; these are the other two.

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

    // on-site app with NO launch page → the informational model-slot affordance.
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
});
