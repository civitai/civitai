import { useRouter } from 'next/router';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { LOADABLE_IMAGE_DATA_URI, renderWithProviders } from '../../../test/component-setup';
import type * as UserAvatarMod from '~/components/UserAvatar/UserAvatar';
import type * as NotificationsModule from '~/utils/notifications';
import { REVIEW_COVER_W, REVIEW_ICON_BOX } from '~/components/Apps/ListingMediaThumb';

/**
 * `ReviewDetailView` — the per-submission review PAGE body (`/apps/review/<id>`),
 * factored out of the page module so it is browser-testable without the server
 * graph. This is the page-specific action + a11y layer (Phase 2.3):
 *  - the approve/reject controls render in a STICKY bottom bar (not inline);
 *  - focus moves to the main review region on mount (a page has no focus trap);
 *  - an aria-live region announces mutation-status transitions;
 *  - a route-leave guard registers while an approve/reject is in flight.
 * Drives the real click → mutation → redirect path, not just a mount.
 */

const PENDING = {
  id: 'req-1',
  appBlockId: null as string | null,
  slug: 'my-block',
  version: '1.2.0',
  submittedAt: new Date('2026-01-01T00:00:00Z'),
  bundleSizeBytes: '2048',
  bundleSha256: 'abc',
  manifest: {
    name: 'My Block',
    blockId: 'blk_1',
    version: '1.2.0',
    scopes: ['user:read'],
    targets: [{ slotId: 'model.sidebar_top', priority: 10 }],
  },
  fileSummary: { files: [], added: [], removed: [], changed: [] },
  manifestDiffSummary: { kind: 'first-version', fields: ['name'] },
  reviewRepoUrl: 'https://forgejo.example/repo',
  pushCommitUrl: null as string | null,
  submittedBy: { id: 7, username: 'dev-user', deletedAt: null, image: null },
};

const APPROVED = {
  ...PENDING,
  id: 'req-2',
  slug: 'approved-block',
  reviewedAt: new Date('2026-01-02T00:00:00Z'),
  approvalNotes: 'looks good',
  reviewedBy: { id: 99, username: 'mod-user', deletedAt: null, image: null },
};

const mocks = vi.hoisted(() => ({
  invalidate: vi.fn().mockResolvedValue(undefined),
  mutate: vi.fn(),
  errorMode: false,
  reviewStatus: undefined as unknown,
  pending: false,
}));

/*
  🔴 `UserAvatar` IS STUBBED, AND IT IS A NEW DEPENDENCY OF THIS TREE. The shared review
  body's submitter line now renders the SAME avatar chip the queue list does, and the real
  component reaches `trpc.user.getById`, `useCurrentUser`,
  `useViewerBrowsingLevelDebounced` and `useBrowsingSettings` — none of which this harness
  mounts, so it throws and blanks the whole render. The stub keeps the only contract this
  suite cares about (WHICH user, and whether it links) and the real component is exercised
  for real in `ReviewSubmitterMeta.browser.test.tsx`. Precedent:
  `UnifiedReviewList.browser.test.tsx`, for the same component and the same reason.
*/
vi.mock('~/components/UserAvatar/UserAvatar', async (importOriginal) => ({
  ...(await importOriginal<typeof UserAvatarMod>()),
  UserAvatar: ({
    user,
    linkToProfile,
  }: {
    user: { id: number; username?: string | null };
    linkToProfile?: boolean;
  }) =>
    linkToProfile ? (
      <a href={`/user/${user.username ?? user.id}`} data-testid="submitter-link">
        {user.username ?? '[deleted]'}
      </a>
    ) : (
      <span>{user.username ?? '[deleted]'}</span>
    ),
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true }),
}));

vi.mock('~/components/Apps/ReviewBlockPreviewHost', () => ({
  ReviewBlockPreviewHost: () => <div data-testid="review-host-stub" />,
}));

