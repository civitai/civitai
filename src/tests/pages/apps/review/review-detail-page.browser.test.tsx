import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { LOADABLE_IMAGE_DATA_URI, renderWithProviders } from '../../../../../test/component-setup';
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
  // Every `selection` IDENTITY the page has handed the body, in order — so a test can ask
  // whether the object was rebuilt rather than whether it merely looks the same.
  selections: [] as unknown[],
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
// not re-run the body's own covered behaviour. The page renders the review body
// via `ReviewDetailView` (which owns the real approve/reject `ReviewActionBar`,
// covered by its own tests); stub it so this shell test doesn't pull that live
// trpc-backed action bar. The title still comes from `OnsiteReviewModal`.
vi.mock('~/components/Apps/ReviewDetailView', () => ({
  ReviewDetailView: (props: { selection: any; onClose: () => void }) => {
    state.bodyProps.last = props;
    state.selections.push(props.selection);
    return (
      <div data-testid="review-body">
        body:{props.selection.request.id}:{props.selection.mode}
      </div>
    );
  },
}));
vi.mock('~/components/Apps/OnsiteReviewModal', () => ({
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
  submittedBy: { id: 7, username: 'dev-user', deletedAt: null, image: null },
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
    await expect
      .element(page.getByTestId('review-body'))
      .toHaveTextContent('body:pubreq_1:pending');
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

describe('ReviewDetailPage — the listing-media seam', () => {
  /**
   * ⚠️ AN INVARIANT GUARD, NOT REGRESSION COVERAGE, AND LABELLED SO BECAUSE IT WAS
   * MEASURED: green on the commit before the listing-media work, because the page hands the
   * body the fetched `request` OBJECT WHOLE and never names a field.
   *
   * What it pins is the future edit that WOULD break — the page cherry-picking fields out
   * of `query.data.request`, which would blank the media section while
   * `ReviewDetailView`'s own arms stayed green.
   */
  test('the page passes the fetched request through WHOLE (no field cherry-picking)', async () => {
    const request = {
      ...REQUEST,
      iconUrl: `${LOADABLE_IMAGE_DATA_URI}#icon`,
      coverUrl: `${LOADABLE_IMAGE_DATA_URI}#cover`,
    };
    state.query = {
      data: { mode: 'pending', request },
      isLoading: false,
      isError: false,
      error: null,
    };
    renderWithProviders(<ReviewDetailPage publishRequestId="pubreq_1" />);
    await expect.element(page.getByTestId('review-body')).toBeInTheDocument();
    // Every key, not only the two this change added — that is what makes it a pass-through
    // assertion rather than a list someone has to remember to extend.
    expect(state.bodyProps.last?.selection.request).toEqual(request);
  });
});

describe('ReviewDetailPage — the `selection` identity the memo downstream depends on', () => {
  /**
   * 🔴 THE PAGE'S `useMemo` IS A LOAD-BEARING PERF CONTRACT WITH A SUBTLE SCOPE, and this is
   * the only test of it.
   *
   * `ReviewDetailTabsView` is `memo()`d, and its single prop is this `selection` object — so
   * a page that rebuilds the object on every render hands the memo a new identity each time
   * and buys nothing. `ReviewDetailTabsMemo.browser.test.tsx` pins the memo's side of that
   * bargain against a synthetic parent; this pins the PAGE's side against the real page.
   *
   * ⚠️ IT IS NOT ABOUT THE 60-SECOND TICK, and an earlier draft of the memo test's header
   * said it was. The tick lives one level DOWN in `ReviewDetailView`, and a child's state
   * update never re-renders its parent — so the page does not re-render on a tick and
   * `memo()` alone covers that case. What the `useMemo` covers is every OTHER re-render of
   * the page: the feature flags resolving, a react-query refetch that returns equal data, a
   * parent update. Those are the ones that would otherwise rebuild the object.
   */
  test('🔴 a page re-render hands the body the SAME `selection` object, not an equal one', async () => {
    state.query = {
      data: { mode: 'pending', request: REQUEST },
      isLoading: false,
      isError: false,
      error: null,
    };
    state.selections = [];
    const { rerender } = await renderWithProviders(
      <ReviewDetailPage publishRequestId="pubreq_1" />
    );
    await expect.element(page.getByTestId('review-body')).toBeInTheDocument();
    const first = state.selections.length;
    expect(first, 'the body rendered at all').toBeGreaterThan(0);

    await rerender(<ReviewDetailPage publishRequestId="pubreq_1" />);
    await expect.element(page.getByTestId('review-body')).toBeInTheDocument();
    expect(
      state.selections.length,
      'the page re-rendered, so the body was handed a selection again'
    ).toBeGreaterThan(first);

    // 🔴 IDENTITY, NOT EQUALITY. `toEqual` would pass against a freshly-built twin, which is
    // exactly the defect: `memo` compares by reference.
    const distinct = new Set(state.selections);
    expect(
      distinct.size,
      `the page rebuilt \`selection\` across ${state.selections.length} renders`
    ).toBe(1);
  });

  test('POSITIVE CONTROL: a DIFFERENT payload does produce a new `selection`', async () => {
    // Without this, the identity assertion above is satisfied by a page that never rebuilds
    // because it never re-reads the query at all.
    state.query = {
      data: { mode: 'pending', request: REQUEST },
      isLoading: false,
      isError: false,
      error: null,
    };
    state.selections = [];
    const { rerender } = await renderWithProviders(
      <ReviewDetailPage publishRequestId="pubreq_1" />
    );
    await expect.element(page.getByTestId('review-body')).toBeInTheDocument();
    // 🔴 ONLY THE REQUEST MOVES — the mode stays `pending`, deliberately. Changing both let
    // an UNDER-SPECIFIED dependency array pass: measured, `useMemo(…, [query.data?.mode])`
    // survived, because the control satisfied it through the mode alone. That mutant's live
    // failure is worse than the lost bail-out this test was written for — a refetch that
    // returns a new request at the same mode would hand the memoised body a STALE payload.
    state.query = {
      data: { mode: 'pending', request: { ...REQUEST, id: 'pubreq_2' } },
      isLoading: false,
      isError: false,
      error: null,
    };
    await rerender(<ReviewDetailPage publishRequestId="pubreq_1" />);
    await expect.element(page.getByTestId('review-body')).toBeInTheDocument();
    expect(new Set(state.selections).size, 'new data must yield a new object').toBeGreaterThan(1);
    expect(state.bodyProps.last?.selection.request.id).toBe('pubreq_2');
  });
});
