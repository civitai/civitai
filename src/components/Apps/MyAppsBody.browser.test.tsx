import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';

// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { LOADABLE_IMAGE_DATA_URI, renderWithProviders } from '../../../test/component-setup';
import type * as MantineHooks from '@mantine/hooks';
import type { MyAppRow } from '~/components/Apps/myAppsView';
import type { MyAppHistoryEntry, OrphanedSubmissionRow } from './MyAppsBody';
import type * as TrpcModule from '~/utils/trpc';
import { capabilitiesForKind } from '~/shared/constants/app-capabilities.constants';

/**
 * `/apps/mine` — the ONE merged author table.
 *
 * 🔴 SCOPE, STATED HONESTLY BECAUSE THE MOCKS ARE HEAVY. What these tests exercise for
 * real: the active/inactive partition, the collapse's a11y state + count + pagination
 * boundary, the placeholder-vs-image branch, the link-vs-no-link status gate, the per-row
 * href derivation, and — in the container block at the bottom — whether the history query
 * is issued at all. What is mock-shadowed: the data layer entirely, and every visual
 * property (the `component` project loads NO CSS, so nothing here is a claim about
 * layout). The mobile card layout is exercised by passing `compact`, which is the SAME
 * boolean the container derives from `useMediaQuery` — the derivation itself is pinned in
 * the container block, not inferred here.
 *
 * 🔴 RED-AT-MAIN HONESTY: this file cannot exist on `origin/main` at all, because the
 * component it imports does not. So "red before, green after" is true but weak on its own —
 * the substantive red→green for the collaborator/transfer population is the SERVER test
 * (`app-access.my-app-listings-media.test.ts`), which fails on `origin/main` for a
 * behavioural reason rather than a missing module.
 */

const mocks = vi.hoisted(() => ({
  compact: false as boolean,
  /** Rows the container's `listMine` query resolves to. */
  rows: [] as unknown[],
  /** Every `listingHistory.useQuery(input, opts)` call, in order. */
  historyCalls: [] as Array<{ input: { appListingId: string }; enabled: boolean }>,
  orphans: [] as unknown[],
  orphansError: null as string | null,
  orphansLoading: false,
  appBlocksFlag: true,
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  // The container reads `appBlocks` for the WRITE gate only — the page itself is
  // `appBlocksAuthor`-gated. See the note at its use site.
  useFeatureFlags: () => ({ appBlocks: mocks.appBlocksFlag, appBlocksAuthor: true }),
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    useUtils: () => ({
      appListings: {
        listingHistory: { invalidate: vi.fn() },
        listMine: { invalidate: vi.fn() },
        listMyOrphanedSubmissions: { invalidate: vi.fn() },
      },
    }),
    appListings: {
      listMine: {
        useQuery: () => ({ data: mocks.rows, isLoading: false, error: null }),
      },
      listingHistory: {
        useQuery: (input: { appListingId: string }, opts: { enabled: boolean }) => {
          mocks.historyCalls.push({ input, enabled: opts.enabled });
          return { data: [], isLoading: false, error: null };
        },
      },
      listMyOrphanedSubmissions: {
        useQuery: () => ({
          data: mocks.orphans,
          isLoading: mocks.orphansLoading,
          error: mocks.orphansError ? { message: mocks.orphansError } : null,
        }),
      },
      withdrawExternalRequest: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      // The restored owner takedown pair. Present here so the CONTAINER block below mounts
      // at all — the mutation hooks run unconditionally on render, so an absent entry is a
      // `Cannot read properties of undefined` at mount, not a missing assertion. What these
      // two procedures are actually CALLED WITH is asserted in
      // `MyAppsBody.authorActions.browser.test.tsx`, which owns the ledger.
      republishOwnListing: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      unpublishOwnListing: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      listMyListingModerationEvents: {
        useQuery: () => ({ data: { items: [] }, isLoading: false, error: null }),
      },
    },
    blocks: {
      withdrawPublishRequest: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
  },
}));

vi.mock('@mantine/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof MantineHooks>()),
  // The real hook measures the real viewport, which is not deterministic under a test
  // runner — force the branch per test instead.
  useMediaQuery: () => mocks.compact,
}));

vi.mock('~/utils/notifications', () => ({
  showErrorNotification: vi.fn(),
  showSuccessNotification: vi.fn(),
}));

const { MyAppsBody, MyAppsBodyView, historyPanelId } = await import('./MyAppsBody');

/**
 * Fixtures are pairwise distinct on every dimension an assertion names — id, slug, status,
 * kind, role, media presence — so a mutant that hardcodes any one literal cannot pass by
 * coincidentally matching a fixture that could only ever have produced that value.
 */
function row(over: Partial<MyAppRow> & { appListingId: string }): MyAppRow {
  const kind = over.kind ?? 'onsite';
  return {
    slug: `slug-${over.appListingId}`,
    name: `Name ${over.appListingId}`,
    status: 'approved',
    kind,
    appBlockId: kind === 'onsite' ? `ab-${over.appListingId}` : null,
    role: 'owner',
    capabilities: capabilitiesForKind(kind),
    iconUrl: null,
    coverUrl: null,
    updatedAt: '2026-08-01T00:00:00Z',
    ...over,
    // `capabilities` must follow the FINAL kind, not the default one.
    ...(over.capabilities ? {} : { capabilities: capabilitiesForKind(over.kind ?? kind) }),
  };
}

function entry(over: Partial<MyAppHistoryEntry> & { id: string }): MyAppHistoryEntry {
  return {
    source: 'version',
    status: 'approved',
    version: '1.0.0',
    submittedAt: '2026-07-01T00:00:00Z',
    reviewedAt: null,
    rejectionReason: null,
    approvalNotes: null,
    changelog: null,
    deployState: null,
    // Default to the SUBMITTER's view so the fixture is not silently unwithdrawable; the
    // cases that care about the collaborator/flag branches set it explicitly.
    canWithdraw: over.status === 'pending',
    ...over,
  };
}

beforeEach(() => {
  mocks.compact = false;
  mocks.rows = [];
  mocks.historyCalls = [];
  mocks.orphans = [];
  mocks.orphansError = null;
  mocks.orphansLoading = false;
  mocks.appBlocksFlag = true;
});

/* ------------------------------------------------------------------ *
 * The three populations `/apps/mine` exists for
 * ------------------------------------------------------------------ */