const showError = vi.fn();
/*
  🔴 SPREAD THE ORIGINAL, never a one-key factory. A factory that omits an export fails the
  WHOLE FILE at import the day anything in its graph starts calling it — and vitest reports
  that as 0 tests collected, not as a failing assertion, so it reads as a skipped file. This
  PR hit it four times at once: the panel gained a `showWarningNotification` call and every
  suite listing only two exports stopped importing. `local-rules/no-wholesale-module-mock`
  reds on the narrow form.
*/
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsModule>()),
  showSuccessNotification: vi.fn(),
  showErrorNotification: (...a: unknown[]) => showError(...a),
}));

vi.mock('~/utils/trpc', () => {
  const mutation =
    (name: string) =>
    (opts?: { onSuccess?: () => void; onError?: (e: { message: string }) => void }) => ({
      mutate: (vars: unknown) => {
        mocks.mutate(name, vars);
        if (mocks.errorMode) opts?.onError?.({ message: 'boom' });
        else void opts?.onSuccess?.();
      },
      mutateAsync: vi.fn(),
      isPending: mocks.pending,
    });
  const inert = { invalidate: mocks.invalidate };
  const utils = {
    blocks: {
      listPendingRequests: inert,
      listApprovedRequests: inert,
      listRejectedRequests: inert,
      getReviewStatus: inert,
      listActivePreviews: inert,
      getMarketplaceMeta: inert,
      getFeaturedBlocks: inert,
      listAvailable: inert,
    },
  };
  return {
    trpc: {
      useUtils: () => utils,
      blocks: {
        approveRequest: { useMutation: mutation('approve') },
        rejectRequest: { useMutation: mutation('reject') },
        getReviewStatus: {
          useQuery: () => ({ data: mocks.reviewStatus, isLoading: false, error: null }),
        },
        previewRequest: { useMutation: mutation('preview') },
        teardownPreview: { useMutation: mutation('teardown') },
        getPublishRequestScreenshots: {
          useQuery: () => ({ data: { items: [] }, isLoading: false, error: null }),
        },
        getPublishRequestDiff: {
          useQuery: () => ({ data: undefined, isLoading: false, error: null }),
        },
        getMarketplaceMeta: {
          useQuery: () => ({ data: undefined, isLoading: false, isError: false, error: null }),
        },
        setMarketplaceMeta: { useMutation: mutation('setMeta') },
      },
    },
  };
});

const { ReviewDetailView } = await import('./ReviewDetailView');
const router = useRouter();

beforeEach(() => {
  mocks.invalidate.mockClear();
  mocks.mutate.mockClear();
  mocks.errorMode = false;
  mocks.reviewStatus = undefined;
  mocks.pending = false;
  showError.mockClear();
  (router.events.on as any).mockClear();
  (router.beforePopState as any).mockClear();
  (router.push as any).mockClear();
  (router.push as any).mockResolvedValue(true);
  (router.replace as any).mockClear();
  // No `?tab=` ⇒ the default (Permissions). Reset per test so one case's deep link cannot
  // leak into the next — the scaffold's router is a shared singleton.
  router.query = {};
  router.pathname = '/apps/review/[publishRequestId]';
});

describe('ReviewDetailView — sticky action bar', () => {
  test('a pending submission renders the review body AND the pinned approve/reject action bar', async () => {
    renderWithProviders(
      <ReviewDetailView selection={{ request: PENDING, mode: 'pending' }} onClose={vi.fn()} />
    );
    // Body content is present. ⚠️ The assertion moved from `getByText('Show code diff')` to
    // the PERMISSIONS card when the page became tabbed: the code-diff affordance now lives
    // in the Code tab, and the default tab is Permissions. The point of the assertion is
    // unchanged — the shared review body rendered something — and the tab mechanics
    // themselves are covered in `ReviewDetailTabs.browser.test.tsx`.
    await expect.element(page.getByTestId('apps-review-permissions')).toBeInTheDocument();
    // The pinned action bar (labelled group) with both terminal actions.
    const bar = page.getByRole('group', { name: 'Review actions' });
    await expect.element(bar).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Approve + build' })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Reject…' })).toBeInTheDocument();
  });

  test('a read-only approved submission renders NO action bar', async () => {
    renderWithProviders(
      <ReviewDetailView selection={{ request: APPROVED, mode: 'approved' }} onClose={vi.fn()} />
    );
    await expect.element(page.getByText('Approved by @mod-user')).toBeInTheDocument();
    expect(page.getByRole('group', { name: 'Review actions' }).elements()).toHaveLength(0);
    expect(page.getByRole('button', { name: 'Approve + build' }).elements()).toHaveLength(0);
  });
});

