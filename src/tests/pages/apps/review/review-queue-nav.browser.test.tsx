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
vi.mock('~/components/Apps/OffsiteReviewQueue', () => ({ OffsiteReportsQueue: () => null }));
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
vi.mock('~/utils/trpc', () => ({
  trpc: {
    useUtils: () => ({ blocks: { listPendingRequests: inert, listApprovedRequests: inert, listRejectedRequests: inert } }),
    blocks: {
      listPendingRequests: {
        useQuery: () => ({ data: { items: [PENDING] }, isLoading: false, isError: false, error: null }),
      },
      listApprovedRequests: {
        useQuery: () => ({ data: { items: [] }, isLoading: false, isError: false, error: null }),
      },
      listRejectedRequests: {
        useQuery: () => ({ data: { items: [] }, isLoading: false, isError: false, error: null }),
      },
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
