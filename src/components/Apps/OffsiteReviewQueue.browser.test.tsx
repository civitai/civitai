import { beforeEach, describe, expect, test, vi } from 'vitest';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';
import { page, userEvent } from 'vitest/browser';
import { formatDate } from '~/utils/date-helpers';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { LOADABLE_IMAGE_DATA_URI, renderWithProviders } from '../../../test/component-setup';
import type * as NotificationsModule from '~/utils/notifications';
import type * as TrpcModule from '~/utils/trpc';

/**
 * W13 P3a — /apps/review off-site (external-link) queue. Browser-mode render test
 * (`Component tests` in CI): a pending off-site row renders in the kind-aware queue,
 * and opening it shows the CONTENT-ONLY checklist (https / asset presence, NO code
 * items) + the external URL + Approve/Reject.
 */

const OFFSITE_ROW = {
  id: 'req-1',
  appListingId: 'listing-1',
  slug: 'ci-ext-app',
  status: 'pending',
  submittedAt: new Date('2026-01-01T00:00:00Z'),
  changelog: 'a note for the reviewer',
  appListing: {
    name: 'CI External App',
    externalUrl: 'https://example.com/app',
    category: 'utility',
    contentRating: 'g',
  },
  submittedBy: { id: 42, username: 'author-dev', deletedAt: null, image: null },
};

const DEFAULT_ASSETS = {
  listingId: 'listing-1',
  iconId: 10,
  coverId: 11,
  iconNsfwLevel: 1,
  coverNsfwLevel: 1,
  // Icon/cover PG (1); a screenshot at R (4) → derived rating 'r' > declared 'g'.
  screenshots: [{ imageId: 12, nsfwLevel: 4, scanStatus: 'scanned' as const }],
  iconScanStatus: 'scanned' as const,
  coverScanStatus: 'scanned' as const,
  hasBlockedAsset: false,
  hasPendingScan: false,
};

const mocks = vi.hoisted(() => ({
  invalidate: vi.fn().mockResolvedValue(undefined),
  approveMutate: vi.fn(),
  rejectMutate: vi.fn(),
  // Mutable so a test can inject a blocked / pending scan state (Item 1).
  assetsData: { current: null as unknown },
  assetsError: { current: false },
  // The moderator preview projection; `undefined` = the placeholder-art fallback.
  previewData: { current: undefined as unknown },
}));

// 🔴 `importOriginal` SPREAD, not a wholesale replacement (local-rules/
// no-wholesale-module-mock). A hand-written factory silently breaks the day the
// module graph reaches an export it omits — measured: once the listing detail
// began importing `SmartCreatorCard` (→ ChatUserButton → useChatEnabled), a
// factory listing only `useFeatureFlags` made this whole FILE fail to import with
// `does not provide an export named 'useFeatureFlagsReady'`, reported as 0 tests
// collected rather than as a failure.
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsMod>()),
  useFeatureFlags: () => ({ appBlocks: true }),
}));
// The modal body renders the listing preview (AppListingCard + AppListingDetailBody),
// which reads useCurrentUser — boundary-stub it (null user is fine).
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

// Same reasoning as the `~/utils/trpc` factory below, and the same fix — this one is here
// because it actually fired. #5082 added `showWarningNotification` to
// `HideUserButton/BlockUserButton`, reached from here through
// OffsiteReviewQueue -> AppListingDetailBody -> AppListingComments -> CommentsV2/Comment, and
// the one-key factory failed the WHOLE FILE at the browser's ESM link step: `SyntaxError: The
// requested module '/src/utils/notifications.tsx' does not provide an export named
// 'showWarningNotification'`. #5102
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsModule>()),
  showSuccessNotification: vi.fn(),
  showErrorNotification: vi.fn(),
}));

// Only the `trpc` client itself is overridden — the rest of `~/utils/trpc`'s real exports
// (setTrpcBatchingEnabled, trpcVanilla, queryClient, ...) are kept via importOriginal so any
// transitively-imported consumer elsewhere in the tree (e.g. session/provider chains) still
// gets a real binding instead of the whack-a-mole of hand-naming every export they touch.
// Without the spread, a LATER PR adding an export to `~/utils/trpc` breaks this file's ESM
// link ("does not provide an export named X") and the whole file collects 0 tests.
vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof TrpcModule>();
  return {
    ...actual,
    trpc: {
      useUtils: () => ({
        appListings: {
          listPendingRequests: { invalidate: mocks.invalidate },
          listApprovedRequests: { invalidate: mocks.invalidate },
          listRejectedRequests: { invalidate: mocks.invalidate },
        },
      }),
      appListings: {
        listPendingRequests: {
          useQuery: () => ({
            data: { items: [OFFSITE_ROW], nextCursor: null },
            isLoading: false,
            error: null,
          }),
        },
        getAssets: {
          useQuery: () => ({
            // Icon/cover PG (1); a screenshot at R (4) → derived rating 'r', which is
            // HIGHER than the declared 'g' (mismatch case). Scan state is configurable
            // per test via mocks.assetsData.current.
            data: mocks.assetsData.current,
            isLoading: false,
            isError: mocks.assetsError.current,
            error: null,
          }),
        },
        approveExternalRequest: {
          useMutation: () => ({
            mutate: mocks.approveMutate,
            mutateAsync: vi.fn(),
            isPending: false,
          }),
        },
        rejectExternalRequest: {
          useMutation: () => ({
            mutate: mocks.rejectMutate,
            mutateAsync: vi.fn(),
            isPending: false,
          }),
        },
        // Listing-preview projection — undefined data → the section falls back to the
        // placeholder-art layout preview (these tests assert checklist/scan behaviour).
        getListingPreviewForReview: {
          useQuery: () => ({ data: mocks.previewData.current, isLoading: false, error: null }),
        },
      },
    },
  };
});

const { OffsiteReviewQueue, OffsiteReviewModal } = await import('./OffsiteReviewQueue');
const { buildListingDetailPreview } = await import('./reviewListingPreview');

