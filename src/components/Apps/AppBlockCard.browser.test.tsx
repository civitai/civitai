import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type { AvailableBlock } from '~/server/schema/blocks/subscription.schema';

/**
 * App Blocks marketplace CARD — component tests for the action-CTA gate + the
 * 2026-06 UX-pass card cleanup.
 *
 * Load-bearing behaviour:
 *  - "View details" is the UNIVERSAL details affordance: it renders on EVERY
 *    card (page app, model app, flag on/off) and opens the details modal. This
 *    is what now guarantees the never-empty-card INVARIANT (audit HIGH) — it
 *    SUPERSEDES the #2747 page-link "View" fallback (the old tests that asserted
 *    a "View" detail-page link now assert "View details" instead — the coverage
 *    is preserved, retargeted to the new affordance, NOT deleted).
 *  - The "Install"/"Manage" CTA is shown ONLY for apps that install into a
 *    model/in-context slot. A PAGE app (target slot `app.page`, installModel
 *    `'none'`) is stateless — no install row, slot install path server-gated
 *    dark (#2622) — so it never shows Install/Manage.
 *  - Card cleanup: the install count is HIDDEN, the review indicator is hidden
 *    when reviewCount=0 (shown when >0), the mod-assigned category (+ icon) is
 *    shown, and the scopes were MOVED off the card face into the modal.
 *  - Round-2 cleanup (2026-06): the slot/location badge and the "by {author}"
 *    attribution line were DROPPED from the card face (launch is page-only →
 *    slot badge is noise; both still on the detail page/modal), and the
 *    "View details" CTA is now a LINK-STYLE (Mantine `variant="subtle"`) button
 *    — still always rendered (never-empty-card invariant) and still opens the
 *    modal.
 *
 * The install predicate is the shared `hasInstallSlot(manifest)` (slot-registry,
 * the single source of truth shared with the detail page) — it scans ALL targets
 * for ANY non-page slot, so it's correct for multi-target / empty-slotId
 * manifests, keyed on the APP's slot (not the viewer).
 */

// LoginRedirect just clones its child with an onClick wrapper (pulls in router +
// tour context we don't need). Stub it to a pass-through so the child's own
// onClick runs directly — keeps the card test network-free.
vi.mock('~/components/LoginRedirect/LoginRedirect', () => ({
  LoginRedirect: ({ children }: { children: React.ReactElement }) => children,
}));

// AppDetailsModal pulls in tRPC queries (getAppDetail / listMySubscriptions) +
// feature-flag/current-user hooks — its internals are covered by its OWN test
// (AppDetailsModal.browser.test.tsx). Stub it to a lightweight, network-free
// component that just reflects `opened` so the CARD test can assert the
// "View details" button opens the modal without any network. Renders a probe
// element ONLY when open.
const detailsModalSpy = vi.fn();
vi.mock('~/components/Apps/AppDetailsModal', () => ({
  AppDetailsModal: ({ opened, block }: { opened: boolean; block: { id: string } }) => {
    detailsModalSpy({ opened, blockId: block.id });
    return opened ? <div data-testid="details-modal">details for {block.id}</div> : null;
  },
}));

// Import AFTER the mocks are declared (vi.mock is hoisted, imports are not).
const { AppBlockCard } = await import('./AppBlockCard');

type ManifestShape = {
  name?: string;
  description?: string;
  targets?: Array<{ slotId?: string }>;
  hasPage?: boolean;
};

function makeBlock(
  manifestOverrides: ManifestShape = {},
  overrides: Partial<AvailableBlock> = {}
): AvailableBlock {
  const targets = manifestOverrides.targets ?? [{ slotId: 'model.sidebar_top' }];
  // Page apps declare a page; default hasPage from whether any target is app.page.
  const defaultHasPage = targets.some((t) => t.slotId === 'app.page');
  return {
    id: 'app-1',
    blockId: 'my-block',
    appId: 'app-1',
    appName: 'My App',
    manifest: {
      name: 'My App',
      description: 'Does a thing.',
      hasPage: defaultHasPage,
      ...manifestOverrides,
      targets,
    },
    installCount: 3,
    category: null,
    scopesSummary: [],
    avgRating: null,
    reviewCount: 0,
    ...overrides,
  };
}

