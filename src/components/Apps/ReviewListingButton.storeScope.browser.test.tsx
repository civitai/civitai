import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';

/**
 * W13 — the review affordance obeys the STORE-SCOPE KIND rule.
 *
 * The server half of this fix lets the `app-listings-public-external` cohort post
 * reviews on OFFSITE listings (they previously got "could not post review, apps are
 * not enabled"). This suite pins the OTHER direction of the same anti-goal — never
 * show a control the server will refuse — for the case the server fix creates: that
 * cohort reaching an ONSITE listing, where the write now correctly NOT_FOUNDs.
 *
 * 🔴 THE SCOPE DRIVES IT, NOT A FLAG NAME. The flags are set here only to construct
 * a scope; every expectation below is stated in terms of the resolved scope and the
 * listing's kind, because "which flag" is precisely the question that produced the
 * bug. A `public-external` viewer is built the way the real cohort is: WITHOUT
 * `appListings` and WITHOUT `appBlocks`.
 *
 * A moderator (`full`) is included as the control that CANNOT see the bug — it is
 * the account every previous look at this surface used.
 */

type Flags = {
  appListings?: boolean;
  appBlocks?: boolean;
  appListingsPublicExternal?: boolean;
};

const mocks = vi.hoisted(() => ({
  upsert: vi.fn(),
  invalidate: vi.fn().mockResolvedValue(undefined),
  currentUser: { id: 11072787, username: 'camer047army744' } as null | {
    id: number;
    username: string;
  },
  // Default: the external-only tester cohort — neither store flag, only the
  // external one. This is the shape `resolveStoreVisibilityScope` maps to
  // `public-external`.
  features: {
    appListings: false,
    appBlocks: false,
    appListingsPublicExternal: true,
  } as Flags | null,
}));

// Spread the REAL module and override only `trpc` (local-rules/no-wholesale-module-mock).
// A hand-written replacement fails the whole FILE to load — as `0 tests collected`,
// not as a failing assertion — the day this module gains an export the factory omits.
// That is not hypothetical here: the sibling suite's wholesale factory broke exactly
// this way when `ReviewListingButton` started importing the flags provider.
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: {
    appListings: {
      getMyReview: { useQuery: () => ({ data: null, isLoading: false }) },
      upsertReview: {
        useMutation: ({ onSuccess }: { onSuccess?: (r: unknown) => void } = {}) => ({
          mutate: (input: unknown) => {
            mocks.upsert(input);
            onSuccess?.({ isNewReview: true });
          },
          isPending: false,
        }),
      },
      listReviews: { invalidate: mocks.invalidate },
    },
    useUtils: () => ({
      appListings: {
        getMyReview: { invalidate: mocks.invalidate },
        listReviews: { invalidate: mocks.invalidate },
        getAppDetail: { invalidate: mocks.invalidate },
      },
    }),
  },
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => mocks.currentUser }));
// Same spread rule — `useCanReviewListing` reads `useOptionalFeatureFlags`, and both
// hooks are overridden so they cannot disagree about the viewer's flags.
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsMod>()),
  useFeatureFlags: () => mocks.features,
  useOptionalFeatureFlags: () => mocks.features,
}));
vi.mock('~/utils/notifications', () => ({
  showSuccessNotification: vi.fn(),
  showErrorNotification: vi.fn(),
}));

const { ReviewListingButton } = await import('./ReviewListingButton');

/** A user id distinct from the viewer's, so the self-review gate never fires. */
const OWNER_ID = 5502;
const CTA = /leave a review/i;

/**
 * 🔴 ABSENCE IS ASSERTED BY COUNT, NEVER BY `expect.element(...).not.toBeInTheDocument()`.
 *
 * That idiom is VACUOUS in this harness — measured, not assumed. Running these very
 * cases against the base revision, where the gate does not exist and the button
 * demonstrably renders, `.not.toBeInTheDocument()` PASSED in ~5ms while a
 * `.toBeInTheDocument()` assertion on the SAME locator in the SAME test also passed
 * (~52ms). Both directions green on one element is the signature of an assertion
 * that observes nothing, and it would have made every "is hidden" claim in this file
 * a green that proves nothing.
 *
 * `.elements()` returns a real array, so the assertion is a COUNT. And because a
 * count of zero is indistinguishable from a tree that never mounted, each negative
 * case renders a SENTINEL alongside the button and waits for it first: that is the
 * positive control, and the pair — sentinel present, CTA count 0 — is what makes the
 * zero meaningful. (`.elements()` + `toHaveLength(0)` is already this repo's idiom;
 * see `src/tests/pages/apps/listing-collaborators-transfer.browser.test.tsx`.)
 */
function mountedSentinel() {
  return <span data-testid="review-gate-sentinel" />;
}

async function expectCtaHidden() {
  // Positive control: the tree really mounted.
  await expect.element(page.getByTestId('review-gate-sentinel')).toBeInTheDocument();
  expect(page.getByRole('button', { name: CTA }).elements()).toHaveLength(0);
}

async function expectCtaShown() {
  await expect.element(page.getByTestId('review-gate-sentinel')).toBeInTheDocument();
  expect(page.getByRole('button', { name: CTA }).elements()).toHaveLength(1);
}

