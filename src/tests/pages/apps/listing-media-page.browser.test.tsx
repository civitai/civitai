import { useEffect, useState } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';
import { useRouter } from 'next/router';

/**
 * On-site listing-media OWNER editor (`ListingMediaEditor`, the "Listing media" tab of
 * `/apps/<appBlockId>/edit`) — render test (browser mode, report-only in Tekton).
 *
 * Asserts the client wiring: it resolves `appBlockId` → `appListingId`
 * (`getMyListingForApp`), re-hosts the reused `ListingAssetStep` against the
 * server-resolved `editTargetId` + the listing's content rating, prefills it from that
 * target's assets, re-pulls the projection after an asset mutation, surfaces the
 * honest live-app framing copy (+ the pending-revision notice when applicable), and
 * fires `submitListingRevision({ shadowId })` from the Submit-for-review button. The
 * asset step itself is stubbed — its real behaviour is covered by
 * `ListingAssetStep.browser.test.tsx`.
 *
 * 🔴 NO `beginListingRevision` ON MOUNT. Firing it here made merely OPENING the tab
 * create a `draft` AppListing (78% of approved onsite parents on prod carried a
 * never-edited shadow, self-refilling on every view). The shadow is minted by the
 * first asset MUTATION, server-side. `editTargetId` is the shadow when one exists and
 * the listing itself otherwise; `editBlockedReason` carries the "this can't be edited"
 * verdict the on-mount call used to deliver as INVALID_REVISION.
 *
 * 🔴 This file used to import the default export of `~/pages/apps/[appBlockId]/listing`.
 * That route is now a getServerSideProps REDIRECT stub whose default export renders
 * `<NotFound />` and nothing else, so every test here rendered an empty not-found div
 * and asserted nothing — a structurally dead suite that still reported green. It now
 * targets the real component the route redirects to. Keep it pointed at a COMPONENT.
 */

const state = vi.hoisted(() => ({
  // getMyListingForApp.useQuery control object.
  query: {
    data: undefined as unknown,
    isLoading: false,
    error: null as unknown,
  },
  // submitListingRevision — captured args.
  submit: { calls: [] as unknown[], pending: false },
  // Props the stubbed ListingAssetStep received.
  assetProps: {
    last: null as null | {
      listingId: string;
      contentRating: string;
      initial?: { icon: { imageId: number | null }; cover: { imageId: number | null } };
    },
  },
  // Floor state the stubbed step reports up via onCompletenessChange (drives the
  // submit button's disabled binding). Default meets-floor so the happy paths click.
  floor: { meetsFloor: true, complete: false },
  invalidate: vi.fn().mockResolvedValue(undefined),
  flags: { appBlocks: true } as Record<string, boolean>,
  // Drives WHICH live-app notice the editor renders. `useCurrentUser()` throws
  // without a CivitaiSessionProvider (which `renderWithProviders` deliberately does
  // not mount), so it is mocked rather than provided.
  currentUser: null as null | { id: number; username: string; isModerator?: boolean },
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => state.flags,
}));

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => state.currentUser,
}));

vi.mock('~/components/AppLayout/NotFound', () => ({
  NotFound: () => <div data-testid="not-found">Not found</div>,
}));
vi.mock('~/utils/notifications', () => ({
  showSuccessNotification: vi.fn(),
  showErrorNotification: vi.fn(),
}));

// Stub the reused asset step — capture the props to prove the shell threads the
// SHADOW id + rating, without re-running its own (covered) upload behaviour.
vi.mock('~/components/Apps/ListingAssetStep', () => ({
  ListingAssetStep: (props: {
    listingId: string;
    contentRating: string;
    initial?: { icon: { imageId: number | null }; cover: { imageId: number | null } };
    onAssetMutated?: () => void;
    onCompletenessChange?: (s: { meetsFloor: boolean; complete: boolean }) => void;
  }) => {
    state.assetProps.last = props;
    // Mirror the real step's seeding EXACTLY: it reads `initial` in its useState
    // INITIALISERS, so what it shows is whatever `initial` held at MOUNT — a mere
    // re-render never re-seeds it, only a remount does. That is what makes the tab
    // round-trip below an end-to-end assertion instead of a prop-passthrough one.
    const [seededIcon] = useState(() => props.initial?.icon.imageId ?? null);
    // Mirror the real step: report the floor state up so the page can gate submit.
    // In an EFFECT, not during render — the real step reports from an effect, and
    // calling the parent's setState mid-render trips React's cross-component warning.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => props.onCompletenessChange?.(state.floor), []);
    return (
      <div data-testid="asset-step">
        assets:{props.listingId}:{props.contentRating}
        <span data-testid="asset-step-seeded-icon">{String(seededIcon ?? 'none')}</span>
        {/* Stands in for a successful attach/remove inside the real step. */}
        <button type="button" data-testid="asset-step-mutate" onClick={() => props.onAssetMutated?.()}>
          mutate
        </button>
      </div>
    );
  },
}));