/** A page app: single `app.page` target. */
function pageBlock(manifestOverrides: ManifestShape = {}): AvailableBlock {
  return makeBlock({ targets: [{ slotId: 'app.page' }], ...manifestOverrides });
}

const onOpen = vi.fn();
const onRecentOpen = vi.fn();

beforeEach(() => {
  onOpen.mockClear();
  onRecentOpen.mockClear();
  detailsModalSpy.mockClear();
});

/** The card's action group lives in the bottom Group; assert ≥1 actionable
 *  control (link OR button) is present — the never-empty-card invariant. */
function expectAtLeastOneAffordance() {
  const links = page.getByRole('link').elements();
  const buttons = page.getByRole('button').elements();
  // The title + description are also links (to the detail page); the action
  // group adds "View details" (universal) / Open app / Install on top. The
  // invariant we care about is a CTA in the action row — every branch below
  // asserts the SPECIFIC expected CTA, so this is the coarse backstop that
  // SOMETHING actionable rendered.
  expect(links.length + buttons.length).toBeGreaterThan(0);
}

describe('AppBlockCard action CTA gate', () => {
  test('page app + canOpenPage=false (pages flag off) → "View details" present, NOT actionless [HIGH regression, #2747 retargeted]', async () => {
    renderWithProviders(
      <AppBlockCard block={pageBlock()} alreadySubscribed={false} onOpen={onOpen} canOpenPage={false} />
    );

    // The live "Open app" run is unavailable (flag off); the never-empty-card
    // invariant is now carried by the universal "View details" button (was the
    // #2747 page-link "View" fallback).
    await expect.element(page.getByRole('button', { name: /view details/i })).toBeInTheDocument();
    // The old page-link "View" fallback is GONE (replaced by the modal button).
    expect(page.getByRole('link', { name: /^view$/i }).query()).toBeNull();
    // "Open app" did NOT render (no flag), and Install is forbidden for a page app.
    expect(page.getByRole('link', { name: /open app/i }).query()).toBeNull();
    expect(page.getByRole('button', { name: /^install$/i }).query()).toBeNull();
    expect(page.getByRole('button', { name: /^manage$/i }).query()).toBeNull();
    // INVARIANT: the card is not actionless.
    expectAtLeastOneAffordance();
  });

  test('page app + manifest.hasPage=false → still ≥1 affordance ("View details")', async () => {
    renderWithProviders(
      // hasPage false but canOpenPage true → "Open app" still can't render (no page).
      <AppBlockCard
        block={pageBlock({ hasPage: false })}
        alreadySubscribed={false}
        onOpen={onOpen}
        canOpenPage
      />
    );

    await expect.element(page.getByRole('button', { name: /view details/i })).toBeInTheDocument();
    expect(page.getByRole('link', { name: /open app/i }).query()).toBeNull();
    expect(page.getByRole('button', { name: /^install$/i }).query()).toBeNull();
    expectAtLeastOneAffordance();
  });

  test('page app + canOpenPage=true → "Open app" shows ALONGSIDE the universal "View details"', async () => {
    renderWithProviders(
      <AppBlockCard block={pageBlock()} alreadySubscribed={false} onOpen={onOpen} canOpenPage />
    );

    await expect.element(page.getByRole('link', { name: /open app/i })).toBeInTheDocument();
    // "View details" is universal — present even when "Open app" renders.
    await expect.element(page.getByRole('button', { name: /view details/i })).toBeInTheDocument();
    // No legacy page-link "View".
    expect(page.getByRole('link', { name: /^view$/i }).query()).toBeNull();
    // Still no Install/Manage for a page app.
    expect(page.getByRole('button', { name: /^install$/i }).query()).toBeNull();
    expect(page.getByRole('button', { name: /^manage$/i }).query()).toBeNull();
    expectAtLeastOneAffordance();
  });

  test('page app + canOpenPage=true even when alreadySubscribed (no "Manage" leak)', async () => {
    renderWithProviders(
      <AppBlockCard block={pageBlock()} alreadySubscribed onOpen={onOpen} canOpenPage />
    );

    await expect.element(page.getByRole('link', { name: /open app/i })).toBeInTheDocument();
    expect(page.getByRole('button', { name: /^manage$/i }).query()).toBeNull();
    expect(page.getByRole('link', { name: /^view$/i }).query()).toBeNull();
  });

  test('model-slot app renders "Install" + the universal "View details" and fires onOpen', async () => {
    renderWithProviders(
      <AppBlockCard
        block={makeBlock({ targets: [{ slotId: 'model.sidebar_top' }] })}
        alreadySubscribed={false}
        onOpen={onOpen}
      />
    );

    const install = page.getByRole('button', { name: /^install$/i });
    await expect.element(install).toBeInTheDocument();
    // "View details" is universal — present even for a model-slot app.
    await expect.element(page.getByRole('button', { name: /view details/i })).toBeInTheDocument();
    // No page → no "Open app", and no legacy page-link "View".
    expect(page.getByRole('link', { name: /open app/i }).query()).toBeNull();
    expect(page.getByRole('link', { name: /^view$/i }).query()).toBeNull();

    await install.click();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  test('model-slot app already subscribed renders "Manage"', async () => {
    renderWithProviders(
      <AppBlockCard
        block={makeBlock({ targets: [{ slotId: 'model.below_images' }] })}
        alreadySubscribed
        onOpen={onOpen}
      />
    );

    await expect.element(page.getByRole('button', { name: /^manage$/i })).toBeInTheDocument();
    expect(page.getByRole('button', { name: /^install$/i }).query()).toBeNull();
  });

  test('multi-target [model, page] → classified as model-slot (Install shows)', async () => {
    renderWithProviders(
      <AppBlockCard
        block={makeBlock({ targets: [{ slotId: 'model.sidebar_top' }, { slotId: 'app.page' }] })}
        alreadySubscribed={false}
        onOpen={onOpen}
        canOpenPage
      />
    );

    // Any non-page target → Install (the `.some()` fix, not trusting index [0]).
    await expect.element(page.getByRole('button', { name: /^install$/i })).toBeInTheDocument();
    expect(page.getByRole('link', { name: /^view$/i }).query()).toBeNull();
  });

  test('multi-target [page, model] → classified as model-slot (Install shows) — order-independent', async () => {
    renderWithProviders(
      <AppBlockCard
        block={makeBlock({ targets: [{ slotId: 'app.page' }, { slotId: 'model.sidebar_top' }] })}
        alreadySubscribed={false}
        onOpen={onOpen}
        canOpenPage
      />
    );

    // page at index [0] must NOT mask the model target → Install still shows.
    await expect.element(page.getByRole('button', { name: /^install$/i })).toBeInTheDocument();
    expect(page.getByRole('link', { name: /^view$/i }).query()).toBeNull();
  });

  test('empty-string slotId at index [0] → treated as a page app (no Install), "View details" fallback', async () => {
    // Parity with the detail page: a falsy slotId is skipped (filter(Boolean)),
    // so [''] yields NO model install slot → page-app branch. The card and the
    // detail page agree on this input (both via the shared hasInstallSlot).
    renderWithProviders(
      <AppBlockCard
        block={makeBlock({ targets: [{ slotId: '' }], hasPage: false })}
        alreadySubscribed={false}
        onOpen={onOpen}
        canOpenPage
      />
    );

    expect(page.getByRole('button', { name: /^install$/i }).query()).toBeNull();
    // No usable page either → the never-empty-card invariant gives us "View details".
    await expect.element(page.getByRole('button', { name: /view details/i })).toBeInTheDocument();
    expect(page.getByRole('link', { name: /^view$/i }).query()).toBeNull();
    expectAtLeastOneAffordance();
  });
});

describe('AppBlockCard — onRecentOpen on route/title open paths (M1)', () => {
  // A page app never fires the install `onOpen` (no install slot), so its open
  // path is the "Open app" route link + the detail-page title/description links.
  // These must call `onRecentOpen` so the page app populates "Recently opened".
  //
  // These paths are real Next `<Link>` anchors (`<a href>`). In the browser-mode
  // test a click would actually navigate the test iframe and crash the runner —
  // so we install a capture-phase guard that `preventDefault()`s the navigation.
  // The card's `onClick` (which calls onRecentOpen) fires in the BUBBLE phase
  // BEFORE the browser's default navigation, so this faithfully exercises the
  // fire-and-navigate wiring without leaving the page.
  const stopNav = (e: Event) => {
    if ((e.target as HTMLElement)?.closest('a')) e.preventDefault();
  };
  beforeEach(() => document.addEventListener('click', stopNav, true));
  afterEach(() => document.removeEventListener('click', stopNav, true));

  test('clicking "Open app" (route link) on a PAGE app calls onRecentOpen', async () => {
    renderWithProviders(
      <AppBlockCard
        block={pageBlock()}
        alreadySubscribed={false}
        onOpen={onOpen}
        onRecentOpen={onRecentOpen}
        canOpenPage
      />
    );

    const openApp = page.getByRole('link', { name: /open app/i });
    await expect.element(openApp).toBeInTheDocument();
    await openApp.click();

    // The route open recorded the app to recents (fire-and-navigate).
    expect(onRecentOpen).toHaveBeenCalledTimes(1);
    expect(onRecentOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'app-1' }));
    // It did NOT route the install/settings open (that's a separate CTA absent
    // for page apps).
    expect(onOpen).not.toHaveBeenCalled();
  });

  test('clicking the title link records the open via onRecentOpen', async () => {
    renderWithProviders(
      <AppBlockCard
        block={pageBlock({ name: 'Titled App' })}
        alreadySubscribed={false}
        onOpen={onOpen}
        onRecentOpen={onRecentOpen}
        canOpenPage={false}
      />
    );

    // The title is a link to the detail page; clicking it is an "open".
    const titleLink = page.getByRole('link', { name: /Titled App/i });
    await expect.element(titleLink).toBeInTheDocument();
    await titleLink.click();

    expect(onRecentOpen).toHaveBeenCalledTimes(1);
    expect(onRecentOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'app-1' }));
  });

  test('onRecentOpen is optional — omitting it does not crash the open paths', async () => {
    // Existing callers (and other tests) that don't track recents must keep
    // working; the `?.()` call is a no-op when the prop is absent.
    renderWithProviders(
      <AppBlockCard block={pageBlock()} alreadySubscribed={false} onOpen={onOpen} canOpenPage />
    );
    const openApp = page.getByRole('link', { name: /open app/i });
    await expect.element(openApp).toBeInTheDocument();
    // No throw on click without an onRecentOpen handler.
    await openApp.click();
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe('AppBlockCard — View details modal opens', () => {
  test('"View details" button is present on a model app and opens the modal', async () => {
    renderWithProviders(
      <AppBlockCard
        block={makeBlock({ targets: [{ slotId: 'model.sidebar_top' }] })}
        alreadySubscribed={false}
        onOpen={onOpen}
      />
    );

    // Closed initially — the modal probe is not in the DOM.
    expect(page.getByTestId('details-modal').query()).toBeNull();

    const viewDetails = page.getByRole('button', { name: /view details/i });
    await expect.element(viewDetails).toBeInTheDocument();
    await viewDetails.click();

    // Clicking opens the modal (opened=true → probe renders).
    await expect.element(page.getByTestId('details-modal')).toBeInTheDocument();
    // The modal received this app's id.
    expect(detailsModalSpy).toHaveBeenCalledWith(
      expect.objectContaining({ opened: true, blockId: 'app-1' })
    );
  });

  test('"View details" button is present on a PAGE app and opens the modal', async () => {
    renderWithProviders(
      <AppBlockCard block={pageBlock()} alreadySubscribed={false} onOpen={onOpen} canOpenPage={false} />
    );

    const viewDetails = page.getByRole('button', { name: /view details/i });
    await expect.element(viewDetails).toBeInTheDocument();
    await viewDetails.click();
    await expect.element(page.getByTestId('details-modal')).toBeInTheDocument();
  });

  // ── L3 (audit): the modal SUBTREE is not even mounted while closed ──────────
  // Previously <AppDetailsModal> was mounted in every card unconditionally
  // (N idle modal instances + their hook subtrees across the grid). It's now
  // gated `{detailsOpen && <AppDetailsModal .../>}`, so the component does not
  // mount — and crucially does not run its tRPC-query hooks — until opened.
  test('modal subtree is NOT mounted while closed (component never invoked), mounts on open', async () => {
    renderWithProviders(
      <AppBlockCard
        block={makeBlock({ targets: [{ slotId: 'model.sidebar_top' }] })}
        alreadySubscribed={false}
        onOpen={onOpen}
      />
    );

    // The "View details" BUTTON is unconditional (never-empty-card invariant)…
    const viewDetails = page.getByRole('button', { name: /view details/i });
    await expect.element(viewDetails).toBeInTheDocument();
    // …but the modal SUBTREE is gated: the component was never even rendered
    // while closed (not "rendered but returned null"). This is the L3 probe —
    // the spy fires inside AppDetailsModal's render, so zero calls ⇒ not mounted.
    expect(detailsModalSpy).not.toHaveBeenCalled();
    expect(page.getByTestId('details-modal').query()).toBeNull();

    // Opening mounts the subtree.
    await viewDetails.click();
    await expect.element(page.getByTestId('details-modal')).toBeInTheDocument();
    expect(detailsModalSpy).toHaveBeenCalledWith(
      expect.objectContaining({ opened: true, blockId: 'app-1' })
    );
  });
});

describe('AppBlockCard — 2026-06 card cleanup', () => {
  test('install count is NOT rendered (hidden until a real user base)', async () => {
    renderWithProviders(
      <AppBlockCard
        block={makeBlock({}, { installCount: 1234 })}
        alreadySubscribed={false}
        onOpen={onOpen}
      />
    );

    await expect.element(page.getByRole('button', { name: /view details/i })).toBeInTheDocument();
    // The old install-count copy ("N installs", lowercase) is gone, and the
    // formatted count itself ("1,234") renders nowhere. (Note: the "Install"
    // BUTTON is a separate, intentional CTA — we match the lowercase count copy,
    // not the capitalized button label.)
    expect(page.getByText(/\d[\d,]*\s+installs?/i).query()).toBeNull();
    expect(page.getByText('1,234', { exact: false }).query()).toBeNull();
  });

  test('review indicator HIDDEN when reviewCount=0 (no "No reviews" affordance)', async () => {
    renderWithProviders(
      <AppBlockCard
        block={makeBlock({}, { reviewCount: 0, avgRating: null })}
        alreadySubscribed={false}
        onOpen={onOpen}
      />
    );

    await expect.element(page.getByRole('button', { name: /view details/i })).toBeInTheDocument();
    // No "No reviews" text, and no rating affordance for a 0-review app.
    expect(page.getByText(/no reviews/i).query()).toBeNull();
  });

  test('review indicator SHOWN when reviewCount>0 (avg + count)', async () => {
    renderWithProviders(
      <AppBlockCard
        block={makeBlock({}, { reviewCount: 12, avgRating: 4.5 })}
        alreadySubscribed={false}
        onOpen={onOpen}
      />
    );

    // avg "4.5" and count "(12)" render.
    await expect.element(page.getByText('4.5', { exact: false })).toBeInTheDocument();
    await expect.element(page.getByText('(12)', { exact: false })).toBeInTheDocument();
  });

  test('category (+ icon) rendered when a category is set', async () => {
    renderWithProviders(
      <AppBlockCard
        block={makeBlock({}, { category: 'generation' })}
        alreadySubscribed={false}
        onOpen={onOpen}
      />
    );

    // The category label chip shows.
    await expect.element(page.getByText('Generation', { exact: true })).toBeInTheDocument();
    // The category badge carries an icon (the leftSection svg). The "grape"
    // category badge is the one with the label text; assert an svg sits in it.
    const labelEl = page.getByText('Generation', { exact: true }).element();
    const badge = labelEl.closest('.mantine-Badge-root');
    expect(badge).not.toBeNull();
    expect(badge!.querySelector('svg')).not.toBeNull();
  });

  test('no category → no category chip rendered', async () => {
    renderWithProviders(
      <AppBlockCard
        block={makeBlock({}, { category: null })}
        alreadySubscribed={false}
        onOpen={onOpen}
      />
    );

    await expect.element(page.getByRole('button', { name: /view details/i })).toBeInTheDocument();
    // None of the category labels render.
    expect(page.getByText('Generation', { exact: true }).query()).toBeNull();
    expect(page.getByText('Utility', { exact: true }).query()).toBeNull();
  });

  test('scopes are NOT rendered on the card face (moved into the modal)', async () => {
    renderWithProviders(
      <AppBlockCard
        block={makeBlock(
          {},
          { scopesSummary: ['user:read:self', 'ai:write:budgeted'] }
        )}
        alreadySubscribed={false}
        onOpen={onOpen}
      />
    );

    await expect.element(page.getByRole('button', { name: /view details/i })).toBeInTheDocument();
    // The scope ids must NOT appear on the card face.
    expect(page.getByText('user:read:self', { exact: false }).query()).toBeNull();
    expect(page.getByText('ai:write:budgeted', { exact: false }).query()).toBeNull();
  });
});

describe('AppBlockCard — round-2 card cleanup (slot badge + author dropped, View details link-styled)', () => {
  // ── Slot/location badge REMOVED from the card face ──────────────────────────
  // The launch is page-only, so the slot/location badge is noise. It was dropped
  // from the card (still available on the detail page / modal). Assert NONE of
  // the slot labels render — for each install-slot value AND the page-app value.
  test('slot badge is NOT rendered (model.sidebar_top → no "Model sidebar")', async () => {
    renderWithProviders(
      <AppBlockCard
        block={makeBlock({ targets: [{ slotId: 'model.sidebar_top' }] })}
        alreadySubscribed={false}
        onOpen={onOpen}
      />
    );

    await expect.element(page.getByRole('button', { name: /view details/i })).toBeInTheDocument();
    // The old slot-badge copy ("Model sidebar") must not appear anywhere.
    expect(page.getByText('Model sidebar', { exact: false }).query()).toBeNull();
  });

  test('slot badge is NOT rendered (model.below_images → no "Below images")', async () => {
    renderWithProviders(
      <AppBlockCard
        block={makeBlock({ targets: [{ slotId: 'model.below_images' }] })}
        alreadySubscribed={false}
        onOpen={onOpen}
      />
    );

    await expect.element(page.getByRole('button', { name: /view details/i })).toBeInTheDocument();
    expect(page.getByText('Below images', { exact: false }).query()).toBeNull();
  });

  test('slot badge is NOT rendered on a PAGE app (no slot label leaks)', async () => {
    renderWithProviders(
      <AppBlockCard block={pageBlock()} alreadySubscribed={false} onOpen={onOpen} canOpenPage={false} />
    );

    await expect.element(page.getByRole('button', { name: /view details/i })).toBeInTheDocument();
    // None of the known slot labels render for a page app either.
    expect(page.getByText('Model sidebar', { exact: false }).query()).toBeNull();
    expect(page.getByText('Below images', { exact: false }).query()).toBeNull();
    expect(page.getByText('Model actions', { exact: false }).query()).toBeNull();
  });

  // ── "by {author}" attribution line REMOVED from the card face ───────────────
  // The publisher attribution ("by My App") was dropped from the card face
  // (still shown on the detail page). Use a DISTINCTIVE author name so the
  // assertion can't collide with the title (which is `manifest.name`).
  test('"by {author}" attribution line is NOT rendered', async () => {
    renderWithProviders(
      <AppBlockCard
        block={makeBlock(
          { name: 'Cool Block' },
          { appName: 'Acme Publisher Co' }
        )}
        alreadySubscribed={false}
        onOpen={onOpen}
      />
    );

    // The card title (manifest.name) still renders…
    await expect.element(page.getByText('Cool Block', { exact: false })).toBeInTheDocument();
    // …but the "by {appName}" attribution does NOT. Match the literal "by …"
    // copy AND the bare author name — neither should be on the card face.
    expect(page.getByText(/by\s+Acme Publisher Co/i).query()).toBeNull();
    expect(page.getByText('Acme Publisher Co', { exact: false }).query()).toBeNull();
  });

  test('"by {author}" falls back to appId when appName is missing — STILL not rendered', async () => {
    renderWithProviders(
      <AppBlockCard
        block={makeBlock({}, { appName: undefined as unknown as string, appId: 'acme-app-id' })}
        alreadySubscribed={false}
        onOpen={onOpen}
      />
    );

    await expect.element(page.getByRole('button', { name: /view details/i })).toBeInTheDocument();
    // Neither the "by acme-app-id" line nor the bare id leaks onto the face.
    expect(page.getByText(/by\s+acme-app-id/i).query()).toBeNull();
    expect(page.getByText('acme-app-id', { exact: false }).query()).toBeNull();
  });

  // ── "View details" is a LINK-STYLE (subtle) button ──────────────────────────
  // Round-2: View details is de-emphasised vs the filled Install/Open-app run
  // affordances — it's a Mantine `variant="subtle"` button (the Apps-dir
  // link-button convention). Still a real button, still opens the modal, still
  // ALWAYS rendered (the never-empty-card invariant). Mantine encodes the
  // variant as the `data-variant` attribute on the button element.
  test('"View details" is rendered as the link-style (subtle) variant', async () => {
    renderWithProviders(
      <AppBlockCard
        block={makeBlock({ targets: [{ slotId: 'model.sidebar_top' }] })}
        alreadySubscribed={false}
        onOpen={onOpen}
      />
    );

    const viewDetails = page.getByRole('button', { name: /view details/i });
    await expect.element(viewDetails).toBeInTheDocument();
    // Mantine renders `variant` to the `data-variant` attribute.
    expect(viewDetails.element().getAttribute('data-variant')).toBe('subtle');
  });

  test('link-styled "View details" still opens the modal on click (functionality preserved)', async () => {
    renderWithProviders(
      <AppBlockCard
        block={makeBlock({ targets: [{ slotId: 'model.sidebar_top' }] })}
        alreadySubscribed={false}
        onOpen={onOpen}
      />
    );

    const viewDetails = page.getByRole('button', { name: /view details/i });
    await expect.element(viewDetails).toBeInTheDocument();
    // Closed initially.
    expect(page.getByTestId('details-modal').query()).toBeNull();
    expect(viewDetails.element().getAttribute('data-variant')).toBe('subtle');
    await viewDetails.click();

    // The subtle button still drives the modal open.
    await expect.element(page.getByTestId('details-modal')).toBeInTheDocument();
    expect(detailsModalSpy).toHaveBeenCalledWith(
      expect.objectContaining({ opened: true, blockId: 'app-1' })
    );
  });

  test('"View details" is rendered on a PAGE app too (invariant preserved) and is link-styled', async () => {
    renderWithProviders(
      <AppBlockCard block={pageBlock()} alreadySubscribed={false} onOpen={onOpen} canOpenPage={false} />
    );

    const viewDetails = page.getByRole('button', { name: /view details/i });
    await expect.element(viewDetails).toBeInTheDocument();
    expect(viewDetails.element().getAttribute('data-variant')).toBe('subtle');
  });
});