beforeEach(() => {
  mocks.upsert.mockClear();
  mocks.invalidate.mockClear();
  mocks.currentUser = { id: 11072787, username: 'camer047army744' };
  mocks.features = { appListings: false, appBlocks: false, appListingsPublicExternal: true };
});

describe('public-external viewer (the external-only tester cohort)', () => {
  test('SEES the CTA on an OFFSITE listing — and the server now accepts the write', async () => {
    renderWithProviders(
      <>
        {mountedSentinel()}
        <ReviewListingButton appListingId="apl_offsite_kt4" ownerUserId={OWNER_ID} listingKind="offsite" />
      </>
    );
    await expectCtaShown();
  });

  test('does NOT see the CTA on an ONSITE listing — the scope hides that listing entirely', async () => {
    renderWithProviders(
      <>
        {mountedSentinel()}
        <ReviewListingButton appListingId="apl_onsite_zw9" ownerUserId={OWNER_ID} listingKind="onsite" />
      </>
    );
    await expectCtaHidden();
  });

  test('the offsite CTA is not merely present but FUNCTIONAL end-to-end', async () => {
    // A visibility assertion alone would pass against a button that renders and does
    // nothing. Drive the real submit path so "shown" and "works" are both pinned.
    renderWithProviders(
      <>
        {mountedSentinel()}
        <ReviewListingButton appListingId="apl_offsite_kt4" ownerUserId={OWNER_ID} listingKind="offsite" />
      </>
    );
    await page.getByRole('button', { name: CTA }).click();
    await page.getByRole('button', { name: /^recommend$/i }).click();
    await page.getByRole('textbox').fill('Works well for external use');
    await page.getByRole('button', { name: /post review/i }).click();

    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.upsert).toHaveBeenCalledWith({
      appListingId: 'apl_offsite_kt4',
      recommended: true,
      details: 'Works well for external use',
    });
  });
});

describe('full-scope viewers are unchanged (the moderator control)', () => {
  test('a viewer holding `appListings` sees the CTA on an ONSITE listing', async () => {
    mocks.features = { appListings: true, appBlocks: false, appListingsPublicExternal: false };
    renderWithProviders(
      <>
        {mountedSentinel()}
        <ReviewListingButton appListingId="apl_onsite_zw9" ownerUserId={OWNER_ID} listingKind="onsite" />
      </>
    );
    await expectCtaShown();
  });

  test('a viewer holding `appBlocks` (the OR-fallback) also sees the ONSITE CTA', async () => {
    mocks.features = { appListings: false, appBlocks: true, appListingsPublicExternal: false };
    renderWithProviders(
      <>
        {mountedSentinel()}
        <ReviewListingButton appListingId="apl_onsite_zw9" ownerUserId={OWNER_ID} listingKind="onsite" />
      </>
    );
    await expectCtaShown();
  });

  test('🔴 a viewer holding BOTH `appListings` and the external flag is NOT narrowed to offsite-only', async () => {
    // The "never narrow a moderator" invariant, in client form. If
    // `resolveClientStoreScope` checked the external axis first, this viewer would
    // resolve `public-external` and LOSE the onsite half of the store.
    mocks.features = { appListings: true, appBlocks: false, appListingsPublicExternal: true };
    renderWithProviders(
      <>
        {mountedSentinel()}
        <ReviewListingButton appListingId="apl_onsite_zw9" ownerUserId={OWNER_ID} listingKind="onsite" />
      </>
    );
    await expectCtaShown();
  });
});

describe('none-scope and the pre-existing gates', () => {
  test('a viewer holding NO store flag sees no CTA on either kind', async () => {
    mocks.features = { appListings: false, appBlocks: false, appListingsPublicExternal: false };
    renderWithProviders(
      <>
        {mountedSentinel()}
        <ReviewListingButton appListingId="apl_offsite_kt4" ownerUserId={OWNER_ID} listingKind="offsite" />
      </>
    );
    await expectCtaHidden();
  });

  test('the OWNER still sees no CTA even with a scope that admits the kind', async () => {
    // Positive control on ordering: the kind term must not have replaced the
    // pre-existing self-review gate.
    mocks.currentUser = { id: OWNER_ID, username: 'owner' };
    renderWithProviders(
      <>
        {mountedSentinel()}
        <ReviewListingButton appListingId="apl_offsite_kt4" ownerUserId={OWNER_ID} listingKind="offsite" />
      </>
    );
    await expectCtaHidden();
  });

  test('a signed-OUT viewer sees no CTA even with a full scope', async () => {
    mocks.currentUser = null;
    mocks.features = { appListings: true, appBlocks: true, appListingsPublicExternal: true };
    renderWithProviders(
      <>
        {mountedSentinel()}
        <ReviewListingButton appListingId="apl_offsite_kt4" ownerUserId={OWNER_ID} listingKind="offsite" />
      </>
    );
    await expectCtaHidden();
  });

  test('an OMITTED listingKind skips the kind term — it does not silently hide the CTA', async () => {
    // The documented opt-in shape. A caller with no kind in hand keeps the old
    // behaviour rather than being downgraded to `none`-like invisibility.
    mocks.features = { appListings: false, appBlocks: false, appListingsPublicExternal: true };
    renderWithProviders(
      <>
        {mountedSentinel()}
        <ReviewListingButton appListingId="apl_offsite_kt4" ownerUserId={OWNER_ID} />
      </>
    );
    await expectCtaShown();
  });
});
