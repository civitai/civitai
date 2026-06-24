import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type { AvailableBlock } from '~/server/schema/blocks/subscription.schema';

/**
 * App Blocks marketplace CARD — component tests for the action-CTA gate.
 *
 * Load-bearing behaviour:
 *  - The "Install"/"Manage" CTA is shown ONLY for apps that install into a
 *    model/in-context slot. A PAGE app (target slot `app.page`, installModel
 *    `'none'`) is stateless — no install row, slot install path server-gated
 *    dark (#2622) — so it never shows Install/Manage.
 *  - INVARIANT (audit HIGH): every card renders ≥1 affordance. A page app whose
 *    live "Open app" run isn't available (no page, or the viewer's
 *    `appBlocksPages` flag is off → `canOpenPage` false) falls back to a "View"
 *    link to the always-reachable detail page — it MUST NOT be an actionless
 *    card.
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

beforeEach(() => {
  onOpen.mockClear();
});

/** The card's action group lives in the bottom Group; assert ≥1 actionable
 *  control (link OR button) is present — the never-empty-card invariant. */
function expectAtLeastOneAffordance() {
  const links = page.getByRole('link').elements();
  const buttons = page.getByRole('button').elements();
  // The title + description are also links (to the detail page); the action
  // group adds Open app / View / Install on top. The invariant we care about is
  // a CTA in the action row — every branch below asserts the SPECIFIC expected
  // CTA, so this is the coarse backstop that SOMETHING actionable rendered.
  expect(links.length + buttons.length).toBeGreaterThan(0);
}

describe('AppBlockCard action CTA gate', () => {
  test('page app + canOpenPage=false (pages flag off) → "View" fallback, NOT zero buttons [HIGH regression]', async () => {
    renderWithProviders(
      <AppBlockCard block={pageBlock()} alreadySubscribed={false} onOpen={onOpen} canOpenPage={false} />
    );

    // The live "Open app" run is unavailable (flag off) → fall back to "View".
    await expect.element(page.getByRole('link', { name: /^view$/i })).toBeInTheDocument();
    // "Open app" did NOT render (no flag), and Install is forbidden for a page app.
    expect(page.getByRole('link', { name: /open app/i }).query()).toBeNull();
    expect(page.getByRole('button', { name: /^install$/i }).query()).toBeNull();
    expect(page.getByRole('button', { name: /^manage$/i }).query()).toBeNull();
    // INVARIANT: the card is not actionless.
    expectAtLeastOneAffordance();
  });

  test('page app + manifest.hasPage=false → still ≥1 affordance ("View")', async () => {
    renderWithProviders(
      // hasPage false but canOpenPage true → "Open app" still can't render (no page).
      <AppBlockCard
        block={pageBlock({ hasPage: false })}
        alreadySubscribed={false}
        onOpen={onOpen}
        canOpenPage
      />
    );

    await expect.element(page.getByRole('link', { name: /^view$/i })).toBeInTheDocument();
    expect(page.getByRole('link', { name: /open app/i }).query()).toBeNull();
    expect(page.getByRole('button', { name: /^install$/i }).query()).toBeNull();
    expectAtLeastOneAffordance();
  });

  test('page app + canOpenPage=true → "Open app" shows, "View" NOT duplicated', async () => {
    renderWithProviders(
      <AppBlockCard block={pageBlock()} alreadySubscribed={false} onOpen={onOpen} canOpenPage />
    );

    await expect.element(page.getByRole('link', { name: /open app/i })).toBeInTheDocument();
    // The live run IS available → no redundant "View" fallback.
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

  test('model-slot app renders "Install" and fires onOpen (no regression)', async () => {
    renderWithProviders(
      <AppBlockCard
        block={makeBlock({ targets: [{ slotId: 'model.sidebar_top' }] })}
        alreadySubscribed={false}
        onOpen={onOpen}
      />
    );

    const install = page.getByRole('button', { name: /^install$/i });
    await expect.element(install).toBeInTheDocument();
    // No page → no "Open app", and no "View" fallback (Install IS the action).
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

  test('empty-string slotId at index [0] → treated as a page app (no Install), "View" fallback', async () => {
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
    // No usable page either → the never-empty-card invariant gives us "View".
    await expect.element(page.getByRole('link', { name: /^view$/i })).toBeInTheDocument();
    expectAtLeastOneAffordance();
  });
});