vi.mock('~/utils/trpc', () => ({
  trpc: {
    useUtils: () => ({
      appListings: { getMyListingForApp: { invalidate: state.invalidate } },
    }),
    appListings: {
      getMyListingForApp: { useQuery: () => state.query },
      // 🔴 `beginListingRevision` is deliberately ABSENT from this mock. If the editor
      // ever re-adds an on-mount call to it, these tests crash rather than silently
      // re-introducing the write-on-view that this change removed.
      submitListingRevision: {
        useMutation: () => ({
          mutateAsync: async (vars: unknown) => {
            state.submit.calls.push(vars);
            return { publishRequestId: 'alpr_1', shadowId: 'apl_shadow', slug: 'my-app' };
          },
          isPending: state.submit.pending,
        }),
      },
    },
  },
}));

// 🔴 The REAL editor component — NOT the `/apps/[appBlockId]/listing` route module,
// which is now a redirect stub that only ever renders <NotFound />.
const { ListingMediaEditor } = await import('~/components/Apps/ListingMediaEditor');
const ListingMediaPage = () => <ListingMediaEditor appBlockId="my-block" />;

/**
 * Stands in for the owning `/apps/[appBlockId]/edit` page's tab shell, which mounts
 * its panels with `keepMounted={false}`: leaving the media tab and coming back
 * genuinely UNMOUNTS and REMOUNTS the editor while the page itself stays put. The key
 * bump reproduces that inside one render tree (a manual `unmount()` fights the
 * scaffold's auto-`cleanup()` and blanks the following test's container).
 */
function TabRoundTrip() {
  const [mountKey, setMountKey] = useState(0);
  return (
    <>
      <button type="button" data-testid="tab-round-trip" onClick={() => setMountKey((n) => n + 1)}>
        leave and re-enter the media tab
      </button>
      <ListingMediaEditor key={mountKey} appBlockId="my-block" />
    </>
  );
}

function setRouterQuery(query: Record<string, string>) {
  const router = (useRouter as unknown as () => { query: Record<string, string> })();
  router.query = query;
}

beforeEach(() => {
  state.query = {
    data: {
      appListingId: 'apl_onsite',
      status: 'approved',
      contentRating: 'pg13',
      hasPendingRevision: false,
      shadowId: 'apl_shadow',
      editTargetId: 'apl_shadow',
      editBlockedReason: null,
      // The SHADOW's assets — what the proc now projects so the step can prefill.
      assets: {
        icon: { imageId: 137918008, url: 'edge:icon' },
        cover: { imageId: 137918011, url: 'edge:cover' },
        screenshots: [],
      },
    },
    isLoading: false,
    error: null,
  };
  state.submit = { calls: [], pending: false };
  state.floor = { meetsFloor: true, complete: false };
  state.assetProps.last = null;
  // mockRESET, not mockClear: a per-test `mockImplementation` (the round-trip test
  // publishes a post-attach projection through it) otherwise leaks into every later
  // test in the file.
  state.invalidate.mockReset();
  state.invalidate.mockResolvedValue(undefined);
  state.flags = { appBlocks: true };
  state.currentUser = { id: 7, username: 'owner' };
  setRouterQuery({ appBlockId: 'my-block' });
});