beforeEach(() => {
  mocks.invalidate.mockClear();
  mocks.approveMutate.mockClear();
  mocks.rejectMutate.mockClear();
  mocks.assetsData.current = { ...DEFAULT_ASSETS };
  mocks.assetsError.current = false;
  mocks.previewData.current = undefined;
});

/**
 * The approve flow when the server reports the split as unreadable (`mediaSplitApproved: null`,
 * the write role cannot read the record). The operator's rule (2026-10-18): approve proceeds with
 * NO split decision, exactly as before the split existed — so no choice is offered and none is
 * sent (an explicit one would be refused). Returns the mutation input.
 *
 * `note` is the WHOLE expected note, pinned literally: the note states what the approve does
 * (rated by all media, an earlier split kept but not applied), so a reword is a claim change.
 */
const UNREADABLE_NOTE =
  'This environment cannot read whether this listing’s media is split between civitai.com and civitai.red. Approving approves the listing with its rating covering all of its media, as before media splits existed. Any split recorded earlier is kept on file but not applied while this environment cannot read it. Split choices are unavailable until the database grant for the media-split record is fixed.';
const UNREADABLE_REVISION_NOTE =
  'This environment cannot read whether this listing’s media is split between civitai.com and civitai.red. Approving this revision keeps the app’s current rating and records no split decision. Any split recorded earlier is kept on file but not applied while this environment cannot read it, so the next time the listing is re-rated its rating is floored by all of its media. Split choices are unavailable until the database grant for the media-split record is fixed.';

async function expectUnreadableApproveSendsNoDecision(note: string) {
  const el = page.getByTestId('apps-media-split-unreadable');
  await expect.element(el).toBeInTheDocument();
  expect((el.element().textContent ?? '').replace(/\s+/g, ' ').trim()).toBe(note);
  expect(page.getByTestId('apps-media-split').elements()).toHaveLength(0);
  expect(page.getByRole('radio', { name: /^Rate by all media/ }).elements()).toHaveLength(0);
  expect(page.getByTestId('apps-media-split-unknown').elements()).toHaveLength(0);
  const confirm = page.getByTestId('apps-offsite-approve-confirm');
  await expect.element(confirm).toBeEnabled();
  await confirm.click();
  expect(mocks.approveMutate).toHaveBeenCalledTimes(1);
  const vars = mocks.approveMutate.mock.calls[0][0];
  expect(vars).toEqual(expect.objectContaining({ publishRequestId: expect.any(String) }));
  expect(vars).not.toHaveProperty('mediaSplit');
  return vars;
}