describe('ReviewDetailView — focus management', () => {
  test('focus moves to the labelled main review region on mount (not left on <body>)', async () => {
    renderWithProviders(
      <ReviewDetailView selection={{ request: PENDING, mode: 'pending' }} onClose={vi.fn()} />
    );
    const region = page.getByRole('region', { name: /Review of my-block v1\.2\.0/ });
    await expect.element(region).toBeInTheDocument();
    const regionEl = region.element();
    await vi.waitFor(() => expect(document.activeElement).toBe(regionEl));
  });
});

describe('ReviewDetailView — approve fires the mutation and redirects', () => {
  test('clicking Approve + build fires blocks.approveRequest and invokes onClose (redirect to queue)', async () => {
    const onClose = vi.fn();
    renderWithProviders(
      <ReviewDetailView selection={{ request: PENDING, mode: 'pending' }} onClose={onClose} />
    );
    await page.getByRole('button', { name: 'Approve + build' }).click();
    expect(mocks.mutate).toHaveBeenCalledWith(
      'approve',
      expect.objectContaining({ publishRequestId: 'req-1' })
    );
    expect(onClose).toHaveBeenCalled();
  });

  test('reject goes through the reason gate then fires blocks.rejectRequest with the trimmed reason', async () => {
    renderWithProviders(
      <ReviewDetailView selection={{ request: PENDING, mode: 'pending' }} onClose={vi.fn()} />
    );
    await page.getByRole('button', { name: 'Reject…' }).click();
    const confirm = page.getByTestId('apps-review-reject-confirm');
    await expect.element(confirm).toBeDisabled();
    await page.getByTestId('apps-review-reject-reason').fill('needs changes');
    await expect.element(confirm).toBeEnabled();
    await confirm.click();
    expect(mocks.mutate).toHaveBeenCalledWith('reject', {
      publishRequestId: 'req-1',
      rejectionReason: 'needs changes',
    });
  });
});

describe('ReviewDetailView — aria-live status region', () => {
  test('announces "approved" after a successful approve', async () => {
    // onClose is a spy (no real navigation) so the component stays mounted and the
    // live region can be asserted post-success.
    renderWithProviders(
      <ReviewDetailView selection={{ request: PENDING, mode: 'pending' }} onClose={vi.fn()} />
    );
    const live = page.getByTestId('apps-review-status-live');
    // Wait for the async mount before touching the element (browser mode commits
    // asynchronously); idle → empty.
    await expect.element(live).toBeInTheDocument();
    expect(live.element().textContent).toBe('');
    await page.getByRole('button', { name: 'Approve + build' }).click();
    await vi.waitFor(() => expect(live.element().textContent).toContain('Submission approved'));
  });

  test('announces "submitting" while a mutation is in flight', async () => {
    mocks.pending = true;
    renderWithProviders(
      <ReviewDetailView selection={{ request: PENDING, mode: 'pending' }} onClose={vi.fn()} />
    );
    const live = page.getByTestId('apps-review-status-live');
    await vi.waitFor(() =>
      expect(live.element().textContent).toContain('Submitting the review decision')
    );
  });
});

