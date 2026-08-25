import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';

// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { LOADABLE_IMAGE_DATA_URI, renderWithProviders } from '../../../test/component-setup';
import type * as MantineHooks from '@mantine/hooks';
import type { MyAppRow } from '~/components/Apps/myAppsView';
import type { OrphanedSubmissionRow } from './MyAppsBody';
import type * as TrpcModule from '~/utils/trpc';
import { capabilitiesForKind } from '~/shared/constants/app-capabilities.constants';

/**
 * `/apps/mine` — the ONE merged author table.
 *
 * 🔴 SCOPE, STATED HONESTLY BECAUSE THE MOCKS ARE HEAVY. What these tests exercise for
 * real: the active/inactive partition, the collapse's a11y state + count + pagination
 * boundary, the placeholder-vs-image branch, the link-vs-no-link ROLE×STATUS gate and the
 * per-row href derivation. The nested history panel and the owner takedown pair have MOVED
 * to the authoring page and are covered by `ListingHistoryPanel.browser.test.tsx` and
 * `ListingPublishingPanel.browser.test.tsx`; nothing about them is asserted here any more,
 * which is why this file no longer mounts a history query at all.
 * What is mock-shadowed: the data layer entirely, and every visual
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

const { MyAppsBody, MyAppsBodyView } = await import('./MyAppsBody');

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

  test('ON-SITE and OFF-SITE render in the SAME table', async () => {
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
    await expect.element(page.getByTestId('apps-mine-row-apl_on')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-mine-row-apl_off')).toBeInTheDocument();
    // ONE table, not two sections: both rows are inside it.
    expect(table.element().querySelectorAll('[data-testid^="apps-mine-row-"]')).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ *
 * The kind badge is GONE — pinned as an absence
 * ------------------------------------------------------------------ */

/**
 * 🔴 THE KIND IS NOT SHOWN ON `/apps/mine` AT ALL, AND THIS PINS THE ABSENCE.
 *
 * The row used to carry a kind badge (`apps-mine-kind-<id>`) reading "On-site" /
 * "External" — the second of those a RETIRED wording that survived the whole #4247
 * sweep, because `myAppsView` shipped a shadowing `listingKindLabel` whose name
 * collided with the canonical one. The badge is deleted: the author already knows what
 * they built, and the kind still renders on the listing detail and edit pages, which
 * are where the question gets asked.
 *
 * 🔴 AN ABSENCE NEEDS A TEST MORE THAN A PRESENCE DOES, not less. "Restore the kind
 * badge, it's useful" is a one-line, entirely reasonable-looking change, and nothing
 * else in this suite would go red for it — the enrolment ledger cannot see it either,
 * because a restored badge composing from `listingKindLabels` would spell the CORRECT
 * word. So the decision is asserted here, where it is visible as a decision.
 */