describe('OffsiteReviewQueue — kind-aware review row', () => {
  test('renders a pending off-site row', async () => {
    renderWithProviders(<OffsiteReviewQueue />);
    await expect.element(page.getByText('ci-ext-app')).toBeInTheDocument();
    await expect.element(page.getByText('External-link submissions')).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Review' })).toBeInTheDocument();
  });

  test('opening a row shows the content-only checklist + external URL + Approve/Reject', async () => {
    renderWithProviders(<OffsiteReviewQueue />);
    await page.getByRole('button', { name: 'Review' }).click();
    // Content checklist items — the off-site (content-only) set.
    await expect.element(page.getByText('URL is https and opens externally')).toBeInTheDocument();
    await expect.element(page.getByText('Icon present')).toBeInTheDocument();
    // NO on-site code items.
    expect(page.getByText('Code diff reviewed').elements()).toHaveLength(0);
    // The two ENTRY actions present (approve is now gated behind its own click).
    await expect.element(page.getByTestId('apps-offsite-approve-open')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-offsite-reject-open')).toBeInTheDocument();
  });
});

describe('OffsiteReviewModal — click-to-reveal on civitai.com and the civitai.red overrides', () => {
  // This host does not show mature content (`canViewNsfw` absent): civitai.com.
  const card = {
    id: 'listing-1',
    slug: 'ci-ext-app',
    kind: 'offsite',
    name: 'CI External App',
    tagline: null,
    category: 'utility',
    contentRating: 'g',
    iconUrl: LOADABLE_IMAGE_DATA_URI,
    coverUrl: LOADABLE_IMAGE_DATA_URI,
    creator: null,
    recommend: { recommendedCount: 0, notRecommendedCount: 0, recommendPct: null },
    reviewCount: 0,
    openCount: null,
    isBeta: false,
    restrictedAudience: null,
    kindData: { kind: 'offsite', externalUrl: 'https://example.com/app' },
  };
  const preview = (screenshotLevel: number) => ({
    card,
    detail: undefined,
    media: {
      icon: { imageId: 10, url: LOADABLE_IMAGE_DATA_URI, nsfwLevel: 1 },
      cover: { imageId: 11, url: LOADABLE_IMAGE_DATA_URI, nsfwLevel: 1 },
      redIcon: { imageId: 13, url: LOADABLE_IMAGE_DATA_URI, nsfwLevel: 16 },
      redCover: null,
      screenshots: [
        {
          imageId: 12,
          url: LOADABLE_IMAGE_DATA_URI,
          nsfwLevel: screenshotLevel,
          caption: null,
        },
      ],
    },
  });

  test('🔴 the store-layout preview is held behind one reveal by its most mature image', async () => {
    mocks.previewData.current = preview(1);
    renderWithProviders(<OffsiteReviewQueue />);
    await page.getByRole('button', { name: 'Review' }).click();
    const reveal = page.getByTestId('apps-listing-preview-reveal');
    await expect.element(reveal).toBeInTheDocument();
    // The XXX civitai.red icon is the most mature image here.
    expect(reveal.element().querySelector('[data-revealed]')?.getAttribute('data-revealed')).toBe(
      'false'
    );
  });

  test('🔴 the media panel shows the civitai.red icon as its own tile, labelled civitai.red only', async () => {
    mocks.previewData.current = preview(1);
    renderWithProviders(<OffsiteReviewQueue />);
    await page.getByRole('button', { name: 'Review' }).click();
    await expect
      .element(page.getByTestId('apps-review-listing-red-icon-audience-ci-ext-app'))
      .toHaveTextContent('civitai.red only');
  });

  test('🔴 the held-back preview cannot be reached by keyboard: its screenshot tile never opens the full-size viewer until Show', async () => {
    // The preview's screenshot tile is a button whose viewer is a portal Modal outside the
    // blur, so Tab + Enter on it showed the XXX media full-size without clicking Show.
    mocks.previewData.current = {
      ...preview(1),
      detail: buildListingDetailPreview(OFFSITE_ROW as never, {
        screenshots: [{ url: LOADABLE_IMAGE_DATA_URI, caption: null }],
      }),
    };
    renderWithProviders(<OffsiteReviewQueue />);
    await page.getByRole('button', { name: 'Review' }).click();
    const reveal = page.getByTestId('apps-listing-preview-reveal');
    const held = () => reveal.element().querySelector('[data-revealed]');
    await expect.poll(() => held()?.getAttribute('data-revealed')).toBe('false');
    const tile = page.getByTestId('apps-listing-screenshot-tile');
    await expect.element(tile).toBeInTheDocument();
    const tileEl = tile.element() as HTMLElement;
    expect(held()?.contains(tileEl)).toBe(true);

    // A Tab sweep through the whole review modal never lands inside the held-back preview.
    let landedInside = 0;
    let moved = 0;
    let last: Element | null = null;
    for (let i = 0; i < 60; i++) {
      await userEvent.keyboard('{Tab}');
      if (document.activeElement !== last) moved++;
      last = document.activeElement;
      if (held()?.contains(document.activeElement)) landedInside++;
    }
    expect(moved).toBeGreaterThan(3); // positive control: the sweep really moved focus
    expect(landedInside).toBe(0);
    // Park focus on the body (the sweep may have ended on another image's own Show button,
    // which would reveal this one too), then try to focus the tile directly and press Enter.
    (document.activeElement as HTMLElement | null)?.blur();
    tileEl.focus();
    expect(document.activeElement).not.toBe(tileEl);
    await userEvent.keyboard('{Enter}');
    expect(page.getByTestId('apps-listing-screenshot-viewer').query()).toBeNull();
    expect(held()?.getAttribute('data-revealed')).toBe('false');

    // After Show the same tile is reachable and opens the viewer.
    // A DOM click: this file loads no site stylesheet, so the overlay is never laid out the way
    // Playwright's actionability check wants (`ReviewMediaReveal.browser.test.tsx` clicks it
    // for real, with the stylesheet).
    (reveal.getByRole('button', { name: 'Show' }).element() as HTMLElement).click();
    await expect.poll(() => held()?.getAttribute('data-revealed')).toBe('true');
    (page.getByTestId('apps-listing-screenshot-tile').element() as HTMLElement).focus();
    expect(document.activeElement).toBe(page.getByTestId('apps-listing-screenshot-tile').element());
    await userEvent.keyboard('{Enter}');
    await expect.element(page.getByTestId('apps-listing-screenshot-viewer')).toBeInTheDocument();
  });

  test('a Blocked civitai.red icon is named in the blocked-media alert', async () => {
    mocks.assetsData.current = {
      ...DEFAULT_ASSETS,
      redIconId: 13,
      redIconNsfwLevel: 16,
      redIconScanStatus: 'blocked',
      hasBlockedAsset: true,
    };
    renderWithProviders(<OffsiteReviewQueue />);
    await page.getByRole('button', { name: 'Review' }).click();
    await expect
      .element(page.getByTestId('apps-offsite-assets-scan-blocked'))
      .toHaveTextContent(/Blocked media: civitai\.red icon/);
  });
});

describe('OffsiteReviewModal — scan-clean dimension (Item 1)', () => {
  test('a BLOCKED asset shows the "blocked media" alert explaining approve will be rejected', async () => {
    mocks.assetsData.current = {
      ...DEFAULT_ASSETS,
      iconScanStatus: 'blocked',
      hasBlockedAsset: true,
    };
    renderWithProviders(<OffsiteReviewQueue />);
    await page.getByRole('button', { name: 'Review' }).click();
    const alert = page.getByTestId('apps-offsite-assets-scan-blocked');
    await expect.element(alert).toBeInTheDocument();
    await expect.element(alert).toHaveTextContent(/Blocked media: icon/i);
  });

  test('a still-PENDING scan shows the "still scanning" advisory (no blocked alert)', async () => {
    mocks.assetsData.current = {
      ...DEFAULT_ASSETS,
      coverScanStatus: 'pending',
      hasPendingScan: true,
    };
    renderWithProviders(<OffsiteReviewQueue />);
    await page.getByRole('button', { name: 'Review' }).click();
    await expect.element(page.getByTestId('apps-offsite-assets-scan-pending')).toBeInTheDocument();
    expect(page.getByTestId('apps-offsite-assets-scan-blocked').elements()).toHaveLength(0);
  });

  test('all-scanned assets show NEITHER the blocked nor the pending scan alert', async () => {
    renderWithProviders(<OffsiteReviewQueue />);
    await page.getByRole('button', { name: 'Review' }).click();
    expect(page.getByTestId('apps-offsite-assets-scan-blocked').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-offsite-assets-scan-pending').elements()).toHaveLength(0);
  });

  // Audit 🟡 — the Approve entry button is DISABLED when the scan-clean gate would
  // reject it (blocked/pending), so a mod click doesn't just eat a server BAD_REQUEST.
  test('the Approve button is DISABLED when an asset is blocked', async () => {
    mocks.assetsData.current = {
      ...DEFAULT_ASSETS,
      iconScanStatus: 'blocked',
      hasBlockedAsset: true,
    };
    renderWithProviders(<OffsiteReviewQueue />);
    await page.getByRole('button', { name: 'Review' }).click();
    await expect.element(page.getByTestId('apps-offsite-approve-open')).toBeDisabled();
  });

  test('the Approve button is DISABLED while an asset is still scanning', async () => {
    mocks.assetsData.current = {
      ...DEFAULT_ASSETS,
      coverScanStatus: 'pending',
      hasPendingScan: true,
    };
    renderWithProviders(<OffsiteReviewQueue />);
    await page.getByRole('button', { name: 'Review' }).click();
    await expect.element(page.getByTestId('apps-offsite-approve-open')).toBeDisabled();
  });

  test('the Approve button is ENABLED when every asset is scan-clean', async () => {
    renderWithProviders(<OffsiteReviewQueue />);
    await page.getByRole('button', { name: 'Review' }).click();
    await expect.element(page.getByTestId('apps-offsite-approve-open')).not.toBeDisabled();
  });
});

describe('OffsiteReviewModal — approve-notes gating, friendly date, field labels', () => {
  test('the approval-notes textarea is NOT shown until "Approve…" is clicked, then a confirm Approve appears', async () => {
    renderWithProviders(<OffsiteReviewQueue />);
    await page.getByRole('button', { name: 'Review' }).click();

    // View mode: only the two entry buttons — NO approval-notes textarea yet.
    await expect.element(page.getByTestId('apps-offsite-approve-open')).toBeInTheDocument();
    expect(page.getByTestId('apps-offsite-approve-notes').elements()).toHaveLength(0);

    // Clicking "Approve…" reveals the notes textarea + a confirm Approve button.
    await page.getByTestId('apps-offsite-approve-open').click();
    await expect.element(page.getByTestId('apps-offsite-approve-notes')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-offsite-approve-confirm')).toBeInTheDocument();
    // The entry buttons are gone (replaced by Cancel / Approve).
    expect(page.getByTestId('apps-offsite-approve-open').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-offsite-reject-open').elements()).toHaveLength(0);
  });

  test('the Reject… flow still reveals the rejection-reason textarea + confirm', async () => {
    renderWithProviders(<OffsiteReviewQueue />);
    await page.getByRole('button', { name: 'Review' }).click();
    // No rejection textarea until Reject… is clicked.
    expect(page.getByTestId('apps-offsite-reject-reason').elements()).toHaveLength(0);
    await page.getByTestId('apps-offsite-reject-open').click();
    await expect.element(page.getByTestId('apps-offsite-reject-reason')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-offsite-reject-confirm')).toBeInTheDocument();
  });

  // Bug 1: the Reject confirm was gated on a silent 10-char minimum (every other
  // mod-reason field uses the shared 3-char `OFFSITE_MOD_REASON_MIN`). Gate is now
  // unified on that minimum with inline feedback — assert the disabled→enabled
  // transition (also catches a genuine wiring defect if the gate never opens).
  test('Reject confirm is disabled until a ≥min-length reason is typed', async () => {
    renderWithProviders(<OffsiteReviewQueue />);
    await page.getByRole('button', { name: 'Review' }).click();
    await page.getByTestId('apps-offsite-reject-open').click();

    const confirm = page.getByTestId('apps-offsite-reject-confirm');
    // Empty reason → disabled.
    await expect.element(confirm).toBeDisabled();

    // A too-short reason (2 < OFFSITE_MOD_REASON_MIN=3) → still disabled.
    await page.getByTestId('apps-offsite-reject-reason').fill('no');
    await expect.element(confirm).toBeDisabled();

    // A reason at/above the 3-char minimum → enabled.
    await page.getByTestId('apps-offsite-reject-reason').fill('needs a real reason');
    await expect.element(confirm).toBeEnabled();

    // Whitespace-only padding does NOT satisfy the gate (trimmed length counts).
    await page.getByTestId('apps-offsite-reject-reason').fill('  a  ');
    await expect.element(confirm).toBeDisabled();
  });

  // Beyond the GATE (disabled→enabled), lock that a valid reject actually FIRES
  // the reject mutation with the trimmed reason + the request id — no prior test
  // asserted the fired offsite reject mutation (only the gate).
  test('Reject with a ≥min-length reason FIRES rejectExternalRequest with {publishRequestId, rejectionReason}', async () => {
    renderWithProviders(<OffsiteReviewQueue />);
    await page.getByRole('button', { name: 'Review' }).click();
    await page.getByTestId('apps-offsite-reject-open').click();

    await page.getByTestId('apps-offsite-reject-reason').fill('needs a real reason');
    const confirm = page.getByTestId('apps-offsite-reject-confirm');
    await expect.element(confirm).toBeEnabled();
    await confirm.click();
    expect(mocks.rejectMutate).toHaveBeenCalledWith({
      publishRequestId: 'req-1',
      rejectionReason: 'needs a real reason',
    });
  });

  // The disabled-reason Tooltip wraps the disabled Button in a Box so it still
  // fires on hover (a native disabled <button> emits no pointer events). Assert
  // the hint text surfaces while the gate is closed.
  test('hovering the disabled Reject confirm surfaces the reason hint', async () => {
    renderWithProviders(<OffsiteReviewQueue />);
    await page.getByRole('button', { name: 'Review' }).click();
    await page.getByTestId('apps-offsite-reject-open').click();

    const confirm = page.getByTestId('apps-offsite-reject-confirm');
    await expect.element(confirm).toBeDisabled();
    await confirm.hover();
    await expect
      .element(page.getByText('Enter a reason — at least 3 characters.'))
      .toBeInTheDocument();
  });

  test('the submitted timestamp renders as "Month D, YYYY" (no time-of-day)', async () => {
    renderWithProviders(<OffsiteReviewQueue />);
    // Self-consistent with the component (same helper) → TZ-agnostic.
    const expected = formatDate(OFFSITE_ROW.submittedAt, 'MMMM D, YYYY');
    // Present in the queue row's "Submitted" column (and again in the modal once open).
    await expect.element(page.getByText(expected, { exact: false }).first()).toBeInTheDocument();
    // The old toLocaleString form carried a clock time — none should remain.
    expect(page.getByText(/\d{1,2}:\d\d/).elements()).toHaveLength(0);
  });

  test('the modal labels the Category and Content-rating fields', async () => {
    renderWithProviders(<OffsiteReviewQueue />);
    await page.getByRole('button', { name: 'Review' }).click();
    // 🔴 SCOPED AWAY FROM THE PREVIEW PANE, for the same reason the Content-rating
    // assertion below already is. The listing-preview detail now carries a store-style
    // "Details" accordion whose rows are ALSO labelled `Category` / `Rating`, so a
    // page-wide exact query resolves to 2 elements and the strict locator throws. This
    // test is about the review FORM's own field labels — say so in the selector, rather
    // than loosening to `.first()`, which would be satisfied by whichever happened to
    // render first.
    const previewDetail = page.getByTestId('apps-listing-preview-detail');
    await expect.element(previewDetail).toBeInTheDocument();
    // Positive control: the preview pane really does hold a `Category` row, so the
    // scoped count below is a discrimination and not an accident of there being one.
    expect(previewDetail.getByText('Category', { exact: true }).elements()).toHaveLength(1);
    const formCategoryLabels = page
      .getByText('Category', { exact: true })
      .elements()
      .filter((el) => !el.closest('[data-testid="apps-listing-preview-detail"]'));
    expect(formCategoryLabels).toHaveLength(1);
    await expect.element(page.getByText('Content rating', { exact: true })).toBeInTheDocument();
    // The badge value the Category field labels is still rendered — scoped out of the
    // preview pane, which now also prints the category in its Details row.
    // 🔴 The DISPLAY label: the fixture stores `utility`, the badge says `Utility` (the
    // same word the store card and the store detail rail print).
    const formCategoryValues = page
      .getByText('Utility', { exact: true })
      .elements()
      .filter((el) => !el.closest('[data-testid="apps-listing-preview-detail"]'));
    expect(formCategoryValues.length).toBeGreaterThan(0);
    // …and the raw stored value is gone from this surface entirely. `.not.toBeInTheDocument()`
    // is INERT in this repo (#4197), so query for null instead — controlled against the
    // label assertion above, which has just proved this query CAN find a match.
    expect(page.getByText('utility', { exact: true }).query()).toBeNull();
    // #3412 added the listing-preview detail pane (`apps-listing-preview-detail`), which
    // renders its OWN content-rating badge — so a bare exact 'g' now matches 2 elements and
    // the strict query throws. Scope to the Content-rating FIELD GROUP this test is about,
    // asserting its full text (label + badge value + qualifier). That still fails if the
    // badge value is wrong or missing, rather than being satisfied by the preview's copy.
    const ratingLabel = page.getByText('Content rating', { exact: true });
    await expect.element(ratingLabel).toBeInTheDocument();
    // 🔴 `G`, not the stored `g`. The whole normalised group text is pinned, so a
    // reworded badge cannot be walked past by a looser substring check.
    expect(ratingLabel.element().parentElement?.textContent).toBe('Content ratingGdeclared');
  });
});

// History-tab parity: opening an offsite row from Approved/Rejected passes readOnly,
// which HIDES the Approve.../Reject... action buttons (an already-decided request would
// only error NOT_PENDING server-side) while keeping the detail view — matching the
// on-site history read-only posture. Purely presentational (no handler change).
describe('OffsiteReviewModal — readOnly (history) posture hides the action buttons', () => {
  test('readOnly HIDES both entry action buttons but keeps the content detail view', async () => {
    renderWithProviders(<OffsiteReviewModal request={OFFSITE_ROW} onClose={vi.fn()} readOnly />);
    // Detail still renders — the external URL + the content checklist.
    await expect.element(page.getByText('URL is https and opens externally')).toBeInTheDocument();
    await expect.element(page.getByText('Icon present')).toBeInTheDocument();
    // But NEITHER Approve… nor Reject… action button renders in read-only mode.
    expect(page.getByTestId('apps-offsite-approve-open').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-offsite-reject-open').elements()).toHaveLength(0);
  });

  test('default (readOnly omitted) still renders the Approve…/Reject… buttons', async () => {
    renderWithProviders(<OffsiteReviewModal request={OFFSITE_ROW} onClose={vi.fn()} />);
    await expect.element(page.getByTestId('apps-offsite-approve-open')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-offsite-reject-open')).toBeInTheDocument();
  });
});

// On-site listing-MEDIA revision (kind: 'onsite') — the same listing modal reviews
// it, but it renders kind-aware: a "listing media" header (NOT "external app"), NO
// external URL, NO connect panel, the shadow-asset content checklist, and a
// cap-at-app-rating review (media must not exceed the app's rating).
describe('OffsiteReviewModal — on-site listing-media revision (kind: onsite)', () => {
  const ONSITE_MEDIA_ROW = {
    id: 'lmr-1',
    kind: 'onsite' as const,
    appListingId: 'listing-1',
    slug: 'onsite-media-app',
    status: 'pending',
    submittedAt: new Date('2026-02-01T00:00:00Z'),
    changelog: 'refreshed the screenshots',
    appListing: {
      name: 'On-site Media App',
      // An on-site listing-media revision has NO external URL and NO connect client.
      externalUrl: null,
      category: 'utility',
      contentRating: 'g',
      connectClientId: null,
      // 🔴 A media revision request targets a SHADOW, so `revisionOfId` is always set.
      // This fixture used to omit it, which made it indistinguishable from the OTHER
      // on-site request shape (the republish re-review, `revisionOfId: null`) — the two
      // are governed by opposite rating rules, so a fixture that cannot tell them apart
      // was pinning the cap copy onto a request shape that may not be under a cap.
      revisionOfId: 'listing-parent',
    },
    submittedBy: { id: 42, username: 'author-dev', deletedAt: null, image: null },
  };

  test('renders the listing-media header, the asset checklist, and NO URL / connect panel', async () => {
    renderWithProviders(<OffsiteReviewModal request={ONSITE_MEDIA_ROW} onClose={vi.fn()} />);
    // Kind-aware header — the "listing media" badge, not "external".
    await expect
      .element(page.getByTestId('apps-offsite-kind-badge'))
      .toHaveTextContent('listing media');
    expect(page.getByText('external', { exact: true }).elements()).toHaveLength(0);
    // The on-site explainer note renders.
    await expect.element(page.getByTestId('apps-offsite-onsite-note')).toBeInTheDocument();
    // The shadow-asset content checklist is present (asset-presence items).
    await expect.element(page.getByText('Icon present')).toBeInTheDocument();
    await expect.element(page.getByText('Cover present')).toBeInTheDocument();
    // No external URL row is rendered (null externalUrl degrades gracefully).
    expect(page.getByText('URL is https and opens externally').elements()).toHaveLength(0);
    // No code-review items and no connect scopes panel.
    expect(page.getByText('Code diff reviewed').elements()).toHaveLength(0);
    expect(page.getByTestId('connect-scopes-panel').elements()).toHaveLength(0);
    // The app-rating cap label surfaces (vs "declared" for offsite).
    await expect.element(page.getByText('app rating (cap)', { exact: true })).toBeInTheDocument();
  });

  test('flags media rated higher than the app rating as a cap violation (reject reason)', async () => {
    // Assets derive 'r' (screenshot @ level 4) vs the app rating 'g' → cap exceeded.
    renderWithProviders(<OffsiteReviewModal request={ONSITE_MEDIA_ROW} onClose={vi.fn()} />);
    const mismatch = page.getByTestId('apps-offsite-rating-mismatch');
    await expect.element(mismatch).toBeInTheDocument();
    // The cap-rule phrase now also appears in the on-site explainer note, so a bare
    // getByText matches two elements (strict-mode violation). Scope the reject-reason
    // assertion to the mismatch callout itself.
    await expect.element(mismatch).toHaveTextContent('must not exceed the app’s rating');
  });

  test('🔴 an on-site media revision whose split the app cannot read approves with no decision', async () => {
    mocks.assetsData.current = { ...DEFAULT_ASSETS, mediaSplitApproved: null };
    renderWithProviders(<OffsiteReviewModal request={ONSITE_MEDIA_ROW} onClose={vi.fn()} />);
    await page.getByTestId('apps-offsite-approve-open').click();
    const vars = await expectUnreadableApproveSendsNoDecision(UNREADABLE_REVISION_NOTE);
    expect(vars).toEqual(expect.objectContaining({ publishRequestId: 'lmr-1' }));
  });

  test('🔴 the split choice previews no rating: the revision apply records it but rates nothing', async () => {
    // `applyApprovedRevision`'s on-site branch is assets-only — it writes the split stamp and
    // never `contentRating`. Fixture ratings are distinct (all media R, civitai.com media G), so
    // a projection of either would be visible.
    mocks.assetsData.current = { ...DEFAULT_ASSETS, mediaSplitApproved: true };
    renderWithProviders(<OffsiteReviewModal request={ONSITE_MEDIA_ROW} onClose={vi.fn()} />);
    await page.getByTestId('apps-offsite-approve-open').click();
    const control = page.getByTestId('apps-media-split');
    await expect.element(control).toBeInTheDocument();
    await expect
      .element(page.getByTestId('apps-media-split-later'))
      .toHaveTextContent('keeps the app’s current rating');
    expect(page.getByTestId('apps-media-split-all-rating').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-media-split-com-rating').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-media-split-audiences').elements()).toHaveLength(0);
    const text = control.element().textContent ?? '';
    expect(text).not.toMatch(/\((G|PG|PG-13|R|X|XXX)\)/);
    expect(text).not.toContain(' as G');
    // The decision itself is kept: preselected as the listing's current split, and sent.
    await expect.element(page.getByRole('radio', { name: /^Split:/ })).toBeChecked();
    await page.getByTestId('apps-offsite-approve-confirm').click();
    expect(mocks.approveMutate).toHaveBeenCalledWith(
      expect.objectContaining({ mediaSplit: 'split' })
    );
  });
});

// 🔴 The OTHER on-site request shape: an owner republish whose store imagery changed
// since the last approval. Same `kind: 'onsite'`, same modal — and the server applies the
// OPPOSITE rating rule (`resolveOnsiteApprovalContentRating` FLOORS the app's declared
// rating at the media-derived value, raise-only). Every assertion here is the mirror of
// one in the media-revision block above, and the ONLY fixture difference is
// `revisionOfId: null`.
describe('OffsiteReviewModal — on-site republish re-review (kind: onsite, NON-shadow)', () => {
  const ONSITE_REPUBLISH_ROW = {
    id: 'rpb-1',
    kind: 'onsite' as const,
    appListingId: 'listing-1',
    slug: 'onsite-republish-app',
    status: 'pending',
    submittedAt: new Date('2026-02-01T00:00:00Z'),
    changelog: null,
    appListing: {
      name: 'On-site Republish App',
      externalUrl: null,
      category: 'utility',
      contentRating: 'g',
      connectClientId: null,
      // The whole discriminator: this request targets the LIVE listing, not a shadow.
      revisionOfId: null,
    },
    submittedBy: { id: 42, username: 'author-dev', deletedAt: null, image: null },
  };

  test('🔴 the note describes a REPUBLISH review and says the rating is RAISED, not capped', async () => {
    renderWithProviders(<OffsiteReviewModal request={ONSITE_REPUBLISH_ROW} onClose={vi.fn()} />);
    const note = page.getByTestId('apps-offsite-onsite-note');
    await expect.element(note).toBeInTheDocument();
    await expect.element(note).toHaveTextContent('Republish review');
    await expect.element(note).toHaveTextContent('RAISES the app’s rating');
    // The cap sentence — correct for a media revision — must NOT appear here.
    expect(note.element().textContent).not.toContain('must not exceed');
  });

  test('🔴 the app rating is labelled a FLOOR, not a cap', async () => {
    renderWithProviders(<OffsiteReviewModal request={ONSITE_REPUBLISH_ROW} onClose={vi.fn()} />);
    await expect.element(page.getByText('app rating (floor)', { exact: true })).toBeInTheDocument();
    expect(page.getByText('app rating (cap)', { exact: true }).elements()).toHaveLength(0);
  });

  test('🔴 the mismatch callout says approving RAISES the app, not that it is a reject reason', async () => {
    // Assets derive 'r' vs the app's declared 'g' → the callout renders. For a media
    // revision that is "reject or trim"; here approving is what the server will do, and
    // it will raise the app to 'r'. Telling the moderator the opposite is the finding.
    renderWithProviders(<OffsiteReviewModal request={ONSITE_REPUBLISH_ROW} onClose={vi.fn()} />);
    const mismatch = page.getByTestId('apps-offsite-rating-mismatch');
    await expect.element(mismatch).toBeInTheDocument();
    await expect.element(mismatch).toHaveTextContent('it is a floor here, not a cap');
    expect(mismatch.element().textContent).not.toContain('reject this revision');
  });

  test('positive control: a republish review DOES rate, so its split choice shows the projection', async () => {
    renderWithProviders(<OffsiteReviewModal request={ONSITE_REPUBLISH_ROW} onClose={vi.fn()} />);
    await page.getByTestId('apps-offsite-approve-open').click();
    await expect.element(page.getByTestId('apps-media-split-all-rating')).toBeInTheDocument();
    expect(page.getByTestId('apps-media-split-later').elements()).toHaveLength(0);
  });

  test('🔴 the approve Select defaults to the DERIVED rating (the floor), not the app rating', async () => {
    // The media-revision default is the app's own rating; offering that here offers a
    // value the server would silently raise past. Fixture ratings are deliberately
    // distinct — app 'g' vs derived 'R' — so a default that echoed either one is visible.
    renderWithProviders(<OffsiteReviewModal request={ONSITE_REPUBLISH_ROW} onClose={vi.fn()} />);
    await page.getByTestId('apps-offsite-approve-open').click();
    const ratingInput = page
      .getByTestId('apps-offsite-approve-rating')
      .element() as HTMLInputElement;
    expect(ratingInput.value).toBe('R');
    expect(ratingInput.value).not.toBe('G');
  });
});

describe('OffsiteReviewModal — content-rating derive + mod override', () => {
  test('surfaces the DERIVED rating and FLAGS it as higher than the declared rating', async () => {
    renderWithProviders(<OffsiteReviewQueue />);
    await page.getByRole('button', { name: 'Review' }).click();
    // Derived from the assets (max R) → stored `r`, DISPLAYED as `R` alongside the
    // declared `g`'s `G`. 🔴 Asserted as EXACT text content, not `toHaveTextContent`:
    // that matcher is a substring match and 'r' is a substring of most words, so it
    // could not tell the label from the raw value.
    const derived = page.getByTestId('apps-offsite-derived-rating');
    await expect.element(derived).toBeInTheDocument();
    expect(derived.element().textContent).toBe('R');
    // Assets more mature than declared → the mismatch warning renders.
    await expect.element(page.getByTestId('apps-offsite-rating-mismatch')).toBeInTheDocument();
  });

  test('with the asset read not in yet, nothing is flagged as a mismatch', async () => {
    mocks.assetsData.current = undefined;
    renderWithProviders(<OffsiteReviewQueue />);
    await page.getByRole('button', { name: 'Review' }).click();
    const derived = page.getByTestId('apps-offsite-derived-rating');
    await expect.element(derived).toBeInTheDocument();
    expect(derived.element().textContent).toBe('G');
    expect(page.getByTestId('apps-offsite-rating-mismatch').elements()).toHaveLength(0);
  });

  test('the mismatch warning names the asset behind the detected rating, not the tame ones', async () => {
    renderWithProviders(<OffsiteReviewQueue />);
    await page.getByRole('button', { name: 'Review' }).click();
    const assets = page.getByTestId('apps-offsite-rating-mismatch-assets');
    await expect.element(assets).toBeInTheDocument();
    expect(assets.element().textContent).toBe('Rated highest: Screenshot 1 (R).');
  });

  test('the approve rating Select defaults to the derived value and approve passes it', async () => {
    renderWithProviders(<OffsiteReviewQueue />);
    await page.getByRole('button', { name: 'Review' }).click();
    await page.getByTestId('apps-offsite-approve-open').click();
    // The Select is present (defaulting to the derived rating), and confirming approve
    // forwards the chosen rating to the mutation.
    await expect.element(page.getByTestId('apps-offsite-approve-rating')).toBeInTheDocument();
    // 🔴 CALL-SITE ASSERTION for the option list's LABEL half. Mantine renders the
    // selected option's label in the input, so this reads what the moderator reads.
    // Was `label: r`, i.e. the raw key.
    const ratingInput = page
      .getByTestId('apps-offsite-approve-rating')
      .element() as HTMLInputElement;
    expect(ratingInput.value).toBe('R');
    expect(ratingInput.value).not.toBe('r');
    await page.getByTestId('apps-offsite-approve-confirm').click();
    // 🔴 …and the VALUE half is unchanged: the mutation still receives the stored
    // key. The pair is the point — a mutant that mapped the value instead of the
    // label would satisfy the assertion above and break this one.
    expect(mocks.approveMutate).toHaveBeenCalledWith(
      expect.objectContaining({ publishRequestId: 'req-1', contentRating: 'r' })
    );
  });
});

describe('OffsiteReviewModal — civitai.com / civitai.red media split', () => {
  async function openApprove() {
    renderWithProviders(<OffsiteReviewQueue />);
    await page.getByRole('button', { name: 'Review' }).click();
    await page.getByTestId('apps-offsite-approve-open').click();
    await expect.element(page.getByTestId('apps-media-split')).toBeInTheDocument();
  }

  test('shows both ratings the decision chooses between', async () => {
    await openApprove();
    expect(page.getByTestId('apps-media-split-all-rating').element().textContent).toBe(
      'Rating with all media: R'
    );
    expect(page.getByTestId('apps-media-split-com-rating').element().textContent).toBe(
      'Rating with civitai.com media only: G'
    );
  });

  test('🔴 by default approve sends rate-mature and the all-media rating', async () => {
    await openApprove();
    await page.getByTestId('apps-offsite-approve-confirm').click();
    expect(mocks.approveMutate).toHaveBeenCalledWith(
      expect.objectContaining({ contentRating: 'r', mediaSplit: 'rate-mature' })
    );
  });

  test('🔴 choosing the split re-defaults the rating to the civitai.com media, and approve sends both', async () => {
    await openApprove();
    await expect.element(page.getByTestId('apps-offsite-rating-mismatch')).toBeInTheDocument();
    await page.getByTestId('apps-media-split-split').click();
    const ratingInput = page
      .getByTestId('apps-offsite-approve-rating')
      .element() as HTMLInputElement;
    await expect.poll(() => ratingInput.value).toBe('G');
    // The R screenshot no longer floors the rating, so nothing is flagged as above it.
    expect(page.getByTestId('apps-offsite-rating-mismatch').elements()).toHaveLength(0);
    await page.getByTestId('apps-offsite-approve-confirm').click();
    expect(mocks.approveMutate).toHaveBeenCalledWith(
      expect.objectContaining({ contentRating: 'g', mediaSplit: 'split' })
    );
  });

  test('labels each image with where it will show under the chosen decision', async () => {
    await openApprove();
    const shot = page.getByTestId('apps-media-split-audience-screenshot-1');
    const icon = page.getByTestId('apps-media-split-audience-icon-0');
    // Rated by all media (R): the listing leaves civitai.com, so everything is .red-only.
    expect(shot.element().textContent).toBe('civitai.red only');
    expect(icon.element().textContent).toBe('civitai.red only');
    await page.getByTestId('apps-media-split-split').click();
    await expect.poll(() => icon.element().textContent).toBe('civitai.com + civitai.red');
    expect(shot.element().textContent).toBe('civitai.red only');
  });

  test('🔴 approve waits until the listing’s media and split state have loaded', async () => {
    mocks.assetsData.current = undefined;
    renderWithProviders(<OffsiteReviewQueue />);
    await page.getByRole('button', { name: 'Review' }).click();
    await page.getByTestId('apps-offsite-approve-open').click();
    await expect
      .element(page.getByTestId('apps-media-split-unknown'))
      .toHaveTextContent('Approve is available once the listing’s media has loaded.');
    await expect.element(page.getByTestId('apps-offsite-approve-confirm')).toBeDisabled();
  });

  test('a failed read says so, and approve stays unavailable', async () => {
    mocks.assetsData.current = undefined;
    mocks.assetsError.current = true;
    renderWithProviders(<OffsiteReviewQueue />);
    await page.getByRole('button', { name: 'Review' }).click();
    await page.getByTestId('apps-offsite-approve-open').click();
    await expect
      .element(page.getByTestId('apps-media-split-unknown'))
      .toHaveTextContent('Could not load the listing’s media');
    await expect.element(page.getByTestId('apps-offsite-approve-confirm')).toBeDisabled();
  });

  test('invariant guard: a request with no listing to read is never blocked on it', async () => {
    mocks.assetsData.current = undefined;
    renderWithProviders(
      <OffsiteReviewModal
        request={{ ...OFFSITE_ROW, appListingId: null } as never}
        onClose={() => undefined}
      />
    );
    await page.getByTestId('apps-offsite-approve-open').click();
    await expect.element(page.getByTestId('apps-offsite-approve-confirm')).toBeEnabled();
    expect(page.getByTestId('apps-media-split-unknown').elements()).toHaveLength(0);
  });

  test('a cover above SFW makes the split unavailable', async () => {
    mocks.assetsData.current = { ...DEFAULT_ASSETS, coverNsfwLevel: 4 };
    await openApprove();
    await expect.element(page.getByTestId('apps-media-split-split')).toBeDisabled();
  });

  test('all-SFW media offers no choice', async () => {
    mocks.assetsData.current = {
      ...DEFAULT_ASSETS,
      screenshots: [{ imageId: 12, nsfwLevel: 2, scanStatus: 'scanned' as const }],
    };
    renderWithProviders(<OffsiteReviewQueue />);
    await page.getByRole('button', { name: 'Review' }).click();
    await page.getByTestId('apps-offsite-approve-open').click();
    await expect.element(page.getByTestId('apps-offsite-approve-rating')).toBeInTheDocument();
    expect(page.getByTestId('apps-media-split').elements()).toHaveLength(0);
  });

  test('🔴 a split the app cannot read: no choice, a note, and approve proceeds with no decision', async () => {
    mocks.assetsData.current = { ...DEFAULT_ASSETS, mediaSplitApproved: null };
    renderWithProviders(<OffsiteReviewQueue />);
    await page.getByRole('button', { name: 'Review' }).click();
    await page.getByTestId('apps-offsite-approve-open').click();
    const vars = await expectUnreadableApproveSendsNoDecision(UNREADABLE_NOTE);
    // Rated by all media (the screenshot's R), as before the split existed.
    expect(vars).toEqual(expect.objectContaining({ contentRating: 'r' }));
  });

  test('positive control: the same listing read as unsplit offers the choice and approves', async () => {
    mocks.assetsData.current = { ...DEFAULT_ASSETS, mediaSplitApproved: false };
    await openApprove();
    expect(page.getByTestId('apps-media-split-unreadable').elements()).toHaveLength(0);
    await expect.element(page.getByTestId('apps-media-split')).toBeInTheDocument();
    await page.getByTestId('apps-offsite-approve-confirm').click();
    expect(mocks.approveMutate).toHaveBeenCalledWith(
      expect.objectContaining({ mediaSplit: 'rate-mature' })
    );
  });

  test('🔴 a listing that is already split keeps it by default, and says how to end it', async () => {
    mocks.assetsData.current = { ...DEFAULT_ASSETS, mediaSplitApproved: true };
    await openApprove();
    await expect.element(page.getByTestId('apps-media-split-current')).toBeInTheDocument();
    await expect.element(page.getByRole('radio', { name: /^Split:/ })).toBeChecked();
    await page.getByTestId('apps-offsite-approve-confirm').click();
    expect(mocks.approveMutate).toHaveBeenCalledWith(
      expect.objectContaining({ contentRating: 'g', mediaSplit: 'split' })
    );
  });

  test('🔴 a split chosen while the choice was shown is not sent once it is hidden', async () => {
    await openApprove();
    await page.getByTestId('apps-media-split-split').click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    // The author's media is now all SFW: the choice no longer applies and is not shown.
    mocks.assetsData.current = {
      ...DEFAULT_ASSETS,
      screenshots: [{ imageId: 12, nsfwLevel: 2, scanStatus: 'scanned' as const }],
    };
    await page.getByTestId('apps-offsite-approve-open').click();
    expect(page.getByTestId('apps-media-split').elements()).toHaveLength(0);
    await page.getByTestId('apps-offsite-approve-confirm').click();
    expect(mocks.approveMutate).toHaveBeenCalledWith(
      expect.objectContaining({ mediaSplit: 'rate-mature' })
    );
  });
});