describe('ReviewDetailView — route-leave guard', () => {
  test('registers a routeChangeStart guard while an approve/reject mutation is in flight', async () => {
    mocks.pending = true;
    renderWithProviders(
      <ReviewDetailView selection={{ request: PENDING, mode: 'pending' }} onClose={vi.fn()} />
    );
    // The action bar reports "submitting" → the view arms the navigation guard.
    await vi.waitFor(() => {
      const regs = (router.events.on as any).mock.calls.filter(
        (c: unknown[]) => c[0] === 'routeChangeStart'
      );
      expect(regs.length).toBeGreaterThanOrEqual(1);
    });
  });

  test('does NOT register a routeChangeStart guard when idle', async () => {
    renderWithProviders(
      <ReviewDetailView selection={{ request: PENDING, mode: 'pending' }} onClose={vi.fn()} />
    );
    await expect.element(page.getByRole('button', { name: 'Approve + build' })).toBeInTheDocument();
    const regs = (router.events.on as any).mock.calls.filter(
      (c: unknown[]) => c[0] === 'routeChangeStart'
    );
    expect(regs).toHaveLength(0);
  });

  test('never clobbers the app-global beforePopState, even while a mutation is in flight', async () => {
    // The reworked guard sits on useCatchNavigation, which does NOT touch the
    // single-slot router.beforePopState (owned app-wide by RoutedDialogProvider).
    // The old hand-rolled guard overwrote it with () => false while armed — this
    // locks that regression out at the integration level.
    mocks.pending = true;
    renderWithProviders(
      <ReviewDetailView selection={{ request: PENDING, mode: 'pending' }} onClose={vi.fn()} />
    );
    await vi.waitFor(() => {
      const regs = (router.events.on as any).mock.calls.filter(
        (c: unknown[]) => c[0] === 'routeChangeStart'
      );
      expect(regs.length).toBeGreaterThanOrEqual(1);
    });
    // Armed, yet beforePopState was never called.
    expect(router.beforePopState).not.toHaveBeenCalled();
  });

  test('a successful approve redirects to /apps/review and the guard does NOT abort its own redirect', async () => {
    // Make the mocked router.push behave like the real pages-router: it fires
    // routeChangeStart at every registered handler. If the leave-guard treated
    // this programmatic redirect as a user navigation it would prompt/throw here
    // and strand the mod on the detail page — the exact bug this rework fixes.
    const emitRouteChangeStart = (url: string) => {
      for (const [evt, handler] of (router.events.on as any).mock.calls) {
        if (evt === 'routeChangeStart') (handler as (u: string) => void)(url);
      }
    };
    (router.push as any).mockImplementation(async (url: unknown) => {
      emitRouteChangeStart(typeof url === 'string' ? url : String(url));
      return true;
    });
    // If the guard wrongly treated the redirect as a user nav it would consult
    // window.confirm; it must not.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    renderWithProviders(
      <ReviewDetailView
        selection={{ request: PENDING, mode: 'pending' }}
        onClose={() => void router.push('/apps/review')}
      />
    );
    await page.getByRole('button', { name: 'Approve + build' }).click();
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith('/apps/review'));
    // The programmatic redirect was NOT treated as a user navigation.
    expect(confirmSpy).not.toHaveBeenCalled();

    confirmSpy.mockRestore();
  });
});

