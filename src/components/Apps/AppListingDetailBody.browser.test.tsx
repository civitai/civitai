import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type * as RecentsMod from '~/components/Apps/recentlyOpenedAppsStore';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';
import type { ListingCard, ListingDetail } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * `AppListingDetailBody` component tests (REPORT-ONLY — the browser project is
 * non-blocking; the blocking gates are `__tests__/appListingDetailView.test.ts`,
 * `__tests__/appListingDetailRows.test.ts` and `__tests__/appsPageWidths.test.ts`).
 *
 * 🔴 WHAT THIS SUITE STRUCTURALLY CANNOT SEE — read before treating any result here
 * as a claim about the page:
 *
 *   1. **NO CSS IS LOADED.** `vitest.config.mts` registers exactly two setup files
 *      (`test/browser-process-shim.ts`, `test/component-setup.tsx`) and neither
 *      imports a stylesheet — not Mantine's, not Tailwind's, not the SCSS modules.
 *      So NOTHING in this file measures a visual property. The two-column layout, the
 *      stacking at a narrow viewport, the rail widths, the `c="inherit"` glyph colour
 *      and the `ContentClamp` height cut are all CSS-driven and are verified by the
 *      before/after CAPTURES in the PR, never here. What the layout tests below assert
 *      is STRUCTURE: that both grid columns exist, in the right document order, with
 *      the right responsive span props — the DOM half of the claim.
 *   2. **A VIEWPORT IS A DIMENSION THIS CONFIG DOES NOT PIN**, which means every test
 *      that does not set one runs at Playwright's default and is blind to viewport
 *      bugs by construction. The layout tests therefore set `page.viewport(...)`
 *      EXPLICITLY at two named points — 1440×900 (wide desktop) and 390×844 (a phone)
 *      — and `beforeEach` restores the wide one so a narrow test cannot leak into its
 *      neighbours.
 *   3. tRPC is mocked, so nothing here exercises a real query, a real gate, or the
 *      server's own eligibility rules.
 */

const WIDE: [number, number] = [1440, 900];
const NARROW: [number, number] = [390, 844];

const mocks = vi.hoisted(() => ({
  currentUser: null as null | { id: number; username: string },
  // Items the mocked `appListings.listAvailable` returns to the related rail.
  relatedItems: [] as unknown[],
  // Every `recordRecentlyOpenedApp(...)` argument seen this test, in order.
  recorded: [] as unknown[],
  // What the mocked `user.getCreator` resolves to (the SmartCreatorCard's data).
  creator: null as null | Record<string, unknown>,
  reportMutate: vi.fn(),
  upsertMutate: vi.fn(),
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

// The detail body renders the discovery rail + the creator card, which read the
// feature flags + tRPC. Mock both so the suite stays network-free.
//
// 🔴 `cosmeticShop` is deliberately ABSENT/falsy, which routes `SmartCreatorCard` to
// the `CreatorCard` branch. That is the branch this suite exercises; the `CreatorCardV2`
// branch is not covered here — named rather than left implicit.
//
// 🔴 `importOriginal` SPREAD, not a wholesale replacement (local-rules/
// no-wholesale-module-mock). Measured on this very change: once the body began
// importing `SmartCreatorCard` (→ ChatUserButton → useChatEnabled), a factory that
// listed only `useFeatureFlags` made four SIBLING suites fail to IMPORT with
// `does not provide an export named 'useFeatureFlagsReady'` — reported as
// `Tests no tests`, i.e. as nothing to see rather than as a failure.
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsMod>()),
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
      // Consumed by the REAL `ReviewListingModal` / `ReportListingModal`, which the
      // `⋮` menu opens. They are NOT mocked away — the menu → modal wiring is the
      // seam this change introduces, so it is exercised end to end.
      getMyReview: { useQuery: () => ({ data: null, isLoading: false }) },
      upsertReview: {
        useMutation: () => ({ mutate: mocks.upsertMutate, isPending: false }),
      },
      // 🔴 This one INVOKES the caller's `onSuccess`, unlike its siblings. The thing
      // under test below is what the detail page does AFTER a report lands (its menu
      // item has to go spent), and a `mutate` that never resolves can never show it.
      reportListing: {
        useMutation: (opts?: { onSuccess?: () => void }) => ({
          mutate: (input: unknown) => {
            mocks.reportMutate(input);
            opts?.onSuccess?.();
          },
          isPending: false,
        }),
      },
    },
    // The SmartCreatorCard's own fetch. 🔴 VERIFIED PUBLIC: `user.getCreator` is a
    // `publicProcedure` in `src/server/routers/user.router.ts`, which is why this page
    // — anon-reachable by design — may mount the card at all.
    user: {
      getCreator: { useQuery: () => ({ data: mocks.creator }) },
      // `UserAvatar` (inside the creator card) falls back to this when the user it is
      // handed carries no `username`/`image`. Never enabled in these fixtures, but the
      // hook is called unconditionally.
      getById: { useQuery: () => ({ data: undefined, isInitialLoading: false }) },
    },
    useUtils: () => ({
      appListings: {
        getMyReview: { invalidate: async () => undefined },
        listReviews: { invalidate: async () => undefined },
        getAppDetail: { invalidate: async () => undefined },
      },
    }),
  },
}));

// Stub the trpc-backed LIST children (reviews/comments) so the test needs no tRPC
// wiring for them. They render identifiable markers (not null) so the preview-mode
// tests below can assert they are OMITTED in preview + PRESENT in the live render.
vi.mock('~/components/Apps/AppListingReviews', () => ({
  AppListingReviews: () => <div data-testid="mock-reviews" />,
}));
vi.mock('~/components/Apps/AppListingComments', () => ({
  AppListingComments: () => <div data-testid="mock-comments" />,
}));

