import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../../test/component-setup';
import { useRouter } from 'next/router';

/**
 * PER-SUBMISSION REVIEW PAGE — route-shell render test (browser mode).
 *
 * Complements the SSR-gate node test (`review-detail-page-gate.test.ts`): this
 * drives the CLIENT shell of `/apps/review/<id>` and asserts the Phase-1 wiring —
 * it reads the `publishRequestId` prop, fetches the request, re-hosts the
 * extracted `OnsiteReviewModalBody` with the resolved `{ request, mode }`, wires
 * the Q6 redirect-to-queue `onClose`, and fails closed (NotFound) when the flag
 * is off / the fetch errors. The body itself is stubbed — its render is covered
 * by `OnsiteReviewModal.browser.test.tsx` (behaviour-preserving extraction).
 */

const state = vi.hoisted(() => ({
  // getPublishRequest.useQuery control object.
  query: { data: undefined as unknown, isLoading: false, isError: false, error: null as unknown },
  // Captured props the page passes to the (stubbed) review body.
  bodyProps: { last: null as null | { selection: any; onClose: () => void } },
  // Feature-flags the page sees (switchable per test).
  flags: { appBlocks: true, appReviewPage: true } as Record<string, boolean>,
}));

// The page's `getServerSideProps` calls createServerSideProps at module top —
// stub it so importing the page in a browser test doesn't pull the server graph.
vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: () => async () => ({ props: {} }),
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => state.flags,
}));

// Stub the extracted body/title so we assert the SHELL wiring (props + gate),
// not re-run the body's own covered behaviour.
vi.mock('~/components/Apps/OnsiteReviewModal', () => ({
  OnsiteReviewModalBody: (props: { selection: any; onClose: () => void }) => {
    state.bodyProps.last = props;
    return <div data-testid="review-body">body:{props.selection.request.id}:{props.selection.mode}</div>;
  },
  OnsiteReviewModalTitle: ({ selection }: { selection: any }) => (
    <div data-testid="review-title">{selection.request.slug}</div>
  ),
}));

// Pass-through layout so title/actions/children are all in the DOM.
vi.mock('~/components/Apps/AppsPageLayout', () => ({
  AppsPageLayout: ({ title, actions, children }: any) => (
    <div data-testid="layout">
      <div>{title}</div>
      <div>{actions}</div>
      <div>{children}</div>
    </div>
  ),
}));

vi.mock('~/components/AppLayout/NotFound', () => ({
  NotFound: () => <div data-testid="not-found">Not found</div>,
}));
vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));

vi.mock('~/utils/trpc', () => ({
  trpc: {
    blocks: {
      getPublishRequest: { useQuery: () => state.query },
    },
  },
}));

const ReviewDetailPage = (await import('~/pages/apps/review/[publishRequestId]')).default;

const REQUEST = {
  id: 'pubreq_1',
  slug: 'my-onsite-block',
  version: '1.2.0',
  submittedAt: new Date('2026-01-01T00:00:00Z'),
  bundleSizeBytes: '2048',
  submittedBy: { id: 7, username: 'dev-user', image: null },
  manifest: {},
  fileSummary: {},
  manifestDiffSummary: { kind: 'first-version', fields: [] },
  reviewRepoUrl: 'https://forgejo.example/repo',
};

beforeEach(() => {
  state.query = { data: undefined, isLoading: false, isError: false, error: null };
  state.bodyProps.last = null;
  state.flags = { appBlocks: true, appReviewPage: true };
});

describe('ReviewDetailPage — route shell', () => {
  test('renders the re-hosted review body with the resolved request + mode when the fetch resolves', async () => {
    state.query = {
      data: { mode: 'pending', request: REQUEST },
      isLoading: false,
      isError: false,
      error: null,
    };
    renderWithProviders(<ReviewDetailPage publishRequestId="pubreq_1" />);

    await expect.element(page.getByTestId('review-body')).toBeInTheDocument();
    // The body received the resolved request id + mode (proves the shell threads
    // the fetched `{ request, mode }` into the extracted body, not the modal).
    await expect.element(page.getByTestId('review-body')).toHaveTextContent('body:pubreq_1:pending');
    // The page header uses the shared modal title component.
    await expect.element(page.getByTestId('review-title')).toHaveTextContent('my-onsite-block');
    // No fail-closed surface on the happy path.
    expect(page.getByTestId('not-found').elements()).toHaveLength(0);
  });

  test('shows a loader (no body, no NotFound) while the fetch is in flight', async () => {
    state.query = { data: undefined, isLoading: true, isError: false, error: null };
    renderWithProviders(<ReviewDetailPage publishRequestId="pubreq_1" />);
    // Loading branch: neither the body nor the fail-closed surface is shown yet.
    expect(page.getByTestId('review-body').elements()).toHaveLength(0);
    expect(page.getByTestId('not-found').elements()).toHaveLength(0);
  });

  test('fails closed to NotFound (belt-and-suspenders) when the appReviewPage flag is off', async () => {
    state.flags = { appBlocks: true, appReviewPage: false };
    state.query = {
      data: { mode: 'pending', request: REQUEST },
      isLoading: false,
      isError: false,
      error: null,
    };
    renderWithProviders(<ReviewDetailPage publishRequestId="pubreq_1" />);
    await expect.element(page.getByTestId('not-found')).toBeInTheDocument();
    expect(page.getByTestId('review-body').elements()).toHaveLength(0);
  });

  test('fails closed to NotFound when the fetch errors (deleted between SSR resolve and fetch)', async () => {
    state.query = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: { message: 'NOT_FOUND' },
    };
    renderWithProviders(<ReviewDetailPage publishRequestId="pubreq_gone" />);
    await expect.element(page.getByTestId('not-found')).toBeInTheDocument();
    expect(page.getByTestId('review-body').elements()).toHaveLength(0);
  });

  test('Q6: the body onClose redirects to the review queue', async () => {
    state.query = {
      data: { mode: 'pending', request: REQUEST },
      isLoading: false,
      isError: false,
      error: null,
    };
    renderWithProviders(<ReviewDetailPage publishRequestId="pubreq_1" />);
    await expect.element(page.getByTestId('review-body')).toBeInTheDocument();

    // Fire the onClose the shell handed the body (what runs after approve/reject
    // success) and assert it navigates back to the queue.
    const push = vi.mocked((useRouter as any)()).push as ReturnType<typeof vi.fn>;
    push.mockClear();
    state.bodyProps.last?.onClose();
    expect(push).toHaveBeenCalledWith('/apps/review');
  });
});