describe('ReviewDetailView — the STORE LISTING media section', () => {
  /**
   * 🔴 THESE ARE DIFFERENT BYTES FROM THE BUNDLE SCREENSHOTS THE SHARED BODY ALREADY SHOWS.
   * The icon and cover are `AppListing` columns, authored in the store form and never in
   * the submitted ZIP, so a moderator approving a first version was approving an app whose
   * store card they had not seen.
   */
  const PIXEL = LOADABLE_IMAGE_DATA_URI;

  /**
   * ⚠️ THE SECTION MOVED INTO THE `Preview` TAB, so every case here selects that tab first.
   * That is not a weakening: the panel is only reachable from there now, so a test that did
   * not navigate would be asserting against a surface no mod can see.
   *
   * 🔴 VIA `router.query`, NOT A CLICK, and that is a property of the design rather than a
   * harness workaround. The active tab is derived from `?tab=` with NO local copy — one
   * source of truth — so the scaffold's `router.replace` (a `vi.fn()` that does not mutate
   * `query`) cannot move it. Setting the query is also the more faithful test: it exercises
   * the DEEP LINK a mod actually receives. The click half — that selecting a tab REWRITES
   * the URL — is asserted in `ReviewDetailTabs.browser.test.tsx`. Precedent:
   * `AppActivityPage.browser.test.tsx`, same split for the same reason.
   */
  beforeEach(() => {
    router.query = { tab: 'preview' };
  });

  test('both assets render as sized images, and NEITHER missing-state appears', async () => {
    renderWithProviders(
      <ReviewDetailView
        selection={{
          request: { ...PENDING, iconUrl: PIXEL, coverUrl: `${PIXEL}#cover` },
          mode: 'pending',
        }}
        onClose={vi.fn()}
      />
    );
    await expect.element(page.getByTestId('apps-review-listing-media')).toBeInTheDocument();
    const icon = page.getByTestId('apps-review-listing-icon-my-block');
    const cover = page.getByTestId('apps-review-listing-cover-my-block');
    await expect.element(icon).toBeInTheDocument();
    await expect.element(cover).toBeInTheDocument();
    // The box is reserved before the bytes land — a review page with two images is
    // otherwise a CLS machine.
    //
    // 🔴 THE REVIEW BOX, NOT THE TABLE-ROW ONE. These used to read 40 and 96, which are the
    // sizes `/apps/mine` and the review QUEUE need for a row. On this page the media is the
    // store card a moderator is approving, and a 40px icon cannot be judged — so the page
    // asks for `size="review"` and the reservation moves with it. Imported rather than
    // retyped, so the two cannot drift: the point of the assertion is that the box is
    // DECLARED on the attributes at all, and the sizes themselves are pinned against the
    // row constants in `ReviewListingMedia.size.geometry.test.tsx`.
    expect((icon.element() as HTMLImageElement).getAttribute('width')).toBe(
      String(REVIEW_ICON_BOX)
    );
    expect((cover.element() as HTMLImageElement).getAttribute('width')).toBe(
      String(REVIEW_COVER_W)
    );
    expect(page.getByTestId('apps-review-listing-no-icon-my-block').elements()).toEqual([]);
    expect(page.getByTestId('apps-review-listing-no-cover-my-block').elements()).toEqual([]);
  });

  test('a listing with NO media says so explicitly, rather than rendering empty boxes', async () => {
    // A pending first version usually HAS a pre-approval draft listing, but not always,
    // and "no icon" is a fact the reviewer needs rather than a blank.
    renderWithProviders(
      <ReviewDetailView selection={{ request: PENDING, mode: 'pending' }} onClose={vi.fn()} />
    );
    await expect
      .element(page.getByTestId('apps-review-listing-no-icon-my-block'))
      .toHaveTextContent('No icon');
    await expect
      .element(page.getByTestId('apps-review-listing-no-cover-my-block'))
      .toHaveTextContent('No cover');
    // Same-sized placeholders, so a listing with one asset does not shift the other.
    await expect
      .element(page.getByTestId('apps-review-listing-icon-placeholder-my-block'))
      .toBeInTheDocument();
    await expect
      .element(page.getByTestId('apps-review-listing-cover-placeholder-my-block'))
      .toBeInTheDocument();
    expect(page.getByTestId('apps-review-listing-icon-my-block').elements()).toEqual([]);
    // Nothing to view → no button, so no dead tab stop on an incomplete listing.
    expect(page.getByTestId('apps-review-listing-icon-button-my-block').elements()).toEqual([]);
    expect(page.getByTestId('apps-review-listing-cover-button-my-block').elements()).toEqual([]);
  });

  test('ONE asset present renders that image AND the other missing-state', async () => {
    // The mixed case is the one a single boolean would get wrong.
    renderWithProviders(
      <ReviewDetailView
        selection={{ request: { ...PENDING, coverUrl: PIXEL }, mode: 'pending' }}
        onClose={vi.fn()}
      />
    );
    await expect
      .element(page.getByTestId('apps-review-listing-cover-my-block'))
      .toBeInTheDocument();
    await expect
      .element(page.getByTestId('apps-review-listing-no-icon-my-block'))
      .toBeInTheDocument();
    expect(page.getByTestId('apps-review-listing-no-cover-my-block').elements()).toEqual([]);
  });

  test('clicking an asset opens the same viewer the queue uses', async () => {
    renderWithProviders(
      <ReviewDetailView
        selection={{ request: { ...PENDING, iconUrl: PIXEL }, mode: 'pending' }}
        onClose={vi.fn()}
      />
    );
    await page.getByTestId('apps-review-listing-icon-button-my-block').click();
    // The shared `AppListingScreenshotViewer`, which is where prev/next and the
    // broken-shot rescue live — so the two surfaces cannot drift on either.
    await expect.element(page.getByText('My Block icon')).toBeInTheDocument();
  });
});