describe('🔴 no row shape renders a kind badge', () => {
  /**
   * Every dimension the deleted badge branched on, plus the two layouts. The old badge
   * read `row.kind` for its text AND its colour, so a partial restore (one layout, one
   * kind) has to fail too — a single-fixture version of this test would miss exactly
   * that.
   */
  for (const compact of [false, true]) {
    test(`neither kind, in the ${compact ? 'card' : 'table'} layout`, async () => {
      const rows = [
        row({ appListingId: 'apl_k_on', kind: 'onsite', status: 'approved' }),
        row({ appListingId: 'apl_k_off', kind: 'offsite', status: 'pending' }),
        row({ appListingId: 'apl_k_draft', kind: 'onsite', status: 'draft', role: 'editor' }),
      ];
      renderWithProviders(<MyAppsBodyView rows={rows} compact={compact} />);
      // POSITIVE CONTROL: the rows really did render, so the zeros below are a fact
      // about the badge and not about an empty page. Without this, deleting the whole
      // table would satisfy every assertion in this test.
      for (const r of rows) {
        await expect
          .element(page.getByTestId(`apps-mine-row-${r.appListingId}`))
          .toBeInTheDocument();
        // …and the badges that DID survive are still there, so "no kind badge" is not
        // being satisfied by "no badges at all".
        await expect
          .element(page.getByTestId(`apps-mine-status-${r.appListingId}`))
          .toBeInTheDocument();
        await expect
          .element(page.getByTestId(`apps-mine-role-${r.appListingId}`))
          .toBeInTheDocument();
        expect(
          page.getByTestId(`apps-mine-kind-${r.appListingId}`).elements(),
          `${r.appListingId} rendered a kind badge — see "no row shape renders a kind badge"`
        ).toHaveLength(0);
      }
      // 🔴 AND THE TESTID NAMESPACE IS EMPTY, not just the three ids above. A restored
      // badge under a NEW id would walk the per-row check; the prefix query cannot be
      // walked that way as long as it keeps the name.
      expect(document.querySelectorAll('[data-testid^="apps-mine-kind-"]')).toHaveLength(0);
      // The retired word itself is absent from the rendered page, in either case. This
      // is the behavioural half of the enrolment ledger's structural claim.
      expect(document.body.textContent).not.toMatch(/\bExternal\b/);
      expect(document.body.textContent).not.toMatch(/on-site/i);
    });
  }
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
  test('🔴 a WITHDRAWN submission on an APPROVED app keeps the app ACTIVE', async () => {
    renderWithProviders(
      <MyAppsBodyView
        rows={[row({ appListingId: 'apl_live', status: 'approved', kind: 'offsite' })]}
      />
    );
    // ACTIVE — in the main table, and NOT in the inactive namespace.
    await expect.element(page.getByTestId('apps-mine-row-apl_live')).toBeInTheDocument();
    expect(page.getByTestId('apps-mine-inactive-row-apl_live').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-mine-inactive-toggle').elements()).toHaveLength(0);
    // 🔴 THE OTHER HALF OF THIS CASE MOVED, IT WAS NOT DROPPED. That the withdrawn REQUEST
    // is still visible as history is now asserted in `ListingHistoryPanel.browser.test.tsx`
    // ("a withdrawn request on a live app is still in the stream"), because the stream is
    // no longer on this row.
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
 * The images open the viewer
 * ------------------------------------------------------------------ */

/**
 * A media URL that RESOLVES and is DIFFERENT per call — the same technique
 * `AppListingDetailBody.viewer.browser.test.tsx` uses, and both halves matter here.
 *
 * DISTINCT, because the whole claim is "the image you clicked is the one that opens":
 * a shared fixture URL makes opening the WRONG image indistinguishable from opening the
 * right one, which is the only way this feature can be broken without looking broken.
 *
 * LOADABLE (a `data:` URI, not http), because an unloadable http source fires a real
 * `error` ~11 ms after mount and the viewer's own rescue effect would then navigate off
 * it — so a green would be measuring the race, not the wiring
 * (`local-rules/no-unloadable-image-fixture`).
 */
const okMedia = (tag: string) =>
  `data:image/svg+xml;base64,${btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" data-tag="${tag}"/>`
  )}`;

/** The viewer's dialog, read from the DOCUMENT — Mantine portals it out of the tree. */
const mediaViewer = () =>
  (document
    .querySelector('[data-testid="apps-listing-screenshot-viewer"]')
    ?.closest('[role="dialog"]') as HTMLElement | null) ?? null;

const mediaViewerImage = () =>
  document.querySelector<HTMLImageElement>('[data-testid="apps-listing-screenshot-viewer-image"]');

const mediaViewerPosition = () =>
  document
    .querySelector('[data-testid="apps-listing-screenshot-position"]')
    ?.textContent?.replace(/\s+/g, ' ')
    .trim() ?? null;

/** Wait until the viewer is showing exactly `url`. */
async function expectViewerShowing(url: string, why: string) {
  await vi.waitFor(() => {
    const img = mediaViewerImage();
    expect(img, `no viewer image — ${why}`).not.toBeNull();
    expect(img!.getAttribute('src'), why).toBe(url);
  });
}

describe('🔴 the row images open the shared listing image viewer', () => {
  const COVER = okMedia('cover');
  const ICON = okMedia('icon');

  /**
   * 🔴 THE HEADLINE, AND THE REASON THE INDEX IS COMPUTED RATHER THAN ASSUMED: clicking
   * the ICON must open the ICON, not the first entry in the list. Cover is entry 0, so
   * an "always open index 0" implementation renders a perfectly healthy modal showing
   * the wrong picture — and with a shared fixture URL it would look correct.
   */
  test('clicking the ICON opens the viewer on the icon', async () => {
    renderWithProviders(
      <MyAppsBodyView
        rows={[row({ appListingId: 'apl_v1', status: 'approved', iconUrl: ICON, coverUrl: COVER })]}
      />
    );
    const btn = page.getByRole('button', { name: 'View icon image for Name apl_v1' });
    await expect.element(btn).toBeInTheDocument();
    // Nothing is open before the click — so the assertions after it are about the click.
    expect(mediaViewer()).toBeNull();
    await userEvent.click(btn.element());
    await expectViewerShowing(ICON, 'the icon button must open the ICON');
    // 🔴 SEEDED WITH BOTH IMAGES, so prev/next works instead of being a dead end. The
    // position indicator counts what navigation can actually reach.
    expect(mediaViewerPosition()).toBe('2 / 2');
  });

  test('clicking the COVER opens the viewer on the cover', async () => {
    renderWithProviders(
      <MyAppsBodyView
        rows={[row({ appListingId: 'apl_v2', status: 'approved', iconUrl: ICON, coverUrl: COVER })]}
      />
    );
    // 🔴 AWAIT THE ELEMENT BEFORE CLICKING. `renderWithProviders` commits
    // asynchronously in browser mode, so a synchronous `.element()` here races the
    // mount and reports "Cannot find element" against an empty <body>.
    const btn2 = page.getByRole('button', { name: 'View cover image for Name apl_v2' });
    await expect.element(btn2).toBeInTheDocument();
    await userEvent.click(btn2.element());
    await expectViewerShowing(COVER, 'the cover button must open the COVER');
    expect(mediaViewerPosition()).toBe('1 / 2');
  });

  /**
   * 🔴 THE POINT OF SEEDING BOTH IMAGES INTO ONE LIST. Two isolated single-image modals
   * would render with both arrows permanently disabled and a `1 / 1` counter — which
   * looks fine and is the whole regression. Navigating from the cover must land on the
   * icon of the SAME row.
   */
  test('🔴 prev/next moves between the row’s two images', async () => {
    renderWithProviders(
      <MyAppsBodyView
        rows={[
          row({ appListingId: 'apl_v3', status: 'approved', iconUrl: ICON, coverUrl: COVER }),
          // A second row with its OWN media, so a mutant that pools every row's images
          // into one list produces a 4-entry viewer and fails the counter below.
          //
          // 🔴 ITS NAME IS NOT A PREFIX-EXTENSION OF THE FIRST ROW'S. `getByRole`'s
          // `name` is a SUBSTRING match by default, so an id like `apl_v3b` makes
          // "…for Name apl_v3" resolve to BOTH buttons and the query dies on a strict-
          // mode violation — which reads exactly like the control being missing.
          row({
            appListingId: 'apl_other',
            status: 'pending',
            kind: 'offsite',
            iconUrl: okMedia('icon-other'),
            coverUrl: okMedia('cover-other'),
          }),
        ]}
      />
    );
    const btn3 = page.getByRole('button', { name: 'View cover image for Name apl_v3' });
    await expect.element(btn3).toBeInTheDocument();
    await userEvent.click(btn3.element());
    await expectViewerShowing(COVER, 'opened on the cover');
    expect(mediaViewerPosition()).toBe('1 / 2');
    const nextBtn = page.getByRole('button', { name: 'Next screenshot' });
    await expect.element(nextBtn).toBeInTheDocument();
    await userEvent.click(nextBtn.element());
    await expectViewerShowing(ICON, 'next from the cover is THIS row’s icon');
    expect(mediaViewerPosition()).toBe('2 / 2');
    const prevBtn = page.getByRole('button', { name: 'Previous screenshot' });
    await expect.element(prevBtn).toBeInTheDocument();
    await userEvent.click(prevBtn.element());
    await expectViewerShowing(COVER, 'prev goes back to the cover');
  });

  /**
   * 🔴 A ROW WITH ONE IMAGE SEEDS ONE ENTRY, AND THE INDEX SHIFTS. With no cover, the
   * icon is entry 0 — an implementation that hardcoded "icon = index 1" would open a
   * viewer on an index that does not exist, and the rescue effect would silently close
   * it. That failure reads as "the click did nothing".
   */
  test('a row with only an icon opens a ONE-entry viewer on that icon', async () => {
    renderWithProviders(
      <MyAppsBodyView
        rows={[row({ appListingId: 'apl_v4', status: 'approved', iconUrl: ICON, coverUrl: null })]}
      />
    );
    const btn4 = page.getByRole('button', { name: 'View icon image for Name apl_v4' });
    await expect.element(btn4).toBeInTheDocument();
    await userEvent.click(btn4.element());
    await expectViewerShowing(ICON, 'the only image is the icon');
    expect(mediaViewerPosition()).toBe('1 / 1');
  });

  /**
   * 🔴 PLACEHOLDERS ARE NOT CLICKABLE — there is nothing to view. A focusable control
   * that opens an empty modal is worse than none, and this table's rows are mostly
   * incomplete listings (measured: all 11 `removed` listings have a null cover), so a
   * placeholder button would add a dead tab stop to nearly every row.
   *
   * 🔴 LABELLED AN **INVARIANT GUARD**, NOT REGRESSION COVERAGE, and the distinction is
   * measured rather than assumed: run against `origin/main` this test PASSES, because
   * at base nothing on the row was clickable at all. It pins an invariant the bug never
   * violated. Every OTHER test in this describe is red at base and green here; this one
   * is not, and counting it as regression coverage would overstate what was proved.
   * It still earns its place — it is the only thing standing between a future
   * "simplify the two branches into one wrapper" refactor and a dead tab stop on every
   * incomplete row — but it is a guard, not evidence.
   */
  test('INVARIANT GUARD: neither placeholder is a button, focusable, or clickable', async () => {
    renderWithProviders(
      <MyAppsBodyView
        rows={[row({ appListingId: 'apl_v5', status: 'pending', iconUrl: null, coverUrl: null })]}
      />
    );
    const iconPh = page.getByTestId('apps-mine-icon-placeholder-apl_v5');
    await expect.element(iconPh).toBeInTheDocument();
    const coverPh = page.getByTestId('apps-mine-cover-placeholder-apl_v5');
    await expect.element(coverPh).toBeInTheDocument();

    for (const [label, el] of [
      ['icon', iconPh.element()],
      ['cover', coverPh.element()],
    ] as const) {
      // Not a button, and not inside one — a wrapper button is the shape that would
      // sneak past a tagName check on the placeholder itself.
      expect(el.tagName, `${label} placeholder is a <${el.tagName.toLowerCase()}>`).toBe('DIV');
      expect(el.closest('button'), `${label} placeholder is wrapped in a button`).toBeNull();
      // Not keyboard-reachable, and offering no pointer affordance.
      expect(el.getAttribute('tabindex'), `${label} placeholder is focusable`).toBeNull();
      expect((el as HTMLElement).style.cursor, `${label} placeholder shows a cursor`).toBe('');
    }

    // 🔴 NEGATIVE CONTROL FOR THE WHOLE `getByRole` FAMILY ABOVE: no view-image button
    // exists for this row at all, under EITHER name. Without this, the assertions above
    // would be satisfied by a placeholder that is inert while some other element opened
    // the viewer.
    expect(
      page.getByRole('button', { name: /^View (icon|cover) image for/ }).elements()
    ).toHaveLength(0);
    expect(mediaViewer()).toBeNull();
  });

  /**
   * 🔴 THE HALF-EMPTY ROW, which is the common production shape rather than an edge
   * case. The present image must still be clickable and the absent one must still be
   * inert — an implementation that gates the buttons on "the row has media" rather than
   * "THIS image exists" passes the both-present and both-absent tests and fails here.
   */
  test('🔴 a row with a cover and NO icon: cover clickable, icon inert', async () => {
    renderWithProviders(
      <MyAppsBodyView
        rows={[row({ appListingId: 'apl_v6', status: 'approved', iconUrl: null, coverUrl: COVER })]}
      />
    );
    await expect.element(page.getByTestId('apps-mine-icon-placeholder-apl_v6')).toBeInTheDocument();
    expect(
      page.getByRole('button', { name: 'View icon image for Name apl_v6' }).elements()
    ).toHaveLength(0);
    const btn6 = page.getByRole('button', { name: 'View cover image for Name apl_v6' });
    await expect.element(btn6).toBeInTheDocument();
    await userEvent.click(btn6.element());
    await expectViewerShowing(COVER, 'the cover is still clickable with no icon');
    expect(mediaViewerPosition()).toBe('1 / 1');
  });

  /**
   * 🔴 THE ACCESSIBLE NAME NAMES THE APP, not just "image". Two rows both offering a
   * button called "View cover image" is a screen-reader dead end, and it is also what
   * makes every `getByRole` query in this file able to address ONE row.
   */
  test('🔴 the button names disambiguate BETWEEN rows', async () => {
    renderWithProviders(
      <MyAppsBodyView
        rows={[
          row({ appListingId: 'apl_v7a', name: 'Aardvark', status: 'approved', coverUrl: COVER }),
          row({
            appListingId: 'apl_v7b',
            name: 'Basilisk',
            status: 'pending',
            kind: 'offsite',
            coverUrl: okMedia('cover-b'),
          }),
        ]}
      />
    );
    await expect
      .element(page.getByRole('button', { name: 'View cover image for Aardvark' }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole('button', { name: 'View cover image for Basilisk' }))
      .toBeInTheDocument();
    // Each name addresses exactly ONE control.
    expect(
      page.getByRole('button', { name: 'View cover image for Aardvark' }).elements()
    ).toHaveLength(1);
  });

  /**
   * 🔴 KEYBOARD-OPERABLE, which is the property `UnstyledButton` buys and an
   * `<img onClick>` does not. A mouse-only affordance that LOOKS wired up is exactly
   * what the screenshot gallery's own wiring gate exists to prevent.
   */
  test('🔴 the control opens on Enter, not only on click', async () => {
    renderWithProviders(
      <MyAppsBodyView
        rows={[row({ appListingId: 'apl_v8', status: 'approved', coverUrl: COVER })]}
      />
    );
    const btn = page.getByRole('button', { name: 'View cover image for Name apl_v8' });
    await expect.element(btn).toBeInTheDocument();
    const el = btn.element() as HTMLElement;
    el.focus();
    expect(document.activeElement, 'the control is not focusable').toBe(el);
    await userEvent.keyboard('{Enter}');
    await expectViewerShowing(COVER, 'Enter must activate the control');
  });

  test('the viewer closes again', async () => {
    renderWithProviders(
      <MyAppsBodyView
        rows={[row({ appListingId: 'apl_v9', status: 'approved', coverUrl: COVER })]}
      />
    );
    const btn9 = page.getByRole('button', { name: 'View cover image for Name apl_v9' });
    await expect.element(btn9).toBeInTheDocument();
    await userEvent.click(btn9.element());
    await expectViewerShowing(COVER, 'opened');
    const closeBtn = page.getByRole('button', { name: 'Close screenshot viewer' });
    await expect.element(closeBtn).toBeInTheDocument();
    await userEvent.click(closeBtn.element());
    await vi.waitFor(() => expect(mediaViewer()).toBeNull());
  });
});

/* ------------------------------------------------------------------ *
 * Per-row capability / href gating
 * ------------------------------------------------------------------ */

describe('🔴 per-row gating survives the merge, and now reads ROLE as well as STATUS', () => {
  /**
   * The edit affordance is the NAME LINK, and it is withheld exactly when
   * `getAppListingAuthoringContext` would refuse the caller.
   *
   * 🔴 THE RULE INVERTED FOR A REMOVED/REJECTED APP, and that inversion is this PR. Those
   * rows used to be dimmed text because the authoring route refused any non-authorable
   * status. The route now opens on them in a NARROWED mode — at most Publishing + History,
   * never Collaborators — and this PR moved BOTH the History disclosure and the
   * Unpublish/Republish pair off this row and onto that page. So an unlinked removed row
   * would now strand whoever is looking at it with no route to either.
   *
   * 🔴 IT DOES NOT READ `role`, AND AN EARLIER DRAFT DID — on a false premise. That draft
   * withheld the link from a seated EDITOR on a removed listing, and the test name said
   * "the page would refuse them". It does not: `resolveListingAccess` returns `role:'editor'`
   * for any accepted seat regardless of the listing's status, so the authoring context is
   * served and `editorTabsFor` hands that editor `['history']`. The clause was therefore not
   * a mirror of a server gate but an unannounced REGRESSION — the pre-PR row rendered its
   * History toggle unconditionally, so an editor could already open a removed app's history
   * here. The case below is that one, corrected and inverted.
   */
  test('🔴 a REMOVED row DOES link for its owner — and lands on Publishing, not Details', async () => {
    renderWithProviders(
      <MyAppsBodyView rows={[row({ appListingId: 'apl_rm', status: 'removed', role: 'owner' })]} />
    );
    // 🔴 AWAIT THE ELEMENT BEFORE CLICKING. `renderWithProviders` commits
    // asynchronously in browser mode, so a synchronous `.element()` here races the
    // mount and reports "Cannot find element" against an empty <body>.
    await expect.element(page.getByTestId('apps-mine-inactive-toggle')).toBeInTheDocument();
    await userEvent.click(page.getByTestId('apps-mine-inactive-toggle').element());
    const a = page.getByTestId('apps-mine-link-apl_rm');
    await expect.element(a).toBeInTheDocument();
    // 🔴 THE TAB IS THE ASSERTION, not merely that a link exists. `?tab=details` here would
    // mean the href was built from a set that still contains Details on a removed listing —
    // i.e. the security branch in `editorTabsFor` had been lost — and the destination would
    // silently rewrite it, hiding the regression.
    expect(a.element().getAttribute('href')).toBe('/apps/listing/apl_rm/edit?tab=publishing');
    expect(page.getByTestId('apps-mine-unlinked-apl_rm').elements()).toHaveLength(0);
  });

  test('🔴 a REJECTED row links its owner to HISTORY — a FAIL-SAFE branch, not a live cohort', async () => {
    renderWithProviders(
      <MyAppsBodyView
        rows={[row({ appListingId: 'apl_rj', status: 'rejected', kind: 'offsite', role: 'owner' })]}
      />
    );
    await expect.element(page.getByTestId('apps-mine-inactive-toggle')).toBeInTheDocument();
    await userEvent.click(page.getByTestId('apps-mine-inactive-toggle').element());
    const a = page.getByTestId('apps-mine-link-apl_rj');
    await expect.element(a).toBeInTheDocument();
    // 🔴 NOT `publishing`: a rejected listing never reached the store, so there is no
    // control to offer and `editorTabsFor` withholds that tab too. A different first tab
    // from the removed case above, so a mutant that hardcodes either literal fails once.
    //
    // 🔴 SCOPE OF THIS CASE, STATED SO IT IS NOT MIS-CITED: nothing writes
    // `AppListing.status = 'rejected'` today — an on-site reject deletes the draft listing,
    // an off-site reject writes `removed`. This pins a FAIL-SAFE for a value the DB CHECK
    // permits and legacy rows may carry. It is not evidence that a live cohort was rescued;
    // rejected first versions are served by the orphan group, which this PR left alone.
    expect(a.element().getAttribute('href')).toBe('/apps/listing/apl_rj/edit?tab=history');
  });

  test('🔴 a seated EDITOR on a REMOVED row DOES link — to History, which the page serves them', async () => {
    renderWithProviders(
      <MyAppsBodyView
        rows={[row({ appListingId: 'apl_seat_rm', status: 'removed', role: 'editor' })]}
      />
    );
    await expect.element(page.getByTestId('apps-mine-inactive-toggle')).toBeInTheDocument();
    await userEvent.click(page.getByTestId('apps-mine-inactive-toggle').element());
    const a = page.getByTestId('apps-mine-link-apl_seat_rm');
    await expect.element(a).toBeInTheDocument();
    // 🔴 `?tab=history`, NOT `?tab=publishing`. Same status as `apl_rm` above, different
    // role: the link exists for both, and what `role` narrows is the TAB, not the link. A
    // regression that re-added a role clause to the link predicate turns this red; a
    // regression that offered an editor Publishing turns it red on the tab instead.
    expect(a.element().getAttribute('href')).toBe('/apps/listing/apl_seat_rm/edit?tab=history');
    expect(page.getByTestId('apps-mine-unlinked-apl_seat_rm').elements()).toHaveLength(0);
  });

  test('🔴 an UNKNOWN status is the ONLY shape left unlinked — fail closed', async () => {
    // The negative arm the role clause used to supply. Without a case here the link
    // predicate would have no `false` at all, and "everything links" is satisfied by
    // deleting the predicate entirely. `quarantined` is not a prefix or suffix of any real
    // status, and it is NOT one of the two the Inactive collapse owns, so it renders in the
    // main table — no disclosure click, which keeps this case free of that dependency.
    renderWithProviders(
      <MyAppsBodyView rows={[row({ appListingId: 'apl_unknown_v9', status: 'quarantined' })]} />
    );
    await expect.element(page.getByTestId('apps-mine-unlinked-apl_unknown_v9')).toBeInTheDocument();
    expect(page.getByTestId('apps-mine-link-apl_unknown_v9').elements()).toHaveLength(0);
  });

  test('a seated EDITOR on an APPROVED row DOES link — the control arm for the role clause', async () => {
    renderWithProviders(
      <MyAppsBodyView
        rows={[row({ appListingId: 'apl_seat_ok', status: 'approved', role: 'editor' })]}
      />
    );
    const a = page.getByTestId('apps-mine-link-apl_seat_ok');
    await expect.element(a).toBeInTheDocument();
    // 🔴 AND NO `publishing` TAB IN THE HREF. Both takedown procs are owner-scoped, so an
    // editor is never offered the tab — `?tab=details` is the proof that `role` narrows the
    // set rather than merely reordering it.
    expect(a.element().getAttribute('href')).toBe('/apps/listing/apl_seat_ok/edit?tab=details');
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

  /**
   * 🔴 THE RULE THIS TEST PINS CHANGED, SO THE TEST WAS REWRITTEN — NOT DELETED.
   *
   * It used to assert only "the group is NOT hidden behind the Inactive collapse",
   * which was the whole rule when the group was unconditionally visible. The group is
   * now its OWN collapse that opens itself when it holds something actionable. Both
   * halves of the new rule are asserted here, and the first half is unchanged: this is
   * still not nested under Inactive.
   */
  test('🔴 NOT inside the Inactive collapse, and OPEN without interaction when actionable', async () => {
    renderWithProviders(
      <MyAppsBodyView
        // An INACTIVE row, so the Inactive collapse actually exists to be nested in —
        // with no inactive rows there is no panel and the structural half would pass
        // vacuously.
        rows={[row({ appListingId: 'apl_rem', status: 'removed' })]}
        orphanedSubmissions={[
          orphan({ id: 'pubreq_x', rejectionReason: 'manifest declares an unused scope' }),
        ]}
      />
    );
    const group = page.getByTestId('apps-mine-orphaned');
    await expect.element(group).toBeInTheDocument();

    // 🔴 STRUCTURAL: the group is not a descendant of the Inactive panel. Asserted as
    // containment rather than as "it is visible", because the Inactive collapse keeps
    // its children mounted while closed — so a nested group would still be findable.
    const inactivePanel = page.getByTestId('apps-mine-inactive-panel').element();
    expect(inactivePanel, 'no Inactive panel to be nested in').not.toBeNull();
    expect(
      inactivePanel.contains(group.element()),
      'the orphan group is nested inside the Inactive collapse'
    ).toBe(false);

    // 🔴 STATE: open on arrival, with NO toggle clicked. Read from `aria-expanded`
    // rather than from the row's presence — Mantine's `Collapse` leaves its children in
    // the DOM when closed, so `toBeInTheDocument` cannot tell open from closed and
    // would pass against a permanently-collapsed group.
    await expect
      .element(page.getByTestId('apps-mine-orphaned-toggle'))
      .toHaveAttribute('aria-expanded', 'true');
    await expect.element(page.getByTestId('apps-mine-orphaned-row-pubreq_x')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-mine-orphaned-count')).toHaveTextContent('1');
  });

  /**
   * 🔴 THE PENDING+WITHDRAWABLE HALF of the auto-open rule — the OTHER shape, because a
   * mutant that only checks `rejectionReason` passes the test above.
   */
  test('a PENDING withdrawable orphan also opens the group on arrival', async () => {
    renderWithProviders(
      <MyAppsBodyView
        rows={[]}
        orphanedSubmissions={[orphan({ id: 'pubreq_open2', status: 'pending', canWithdraw: true })]}
        onWithdrawOrphan={() => undefined}
      />
    );
    await expect
      .element(page.getByTestId('apps-mine-orphaned-toggle'))
      .toHaveAttribute('aria-expanded', 'true');
  });

  /**
   * 🔴 THE CLOSED CASE, and it is the one that makes the whole feature more than a
   * no-op. Settled history collapses — and the COUNT BADGE STAYS ON THE HEADER, because
   * a closed group with no count is an unlabelled box, indistinguishable from the rows
   * being gone. That is the exact impression this section exists to stop giving.
   */
  test('🔴 nothing actionable → CLOSED, but the count is still on the header', async () => {
    renderWithProviders(
      <MyAppsBodyView
        rows={[]}
        orphanedSubmissions={[
          orphan({ id: 'pubreq_hist1', status: 'withdrawn' }),
          orphan({ id: 'pubreq_hist2', status: 'approved' }),
          // A rejection with NO reason attached: settled, and nothing to act on.
          orphan({ id: 'pubreq_hist3', status: 'rejected', rejectionReason: null }),
        ]}
      />
    );
    await expect.element(page.getByTestId('apps-mine-orphaned')).toBeInTheDocument();
    const toggle = page.getByTestId('apps-mine-orphaned-toggle');
    await expect.element(toggle).toHaveAttribute('aria-expanded', 'false');

    // The signal survives the collapse — and it is COUNTING, not a hardcoded 1.
    const count = page.getByTestId('apps-mine-orphaned-count');
    await expect.element(count).toHaveTextContent('3');

    /**
     * 🔴 THE HALF THIS TEST'S NAME CLAIMS AND `toHaveTextContent` DOES NOT PROVE, found
     * by mutation: moving the badge INSIDE the `Collapse` left this test fully green,
     * because Mantine's `Collapse` keeps its children MOUNTED when closed. So "the
     * count is still there" is true of a badge the user cannot see, and the assertion
     * above reads as coverage while providing none.
     *
     * The checkable claim is CONTAINMENT: the badge is on the toggle (the always-
     * visible header), not in the panel the toggle hides.
     */
    const panel = document.querySelector('[data-testid="apps-mine-orphaned-panel"]');
    expect(panel, 'no collapse panel — the group is not collapsible at all').not.toBeNull();
    expect(
      panel!.contains(count.element()),
      'the count badge is INSIDE the collapse, so a closed group shows no count at all — ' +
        'an unlabelled box, indistinguishable from the rows being gone'
    ).toBe(false);
    expect(
      toggle.element().contains(count.element()),
      'the count badge is not on the toggle header'
    ).toBe(true);
  });

  test('a closed group opens on click, and its rows are reachable', async () => {
    renderWithProviders(
      <MyAppsBodyView
        rows={[]}
        orphanedSubmissions={[orphan({ id: 'pubreq_cl', status: 'withdrawn' })]}
      />
    );
    const toggle = page.getByTestId('apps-mine-orphaned-toggle');
    await expect.element(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle.element());
    await expect.element(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect.element(page.getByTestId('apps-mine-orphaned-row-pubreq_cl')).toBeInTheDocument();
  });

  /**
   * 🔴 `aria-controls` NAMES A REAL ELEMENT ID. A toggle pointing at nothing reports to
   * assistive tech that the panel does not exist — the same rule the row-history toggle
   * and the Inactive toggle already follow, applied to the third disclosure on the page.
   */
  test('the toggle’s aria-controls resolves to the panel it controls', async () => {
    renderWithProviders(
      <MyAppsBodyView rows={[]} orphanedSubmissions={[orphan({ id: 'pubreq_aria' })]} />
    );
    const toggle = page.getByTestId('apps-mine-orphaned-toggle');
    await expect.element(toggle).toBeInTheDocument();
    const id = toggle.element().getAttribute('aria-controls');
    expect(id, 'the toggle controls nothing').toBeTruthy();
    const panel = document.getElementById(id!);
    expect(panel, `aria-controls="${id}" resolves to no element`).not.toBeNull();
    expect(panel!.getAttribute('data-testid')).toBe('apps-mine-orphaned-panel');
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
  /**
   * 🔴 THE ROW SOURCE IS `appListings.listMine`. This is the single most load-bearing
   * property of the consolidation: the trpc mock supplies ONLY `listMine` as a row source,
   * so a container re-derived from `listMySubmissions` / `listMyPublishRequests` would
   * render the empty state here rather than the rows. (Carried over from the container
   * block that held the lazy-history cases, which this PR removed along with the query.)
   */
  test('🔴 rows come from listMine — the ownership∪seat read', async () => {
    mocks.rows = [row({ appListingId: 'apl_from_listmine', role: 'editor', kind: 'offsite' })];
    renderWithProviders(<MyAppsBody />);
    await expect.element(page.getByTestId('apps-mine-row-apl_from_listmine')).toBeInTheDocument();
    expect(page.getByTestId('apps-mine-empty').elements()).toHaveLength(0);
  });

  test('🔴 the container issues NO listingHistory query at all — the panel MOVED', async () => {
    mocks.rows = [row({ appListingId: 'apl_nohist', status: 'approved' })];
    renderWithProviders(<MyAppsBody />);
    await expect.element(page.getByTestId('apps-mine-row-apl_nohist')).toBeInTheDocument();

    // 🔴 THE MOVE, ASSERTED AS A NEGATIVE — and a zero needs its positive control, which is
    // the awaited row above: the page really did mount and really did render this row, so
    // the empty call list is a fact about the container rather than about a render that
    // never happened. On `origin/main` this row's history query is issued (disabled, but
    // issued), so `historyCalls` is length 1 there and this assertion is red.
    expect(mocks.historyCalls).toEqual([]);

    // …and the row's own expand control is gone with it. The stream lives on the authoring
    // page now; a leftover toggle here would be the second home this move exists to avoid.
    expect(page.getByTestId('apps-mine-expand-apl_nohist').elements()).toHaveLength(0);
  });

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