describe('🔴 one table, all three populations `/apps/my-submissions` could not serve', () => {
  /**
   * The regression a naive merge reintroduces. `/apps/my-submissions` read publish
   * requests scoped to `submittedByUserId`; a collaborator submitted nothing, and an owner
   * who acquired a listing by TRANSFER or by moderator CLAIM did not submit it either. All
   * three must be rows in the ONE table.
   */
  test('owner, accepted collaborator and a transferred/mod-claimed app all render', async () => {
    renderWithProviders(
      <MyAppsBodyView
        rows={[
          row({ appListingId: 'apl_owned', role: 'owner', status: 'approved' }),
          row({
            appListingId: 'apl_seat',
            role: 'editor',
            status: 'pending',
            kind: 'offsite',
          }),
          // Acquired by transfer / mod claim: indistinguishable at this seam by
          // construction — both are "owner who never submitted".
          row({ appListingId: 'apl_transferred', role: 'owner', status: 'draft' }),
        ]}
      />
    );
    await expect.element(page.getByTestId('apps-mine-row-apl_owned')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-mine-row-apl_seat')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-mine-row-apl_transferred')).toBeInTheDocument();
    // The seat row is labelled as a seat, not silently shown as ownership.
    await expect
      .element(page.getByTestId('apps-mine-role-apl_seat'))
      .toHaveTextContent(/collaborator/i);
    await expect.element(page.getByTestId('apps-mine-role-apl_owned')).toHaveTextContent(/owner/i);
  });

  test('ON-SITE and OFF-SITE render in the SAME table, each labelled by kind', async () => {
    renderWithProviders(
      <MyAppsBodyView
        rows={[
          row({ appListingId: 'apl_on', kind: 'onsite', status: 'approved' }),
          row({ appListingId: 'apl_off', kind: 'offsite', status: 'pending' }),
        ]}
      />
    );
    const table = page.getByTestId('apps-mine-table');
    await expect.element(table).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-mine-kind-apl_on')).toHaveTextContent(/on-site/i);
    await expect.element(page.getByTestId('apps-mine-kind-apl_off')).toHaveTextContent(/external/i);
    // ONE table, not two sections: both rows are inside it.
    expect(table.element().querySelectorAll('[data-testid^="apps-mine-row-"]')).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ *
 * The active / inactive partition
 * ------------------------------------------------------------------ */

describe('🔴 the active/inactive partition is LISTING-level and terminal-only', () => {
  test('draft, pending and approved are in the MAIN table', async () => {
    renderWithProviders(
      <MyAppsBodyView
        rows={[
          row({ appListingId: 'apl_d', status: 'draft' }),
          row({ appListingId: 'apl_p', status: 'pending', kind: 'offsite' }),
          row({ appListingId: 'apl_a', status: 'approved' }),
        ]}
      />
    );
    await expect.element(page.getByTestId('apps-mine-row-apl_d')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-mine-row-apl_p')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-mine-row-apl_a')).toBeInTheDocument();
    // …and there is no collapse at all, because nothing is inactive.
    expect(page.getByTestId('apps-mine-inactive-toggle').elements()).toHaveLength(0);
  });

  test('a DRAFT is never filed under Inactive', async () => {
    renderWithProviders(
      <MyAppsBodyView
        rows={[
          row({ appListingId: 'apl_draft', status: 'draft' }),
          row({ appListingId: 'apl_removed', status: 'removed', kind: 'offsite' }),
        ]}
      />
    );
    // Present as an ACTIVE row…
    await expect.element(page.getByTestId('apps-mine-row-apl_draft')).toBeInTheDocument();
    // …and absent from the inactive group, whose testid namespace is separate.
    expect(page.getByTestId('apps-mine-inactive-row-apl_draft').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-mine-inactive-row-apl_removed').elements()).toHaveLength(1);
  });

  test('rejected and removed go to the collapse', async () => {
    renderWithProviders(
      <MyAppsBodyView
        rows={[
          row({ appListingId: 'apl_rej', status: 'rejected' }),
          row({ appListingId: 'apl_rem', status: 'removed', kind: 'offsite' }),
          row({ appListingId: 'apl_ok', status: 'approved' }),
        ]}
      />
    );
    await expect.element(page.getByTestId('apps-mine-row-apl_ok')).toBeInTheDocument();
    expect(page.getByTestId('apps-mine-row-apl_rej').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-mine-inactive-row-apl_rej').elements()).toHaveLength(1);
    expect(page.getByTestId('apps-mine-inactive-row-apl_rem').elements()).toHaveLength(1);
  });

  /**
   * 🔴 DECISION #2's core invariant, at the UI. A WITHDRAWN submission is an event on an
   * app; it is not a listing state and must not move the app anywhere. The app stays in the
   * main table AND the withdrawn request is visible in its nested history.
   */
  test('🔴 a WITHDRAWN submission on an APPROVED app keeps the app ACTIVE, with the request in its history', async () => {
    renderWithProviders(
      <MyAppsBodyView
        rows={[row({ appListingId: 'apl_live', status: 'approved', kind: 'offsite' })]}
        expandedId="apl_live"
        history={[
          entry({ id: 'req_wd', source: 'listing', status: 'withdrawn', version: null }),
          entry({ id: 'req_ok', source: 'version', status: 'approved', version: '2.1.0' }),
        ]}
      />
    );
    // ACTIVE — in the main table, and NOT in the inactive namespace.
    await expect.element(page.getByTestId('apps-mine-row-apl_live')).toBeInTheDocument();
    expect(page.getByTestId('apps-mine-inactive-row-apl_live').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-mine-inactive-toggle').elements()).toHaveLength(0);
    // …and the withdrawn request is still visible, as history.
    await expect
      .element(page.getByTestId('apps-mine-history-status-req_wd'))
      .toHaveTextContent(/withdrawn/i);
    await expect.element(page.getByTestId('apps-mine-history-entry-req_ok')).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * Media
 * ------------------------------------------------------------------ */

describe('icon + cover, and the placeholder path', () => {
  test('renders both images with FIXED dimensions and lazy loading', async () => {
    renderWithProviders(
      <MyAppsBodyView
        rows={[
          row({
            appListingId: 'apl_media',
            status: 'approved',
            // 🔴 A data: URI, not an http(s) URL. Nothing serves an http source to the
            // test browser, so the <img> fires a real `error` event ~11 ms after mount and
            // any "the image exists" assertion races that window — green locally, flaky on
            // a loaded CI box (local-rules/no-unloadable-image-fixture).
            iconUrl: LOADABLE_IMAGE_DATA_URI,
            coverUrl: LOADABLE_IMAGE_DATA_URI,
          }),
        ]}
      />
    );
    const icon = page.getByTestId('apps-mine-icon-apl_media');
    await expect.element(icon).toBeInTheDocument();
    const iconEl = icon.element() as HTMLImageElement;
    // 🔴 Attributes, not computed style. The harness loads no CSS, so a `getComputedStyle`
    // assertion here would be vacuous; the width/height ATTRIBUTES are what actually
    // reserve the box before the bytes arrive, which is the CLS property being pinned.
    expect(iconEl.getAttribute('width')).toBeTruthy();
    expect(iconEl.getAttribute('height')).toBeTruthy();
    expect(iconEl.getAttribute('loading')).toBe('lazy');

    const coverEl = page.getByTestId('apps-mine-cover-apl_media').element() as HTMLImageElement;
    expect(coverEl.getAttribute('width')).toBeTruthy();
    expect(coverEl.getAttribute('height')).toBeTruthy();
    expect(coverEl.getAttribute('loading')).toBe('lazy');
  });

  /**
   * 🔴 THE PLACEHOLDER IS THE MAIN RENDER PATH FOR THE INACTIVE TABLE, not an edge case:
   * measured on production 2026-08-19, all 11 `removed` listings have `cover_id IS NULL`
   * and 10 of the 11 have an icon. So the exact shape fixtured here — icon present, cover
   * absent, status `removed` — is what the collapse actually renders today.
   */
  test('🔴 a removed listing with an icon and NO cover renders the cover placeholder', async () => {
    renderWithProviders(
      <MyAppsBodyView
        rows={[
          row({
            appListingId: 'apl_gone',
            status: 'removed',
            iconUrl: LOADABLE_IMAGE_DATA_URI,
            coverUrl: null,
          }),
        ]}
      />
    );
    // 🔴 AWAIT THE ELEMENT BEFORE CLICKING. `renderWithProviders` commits
    // asynchronously in browser mode, so a synchronous `.element()` here races the
    // mount and reports "Cannot find element" against an empty <body>.
    await expect.element(page.getByTestId('apps-mine-inactive-toggle')).toBeInTheDocument();
    await userEvent.click(page.getByTestId('apps-mine-inactive-toggle').element());
    await expect
      .element(page.getByTestId('apps-mine-cover-placeholder-apl_gone'))
      .toBeInTheDocument();
    // The icon is a real image; only the cover falls back.
    await expect.element(page.getByTestId('apps-mine-icon-apl_gone')).toBeInTheDocument();
    expect(page.getByTestId('apps-mine-cover-apl_gone').elements()).toHaveLength(0);
  });

  test('a listing with NO icon renders the icon placeholder', async () => {
    renderWithProviders(
      <MyAppsBodyView
        rows={[row({ appListingId: 'apl_bare', status: 'pending', iconUrl: null })]}
      />
    );
    await expect
      .element(page.getByTestId('apps-mine-icon-placeholder-apl_bare'))
      .toBeInTheDocument();
    expect(page.getByTestId('apps-mine-icon-apl_bare').elements()).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * Per-row capability / href gating
 * ------------------------------------------------------------------ */

describe('🔴 per-row gating survives the merge', () => {
  /**
   * The edit affordance is the NAME LINK, and it is withheld exactly when
   * `getAppListingAuthoringContext` would throw FORBIDDEN — a `removed` or `rejected`
   * listing. Flattening every row to an unconditional `/edit` link would offer a
   * guaranteed 403, and on a removed listing that page used to open with a fully live
   * Collaborators tab.
   */
  test('a REMOVED row has no edit link, only dimmed text', async () => {
    renderWithProviders(
      <MyAppsBodyView rows={[row({ appListingId: 'apl_rm', status: 'removed' })]} />
    );
    // 🔴 AWAIT THE ELEMENT BEFORE CLICKING. `renderWithProviders` commits
    // asynchronously in browser mode, so a synchronous `.element()` here races the
    // mount and reports "Cannot find element" against an empty <body>.
    await expect.element(page.getByTestId('apps-mine-inactive-toggle')).toBeInTheDocument();
    await userEvent.click(page.getByTestId('apps-mine-inactive-toggle').element());
    await expect.element(page.getByTestId('apps-mine-unlinked-apl_rm')).toBeInTheDocument();
    expect(page.getByTestId('apps-mine-link-apl_rm').elements()).toHaveLength(0);
  });

  test('a REJECTED row has no edit link either', async () => {
    renderWithProviders(
      <MyAppsBodyView
        rows={[row({ appListingId: 'apl_rj', status: 'rejected', kind: 'offsite' })]}
      />
    );
    // 🔴 AWAIT THE ELEMENT BEFORE CLICKING. `renderWithProviders` commits
    // asynchronously in browser mode, so a synchronous `.element()` here races the
    // mount and reports "Cannot find element" against an empty <body>.
    await expect.element(page.getByTestId('apps-mine-inactive-toggle')).toBeInTheDocument();
    await userEvent.click(page.getByTestId('apps-mine-inactive-toggle').element());
    await expect.element(page.getByTestId('apps-mine-unlinked-apl_rj')).toBeInTheDocument();
    expect(page.getByTestId('apps-mine-link-apl_rj').elements()).toHaveLength(0);
  });

  test('an APPROVED row does link, and the href is derived PER ROW', async () => {
    renderWithProviders(
      <MyAppsBodyView
        rows={[
          row({ appListingId: 'apl_one', status: 'approved', kind: 'onsite' }),
          row({ appListingId: 'apl_two', status: 'draft', kind: 'offsite' }),
        ]}
      />
    );
    const a = page.getByTestId('apps-mine-link-apl_one');
    await expect.element(a).toBeInTheDocument();
    // Listing-keyed and per-row — NOT one shared href, and never block-keyed (an off-site
    // listing has no block id to build such a URL with).
    expect(a.element().getAttribute('href')).toBe('/apps/listing/apl_one/edit?tab=details');
    expect(page.getByTestId('apps-mine-link-apl_two').element().getAttribute('href')).toBe(
      '/apps/listing/apl_two/edit?tab=details'
    );
  });
});

/* ------------------------------------------------------------------ *
 * The Inactive collapse
 * ------------------------------------------------------------------ */

describe('the Inactive collapse', () => {
  const inactiveRows = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      row({
        appListingId: `apl_x${String(i).padStart(2, '0')}`,
        status: i % 2 === 0 ? 'removed' : 'rejected',
        kind: i % 3 === 0 ? 'offsite' : 'onsite',
        updatedAt: `2026-0${(i % 9) + 1}-01T00:00:00Z`,
      })
    );

  test('is COLLAPSED by default and reports its count in the header', async () => {
    renderWithProviders(
      <MyAppsBodyView rows={[row({ appListingId: 'apl_live' }), ...inactiveRows(3)]} />
    );
    const toggle = page.getByTestId('apps-mine-inactive-toggle');
    await expect.element(toggle).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-mine-inactive-count')).toHaveTextContent('3');
    // 🔴 The a11y STATE, not merely the attribute's presence.
    expect(toggle.element().getAttribute('aria-expanded')).toBe('false');
  });

  test('🔴 aria-expanded FLIPS on click and aria-controls names a real element', async () => {
    renderWithProviders(<MyAppsBodyView rows={inactiveRows(2)} />);
    const toggle = page.getByTestId('apps-mine-inactive-toggle');
    await expect.element(toggle).toBeInTheDocument();
    const controls = toggle.element().getAttribute('aria-controls');
    expect(controls).toBe('apps-mine-inactive-panel');
    // The id it points at must EXIST — an `aria-controls` naming nothing is worse than none.
    expect(document.getElementById(controls as string)).not.toBeNull();

    await userEvent.click(toggle.element());
    await expect
      .element(page.getByTestId('apps-mine-inactive-toggle'))
      .toHaveAttribute('aria-expanded', 'true');
    // 🔴 AWAIT THE ELEMENT BEFORE CLICKING. `renderWithProviders` commits
    // asynchronously in browser mode, so a synchronous `.element()` here races the
    // mount and reports "Cannot find element" against an empty <body>.
    await expect.element(page.getByTestId('apps-mine-inactive-toggle')).toBeInTheDocument();
    await userEvent.click(page.getByTestId('apps-mine-inactive-toggle').element());
    await expect
      .element(page.getByTestId('apps-mine-inactive-toggle'))
      .toHaveAttribute('aria-expanded', 'false');
  });

  test('paginates past the page size, and the LAST page holds the remainder', async () => {
    // 23 inactive rows over a page size of 10 → 3 pages, the last holding 3.
    renderWithProviders(<MyAppsBodyView rows={inactiveRows(23)} />);
    // 🔴 AWAIT THE ELEMENT BEFORE CLICKING. `renderWithProviders` commits
    // asynchronously in browser mode, so a synchronous `.element()` here races the
    // mount and reports "Cannot find element" against an empty <body>.
    await expect.element(page.getByTestId('apps-mine-inactive-toggle')).toBeInTheDocument();
    await userEvent.click(page.getByTestId('apps-mine-inactive-toggle').element());
    const panel = page.getByTestId('apps-mine-inactive-panel');
    await expect.element(panel).toBeInTheDocument();
    const count = () =>
      panel.element().querySelectorAll('[data-testid^="apps-mine-inactive-row-"]').length;
    expect(count()).toBe(10);
    await expect.element(page.getByTestId('apps-mine-inactive-pagination')).toBeInTheDocument();

    // 🔴 THE BOUNDARY: page 3 is the short one. A `Math.floor` page count would render 2
    // pages and silently drop the last 3 apps out of the only surface that lists them.
    //
    // Scoped to the pagination container: a document-wide `getByRole('button', {name:'3'})`
    // ALSO matches the Inactive toggle, whose accessible name carries the count badge
    // ("Inactive 23") — a strict-mode violation, and a reminder that the count really is
    // part of the control's name.
    const pageThree = page
      .getByTestId('apps-mine-inactive-pagination')
      .getByRole('button', { name: '3' });
    await expect.element(pageThree).toBeInTheDocument();
    await userEvent.click(pageThree.element());
    await expect.element(page.getByTestId('apps-mine-inactive-panel')).toBeInTheDocument();
    expect(count()).toBe(3);
  });

  test('no pagination control when everything fits on one page', async () => {
    renderWithProviders(<MyAppsBodyView rows={inactiveRows(4)} />);
    // 🔴 AWAIT THE ELEMENT BEFORE CLICKING. `renderWithProviders` commits
    // asynchronously in browser mode, so a synchronous `.element()` here races the
    // mount and reports "Cannot find element" against an empty <body>.
    await expect.element(page.getByTestId('apps-mine-inactive-toggle')).toBeInTheDocument();
    await userEvent.click(page.getByTestId('apps-mine-inactive-toggle').element());
    await expect.element(page.getByTestId('apps-mine-inactive-panel')).toBeInTheDocument();
    expect(page.getByTestId('apps-mine-inactive-pagination').elements()).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * Empty / error / loading, and the mobile layout
 * ------------------------------------------------------------------ */

describe('empty, error and the card layout', () => {
  test('an empty account says so — not a blank page', async () => {
    renderWithProviders(<MyAppsBodyView rows={[]} />);
    await expect.element(page.getByTestId('apps-mine-empty')).toBeInTheDocument();
    expect(page.getByTestId('apps-mine-table').elements()).toHaveLength(0);
  });

  test('a failed read shows the error, never an empty state', async () => {
    renderWithProviders(<MyAppsBodyView rows={[]} errorMessage="Apps authoring is not enabled" />);
    await expect.element(page.getByTestId('apps-mine-error')).toBeInTheDocument();
    expect(page.getByTestId('apps-mine-empty').elements()).toHaveLength(0);
  });

  test('an account whose apps are ALL inactive gets its own empty state, not a bare page', async () => {
    renderWithProviders(
      <MyAppsBodyView rows={[row({ appListingId: 'apl_only', status: 'removed' })]} />
    );
    await expect.element(page.getByTestId('apps-mine-active-empty')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-mine-inactive-count')).toHaveTextContent('1');
  });

  /**
   * 🔴 EXACTLY ONE LAYOUT IS RENDERED. If both were emitted and hidden with CSS, every
   * document-scoped query would resolve to two elements — and the harness loads no CSS, so
   * "hidden" would not even be true here.
   */
  test('compact renders CARDS, not a scrolling table — and only one copy of each row', async () => {
    mocks.compact = true;
    renderWithProviders(
      <MyAppsBodyView
        compact
        rows={[row({ appListingId: 'apl_m1' }), row({ appListingId: 'apl_m2', kind: 'offsite' })]}
      />
    );
    await expect.element(page.getByTestId('apps-mine-row-apl_m1')).toBeInTheDocument();
    expect(page.getByTestId('apps-mine-row-apl_m1').elements()).toHaveLength(1);
    // No `<table>` in the card layout at all.
    expect(document.querySelectorAll('table')).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * The nested history panel
 * ------------------------------------------------------------------ */

describe('nested history', () => {
  test('the toggle reports its own row state, and the panel id is row-scoped', async () => {
    renderWithProviders(
      <MyAppsBodyView
        rows={[row({ appListingId: 'apl_h1' }), row({ appListingId: 'apl_h2', kind: 'offsite' })]}
        expandedId="apl_h1"
        history={[entry({ id: 'req_1', version: '3.0.0' })]}
      />
    );
    await expect
      .element(page.getByTestId('apps-mine-expand-apl_h1'))
      .toHaveAttribute('aria-expanded', 'true');
    await expect
      .element(page.getByTestId('apps-mine-expand-apl_h2'))
      .toHaveAttribute('aria-expanded', 'false');
    expect(
      page.getByTestId('apps-mine-expand-apl_h1').element().getAttribute('aria-controls')
    ).toBe(historyPanelId('apl_h1'));
    // The OPEN row shows its entries; the closed one shows none.
    await expect.element(page.getByTestId('apps-mine-history-entry-req_1')).toBeInTheDocument();
    expect(
      page
        .getByTestId(historyPanelId('apl_h2'))
        .element()
        .querySelectorAll('[data-testid^="apps-mine-history-entry-"]')
    ).toHaveLength(0);
  });

  test('BOTH publish-request streams appear, tagged by source, without duplication', async () => {
    // The two tables are disjoint event streams over one app — see
    // `app-listing-history.service`'s header. A version bump and a listing edit are
    // different events and must BOTH show.
    renderWithProviders(
      <MyAppsBodyView
        rows={[row({ appListingId: 'apl_hist' })]}
        expandedId="apl_hist"
        history={[
          entry({ id: 'blk_1', source: 'version', status: 'approved', version: '4.2.0' }),
          entry({ id: 'lst_1', source: 'listing', status: 'pending', version: null }),
        ]}
      />
    );
    const blk = page.getByTestId('apps-mine-history-entry-blk_1');
    await expect.element(blk).toBeInTheDocument();
    expect(blk.element().getAttribute('data-history-source')).toBe('version');
    await expect.element(blk).toHaveTextContent('4.2.0');
    const lst = page.getByTestId('apps-mine-history-entry-lst_1');
    expect(lst.element().getAttribute('data-history-source')).toBe('listing');
    await expect.element(lst).toHaveTextContent(/listing edit/i);
    // One element each — a merged read that failed to distinguish the streams would
    // render the same event twice.
    expect(blk.elements()).toHaveLength(1);
    expect(lst.elements()).toHaveLength(1);
  });

  test('an app with no history says so rather than rendering an empty box', async () => {
    renderWithProviders(
      <MyAppsBodyView
        rows={[row({ appListingId: 'apl_none' })]}
        expandedId="apl_none"
        history={[]}
      />
    );
    await expect.element(page.getByTestId('apps-mine-history-empty-apl_none')).toBeInTheDocument();
  });

  test('a failed history read shows an error scoped to that row', async () => {
    renderWithProviders(
      <MyAppsBodyView
        rows={[row({ appListingId: 'apl_err' })]}
        expandedId="apl_err"
        historyError="nope"
      />
    );
    await expect.element(page.getByTestId('apps-mine-history-error-apl_err')).toBeInTheDocument();
  });

  test('Withdraw is offered only on a PENDING entry', async () => {
    const withdrawn: MyAppHistoryEntry[] = [
      entry({ id: 'pend_1', status: 'pending', canWithdraw: true }),
      entry({ id: 'appr_1', status: 'approved', canWithdraw: false }),
    ];
    const seen: string[] = [];
    renderWithProviders(
      <MyAppsBodyView
        rows={[row({ appListingId: 'apl_w' })]}
        expandedId="apl_w"
        history={withdrawn}
        onWithdraw={(e) => seen.push(e.id)}
      />
    );
    const btn = page.getByTestId('apps-mine-history-withdraw-pend_1');
    await expect.element(btn).toBeInTheDocument();
    expect(page.getByTestId('apps-mine-history-withdraw-appr_1').elements()).toHaveLength(0);
    await userEvent.click(btn.element());
    expect(seen).toEqual(['pend_1']);
  });
});

/* ------------------------------------------------------------------ *
 * The container — the LAZY history query
 * ------------------------------------------------------------------ */

describe('MyAppsBody (container) — history is fetched on EXPAND, not up front', () => {
  /**
   * 🔴 THE COST THE MERGE WAS SUPPOSED TO REMOVE. `/apps/my-submissions` issued TWO
   * unbounded per-user reads on mount — `blocks.listMyPublishRequests` (which itself fans
   * out to four more queries) and `appListings.listMySubmissions` — to render history
   * nobody had asked to see. The merged page renders from `listMine` alone.
   *
   * 🔴 GATE CAVEAT, stated because it is the honest limit of this technique: the stub
   * returns data regardless of `enabled`, so the laziness is pinned by reading the
   * `enabled` ARGUMENT off the recorded calls, not by observing that no fetch happened.
   * A behavioural version would need a real query client and a real transport.
   */
  test('🔴 on first render the history query is DISABLED — nothing is fetched', async () => {
    mocks.rows = [row({ appListingId: 'apl_lazy1' }), row({ appListingId: 'apl_lazy2' })];
    renderWithProviders(<MyAppsBody />);
    await expect.element(page.getByTestId('apps-mine-row-apl_lazy1')).toBeInTheDocument();

    // Read `.mock`-style state only AFTER an awaited element — render is async-committed.
    expect(mocks.historyCalls.length).toBeGreaterThan(0); // positive control: the hook ran
    expect(mocks.historyCalls.every((c) => c.enabled === false)).toBe(true);
    // …and ONE hook for the whole table, not one per row — the fan-out this replaces.
    expect(new Set(mocks.historyCalls.map((c) => c.input.appListingId))).toEqual(new Set(['']));
  });

  test('🔴 expanding a row enables the query FOR THAT ROW', async () => {
    mocks.rows = [row({ appListingId: 'apl_lazy1' }), row({ appListingId: 'apl_lazy2' })];
    renderWithProviders(<MyAppsBody />);
    await expect.element(page.getByTestId('apps-mine-expand-apl_lazy2')).toBeInTheDocument();
    const before = mocks.historyCalls.length;

    await userEvent.click(page.getByTestId('apps-mine-expand-apl_lazy2').element());
    await expect
      .element(page.getByTestId('apps-mine-expand-apl_lazy2'))
      .toHaveAttribute('aria-expanded', 'true');

    const after = mocks.historyCalls.slice(before);
    expect(after.length).toBeGreaterThan(0);
    const enabled = after.filter((c) => c.enabled);
    expect(enabled.length).toBeGreaterThan(0);
    // The id is the row that was opened — not the first row, and not the other one.
    expect(new Set(enabled.map((c) => c.input.appListingId))).toEqual(new Set(['apl_lazy2']));
  });

  test('collapsing the row disables it again', async () => {
    mocks.rows = [row({ appListingId: 'apl_lazy1' })];
    renderWithProviders(<MyAppsBody />);
    await expect.element(page.getByTestId('apps-mine-expand-apl_lazy1')).toBeInTheDocument();
    await userEvent.click(page.getByTestId('apps-mine-expand-apl_lazy1').element());
    await expect
      .element(page.getByTestId('apps-mine-expand-apl_lazy1'))
      .toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(page.getByTestId('apps-mine-expand-apl_lazy1').element());
    await expect
      .element(page.getByTestId('apps-mine-expand-apl_lazy1'))
      .toHaveAttribute('aria-expanded', 'false');
    expect(mocks.historyCalls.at(-1)?.enabled).toBe(false);
  });

  /**
   * 🔴 THE ROW SOURCE IS `appListings.listMine`. This is the single most load-bearing
   * property of the consolidation: the trpc mock supplies ONLY `listMine` as a row source,
   * so a container re-derived from `listMySubmissions` / `listMyPublishRequests` would
   * render the empty state here rather than the rows.
   */
  test('🔴 rows come from listMine — the ownership∪seat read', async () => {
    mocks.rows = [row({ appListingId: 'apl_from_listmine', role: 'editor', kind: 'offsite' })];
    renderWithProviders(<MyAppsBody />);
    await expect.element(page.getByTestId('apps-mine-row-apl_from_listmine')).toBeInTheDocument();
    expect(page.getByTestId('apps-mine-empty').elements()).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * Withdraw is only offered to someone who can actually use it
 * ------------------------------------------------------------------ */

describe('🔴 Withdraw is not offered to people the server will refuse', () => {
  /**
   * Both withdraw procs are SUBMITTER-scoped (`withdrawExternalRequest` and
   * `withdrawRequest` each throw NOT_OWNED unless `submittedByUserId === userId`). An
   * accepted collaborator, a transfer recipient and a moderator-claimed owner — the three
   * populations this page exists to serve — would otherwise get a button that only ever
   * red-toasts. The server sends its own verdict as `canWithdraw`.
   */
  test('a PENDING entry the viewer did not submit shows NO button', async () => {
    renderWithProviders(
      <MyAppsBodyView
        rows={[row({ appListingId: 'apl_seat', role: 'editor' })]}
        expandedId="apl_seat"
        history={[entry({ id: 'req_theirs', status: 'pending', canWithdraw: false })]}
        onWithdraw={() => undefined}
      />
    );
    await expect
      .element(page.getByTestId('apps-mine-history-entry-req_theirs'))
      .toBeInTheDocument();
    expect(page.getByTestId('apps-mine-history-withdraw-req_theirs').elements()).toHaveLength(0);
  });

  test('the same entry DOES show it for the submitter', async () => {
    renderWithProviders(
      <MyAppsBodyView
        rows={[row({ appListingId: 'apl_own' })]}
        expandedId="apl_own"
        history={[entry({ id: 'req_mine', status: 'pending', canWithdraw: true })]}
        onWithdraw={() => undefined}
      />
    );
    await expect
      .element(page.getByTestId('apps-mine-history-withdraw-req_mine'))
      .toBeInTheDocument();
  });

  /**
   * 🔴 THE FLAG MISMATCH. `blocks.withdrawPublishRequest` carries `enforceAppBlocksFlag`;
   * this page and both of its reads gate on `appBlocksAuthor` only. With the author flag
   * on and the store flag off the page renders, history loads, and the VERSION half of the
   * button 403s — while the off-site half (`withdrawExternalRequest`, no flag) is fine.
   */
  test('🔴 with the store flag off, the VERSION withdraw is hidden and the LISTING one is not', async () => {
    renderWithProviders(
      <MyAppsBodyView
        rows={[row({ appListingId: 'apl_flag' })]}
        expandedId="apl_flag"
        withdrawEnabled={false}
        history={[
          entry({ id: 'ver_1', source: 'version', status: 'pending', canWithdraw: true }),
          entry({
            id: 'lst_1',
            source: 'listing',
            status: 'pending',
            version: null,
            canWithdraw: true,
          }),
        ]}
        onWithdraw={() => undefined}
      />
    );
    await expect.element(page.getByTestId('apps-mine-history-entry-ver_1')).toBeInTheDocument();
    expect(page.getByTestId('apps-mine-history-withdraw-ver_1').elements()).toHaveLength(0);
    // The off-site sibling proc has no such gate, so its control stays.
    await expect.element(page.getByTestId('apps-mine-history-withdraw-lst_1')).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * The completeness advisory
 * ------------------------------------------------------------------ */

describe('🔴 the listing-completeness advisory has a home', () => {
  /**
   * It rendered on the two `/apps/my-submissions` tables, which lost their importer when
   * that page merged here. Without it an author stops being told the listing is
   * incomplete — and `listingCoverUrl`'s "no screenshot fallback, the author must see the
   * gap" rationale cites this warning by name, so removing it would falsify that comment.
   */
  test('a row with problems renders the indicator', async () => {
    renderWithProviders(
      <MyAppsBodyView
        rows={[
          row({
            appListingId: 'apl_incomplete',
            status: 'draft',
            problems: [
              // Real codes from `ListingProblemCode` — a made-up one typechecks red, which
              // is the point of pinning the union rather than a loose string.
              { code: 'missing-cover', label: 'Missing cover image', severity: 'blocking' },
              { code: 'empty-tagline', label: 'Missing tagline', severity: 'advisory' },
            ],
          }),
        ]}
      />
    );
    const holder = page.getByTestId('apps-mine-problems-apl_incomplete');
    await expect.element(holder).toBeInTheDocument();
    // The indicator itself, not just the slot — it returns null on an empty list.
    expect(
      holder.element().querySelector('[data-testid="apps-submission-problems"]')
    ).not.toBeNull();
  });

  test('a complete row renders no warning at all', async () => {
    renderWithProviders(
      <MyAppsBodyView rows={[row({ appListingId: 'apl_complete', problems: [] })]} />
    );
    const holder = page.getByTestId('apps-mine-problems-apl_complete');
    await expect.element(holder).toBeInTheDocument();
    expect(holder.element().querySelector('[data-testid="apps-submission-problems"]')).toBeNull();
  });

  /**
   * 🔴 A PROBLEM CODE IS NOT UNIQUE WITHIN A ROW — and until the scan dimension was wired
   * into `listMyAppListings`, nothing on this page could demonstrate it.
   *
   * `computeListingProblems` emits ONE `blocked-media` per ASSET SLOT, so a listing whose
   * icon and cover both came back `Blocked` produces two items sharing one code and
   * differing only in their label. `ListingProblemsIndicator` keyed its list on `p.code`,
   * which React rejects as a duplicate key.
   *
   * 🔴 WHAT THIS KILLS: any "fix" that DEDUPES the list by code — the obvious wrong answer
   * to the duplicate-React-key problem, and the one that silently hides which asset the
   * author has to replace. Mutating the component to unique-by-code turns this red.
   *
   * 🔴 WHAT IT DOES **NOT** KILL, stated rather than implied. The accompanying
   * `key={p.code}` → `key={code:label}` change in `ListingProblemsIndicator` has NO
   * killing test. React renders both items on a first paint with duplicate keys anyway,
   * and an attempt to assert React's "two children with the same key" warning through a
   * `console.error` spy SURVIVED its own mutant in this harness — so it was removed rather
   * than shipped as coverage it does not provide. The key fix is carried by review.
   */
  test('🔴 two problems sharing one CODE both reach the reader', async () => {
    renderWithProviders(
      <MyAppsBodyView
        rows={[
          row({
            appListingId: 'apl_twoblocked',
            status: 'draft',
            problems: [
              {
                code: 'blocked-media',
                label: 'Replace the blocked icon before it can publish',
                severity: 'blocking',
              },
              {
                code: 'blocked-media',
                label: 'Replace the blocked cover before it can publish',
                severity: 'blocking',
              },
            ],
          }),
        ]}
      />
    );
    const holder = page.getByTestId('apps-mine-problems-apl_twoblocked');
    await expect.element(holder).toBeInTheDocument();
    const indicator = holder.element().querySelector('[data-testid="apps-submission-problems"]');
    expect(indicator).not.toBeNull();
    // The labels live in a HoverCard dropdown that mounts on hover.
    await userEvent.hover(indicator as HTMLElement);
    await expect
      .element(page.getByText('Replace the blocked icon before it can publish'))
      .toBeInTheDocument();
    await expect
      .element(page.getByText('Replace the blocked cover before it can publish'))
      .toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * Submissions whose listing was deleted
 * ------------------------------------------------------------------ */

describe('🔴 submissions without a listing', () => {
  const orphan = (
    over: Partial<OrphanedSubmissionRow> & { id: string }
  ): OrphanedSubmissionRow => ({
    slug: `slug-${over.id}`,
    version: '0.1.0',
    status: 'rejected',
    submittedAt: '2026-07-07T00:00:00Z',
    reviewedAt: '2026-07-08T00:00:00Z',
    rejectionReason: null,
    approvalNotes: null,
    canWithdraw: false,
    ...over,
  });

  /**
   * 🔴 THE POPULATION THAT HAD NO SURFACE. A first version that is rejected or withdrawn
   * has its pre-approval draft listing DELETED to release the slug, so there is no app row
   * to nest it under. Measured on production 2026-08-20: 3 of 3 rejected and 27 of 33
   * withdrawn on-site requests are in that state — and the "your app was rejected"
   * notification now points at this page.
   */
  test('a rejected submission with no listing renders WITH its reviewer reason', async () => {
    renderWithProviders(
      <MyAppsBodyView
        rows={[row({ appListingId: 'apl_other' })]}
        orphanedSubmissions={[
          orphan({
            id: 'pubreq_rej',
            slug: 'gone-app',
            rejectionReason: 'manifest requests a scope it never uses',
          }),
        ]}
      />
    );
    await expect.element(page.getByTestId('apps-mine-orphaned')).toBeInTheDocument();
    await expect
      .element(page.getByTestId('apps-mine-orphaned-row-pubreq_rej'))
      .toHaveTextContent('gone-app');
    await expect
      .element(page.getByTestId('apps-mine-orphaned-status-pubreq_rej'))
      .toHaveTextContent(/rejected/i);
    // The reason is the whole point — it is the only thing that tells the dev what to fix.
    await expect
      .element(page.getByTestId('apps-mine-orphaned-notes-pubreq_rej'))
      .toHaveTextContent(/scope it never uses/i);
  });

  test('the group is NOT hidden behind the Inactive collapse', async () => {
    renderWithProviders(
      <MyAppsBodyView
        rows={[row({ appListingId: 'apl_live' })]}
        orphanedSubmissions={[orphan({ id: 'pubreq_x' })]}
      />
    );
    // Visible with no interaction at all: no toggle was clicked.
    await expect.element(page.getByTestId('apps-mine-orphaned-row-pubreq_x')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-mine-orphaned-count')).toHaveTextContent('1');
  });

  test('a PENDING orphan offers Withdraw; a rejected one does not', async () => {
    const seen: string[] = [];
    renderWithProviders(
      <MyAppsBodyView
        rows={[]}
        orphanedSubmissions={[
          orphan({ id: 'pubreq_pend', status: 'pending', canWithdraw: true }),
          orphan({ id: 'pubreq_rej2', status: 'rejected', canWithdraw: false }),
        ]}
        onWithdrawOrphan={(r) => seen.push(r.id)}
      />
    );
    const btn = page.getByTestId('apps-mine-orphaned-withdraw-pubreq_pend');
    await expect.element(btn).toBeInTheDocument();
    expect(page.getByTestId('apps-mine-orphaned-withdraw-pubreq_rej2').elements()).toHaveLength(0);
    await userEvent.click(btn.element());
    expect(seen).toEqual(['pubreq_pend']);
  });

  test('an orphan withdraw is hidden when the store flag is off (same proc, same gate)', async () => {
    renderWithProviders(
      <MyAppsBodyView
        rows={[]}
        withdrawEnabled={false}
        orphanedSubmissions={[orphan({ id: 'pubreq_f', status: 'pending', canWithdraw: true })]}
        onWithdrawOrphan={() => undefined}
      />
    );
    await expect.element(page.getByTestId('apps-mine-orphaned-row-pubreq_f')).toBeInTheDocument();
    expect(page.getByTestId('apps-mine-orphaned-withdraw-pubreq_f').elements()).toHaveLength(0);
  });

  test('no group at all when there is nothing orphaned', async () => {
    renderWithProviders(<MyAppsBodyView rows={[row({ appListingId: 'apl_only' })]} />);
    await expect.element(page.getByTestId('apps-mine-row-apl_only')).toBeInTheDocument();
    expect(page.getByTestId('apps-mine-orphaned').elements()).toHaveLength(0);
  });

  /**
   * 🔴 THE EMPTY STATE MUST NOT SWALLOW THEM. An account whose only records are orphans
   * has zero listings, so the "you don't own any apps yet" alert would otherwise be the
   * whole page — which is exactly the "my rejection is nowhere" defect in a new place.
   */
  test('an account with ONLY orphans still sees them, not the empty state', async () => {
    renderWithProviders(
      <MyAppsBodyView rows={[]} orphanedSubmissions={[orphan({ id: 'pubreq_lonely' })]} />
    );
    await expect
      .element(page.getByTestId('apps-mine-orphaned-row-pubreq_lonely'))
      .toBeInTheDocument();
  });
});

describe('MyAppsBody (container) — the orphan read and the write flag', () => {
  test('renders orphaned submissions from their own query', async () => {
    mocks.rows = [row({ appListingId: 'apl_c1' })];
    mocks.orphans = [
      {
        id: 'pubreq_c',
        slug: 'container-gone',
        version: '0.1.0',
        status: 'rejected',
        submittedAt: '2026-07-07T00:00:00Z',
        reviewedAt: null,
        rejectionReason: 'nope',
        approvalNotes: null,
        canWithdraw: false,
      },
    ];
    renderWithProviders(<MyAppsBody />);
    await expect.element(page.getByTestId('apps-mine-orphaned-row-pubreq_c')).toBeInTheDocument();
  });

  /**
   * 🔴 The container is where the flag mismatch is actually decided. With `appBlocks` off
   * the page still renders (it gates on `appBlocksAuthor`) but the version-withdraw
   * mutation would 403, so the control must not be offered.
   */
  test('🔴 with appBlocks OFF the orphan Withdraw is not rendered', async () => {
    mocks.appBlocksFlag = false;
    mocks.rows = [];
    mocks.orphans = [
      {
        id: 'pubreq_flag',
        slug: 'flagged',
        version: '0.1.0',
        status: 'pending',
        submittedAt: '2026-07-07T00:00:00Z',
        reviewedAt: null,
        rejectionReason: null,
        approvalNotes: null,
        canWithdraw: true,
      },
    ];
    renderWithProviders(<MyAppsBody />);
    await expect
      .element(page.getByTestId('apps-mine-orphaned-row-pubreq_flag'))
      .toBeInTheDocument();
    expect(page.getByTestId('apps-mine-orphaned-withdraw-pubreq_flag').elements()).toHaveLength(0);
  });

  test('…and IS rendered with the flag on (the control arm)', async () => {
    mocks.appBlocksFlag = true;
    mocks.rows = [];
    mocks.orphans = [
      {
        id: 'pubreq_flag2',
        slug: 'flagged2',
        version: '0.1.0',
        status: 'pending',
        submittedAt: '2026-07-07T00:00:00Z',
        reviewedAt: null,
        rejectionReason: null,
        approvalNotes: null,
        canWithdraw: true,
      },
    ];
    renderWithProviders(<MyAppsBody />);
    await expect
      .element(page.getByTestId('apps-mine-orphaned-withdraw-pubreq_flag2'))
      .toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * 🔴 A failed read must SAY so — never render as an empty set
 * ------------------------------------------------------------------ */

describe('🔴 neither read can fail silently on the surface this population has', () => {
  const anOrphan: OrphanedSubmissionRow = {
    id: 'pubreq_survivor',
    slug: 'survivor',
    version: '0.1.0',
    status: 'rejected',
    submittedAt: '2026-07-07T00:00:00Z',
    reviewedAt: null,
    rejectionReason: 'needs a smaller bundle',
    approvalNotes: null,
    canWithdraw: false,
  };

  /**
   * 🔴 A `listMine` FAILURE USED TO RETURN EARLY, blanking the orphan group with it. That
   * group is by construction the ONLY place a rejected first submission is reachable, so
   * swallowing it is the original §1 defect arriving by a different route — an invisible
   * population, this time caused by an unrelated query.
   */
  test('🔴 a failed listMine still renders the orphan group, alongside its error', async () => {
    renderWithProviders(
      <MyAppsBodyView rows={[]} errorMessage="listMine blew up" orphanedSubmissions={[anOrphan]} />
    );
    await expect.element(page.getByTestId('apps-mine-error')).toBeInTheDocument();
    // …and the group survives it.
    await expect
      .element(page.getByTestId('apps-mine-orphaned-row-pubreq_survivor'))
      .toBeInTheDocument();
    await expect
      .element(page.getByTestId('apps-mine-orphaned-notes-pubreq_survivor'))
      .toHaveTextContent(/smaller bundle/i);
  });

  test('a failed listMine with nothing else still shows the error alone', async () => {
    renderWithProviders(<MyAppsBodyView rows={[]} errorMessage="listMine blew up" />);
    await expect.element(page.getByTestId('apps-mine-error')).toBeInTheDocument();
    expect(page.getByTestId('apps-mine-orphaned').elements()).toHaveLength(0);
  });

  /**
   * 🔴 `orphansQuery.error` WAS READ NOWHERE. A failing read rendered nothing and reported
   * nothing, which is indistinguishable from "you have no rejected submissions" — the
   * exact lie this group exists to stop telling. A reassuring zero is not evidence.
   */
  test('🔴 a failed orphan read reports itself instead of rendering as "none"', async () => {
    renderWithProviders(
      <MyAppsBodyView rows={[row({ appListingId: 'apl_live' })]} orphanedError="orphans blew up" />
    );
    await expect.element(page.getByTestId('apps-mine-orphaned-error')).toBeInTheDocument();
    // The rows that DID resolve are still shown — one failure does not blank the page.
    await expect.element(page.getByTestId('apps-mine-row-apl_live')).toBeInTheDocument();
  });

  /**
   * 🔴 AND IT MUST NOT BE DRESSED UP AS AN EMPTY ACCOUNT. "You don't own any apps yet" over
   * the top of a broken read is a confident, wrong answer.
   */
  test('🔴 a broken orphan read never renders the "no apps yet" empty state', async () => {
    renderWithProviders(<MyAppsBodyView rows={[]} orphanedError="orphans blew up" />);
    await expect.element(page.getByTestId('apps-mine-orphaned-error')).toBeInTheDocument();
    expect(page.getByTestId('apps-mine-empty').elements()).toHaveLength(0);
  });

  test('a genuinely empty account still says so (the control arm)', async () => {
    renderWithProviders(<MyAppsBodyView rows={[]} />);
    await expect.element(page.getByTestId('apps-mine-empty')).toBeInTheDocument();
    expect(page.getByTestId('apps-mine-orphaned-error').elements()).toHaveLength(0);
  });
});

describe('MyAppsBody (container) — the orphan query’s error reaches the view', () => {
  test('🔴 a failing listMyOrphanedSubmissions surfaces its message', async () => {
    mocks.rows = [row({ appListingId: 'apl_c9' })];
    mocks.orphansError = 'orphan read refused';
    renderWithProviders(<MyAppsBody />);
    await expect
      .element(page.getByTestId('apps-mine-orphaned-error'))
      .toHaveTextContent(/orphan read refused/i);
  });
});

/* ------------------------------------------------------------------ *
 * 🔴 The guards themselves must not become silent-zero paths
 * ------------------------------------------------------------------ */

describe('🔴 a pending or failed orphan read is never dressed up as "none"', () => {
  const anOrphan: OrphanedSubmissionRow = {
    id: 'pubreq_f2',
    slug: 'in-flight',
    version: '0.3.0',
    status: 'withdrawn',
    submittedAt: '2026-07-09T00:00:00Z',
    reviewedAt: null,
    rejectionReason: null,
    approvalNotes: null,
    canWithdraw: false,
  };

  /**
   * 🔴 F1 — BOTH READS FAILED, ZERO ORPHAN ROWS. The early return keyed on orphan DATA
   * length alone, so this shape rendered only the `listMine` alert and the orphan failure
   * reported nothing, permanently. Zero rows is not the same fact as "the read succeeded
   * and found none" — the silent-zero lesson applied to the guard that was written for it.
   */
  test('🔴 both reads failing reports BOTH failures, not just listMine', async () => {
    renderWithProviders(
      <MyAppsBodyView rows={[]} errorMessage="listMine blew up" orphanedError="orphans blew up" />
    );
    await expect.element(page.getByTestId('apps-mine-error')).toBeInTheDocument();
    await expect
      .element(page.getByTestId('apps-mine-orphaned-error'))
      .toHaveTextContent(/orphans blew up/i);
  });

  /**
   * 🔴 F2 — `rowsQuery` RESOLVED EMPTY WHILE THE ORPHAN READ IS STILL STREAMING. The two
   * procedures batch into one request under `httpBatchStreamLink` but stream back
   * independently, so this interleaving is ordinary rather than exotic. Without the
   * loading term the page asserts "you don't own any apps yet" over a pending read.
   */
  test('🔴 an in-flight orphan read never renders the "no apps yet" empty state', async () => {
    renderWithProviders(<MyAppsBodyView rows={[]} orphanedLoading />);
    await expect.element(page.getByTestId('apps-mine-list')).toBeInTheDocument();
    expect(page.getByTestId('apps-mine-empty').elements()).toHaveLength(0);
  });

  test('…and once it resolves genuinely empty, the empty state DOES appear (control arm)', async () => {
    renderWithProviders(<MyAppsBodyView rows={[]} orphanedLoading={false} />);
    await expect.element(page.getByTestId('apps-mine-empty')).toBeInTheDocument();
  });

  /**
   * 🔴 THE `isLoading && orphanedSubmissions.length === 0` GUARD'S OWN CASE. Reverting it
   * to a plain `isLoading` survived the previous battery — it was uncovered. Its real
   * effect is not about errors at all: once orphans resolve while rows are still loading,
   * falling through renders the group instead of a spinner over data that already arrived.
   */
  test('🔴 resolved orphans render while rows are STILL loading, rather than a bare spinner', async () => {
    renderWithProviders(<MyAppsBodyView rows={[]} isLoading orphanedSubmissions={[anOrphan]} />);
    await expect.element(page.getByTestId('apps-mine-orphaned-row-pubreq_f2')).toBeInTheDocument();
  });

  test('with nothing resolved yet, the loader is still what renders', async () => {
    renderWithProviders(<MyAppsBodyView rows={[]} isLoading />);
    // No list, no empty state — the page is honestly still working.
    expect(page.getByTestId('apps-mine-list').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-mine-empty').elements()).toHaveLength(0);
  });
});

describe('MyAppsBody (container) — the orphan query’s LOADING state reaches the view', () => {
  test('🔴 an in-flight orphan read suppresses the empty state end-to-end', async () => {
    mocks.rows = [];
    mocks.orphansLoading = true;
    renderWithProviders(<MyAppsBody />);
    await expect.element(page.getByTestId('apps-mine-list')).toBeInTheDocument();
    expect(page.getByTestId('apps-mine-empty').elements()).toHaveLength(0);
  });

  test('…and a resolved-empty one does not (control arm)', async () => {
    mocks.rows = [];
    mocks.orphansLoading = false;
    renderWithProviders(<MyAppsBody />);
    await expect.element(page.getByTestId('apps-mine-empty')).toBeInTheDocument();
  });
});
