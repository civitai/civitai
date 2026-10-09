import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../../test/component-setup';
import { useRouter } from 'next/router';
import type * as UserAvatarMod from '~/components/UserAvatar/UserAvatar';
import type * as OnsiteReviewModalMod from '~/components/Apps/OnsiteReviewModal';
import type * as TrpcMod from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';

/**
 * REVIEW QUEUE dual-path row selection (Phase 1 migration) — browser mode.
 *
 * With the `appReviewPage` flag ON a row NAVIGATES to the deep-linkable detail
 * page `/apps/review/<id>`; with the flag OFF it opens the modal exactly as
 * before (the reversible dual-path). Asserts both branches on the pending queue.
 *
 * Heavy siblings (`AppListingsModerationTable`, `ActivePreviewsPanel`,
 * `OffsiteReportsQueue`) + the review modal are stubbed so this isolates the
 * QUEUE's selection behaviour; `formatBytes`/`formatDate` are kept REAL (via
 * `importOriginal`) so the row renders faithfully.
 */

const state = vi.hoisted(() => ({
  flags: { appBlocks: true, appReviewPage: true } as Record<string, boolean>,
  subListingCount: 0,
  flaggedCount: 0,
}));

// Page's getServerSideProps calls createServerSideProps at module top — stub so
// importing the page doesn't pull the server graph into the browser bundle.
vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: () => async () => ({ props: {} }),
}));

// 🔴 ALL THREE HOOKS, because this factory REPLACES the module. The queue page's row now
// renders the review entry point, which reads flags through `useOptionalFeatureFlags`
// (the non-throwing variant, correct outside a provider). A factory naming only
// `useFeatureFlags` left that named import nothing to bind to:
//   SyntaxError: The requested module '/src/providers/FeatureFlagsProvider.tsx'
//   does not provide an export named 'useOptionalFeatureFlags'
// and in BROWSER mode that does not fail this file — it takes down the whole run. The
// factory is resolved over the browser<->node channel inside a Playwright route handler
// that does not catch, so the rejection escapes as an Unhandled Rejection in the
// orchestrator: no summary, no per-file results, zero tests collected, exit 1. This one
// file zeroed the entire `preview / component-tests` tier.
//
// 🔴 So the rule is EVERY RUNTIME EXPORT the module has, not "the ones we know about".
// `useFeatureFlagsReady` is the third hook (`src/providers/FeatureFlagsProvider.tsx:36`), with
// four live consumers — useChatEnabled, useFeatureNotice, NavCustomizeNotice,
// YellowBuzzMigrationNotice — and `FeatureFlagsProvider` itself is the fourth export
// (`:37`, imported today only by `src/pages/_app.tsx`). Neither is in this page's graph TODAY,
// which is the only reason naming fewer would still load — and "not in this graph today" is
// precisely the reasoning that put this file in the diff. So name all four.
// The flag hooks return the SAME flags: the gate must be decided by this fixture, not by
// which of them a component happens to call.
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => state.flags,
  useOptionalFeatureFlags: () => state.flags,
  useFeatureFlagsReady: () => true,
  FeatureFlagsProvider: ({ children }: { children: unknown }) => children,
}));

// Stub the modal component (assert whether a selection opened it) but keep the
// real byte/date formatters + request types the queue table depends on.
vi.mock('~/components/Apps/OnsiteReviewModal', async (importOriginal) => {
  const actual = await importOriginal<typeof OnsiteReviewModalMod>();
  return {
    ...actual,
    OnsiteReviewModal: ({ selection }: { selection: { request: { slug: string } } | null }) =>
      selection ? <div data-testid="modal-open">{selection.request.slug}</div> : null,
  };
});

