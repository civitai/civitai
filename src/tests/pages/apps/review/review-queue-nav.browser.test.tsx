import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../../test/component-setup';
import { useRouter } from 'next/router';

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
}));

// Page's getServerSideProps calls createServerSideProps at module top — stub so
// importing the page doesn't pull the server graph into the browser bundle.
vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: () => async () => ({ props: {} }),
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => state.flags,
}));

// Stub the modal component (assert whether a selection opened it) but keep the
// real byte/date formatters + request types the queue table depends on.
vi.mock('~/components/Apps/OnsiteReviewModal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/components/Apps/OnsiteReviewModal')>();
  return {
    ...actual,
    OnsiteReviewModal: ({ selection }: { selection: { request: { slug: string } } | null }) =>
      selection ? <div data-testid="modal-open">{selection.request.slug}</div> : null,
  };
});

// Pass-through layout — the real one renders `AppsSubNav` → `useCurrentUser`,
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

const PENDING = {
  id: 'onsite-req-1',
  appBlockId: null,
  slug: 'my-onsite-block',
  version: '1.2.0',
  submittedAt: new Date('2026-01-01T00:00:00Z'),
  bundleSizeBytes: '2048',
  bundleSha256: 'abc',
  manifest: {},
  fileSummary: { files: [{ path: 'index.js', sha256: 'x', sizeBytes: 10 }], added: [], removed: [], changed: [] },
  manifestDiffSummary: { kind: 'first-version', fields: [] },
  reviewRepoUrl: 'https://forgejo.example/repo',
  pushCommitUrl: null,
  submittedBy: { id: 7, username: 'dev-user', image: null },
};

const inert = { invalidate: vi.fn() };
const emptyQuery = () => ({
  data: { items: [], nextCursor: null },
  isLoading: false,
  isFetching: false,
  isError: false,
  error: null,
});
vi.mock('~/utils/trpc', () => ({
  trpc: {
    useUtils: () => ({
      blocks: { listPendingRequests: inert, listApprovedRequests: inert, listRejectedRequests: inert },
      appListings: { listPendingRequests: inert, listApprovedRequests: inert, listRejectedRequests: inert },
    }),
    blocks: {
      listPendingRequests: {
        useQuery: () => ({
          data: { items: [PENDING], nextCursor: null },
          isLoading: false,
          isFetching: false,
          isError: false,
          error: null,
        }),
      },
      listApprovedRequests: { useQuery: emptyQuery },
      listRejectedRequests: { useQuery: emptyQuery },
    },
    // The unified pending queue also reads the OFF-SITE pending source; return an
    // empty page so this test isolates the single on-site row's selection path.
    appListings: {
      listPendingRequests: { useQuery: emptyQuery },
      listApprovedRequests: { useQuery: emptyQuery },
      listRejectedRequests: { useQuery: emptyQuery },
    },
  },
}));

const ReviewQueuePage = (await import('~/pages/apps/review')).default;

function routerPush() {
  return (useRouter() as unknown as { push: ReturnType<typeof vi.fn> }).push;
}

beforeEach(() => {
  state.flags = { appBlocks: true, appReviewPage: true };
  routerPush().mockClear();
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