// The creator card's ACTION buttons each carry their own tRPC + store graph, which is
// not what this suite is about. The card itself (and its `user.getCreator` read) is
// REAL — only these three leaves are stubbed.
vi.mock('~/components/Chat/ChatUserButton', () => ({
  ChatUserButton: () => <div data-testid="mock-chat-button" />,
}));
vi.mock('~/components/FollowUserButton/FollowUserButton', () => ({
  FollowUserButton: () => <div data-testid="mock-follow-button" />,
}));
vi.mock('~/components/Buzz/TipBuzzButton', () => ({
  TipBuzzButton: () => <div data-testid="mock-tip-button" />,
}));
// `UserAvatar` requires a `ContentSettingsProvider` that the shared component-setup
// does not mount. Stubbed to the ONE thing this suite reads from it: the username it
// was handed. 🔴 That username comes from `CreatorCard`'s `user.getCreator` RESULT,
// not from the listing DTO — which is precisely why the stub still lets the creator
// test prove the fetch path is wired rather than just that a box rendered.
vi.mock('~/components/UserAvatar/UserAvatar', () => ({
  UserAvatar: ({ user }: { user?: { username?: string | null } }) => (
    <div data-testid="mock-user-avatar">{user?.username ?? ''}</div>
  ),
  UserProfileLink: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

// Import AFTER the mocks are declared (vi.mock is hoisted, imports are not).
const { AppListingDetailBody } = await import('./AppListingDetailBody');

beforeEach(async () => {
  mocks.currentUser = null;
  mocks.relatedItems = [];
  mocks.recorded = [];
  mocks.creator = null;
  mocks.reportMutate.mockClear();
  mocks.upsertMutate.mockClear();
  // 🔴 Restore the WIDE viewport before every test. The viewport is browser-global
  // state, so without this a narrow-layout test silently re-runs every later test at
  // 390px — the "config pins a dimension" trap, arriving by leakage instead of config.
  await page.viewport(...WIDE);
});

function base(over: Partial<ListingDetail>): ListingDetail {
  return {
    id: 'l1',
    serialId: 1,
    slug: 'my-app',
    kind: 'onsite',
    collaborators: [],
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
    // Fixed + distinctive. 4213 is pairwise distinct from every other number in this
    // file and from any constant an assertion names, so a chip that hardcoded a value
    // could not accidentally match it.
    installCount: 4213,
    updatedAt: '2026-03-04T05:06:07.000Z',
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

/**
 * Render, and return a locator scoped to THIS mount's container.
 *
 * 🔴 Every query that can be scoped goes through `within`, never the page-wide
 * `page.*` or `document.body`. Measured while establishing the red-at-base matrix (on
 * a base where the `afterEach` `cleanup()` was not awaited): a test that FAILS could
 * leave its mounted tree in `document.body`, so with three neighbours red the next
 * test saw three extra copies — a body-wide `getByText('My App')` hit "strict mode
 * violation: resolved to 3 elements". #3556 has since fixed that root cause; the
 * scoping stays anyway, because whether this test passes should not depend on whether
 * its neighbours did.
 *
 * (`renderWithProviders`'s own returned selectors do NOT do this — vitest-browser-react
 * binds them to `baseElement`, which defaults to `document.body`.
 * `page.elementLocator(container)` is the scoped one. PORTALLED content — the Menu
 * dropdown, the Modals, the HoverCard — lands OUTSIDE the container by construction and
 * must be queried page-wide; each such query says so.)
 */
async function renderScoped(ui: Parameters<typeof renderWithProviders>[0]) {
  const { container } = await renderWithProviders(ui);
  return { container, within: page.elementLocator(container) };
}

describe('AppListingDetailBody', () => {
  test('kind + category badges are NOT rendered as HEADER badges (round-2 truncation fix)', async () => {
    // "App" was formerly the on-site kind badge's exact-match text. It must not come
    // back as a header badge. (The CATEGORY does now appear — once — in the model-page
    // meta line; that is a deliberate part of this change and is pinned separately.)
    const { within } = await renderScoped(<AppListingDetailBody detail={base({})} />);
    await expect.element(within.getByText('My App')).toBeInTheDocument();
    expect(within.getByText('App', { exact: true }).elements()).toHaveLength(0);
  });

  test('contentRating renders in the Details rail (not as a header badge)', async () => {
    const { container, within } = await renderScoped(
      <AppListingDetailBody detail={base({ contentRating: 'PG' })} />
    );
    await expect.element(within.getByText('My App')).toBeInTheDocument();
    const row = container.querySelector('[data-listing-detail-row="rating"]');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain('PG');
  });

  // ── The `⋮` overflow menu ──────────────────────────────────────────────────
  //
  // 🔴 RED AT BASE. The base renders the secondary actions as a stacked full-width
  // button column with no menu at all, so `apps-listing-actions-menu` does not exist
  // there and every test in this block fails on it. Genuine regression coverage for
  // the header restructure.

  const MENU = 'apps-listing-actions-menu';

  /** Open the `⋮` menu of THIS mount and return the portalled dropdown element. */
  async function openMenu(within: ReturnType<typeof page.elementLocator>) {
    const trigger = within.getByTestId(MENU);
    await expect.element(trigger).toBeInTheDocument();
    await userEvent.click(trigger);
    // The dropdown is PORTALLED (`withinPortal`), so it is not inside the render
    // container — query it page-wide, and wait for it rather than reading a
    // still-empty DOM.
    return vi.waitUntil(() => document.querySelector('[role="menu"], .mantine-Menu-dropdown'), {
      timeout: 10000,
      interval: 25,
    });
  }

  test('🔴 the owner sees Edit in the menu → on-site manifest editor', async () => {
    mocks.currentUser = { id: 5, username: 'alice' }; // matches base().creator.id
    const { within } = await renderScoped(<AppListingDetailBody detail={base({})} />);
    const dropdown = (await openMenu(within)) as HTMLElement;
    const edit = dropdown.querySelector('[data-testid="apps-listing-owner-edit"]');
    expect(edit).not.toBeNull();
    expect(edit?.getAttribute('href')).toBe('/apps/blk-1/edit');
  });

  test('🔴 the owner of an off-site listing → Edit routes to the submit editor by listing id', async () => {
    mocks.currentUser = { id: 5, username: 'alice' };
    const { within } = await renderScoped(
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
    const dropdown = (await openMenu(within)) as HTMLElement;
    expect(
      dropdown.querySelector('[data-testid="apps-listing-owner-edit"]')?.getAttribute('href')
    ).toBe('/apps/submit?edit=l1');
  });

  test('🔴 a signed-in NON-owner gets Review + Report, and NO Edit', async () => {
    mocks.currentUser = { id: 999, username: 'bob' };
    const { within } = await renderScoped(<AppListingDetailBody detail={base({})} />);
    const dropdown = (await openMenu(within)) as HTMLElement;
    // POSITIVE half first: the dropdown really does hold items, so the Edit zero
    // below is about Edit and not about an empty menu.
    expect(dropdown.querySelector('[data-testid="apps-listing-review-action"]')).not.toBeNull();
    expect(dropdown.querySelector('[data-testid="apps-listing-report-action"]')).not.toBeNull();
    expect(dropdown.querySelector('[data-testid="apps-listing-owner-edit"]')).toBeNull();
  });

  test('🔴 the OWNER gets no Review item (no self-review), but keeps Report', async () => {
    mocks.currentUser = { id: 5, username: 'alice' };
    const { within } = await renderScoped(<AppListingDetailBody detail={base({})} />);
    const dropdown = (await openMenu(within)) as HTMLElement;
    // Positive control from the same dropdown: Report and Edit ARE there.
    expect(dropdown.querySelector('[data-testid="apps-listing-report-action"]')).not.toBeNull();
    expect(dropdown.querySelector('[data-testid="apps-listing-owner-edit"]')).not.toBeNull();
    expect(dropdown.querySelector('[data-testid="apps-listing-review-action"]')).toBeNull();
  });

  test('🔴 a SIGNED-OUT viewer gets no menu at all (nothing in it is available)', async () => {
    mocks.currentUser = null;
    const { container, within } = await renderScoped(<AppListingDetailBody detail={base({})} />);
    await expect.element(within.getByText('My App')).toBeInTheDocument(); // render barrier
    // Every item is signed-in-only (edit → owner, review → signed-in non-owner,
    // report → signed-in), so the trigger itself is suppressed rather than opening an
    // empty dropdown.
    expect(container.querySelectorAll(`[data-testid="${MENU}"]`)).toHaveLength(0);
  });

  test('🔴 the Review menu item opens the review modal (menu → modal wiring)', async () => {
    // The structural reason this test exists: a Mantine Menu.Dropdown UNMOUNTS on
    // close, so a modal rendered as a sibling of the Menu.Item would be destroyed by
    // the very click meant to open it. The modals are mounted outside the menu; this
    // is the assertion that says so.
    mocks.currentUser = { id: 999, username: 'bob' };
    const { within } = await renderScoped(<AppListingDetailBody detail={base({})} />);
    const dropdown = (await openMenu(within)) as HTMLElement;
    const item = dropdown.querySelector('[data-testid="apps-listing-review-action"]') as HTMLElement;
    expect(item).not.toBeNull();
    await userEvent.click(item);
    // The modal is portalled to the body. Its own copy is the REAL component.
    await expect.element(page.getByText('Would you recommend this app to others?')).toBeInTheDocument();
  });

  test('🔴 the Report menu item opens the report modal', async () => {
    mocks.currentUser = { id: 999, username: 'bob' };
    const { within } = await renderScoped(<AppListingDetailBody detail={base({})} />);
    const dropdown = (await openMenu(within)) as HTMLElement;
    const item = dropdown.querySelector('[data-testid="apps-listing-report-action"]') as HTMLElement;
    await userEvent.click(item);
    await expect.element(page.getByRole('button', { name: 'Submit report' })).toBeInTheDocument();
  });

  test('🔴 REGRESSION: after a successful report the menu item is DISABLED and reads "Reported"', async () => {
    // The shipped defect: the modal's `onReported` callback existed and was wired
    // only in a standalone `ReportListingButton` that nothing rendered, while THIS —
    // the live path — mounted the modal without it. The item stayed clickable, so a
    // second report hit the server's one-open-report-per-reporter CONFLICT and the
    // user got an ERROR where they expected a confirmation.
    //
    // 🔴 Asserted on the STATE, never on the word: `disabled` + Mantine's
    // `data-disabled` on the item itself. "Reported" as text is checked too, but it
    // is the weakest half of the claim — any feature can spell a word.
    mocks.currentUser = { id: 999, username: 'bob' };
    const { within } = await renderScoped(<AppListingDetailBody detail={base({})} />);

    const item = () =>
      document.querySelector(
        '[data-testid="apps-listing-report-action"]'
      ) as HTMLButtonElement | null;

    // POSITIVE CONTROL, from the same element: it is LIVE before the report, so the
    // disabled state below is about the report and not about how the item renders.
    await openMenu(within);
    const before = item() as HTMLButtonElement;
    expect(before).not.toBeNull();
    expect(before.disabled).toBe(false);
    expect(before.getAttribute('data-disabled')).toBeNull();
    expect(before.textContent).toContain('Report');
    expect(before.textContent).not.toContain('Reported');

    await userEvent.click(before);
    await page.getByRole('radio', { name: 'Spam' }).click();
    await page.getByRole('button', { name: 'Submit report' }).click();
    expect(mocks.reportMutate).toHaveBeenCalledTimes(1);
    expect(mocks.reportMutate.mock.calls[0][0]).toMatchObject({
      appListingId: 'l1',
      reason: 'spam',
    });

    // Re-open the menu (the dropdown UNMOUNTS on close, so this is a fresh element).
    await openMenu(within);
    await vi.waitFor(() => {
      const spent = item();
      expect(spent).not.toBeNull();
      expect((spent as HTMLButtonElement).disabled).toBe(true);
    });
    const spent = item() as HTMLButtonElement;
    expect(spent.getAttribute('data-disabled')).toBe('true');
    expect(spent.textContent).toContain('Reported');
  });

  // ── Header stat chips ──────────────────────────────────────────────────────

  test('🔴 the header carries exactly two stat chips, each with an accessible name', async () => {
    const { container, within } = await renderScoped(
      <AppListingDetailBody
        detail={base({
          recommend: { recommendedCount: 317, notRecommendedCount: 12, recommendPct: 317 / 329 },
          reviewCount: 329,
        })}
      />
    );
    await expect.element(within.getByText('My App')).toBeInTheDocument();

    // 🔴 Asserted on the STATE (a data attribute + the aria-label attribute), never on
    // a spelled word: a chip's visible text is a bare number, and any other feature on
    // this page could spell the same number.
    const chips = Array.from(container.querySelectorAll('[data-listing-stat]'));
    expect(chips).toHaveLength(2);
    expect(chips.map((c) => c.getAttribute('data-listing-stat')).sort()).toEqual([
      'installs',
      'recommend',
    ]);
    for (const chip of chips) {
      expect(chip.getAttribute('aria-label')).toBeTruthy();
    }
    expect(
      container.querySelector('[data-listing-stat="recommend"]')?.getAttribute('aria-label')
    ).toBe('317 recommendations');
    expect(
      container.querySelector('[data-listing-stat="installs"]')?.getAttribute('aria-label')
    ).toBe('4,213 installs');
  });

  // ── Meta line ──────────────────────────────────────────────────────────────

  test('🔴 the meta line shows the update date and the category badge', async () => {
    const { container, within } = await renderScoped(<AppListingDetailBody detail={base({})} />);
    const meta = within.getByTestId('apps-listing-meta');
    await expect.element(meta).toBeInTheDocument();
    // `formatDate` default format is `MMM D, YYYY`; base() pins 2026-03-04.
    expect(meta.element().textContent).toContain('Updated:');
    expect(meta.element().textContent).toContain('2026');
    expect(container.querySelector('[data-testid="apps-listing-category"]')?.textContent).toBe(
      'utility'
    );
  });

  test('🔴 the category is a plain badge, NOT a link (the store has no category route)', async () => {
    const { container, within } = await renderScoped(<AppListingDetailBody detail={base({})} />);
    await expect.element(within.getByTestId('apps-listing-category')).toBeInTheDocument();
    const badge = container.querySelector('[data-testid="apps-listing-category"]') as HTMLElement;
    expect(badge.tagName).not.toBe('A');
    expect(badge.closest('a')).toBeNull();
  });

  test('a listing with no category renders the meta line without a badge', async () => {
    const { container, within } = await renderScoped(
      <AppListingDetailBody detail={base({ category: null })} />
    );
    await expect.element(within.getByTestId('apps-listing-meta')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-testid="apps-listing-category"]')).toHaveLength(0);
  });

  // ── Two-column structure ───────────────────────────────────────────────────
  //
  // 🔴 STRUCTURAL ONLY. No CSS is loaded (see the file header), so these cannot and do
  // not assert that anything is side-by-side or stacked. They assert that both columns
  // exist, that they are SIBLINGS in the documented order, and that the rail's contents
  // survive at a narrow viewport. The visual claim lives in the PR's captures.

  test('🔴 both grid columns exist as siblings, RAIL first in the DOM — at 1440×900', async () => {
    await page.viewport(...WIDE);
    const { container, within } = await renderScoped(<AppListingDetailBody detail={base({})} />);
    await expect.element(within.getByText('My App')).toBeInTheDocument();

    const cols = Array.from(
      container.querySelectorAll('[data-testid="apps-listing-main-col"], [data-testid="apps-listing-rail-col"]')
    );
    expect(cols).toHaveLength(2);
    // 🔴 RAIL FIRST, MAIN SECOND — the same source order `ModelVersionDetails` uses,
    // with `order={{sm:2}}` on the rail moving it right on a wide container and the
    // order props falling away below `sm` so the rail stacks ABOVE the content on a
    // phone. This assertion is what stops a "tidy-up" swapping the JSX and silently
    // changing the mobile stack. (Measured, not assumed: it was written the other way
    // round first and this test caught it.)
    expect(cols[0].getAttribute('data-testid')).toBe('apps-listing-rail-col');
    expect(cols[1].getAttribute('data-testid')).toBe('apps-listing-main-col');
    // Neither column contains the other — a nested pair would satisfy every count
    // above while being a completely different layout.
    expect(cols[0].contains(cols[1])).toBe(false);
    expect(cols[1].contains(cols[0])).toBe(false);
    // …and they really are siblings of one grid, not two unrelated blocks.
    expect(cols[0].parentElement).toBe(cols[1].parentElement);
  });

  test('🔴 the same two columns are present at 390×844 (no viewport-conditional render)', async () => {
    // The point of setting a SECOND viewport: the stacking is pure CSS, so if this
    // ever became a JS breakpoint branch the structure would differ here. Measured at
    // two named points rather than one.
    await page.viewport(...NARROW);
    const { container, within } = await renderScoped(<AppListingDetailBody detail={base({})} />);
    await expect.element(within.getByText('My App')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-testid="apps-listing-main-col"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="apps-listing-rail-col"]')).toHaveLength(1);
    // …and the rail's contents came with it, rather than being dropped on mobile.
    expect(container.querySelectorAll('[data-testid="apps-listing-action-card"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="apps-listing-details-accordion"]')).toHaveLength(1);
  });

  test('🔴 the rail holds the action card, the creator card and the details accordion; the main column holds About', async () => {
    const { container, within } = await renderScoped(
      <AppListingDetailBody detail={base({ description: 'Body **text**.' })} />
    );
    await expect.element(within.getByText('About', { exact: true })).toBeInTheDocument();
    const rail = container.querySelector('[data-testid="apps-listing-rail-col"]') as HTMLElement;
    const main = container.querySelector('[data-testid="apps-listing-main-col"]') as HTMLElement;

    expect(rail.querySelector('[data-testid="apps-listing-action-card"]')).not.toBeNull();
    expect(rail.querySelector('[data-testid="apps-listing-creator-card"]')).not.toBeNull();
    expect(rail.querySelector('[data-testid="apps-listing-details-accordion"]')).not.toBeNull();
    // The prose is in the MAIN column, not the rail — the whole reason there are two.
    expect(main.textContent).toContain('Body');
    expect(rail.textContent).not.toContain('Body');
  });

  // ── Creator card ───────────────────────────────────────────────────────────

  test('🔴 the SmartCreatorCard renders in the rail, keyed only on the creator id', async () => {
    mocks.creator = {
      id: 5,
      username: 'alice',
      image: null,
      createdAt: new Date('2024-01-02T00:00:00Z'),
      _count: { models: 3 },
      rank: null,
      links: [],
      cosmetics: [],
      stats: { downloadCountAllTime: 1, thumbsUpCountAllTime: 2, followerCountAllTime: 3 },
    };
    const { container, within } = await renderScoped(<AppListingDetailBody detail={base({})} />);
    const card = within.getByTestId('apps-listing-creator-card');
    await expect.element(card).toBeInTheDocument();
    // The card resolved the creator through `user.getCreator` — the username it prints
    // comes from the MOCKED QUERY, not from the listing DTO (which carries it too), so
    // this is evidence the fetch path is wired.
    await expect.element(within.getByText('alice')).toBeInTheDocument();
    // The old lightweight "by <username>" chip is GONE from the live page — the card
    // replaces it rather than sitting beside it.
    expect(container.textContent).not.toContain('by alice');
  });

  test('a listing whose creator row vanished renders no creator card (and does not crash)', async () => {
    const { container, within } = await renderScoped(
      <AppListingDetailBody detail={base({ creator: null })} />
    );
    await expect.element(within.getByText('My App')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-testid="apps-listing-creator-card"]')).toHaveLength(0);
  });

  // ── Details accordion ──────────────────────────────────────────────────────

  test('🔴 the details accordion renders the row set, in order', async () => {
    const { container, within } = await renderScoped(
      <AppListingDetailBody detail={base({ contentRating: 'PG' })} />
    );
    await expect.element(within.getByTestId('apps-listing-details-accordion')).toBeInTheDocument();
    const rows = Array.from(container.querySelectorAll('[data-listing-detail-row]')).map((r) =>
      r.getAttribute('data-listing-detail-row')
    );
    expect(rows).toEqual(['kind', 'category', 'rating', 'reviews', 'installs', 'updated']);
  });

  test('🔴 a null field omits its row (positive control paired)', async () => {
    // Control: with a contentRating the `rating` row exists (asserted above). Here it
    // is null, so it must be absent while its neighbours stay.
    const { container, within } = await renderScoped(
      <AppListingDetailBody detail={base({ contentRating: null, category: null })} />
    );
    await expect.element(within.getByTestId('apps-listing-details-accordion')).toBeInTheDocument();
    const rows = Array.from(container.querySelectorAll('[data-listing-detail-row]')).map((r) =>
      r.getAttribute('data-listing-detail-row')
    );
    expect(rows).toEqual(['kind', 'reviews', 'installs', 'updated']);
  });

  test('🔴 the reviews row shows the SHARED ladder word label, not a percentage', async () => {
    const { container, within } = await renderScoped(
      <AppListingDetailBody
        detail={base({
          recommend: { recommendedCount: 431, notRecommendedCount: 68, recommendPct: 431 / 499 },
          reviewCount: 499,
        })}
      />
    );
    await expect.element(within.getByTestId('apps-listing-details-accordion')).toBeInTheDocument();
    const row = container.querySelector('[data-listing-detail-row="reviews"]') as HTMLElement;
    expect(row.textContent).toContain('Very Positive (499)');
    // The percentage form belongs to the store CARD (`getRecommendLabel`), which this
    // change leaves alone; the detail row must not have picked it up.
    expect(row.textContent).not.toContain('%');
  });

  test('a11y: the details accordion control is a BUTTON with an accessible name', async () => {
    const { container, within } = await renderScoped(<AppListingDetailBody detail={base({})} />);
    const acc = within.getByTestId('apps-listing-details-accordion');
    await expect.element(acc).toBeInTheDocument();
    const control = container.querySelector(
      '[data-testid="apps-listing-details-accordion"] button'
    ) as HTMLElement;
    expect(control).not.toBeNull();
    // 🔴 STATE, not a spelled word: the tag, the expanded state attribute, and the
    // aria-controls wiring. The visible label is asserted separately and loosely.
    expect(control.tagName).toBe('BUTTON');
    expect(control.getAttribute('aria-expanded')).toBe('true'); // defaultValue opens it
    expect(control.getAttribute('aria-controls')).toBeTruthy();
    expect(control.textContent?.trim()).toBe('Details');
  });

  // ── ContentClamp on the description ────────────────────────────────────────

  test('🔴 a long description is wrapped in a clamp with a Show More control', async () => {
    // 🔴 NOT a visual claim. No CSS is loaded, so the clamp does not visually cut
    // anything here; what is asserted is that the control EXISTS and TOGGLES, which is
    // the JS half. The height cut itself is a capture-verified claim.
    const long = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} of the description.`).join(
      '\n\n'
    );
    const { within } = await renderScoped(
      <AppListingDetailBody detail={base({ description: long })} />
    );
    await expect.element(within.getByText('About', { exact: true })).toBeInTheDocument();
    const showMore = within.getByText('Show More');
    await expect.element(showMore).toBeInTheDocument();
    await userEvent.click(showMore);
    await expect.element(within.getByText('Hide')).toBeInTheDocument();
  });

  test('the description still goes through CustomMarkdown, never innerHTML', async () => {
    const { container, within } = await renderScoped(
      <AppListingDetailBody detail={base({ description: 'a **bold** word' })} />
    );
    await expect.element(within.getByText('About', { exact: true })).toBeInTheDocument();
    // react-markdown produced a real <strong>; a raw-HTML path would not have.
    expect(container.querySelector('.markdown-content strong')?.textContent).toBe('bold');
  });

  // ── preview posture ────────────────────────────────────────────────────────
  //
  // 🔴 ONE TEST PER OMISSION, each paired with its positive control from the
  // non-preview arm — a `toHaveLength(0)` from a selector that can never match
  // anything is indistinguishable from a real omission. The controls are the
  // `live: …` half of each pair below.

  const previewCases: Array<{ what: string; testid: string; over?: Partial<ListingDetail> }> = [
    { what: 'the comments thread', testid: 'mock-comments' },
    { what: 'the reviews list', testid: 'mock-reviews' },
    { what: 'the ⋮ actions menu', testid: MENU },
    { what: 'the right-rail action card', testid: 'apps-listing-action-card' },
    { what: 'the creator card', testid: 'apps-listing-creator-card' },
    { what: 'the header stat chips', testid: 'apps-listing-stat-chips' },
    { what: 'the header meta line', testid: 'apps-listing-meta' },
    { what: 'the related-listings rail', testid: 'apps-related-rail' },
    { what: 'the clickable hero', testid: 'apps-listing-hero-launch' },
  ];

  for (const { what, testid } of previewCases) {
    test(`🔴 preview OMITS ${what} — with its live positive control`, async () => {
      // Owner + relateds seeded so the LIVE arm renders the maximum surface.
      mocks.currentUser = { id: 5, username: 'alice' };
      mocks.relatedItems = [relatedCard('l2', 'Sibling One')];

      // POSITIVE CONTROL: the same selector, same fixture, non-preview.
      const live = await renderScoped(<AppListingDetailBody detail={base({})} canOpenPage />);
      await expect.element(live.within.getByText('My App')).toBeInTheDocument();
      const liveCount =
        testid === 'apps-listing-stat-chips'
          ? live.container.querySelectorAll('[data-listing-stat]').length
          : live.container.querySelectorAll(`[data-testid="${testid}"]`).length;
      expect(liveCount, `positive control: ${what} must be findable in the live arm`).toBeGreaterThan(0);

      // …and now the preview arm. `canOpenPage` stays TRUE so the ONLY thing
      // suppressing anything is `preview`.
      const prev = await renderScoped(
        <AppListingDetailBody detail={base({})} canOpenPage preview />
      );
      await expect.element(prev.within.getByText('My App')).toBeInTheDocument();
      const previewCount =
        testid === 'apps-listing-stat-chips'
          ? prev.container.querySelectorAll('[data-listing-stat]').length
          : prev.container.querySelectorAll(`[data-testid="${testid}"]`).length;
      expect(previewCount, `${what} must be omitted in preview`).toBe(0);
    });
  }

  test('🔴 preview omits the back-to-store link (text-level, with its control)', async () => {
    const live = await renderScoped(<AppListingDetailBody detail={base({})} />);
    await expect.element(live.within.getByText('Back to store')).toBeInTheDocument();

    const prev = await renderScoped(<AppListingDetailBody detail={base({})} preview />);
    await expect.element(prev.within.getByText('My App')).toBeInTheDocument();
    expect(prev.within.getByText('Back to store').elements()).toHaveLength(0);
  });

  test('🔴 preview omits the REVIEWS row from the details rail, keeping the others', async () => {
    const prev = await renderScoped(
      <AppListingDetailBody detail={base({ contentRating: 'PG' })} preview />
    );
    await expect.element(prev.within.getByTestId('apps-listing-details-accordion')).toBeInTheDocument();
    const rows = Array.from(
      prev.container.querySelectorAll('[data-listing-detail-row]')
    ).map((r) => r.getAttribute('data-listing-detail-row'));
    // Control: the live arm has 6 rows including `reviews` (asserted above).
    expect(rows).toEqual(['kind', 'category', 'rating', 'installs', 'updated']);
  });

  test('🔴 preview keeps the read-only creator CHIP so the submitter is still named', async () => {
    // The rail's creator card is omitted in preview; without this chip a moderator
    // would see no submitter at all.
    const prev = await renderScoped(<AppListingDetailBody detail={base({})} preview />);
    await expect.element(prev.within.getByText('by alice')).toBeInTheDocument();
  });

  test('preview mode still renders the presentational parts', async () => {
    const { within } = await renderScoped(
      <AppListingDetailBody
        detail={base({
          description: 'About **this** app.',
          screenshots: [{ url: 'https://cdn.example/shot-1.png', caption: 'a shot' }],
        })}
        preview
      />
    );
    await expect.element(within.getByText('My App')).toBeInTheDocument();
    await expect.element(within.getByText('Screenshots')).toBeInTheDocument();
    await expect.element(within.getByText('About', { exact: true })).toBeInTheDocument();
  });

  test('non-preview (live) still renders comments/reviews + the primary action (regression)', async () => {
    const { within } = await renderScoped(<AppListingDetailBody detail={base({})} />);
    await expect.element(within.getByTestId('mock-comments')).toBeInTheDocument();
    await expect.element(within.getByTestId('mock-reviews')).toBeInTheDocument();
    // Primary action present. base() is an on-site page app whose viewer CAN'T
    // open the in-host page route (appBlocksPages is false in the mocked flags),
    // so the raw-origin "Open live" escape hatch is the primary action.
    const openLive = within.getByTestId('apps-listing-open-live');
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

  test('🔴 renders NO in-page preview section and NO iframe (invariant guard)', async () => {
    const { within } = await renderScoped(<AppListingDetailBody detail={base({})} />);
    // Anchor on a real awaited element first, so the sync DOM reads below are
    // not racing the mount.
    await expect.element(within.getByTestId('apps-listing-open-live')).toBeInTheDocument();

    expect(within.getByTestId('apps-listing-preview').elements()).toHaveLength(0);
    expect(within.getByTestId('apps-listing-preview-activate').elements()).toHaveLength(0);
    expect(within.getByTestId('apps-listing-preview-frame').elements()).toHaveLength(0);
    expect(within.getByTestId('apps-listing-preview-poster').elements()).toHaveLength(0);
    // No third-party frame of any kind, however it might be re-added.
    expect(document.querySelectorAll('iframe')).toHaveLength(0);
    // …and no copy pointing at a section that does not exist.
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('Live preview');
    expect(text).not.toContain('Run live preview');
    expect(text).not.toContain('live preview below');
  });

  test('a listing with NO cover and NO screenshots renders no preview either', async () => {
    const { container, within } = await renderScoped(
      <AppListingDetailBody detail={base({ coverUrl: null, screenshots: [] })} />
    );
    await expect.element(within.getByText('My App')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-testid="apps-listing-preview"]')).toHaveLength(0);
    expect(document.querySelectorAll('iframe')).toHaveLength(0);
  });

  test('canOpenPage → the in-host Open button, and the raw-origin escape hatch is HIDDEN', async () => {
    const { container, within } = await renderScoped(
      <AppListingDetailBody detail={base({})} canOpenPage />
    );
    await expect.element(within.getByText('Open', { exact: true })).toBeInTheDocument();
    expect(container.querySelectorAll('[data-testid="apps-listing-open-live"]')).toHaveLength(0);
  });

  test('the VERBOSE legacy preview copy is gone (the escape-hatch button is not)', async () => {
    const { container, within } = await renderScoped(<AppListingDetailBody detail={base({})} />);
    await expect.element(within.getByTestId('apps-listing-open-live')).toBeInTheDocument();
    const text = container.textContent ?? '';
    expect(text).not.toContain('Preview of the standalone block at');
    expect(text).not.toContain('The live block on a model page runs with your granted permissions');
    expect(text).not.toContain('this standalone preview does not');
    // The button itself STAYS in this state — it is the only route for a block
    // the sandboxed frame can't run. Only the wall of caveat text was removed.
    expect(container.querySelectorAll('[data-testid="apps-listing-open-live"]')).toHaveLength(1);
  });

  // ── Screenshot gallery ─────────────────────────────────────────────────────

  test('a screenshot tile hides ITSELF on load error', async () => {
    const { container, within } = await renderScoped(
      <AppListingDetailBody
        detail={base({
          screenshots: [
            { url: 'https://cdn.example/missing.png', caption: null },
            { url: 'https://cdn.example/other.png', caption: null },
          ],
        })}
      />
    );
    // POSITIVE CONTROL: the gallery and BOTH tiles are there before any error fires.
    await expect.element(within.getByText('Screenshots')).toBeInTheDocument();
    expect(container.querySelectorAll('img')).toHaveLength(2);
    // Both URLs are unresolvable, so the browser fires `error` on its own; wait for the
    // component to react rather than asserting against a still-loading DOM.
    await vi.waitUntil(() => container.querySelectorAll('img').length === 0, {
      timeout: 10000,
      interval: 25,
    });

    // 🔴 MEASURED, AND IT IS NOT WHAT THE DOCSTRING IMPLIES: the "Screenshots" HEADING
    // SURVIVES once every tile has errored. `ScreenshotGallery` decides whether to
    // render the section from the URL list (`filter(s => !!s.url)`), which is a render-
    // time fact, while `broken` is per-tile state discovered later — so an all-404
    // gallery leaves an empty heading. PRE-EXISTING behaviour, unchanged by this PR and
    // deliberately not "fixed" here (lifting the broken-set into the parent is a
    // behaviour change with its own decision to make). Asserted as it IS, so nobody
    // reads the section-hiding test below as covering this case.
    expect(within.getByText('Screenshots').elements()).toHaveLength(1);
  });

  test('the gallery section is hidden when NOTHING remains after the url filter', async () => {
    // The case the section-hiding branch actually covers: no usable URLs at all.
    const { within } = await renderScoped(
      <AppListingDetailBody detail={base({ screenshots: [{ url: '', caption: 'no url' }] })} />
    );
    await expect.element(within.getByText('My App')).toBeInTheDocument();
    expect(within.getByText('Screenshots').elements()).toHaveLength(0);
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
   * Render, then poll for THIS mount's CTA.
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
   */
  async function renderAndSettle(
    ui: Parameters<typeof renderWithProviders>[0],
    ctaHref: string
  ): Promise<{ cta: HTMLAnchorElement; container: HTMLElement }> {
    const { container } = await renderWithProviders(ui);
    const cta = await vi.waitUntil(
      () => container.querySelector(`a[href="${ctaHref}"][class*="Button-root"]`),
      { timeout: 10000, interval: 25 }
    );
    return { cta: cta as HTMLAnchorElement, container: container as HTMLElement };
  }

  test('🔴 the in-site Open CTA and the off-site Visit CTA render DIFFERENT glyphs', async () => {
    const { cta: openBtn } = await renderAndSettle(
      <AppListingDetailBody detail={base({})} canOpenPage />,
      '/apps/run/my-app'
    );
    const openGlyph = glyphOf(openBtn);

    const { cta: visitBtn } = await renderAndSettle(
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
    const { cta: openBtn } = await renderAndSettle(
      <AppListingDetailBody detail={base({})} canOpenPage />,
      '/apps/run/my-app'
    );
    expect(openBtn.getAttribute('target')).toBeNull();
    expect(openBtn.getAttribute('rel')).toBeNull();

    const { cta: visitBtn } = await renderAndSettle(
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
   * `renderAndSettle`'s href key can't reach them.
   */
  async function waitForCtaGlyph(root: HTMLElement, label: string): Promise<string> {
    const host = await vi.waitUntil(
      () =>
        Array.from(root.querySelectorAll('button, div')).find(
          (n) => n.textContent?.trim() === label && n.querySelector('svg')
        ) ?? null,
      { timeout: 10000, interval: 25 }
    );
    return glyphOf(host as Element);
  }

  test('🔴 a connect listing WITH an https externalUrl renders a real Visit ↗ anchor', async () => {
    const { cta: visitBtn, container } = await renderAndSettle(
      <AppListingDetailBody
        detail={base({
          kind: 'offsite',
          kindData: {
            kind: 'offsite',
            subKind: 'connect',
            externalUrl: 'https://connect.app',
            connectClientId: 'oauth-client-1',
          },
        })}
      />,
      'https://connect.app'
    );
    expect(visitBtn.textContent?.trim()).toBe('Visit');
    expect(visitBtn.getAttribute('target')).toBe('_blank');
    expect(visitBtn.getAttribute('rel')).toBe('noopener noreferrer');
    expect(glyphOf(visitBtn)).toBe('external-link');
    // The stub copy must be GONE from this state — it is the exact string a user
    // reported as a dead end.
    expect(container.textContent).not.toContain('Connecting this app will be available soon');
  });

  test('the connect branch keeps its own glyph', async () => {
    const { container } = await renderScoped(
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
    expect(await waitForCtaGlyph(container as HTMLElement, 'Connect')).toBe('plug-connected');
  });

  test('the info (model-slot) branch keeps its own glyph', async () => {
    const { container } = await renderScoped(
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
    expect(await waitForCtaGlyph(container as HTMLElement, 'Runs on model pages')).toBe(
      'info-circle'
    );
  });

  // ── Discovery rail ─────────────────────────────────────────────────────────

  test('the related rail renders siblings and EXCLUDES the listing being viewed', async () => {
    mocks.relatedItems = [
      relatedCard('l1', 'My App'), // self — must not appear as a related card
      relatedCard('l2', 'Sibling One'),
      relatedCard('l3', 'Sibling Two'),
    ];
    const { container, within } = await renderScoped(<AppListingDetailBody detail={base({})} />);

    await expect.element(within.getByTestId('apps-related-rail')).toBeInTheDocument();
    await expect.element(within.getByText('Sibling One')).toBeInTheDocument();
    await expect.element(within.getByText('Sibling Two')).toBeInTheDocument();
    // Two related cards, not three — self was dropped.
    expect(container.querySelectorAll('[data-testid="apps-related-grid-col"]')).toHaveLength(2);
    // No related card links back to this very listing.
    const hrefs = Array.from(container.querySelectorAll('[data-testid="apps-related-grid-col"]'))
      .flatMap((col) => Array.from(col.querySelectorAll('a')).map((a) => a.getAttribute('href')));
    expect(hrefs).not.toContain('/apps/store-preview/my-app');
  });

  test('the "Browse all apps" link is present even when the rail is empty', async () => {
    mocks.relatedItems = [];
    const { container, within } = await renderScoped(<AppListingDetailBody detail={base({})} />);
    await expect.element(within.getByText('My App')).toBeInTheDocument();
    const browse = container.querySelector('[data-testid="apps-browse-all"]');
    expect(browse).not.toBeNull();
    expect(browse?.getAttribute('href')).toBe('/apps');
  });

  // ── Hero banner click-to-launch ────────────────────────────────────────────
  //
  // The banner is a SECOND affordance for the primary `open` action — an
  // ordinary `<a href="/apps/run/<slug>">` wrapping the cover art. Not a frame,
  // not a div-with-onClick.
  //
  // 🔴 RED-AT-BASE STATUS, stated per test rather than implied (measured on the
  // pre-#3556 base by running each in isolation):
  //   RED   — "is a real link", "NO cover art still launches", "keyboard focusable and
  //           Enter activates", "records recents exactly as the Open CTA does".
  //   GREEN — the negative tests (off-site, the on-site "Open live" escape hatch, the
  //           model-slot info branch) and the positive control. Base renders no banner
  //           link at all, so the negatives pass there VACUOUSLY: they are INVARIANT
  //           GUARDS, not coverage. Their worth is mutation-proof against the
  //           `heroLaunchHref` guard — drop a clause and each goes red for its own
  //           reason. Do not count them as regression coverage.

  /** The banner's launch anchor, when there is one. */
  const HERO = 'apps-listing-hero-launch';

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
    const { within } = await renderScoped(
      <AppListingDetailBody detail={base({ coverUrl: null })} canOpenPage />
    );
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

  test('off-site (Visit) → the banner is NOT interactive (invariant guard)', async () => {
    const { container, within } = await renderScoped(<AppListingDetailBody detail={offsite()} />);
    await expect.element(within.getByTestId('apps-listing-open-live')).toBeInTheDocument();
    expect(container.querySelectorAll(`[data-testid="${HERO}"]`)).toHaveLength(0);
    // Exactly one route off-platform: the labelled button.
    expect(container.querySelectorAll('a[href="https://ext.app"]')).toHaveLength(1);
  });

  test('the on-site raw-origin escape hatch does NOT make the banner interactive (invariant guard)', async () => {
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

/**
 * The PUBLIC COLLABORATOR BYLINE, asserted from an ANONYMOUS view.
 *
 * 🔴 ANONYMOUS is the load-bearing part of the setup, not a detail: `mocks.currentUser`
 * is `null` for every test in this file (see `beforeEach`), so what renders here is what
 * a logged-out visitor to the store page sees. The server hands this component the
 * ACCEPTED-and-`displayed` set only — the consent + opt-out filters live in
 * `listDisplayedCollaboratorUserIds` and are pinned in `app-access.service.test.ts`, and
 * the three-key projection in `app-collaborator.public-projection.test.ts`. What is
 * pinned HERE is that the surface consumes the field at all and that it neither widens
 * nor re-filters it.
 */
describe('AppListingDetailBody — the public collaborator byline (anonymous view)', () => {
  test('a DISPLAYED accepted collaborator appears in the byline for a logged-out viewer', async () => {
    expect(mocks.currentUser).toBeNull();
    const { container, within } = await renderScoped(
      <AppListingDetailBody
        detail={base({ collaborators: [{ id: 42, username: 'bob', image: null }] })}
      />
    );
    await expect.element(within.getByTestId('apps-listing-collaborators')).toBeInTheDocument();
    const chip = container.querySelector('[data-testid="apps-listing-collaborator-42"]');
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute('href')).toBe('/user/bob');
  });

  /**
   * 🔴 THE NEGATIVE HALF. A pending invitee, a rejected invitee and an accepted seat with
   * `displayed:false` are all absent from `detail.collaborators` server-side — so an
   * empty projection must render NO byline row at all.
   */
  test('an EMPTY collaborator set renders no byline — pending/rejected/undisplayed are absent', async () => {
    const { container, within } = await renderScoped(
      <AppListingDetailBody detail={base({ collaborators: [] })} />
    );
    // The page itself rendered (so this zero is not "nothing rendered at all").
    await expect.element(within.getByText('My App')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-testid="apps-listing-collaborators"]')).toHaveLength(0);
  });

  test('the byline is rendered alongside — not instead of — the creator card', async () => {
    mocks.creator = { id: 5, username: 'alice', image: null, rank: null, links: [], cosmetics: [], stats: null };
    const { container, within } = await renderScoped(
      <AppListingDetailBody
        detail={base({ collaborators: [{ id: 42, username: 'bob', image: null }] })}
      />
    );
    await expect.element(within.getByTestId('apps-listing-creator-card')).toBeInTheDocument();
    expect(container.querySelector('[data-testid="apps-listing-collaborator-42"]')).not.toBeNull();
  });
});