// Pass-through layout — the real one renders the rail → `useAppsNavSections` → `useCurrentUser`,
// which needs the CivitaiSession context this network-free test doesn't mount.
vi.mock('~/components/Apps/AppsPageLayout', () => ({
  AppsPageLayout: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('~/components/Apps/AppListingsModerationTable', () => ({
  AppListingsModerationTable: () => null,
}));
vi.mock('~/components/Apps/ActivePreviewsPanel', () => ({ ActivePreviewsPanel: () => null }));
// The off-site review modal is now PAGE-OWNED (rendered by the page) — stub it + the
// reports queue so this test isolates the on-site pending queue's selection path.
// NOTE: this is a WHOLESALE module mock, so it must re-stub EVERY export of
// `OffsiteReviewQueue.tsx` that anything in the page's graph statically imports —
// `CombinedReviewModal` imports `OffsiteReviewModalBody` from here. Miss one and the
// file's ESM link fails ("does not provide an export named ...") and it collects 0 tests.
vi.mock('~/components/Apps/OffsiteReviewQueue', () => ({
  OffsiteReportsQueue: () => null,
  OffsiteReviewModal: () => null,
  OffsiteReviewModalBody: () => null,
}));
vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));
// Stubbed: the real `UserAvatar` reaches providers this network-free test does not mount.
// Precedent: `~/components/Reaction/ImageReactorsPreview.browser.test.tsx`.
vi.mock('~/components/UserAvatar/UserAvatar', async (importOriginal) => ({
  ...(await importOriginal<typeof UserAvatarMod>()),
  UserAvatar: ({ user }: { user: { id: number; username?: string | null } }) => (
    <span>{user.username ?? `#${user.id}`}</span>
  ),
}));

const PENDING = {
  id: 'onsite-req-1',
  appBlockId: null,
  slug: 'my-onsite-block',
  version: '1.2.0',
  submittedAt: new Date('2026-01-01T00:00:00Z'),
  bundleSizeBytes: '2048',
  bundleSha256: 'abc',
  manifest: {},
  fileSummary: {
    files: [{ path: 'index.js', sha256: 'x', sizeBytes: 10 }],
    added: [],
    removed: [],
    changed: [],
  },
  manifestDiffSummary: { kind: 'first-version', fields: [] },
  reviewRepoUrl: 'https://forgejo.example/repo',
  pushCommitUrl: null,
  submittedBy: { id: 7, username: 'dev-user', deletedAt: null, image: null },
};

const inert = { invalidate: vi.fn() };
const emptyQuery = () => ({
  data: { items: [], nextCursor: null },
  isLoading: false,
  isFetching: false,
  isError: false,
  error: null,
});
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: makeTrpcProxy(
    {
      'blocks.listPendingRequests': {
        useQuery: () => ({
          data: { items: [PENDING], nextCursor: null },
          isLoading: false,
          isFetching: false,
          isError: false,
          error: null,
        }),
      },
      'blocks.listApprovedRequests': { useQuery: emptyQuery },
      'blocks.listRejectedRequests': { useQuery: emptyQuery },
      // The page mounts `PriorVersionsModal`, whose read is `enabled`-gated but whose
      // HOOK still runs on every render.
      'blocks.listVersionHistory': { useQuery: emptyQuery },
      // The unified pending queue also reads the OFF-SITE pending source; return an
      // empty page so this test isolates the single on-site row's selection path.
      'appListings.listPendingRequests': { useQuery: emptyQuery },
      'appListings.listApprovedRequests': { useQuery: emptyQuery },
      'appListings.listRejectedRequests': { useQuery: emptyQuery },
      // The Sub-listings tab label's pending count runs on every render of the page.
      'appListings.countSubListingQueue': {
        useQuery: () => ({ data: { count: state.subListingCount } }),
      },
      'appFeedback.modCountFlagged': { useQuery: () => ({ data: state.flaggedCount }) },
    },
    {
      useUtils: () => ({
        blocks: {
          listPendingRequests: inert,
          listApprovedRequests: inert,
          listRejectedRequests: inert,
        },
        appListings: {
          listPendingRequests: inert,
          listApprovedRequests: inert,
          listRejectedRequests: inert,
        },
      }),
    }
  ),
}));