describe('ListingMediaPage — owner listing-media route shell', () => {
  test('resolves the listing and renders the asset step against the server-resolved edit target + rating', async () => {
    renderWithProviders(<ListingMediaPage />);

    // The reused asset step is hosted against the edit target + the listing's rating.
    await expect.element(page.getByTestId('asset-step')).toBeInTheDocument();
    await expect.element(page.getByTestId('asset-step')).toHaveTextContent('assets:apl_shadow:pg13');
    expect(state.assetProps.last).toMatchObject({ listingId: 'apl_shadow', contentRating: 'pg13' });
    expect(page.getByTestId('not-found').elements()).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 🔴 LAZY CREATION — no shadow yet.
  // -------------------------------------------------------------------------

  test('🔴 with NO shadow yet, the editor mounts against the PARENT id and never opens a revision', async () => {
    state.query.data = {
      ...(state.query.data as Record<string, unknown>),
      shadowId: null,
      editTargetId: 'apl_onsite',
    };
    renderWithProviders(<ListingMediaPage />);

    // It renders (no "Preparing your revision…" gate — there is nothing to prepare),
    // hosted against the LIVE listing id. The first mutation mints the shadow
    // server-side and applies there.
    await expect.element(page.getByTestId('asset-step')).toHaveTextContent('assets:apl_onsite:pg13');
  });

  test('🔴 Submit is DISABLED until a shadow exists — no edits means no revision to submit', async () => {
    state.query.data = {
      ...(state.query.data as Record<string, unknown>),
      shadowId: null,
      editTargetId: 'apl_onsite',
    };
    state.floor = { meetsFloor: true, complete: false };
    renderWithProviders(<ListingMediaPage />);

    const submit = page.getByTestId('apps-listing-media-submit');
    await expect.element(submit).toBeDisabled();
    await expect.element(page.getByTestId('apps-listing-media-no-changes')).toBeInTheDocument();
  });

  test('🔴 editBlockedReason renders the inline alert and keeps the editor unmounted', async () => {
    state.query.data = {
      ...(state.query.data as Record<string, unknown>),
      status: 'removed',
      shadowId: null,
      editTargetId: 'apl_onsite',
      editBlockedReason: 'this listing has been removed by a moderator and can no longer be edited',
    };
    renderWithProviders(<ListingMediaPage />);

    const alert = page.getByTestId('apps-listing-media-begin-error');
    await expect.element(alert).toHaveTextContent(/removed by a moderator/i);
    // No editor over a dead listing, and no contradictory "this app is live" notice.
    expect(page.getByTestId('asset-step').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-listing-media-live-notice').elements()).toHaveLength(0);
    expect(page.getByTestId('not-found').elements()).toHaveLength(0);
  });

  test('a DRAFT listing is edited in place — no live notice, no revision Submit button', async () => {
    state.query.data = {
      ...(state.query.data as Record<string, unknown>),
      status: 'draft',
      shadowId: null,
      editTargetId: 'apl_draft',
      editBlockedReason: null,
    };
    renderWithProviders(<ListingMediaPage />);

    await expect.element(page.getByTestId('asset-step')).toHaveTextContent('assets:apl_draft:pg13');
    expect(page.getByTestId('apps-listing-media-live-notice').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-listing-media-submit').elements()).toHaveLength(0);
  });

  test('prefills the asset step with the SHADOW revision assets the proc projects', async () => {
    renderWithProviders(<ListingMediaPage />);

    await expect.element(page.getByTestId('asset-step')).toBeInTheDocument();
    // Without this prop the step seeded every slot empty → "Icon none / Cover none"
    // → the publish floor could never be met → Submit stayed permanently disabled.
    expect(state.assetProps.last?.initial).toMatchObject({
      icon: { imageId: 137918008 },
      cover: { imageId: 137918011 },
    });
  });

  test('surfaces the honest live-app framing copy', async () => {
    renderWithProviders(<ListingMediaPage />);
    const notice = page.getByTestId('apps-listing-media-live-notice');
    await expect.element(notice).toBeInTheDocument();
    await expect.element(notice).toHaveTextContent(/live/i);
    await expect.element(notice).toHaveTextContent(/moderator re-approves/i);
  });

  // -------------------------------------------------------------------------
  // 🔴 The live-app notice must match the CALLER's actual write semantics, and the
  // discriminator is `isModerator && !shadowId` — NOT `isModerator`.
  //
  // With NO shadow, `editTargetId` is the live parent and
  // `resolveOwnerAssetEditTarget` + `assertOwnerAssetEditable` both short-circuit on
  // `user.isModerator`, so a moderator's edit is written DIRECTLY to the live listing.
  // (Confirmed in production, on listings the moderator also OWNED — this editor's
  // read is owner-bound with no mod branch, so it is only ever reachable for your own
  // listing.)
  //
  // 🔴 But `getMyListingForApp` redirects `editTargetId` to an EXISTING shadow with no
  // moderator branch of its own. A moderator whose listing already carries a shadow is
  // therefore editing the SHADOW — the bypass is a no-op there (`revisionOfId != null`)
  // — and IS staged. Gating on `isModerator` alone replaces one false banner with
  // another, for a case that is common rather than theoretical.
  //
  // The four states below are the whole matrix; each has a test.
  // -------------------------------------------------------------------------

  test('🔴 MOD + NO shadow: told they are editing the LIVE listing directly — never that it is staged', async () => {
    state.currentUser = { id: 1, username: 'mod', isModerator: true };
    // The mod bypass only reaches the live parent when there is no shadow to redirect
    // the edit target onto. (The shared fixture carries a shadow — see the next test.)
    state.query.data = {
      ...(state.query.data as Record<string, unknown>),
      shadowId: null,
      editTargetId: 'apl_onsite',
    };
    renderWithProviders(<ListingMediaPage />);

    // The step really is hosted against the LIVE parent — the precondition for the
    // copy, asserted rather than assumed.
    await expect.element(page.getByTestId('asset-step')).toHaveTextContent('assets:apl_onsite:');

    const notice = page.getByTestId('apps-listing-media-mod-live-notice');
    await expect.element(notice).toBeInTheDocument();
    await expect.element(notice).toHaveTextContent(/live/i);
    await expect.element(notice).toHaveTextContent(/apply to the live listing immediately/i);
    await expect.element(notice).toHaveTextContent(/not.*staged as a revision/i);

    // The owner variant — the one carrying the false "staged / re-approval" claim —
    // must be GONE, not merely supplemented.
    expect(page.getByTestId('apps-listing-media-live-notice').elements()).toHaveLength(0);
    // And no surviving copy anywhere may assert the staged/re-approval semantics.
    expect(page.getByText(/go live only after a moderator re-approves/i).elements()).toHaveLength(
      0
    );
  });

  test('🔴 MOD + shadow ALREADY exists: the edit IS staged, so the STAGED copy must render', async () => {
    // `getMyListingForApp` redirects `editTargetId` onto an existing shadow with no
    // moderator branch, so this write goes to the shadow and only goes live on
    // re-approval. Gating the "applies immediately" copy on `isModerator` alone told
    // this moderator the opposite. The shared fixture is exactly this shape.
    state.currentUser = { id: 1, username: 'mod', isModerator: true };
    renderWithProviders(<ListingMediaPage />);

    // Precondition: the step is hosted against the SHADOW, not the live parent.
    await expect.element(page.getByTestId('asset-step')).toHaveTextContent('assets:apl_shadow:');

    const notice = page.getByTestId('apps-listing-media-live-notice');
    await expect.element(notice).toBeInTheDocument();
    await expect.element(notice).toHaveTextContent(/staged as a revision/i);
    await expect.element(notice).toHaveTextContent(/go live only after a moderator re-approves/i);

    // The immediate-edit claim must NOT appear for this moderator.
    expect(page.getByTestId('apps-listing-media-mod-live-notice').elements()).toHaveLength(0);
    expect(page.getByText(/apply to the live listing immediately/i).elements()).toHaveLength(0);
  });

  test('🔴 a NON-moderator owner keeps the staged-revision copy (and never sees the mod variant)', async () => {
    state.currentUser = { id: 7, username: 'owner', isModerator: false };
    renderWithProviders(<ListingMediaPage />);

    const notice = page.getByTestId('apps-listing-media-live-notice');
    await expect.element(notice).toBeInTheDocument();
    await expect.element(notice).toHaveTextContent(/staged as a revision/i);
    await expect.element(notice).toHaveTextContent(/go live only after a moderator re-approves/i);

    expect(page.getByTestId('apps-listing-media-mod-live-notice').elements()).toHaveLength(0);
  });

  test('a NON-moderator owner with NO shadow still gets the STAGED copy (their first edit mints one)', async () => {
    // `!shadowId` alone must not flip the copy — it only means "immediate" for a mod.
    state.currentUser = { id: 7, username: 'owner', isModerator: false };
    state.query.data = {
      ...(state.query.data as Record<string, unknown>),
      shadowId: null,
      editTargetId: 'apl_onsite',
    };
    renderWithProviders(<ListingMediaPage />);

    await expect
      .element(page.getByTestId('apps-listing-media-live-notice'))
      .toHaveTextContent(/staged as a revision/i);
    expect(page.getByTestId('apps-listing-media-mod-live-notice').elements()).toHaveLength(0);
  });

  test('a MODERATOR on a non-approved (draft) listing sees NEITHER live notice', async () => {
    // The bypass only matters for an APPROVED, non-shadow listing — a draft is edited
    // in place for everyone, so neither "this is live" framing applies.
    state.currentUser = { id: 1, username: 'mod', isModerator: true };
    state.query.data = {
      ...(state.query.data as Record<string, unknown>),
      status: 'draft',
      shadowId: null,
      editTargetId: 'apl_draft',
    };
    renderWithProviders(<ListingMediaPage />);

    await expect.element(page.getByTestId('asset-step')).toBeInTheDocument();
    expect(page.getByTestId('apps-listing-media-mod-live-notice').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-listing-media-live-notice').elements()).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // The Submit affordance must follow the SAME discriminator as the notice.
  // -------------------------------------------------------------------------

  test('🔴 MOD + NO shadow: no dead Submit button and no "stage a revision" hint', async () => {
    // No edit by this moderator will ever mint a shadow, so `disabled={… || !shadowId}`
    // would leave Submit permanently dead beneath a banner correctly saying the change
    // is already live, next to a hint promising a revision that never appears.
    state.currentUser = { id: 1, username: 'mod', isModerator: true };
    state.query.data = {
      ...(state.query.data as Record<string, unknown>),
      shadowId: null,
      editTargetId: 'apl_onsite',
    };
    renderWithProviders(<ListingMediaPage />);

    await expect.element(page.getByTestId('asset-step')).toBeInTheDocument();
    expect(page.getByTestId('apps-listing-media-submit').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-listing-media-no-changes').elements()).toHaveLength(0);
  });

  test('🔴 MOD + shadow: Submit REMAINS — that revision still needs re-approval', async () => {
    // The mirror of the test above: hiding Submit on `isModerator` alone would strand a
    // real revision with no way to send it for review.
    state.currentUser = { id: 1, username: 'mod', isModerator: true };
    state.floor = { meetsFloor: true, complete: false };
    renderWithProviders(<ListingMediaPage />);

    const submit = page.getByTestId('apps-listing-media-submit');
    await expect.element(submit).toBeInTheDocument();
    await expect.element(submit).not.toBeDisabled();
  });

  test('Submit for review fires submitListingRevision with the shadow id', async () => {
    renderWithProviders(<ListingMediaPage />);
    await expect.element(page.getByTestId('apps-listing-media-submit')).toBeInTheDocument();
    await userEvent.click(page.getByTestId('apps-listing-media-submit'));
    await vi.waitFor(() => expect(state.submit.calls).toHaveLength(1));
    expect(state.submit.calls[0]).toEqual({ shadowId: 'apl_shadow' });
  });

  test('the Submit button is ENABLED when the step reports it meets the floor (icon+cover)', async () => {
    state.floor = { meetsFloor: true, complete: false };
    renderWithProviders(<ListingMediaPage />);
    const submit = page.getByTestId('apps-listing-media-submit');
    await expect.element(submit).toBeInTheDocument();
    await expect.element(submit).not.toBeDisabled();
  });

  test('the Submit button is DISABLED when the step reports it is below the floor', async () => {
    state.floor = { meetsFloor: false, complete: false };
    renderWithProviders(<ListingMediaPage />);
    const submit = page.getByTestId('apps-listing-media-submit');
    await expect.element(submit).toBeInTheDocument();
    await expect.element(submit).toBeDisabled();
  });

  test('shows the pending-revision notice when a revision is already under review', async () => {
    state.query = {
      data: {
        appListingId: 'apl_onsite',
        status: 'approved',
        contentRating: 'g',
        hasPendingRevision: true,
        shadowId: 'apl_shadow',
        editTargetId: 'apl_shadow',
        editBlockedReason: null,
      },
      isLoading: false,
      error: null,
    };
    renderWithProviders(<ListingMediaPage />);
    await expect
      .element(page.getByTestId('apps-listing-media-pending-revision-notice'))
      .toBeInTheDocument();
  });

  test('does NOT show the pending-revision notice when none is queued', async () => {
    renderWithProviders(<ListingMediaPage />);
    await expect.element(page.getByTestId('asset-step')).toBeInTheDocument();
    expect(page.getByTestId('apps-listing-media-pending-revision-notice').elements()).toHaveLength(0);
  });

  test('fails closed to NotFound when the owner resolve errors (non-owner / missing listing)', async () => {
    state.query = {
      data: undefined,
      isLoading: false,
      error: { message: 'you can only manage your own listings', data: { code: 'FORBIDDEN' } },
    };
    renderWithProviders(<ListingMediaPage />);
    await expect.element(page.getByTestId('not-found')).toBeInTheDocument();
    expect(page.getByTestId('asset-step').elements()).toHaveLength(0);
  });

  test('a NON-owner-gating error surfaces the inline alert instead of collapsing to NotFound', async () => {
    // Anything that isn't FORBIDDEN/NOT_FOUND arrives here as a settled query error.
    // Blanket-NotFound'ing it hid the one surface that explains it and told the owner
    // their LIVE app did not exist.
    state.query = {
      data: undefined,
      isLoading: false,
      error: { message: 'cannot edit a listing in status removed', data: { code: 'BAD_REQUEST' } },
    };
    renderWithProviders(<ListingMediaPage />);
    const alert = page.getByTestId('apps-listing-media-begin-error');
    await expect.element(alert).toBeInTheDocument();
    await expect.element(alert).toHaveTextContent(/cannot edit a listing in status removed/i);
    expect(page.getByTestId('not-found').elements()).toHaveLength(0);
  });

  test('re-pulls the projected assets after an asset mutation (stale-prefill guard)', async () => {
    renderWithProviders(<ListingMediaPage />);
    await expect.element(page.getByTestId('asset-step')).toBeInTheDocument();
    expect(state.invalidate).not.toHaveBeenCalled();

    // The step reports a successful attach/remove.
    await userEvent.click(page.getByTestId('asset-step-mutate'));

    // Without this the cached `assets` stay pre-mutation and the /edit page's
    // `keepMounted={false}` tab round-trip re-seeds the step from them — a just-
    // attached icon reads as unattached and Submit goes disabled again.
    await vi.waitFor(() => expect(state.invalidate).toHaveBeenCalledWith({ appBlockId: 'my-block' }));
  });

  test('a re-attached icon survives a tab round-trip: the REMOUNT re-seeds from the refreshed assets', async () => {
    // Start below the floor — the shadow has no icon yet.
    const before = {
      icon: { imageId: null as number | null, url: null as string | null },
      cover: { imageId: 137918011, url: 'edge:cover' },
      screenshots: [] as unknown[],
    };
    state.query = {
      data: {
        appListingId: 'apl_onsite',
        status: 'approved',
        contentRating: 'pg13',
        hasPendingRevision: false,
        shadowId: 'apl_shadow',
        editTargetId: 'apl_shadow',
        editBlockedReason: null,
        assets: before,
      },
      isLoading: false,
      error: null,
    };
    // The real `invalidate` refetches `getMyListingForApp`; stand in for that refetch
    // by publishing the post-attach projection the server would now return.
    state.invalidate.mockImplementation(async () => {
      (state.query.data as { assets: typeof before }).assets = {
        ...before,
        icon: { imageId: 555, url: 'edge:new-icon' },
      };
    });

    renderWithProviders(<TabRoundTrip />);
    await expect.element(page.getByTestId('asset-step-seeded-icon')).toHaveTextContent('none');

    // The step reports a successful icon attach.
    await userEvent.click(page.getByTestId('asset-step-mutate'));
    await vi.waitFor(() =>
      expect(state.invalidate).toHaveBeenCalledWith({ appBlockId: 'my-block' })
    );

    // media → manifest → media: the editor UNMOUNTS and REMOUNTS, and the step re-runs
    // its useState INITIALISERS against whatever `initial` holds now.
    await userEvent.click(page.getByTestId('tab-round-trip'));

    // Without the post-mutation invalidation the remount re-seeds from the ORIGINAL
    // cached assets: the just-attached icon reads as unattached, the publish floor is
    // unmet and Submit goes disabled again — the exact symptom this fix exists to kill.
    await expect.element(page.getByTestId('asset-step-seeded-icon')).toHaveTextContent('555');
  });

  test('a settled error does NOT also claim "this app is live" (no contradictory half-UI)', async () => {
    // A `removed` listing, an INTERNAL_SERVER_ERROR, or a client error with no
    // `data.code` all land here. Narrowing the NotFound guard (so the inline alert is
    // reachable) must not leave the blue live-app notice asserting context that never
    // resolved — "This app is live" directly above "cannot edit a listing in status
    // removed".
    state.query = {
      data: undefined,
      isLoading: false,
      error: { message: 'cannot edit a listing in status removed', data: { code: 'BAD_REQUEST' } },
    };
    renderWithProviders(<ListingMediaPage />);

    await expect.element(page.getByTestId('apps-listing-media-begin-error')).toBeInTheDocument();
    expect(page.getByTestId('apps-listing-media-live-notice').elements()).toHaveLength(0);
    expect(page.getByTestId('asset-step').elements()).toHaveLength(0);
  });
});