const ReviewQueuePage = (await import('~/pages/apps/review')).default;

// The global `next/router` mock returns one router object; read it outside React through an
// alias so the hook rule does not mistake this helper for a component.
const readRouter = useRouter;
function routerPush() {
  return (readRouter() as unknown as { push: ReturnType<typeof vi.fn> }).push;
}

function routerState() {
  return readRouter() as unknown as { query: Record<string, string> };
}

beforeEach(() => {
  state.flags = { appBlocks: true, appReviewPage: true };
  state.subListingCount = 0;
  state.flaggedCount = 0;
  routerState().query = {};
  routerPush().mockClear();
});

describe('ReviewQueuePage — App feedback tab', () => {
  test('a moderator gets the tab, with the flagged count on its label', async () => {
    state.flaggedCount = 3;
    renderWithProviders(<ReviewQueuePage canMonitorAppFeedback />);
    await expect.element(page.getByRole('tab', { name: /App feedback/ })).toBeInTheDocument();
    await expect.element(page.getByTestId('app-feedback-flagged-count')).toHaveTextContent('3');
  });

  test('?tab=app-feedback opens it for a moderator', async () => {
    routerState().query = { tab: 'app-feedback' };
    renderWithProviders(<ReviewQueuePage canMonitorAppFeedback />);
    await expect
      .element(page.getByRole('tab', { name: /App feedback/ }))
      .toHaveAttribute('aria-selected', 'true');
  });

  test('without it: no tab, and ?tab=app-feedback lands on Pending', async () => {
    routerState().query = { tab: 'app-feedback' };
    renderWithProviders(<ReviewQueuePage />);
    await expect
      .element(page.getByRole('tab', { name: /Pending/ }))
      .toHaveAttribute('aria-selected', 'true');
    expect(page.getByRole('tab', { name: /App feedback/ }).elements()).toHaveLength(0);
  });
});

describe('ReviewQueuePage — Sub-listings tab', () => {
  test('shows the pending store-item count on the tab label', async () => {
    state.subListingCount = 4;
    renderWithProviders(<ReviewQueuePage />);
    const tab = page.getByRole('tab', { name: /Sub-listings/ });
    await expect.element(tab).toBeInTheDocument();
    await expect.element(page.getByTestId('sub-listing-pending-count')).toHaveTextContent('4');
  });

  test('shows no count badge when nothing is waiting', async () => {
    renderWithProviders(<ReviewQueuePage />);
    await expect.element(page.getByRole('tab', { name: /Sub-listings/ })).toBeInTheDocument();
    expect(page.getByTestId('sub-listing-pending-count').elements()).toHaveLength(0);
  });
});

describe('ReviewQueuePage — dual-path row selection', () => {
  test('flag ON: clicking a pending row NAVIGATES to /apps/review/<id> (no modal)', async () => {
    state.flags = { appBlocks: true, appReviewPage: true };
    renderWithProviders(<ReviewQueuePage />);

    const reviewBtn = page.getByRole('button', { name: 'Review' });
    await expect.element(reviewBtn).toBeInTheDocument();
    await userEvent.click(reviewBtn);

    expect(routerPush()).toHaveBeenCalledWith('/apps/review/onsite-req-1');
    // No modal opened on the page path.
    expect(page.getByTestId('modal-open').elements()).toHaveLength(0);
  });

  test('flag OFF: clicking a pending row OPENS the modal (no navigation)', async () => {
    state.flags = { appBlocks: true, appReviewPage: false };
    renderWithProviders(<ReviewQueuePage />);

    const reviewBtn = page.getByRole('button', { name: 'Review' });
    await expect.element(reviewBtn).toBeInTheDocument();
    await userEvent.click(reviewBtn);

    // Modal opened with the selected request; NO navigation to the detail page.
    await expect.element(page.getByTestId('modal-open')).toHaveTextContent('my-onsite-block');
    expect(routerPush()).not.toHaveBeenCalledWith('/apps/review/onsite-req-1');
  });
});
