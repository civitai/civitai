import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * W13 — `/apps/submit?edit=` routing view (`AppsSubmitEditView`). Browser-mode
 * surface test of the states: loading, error (not-found / not-owner — the proc
 * throws, surfaced as a friendly inline alert), settled-but-empty (no data, no
 * thrown error), success (renders the External wizard in EDIT mode), and the
 * BOUNDED-loader guard (a query that never settles must fall through to the
 * recoverable alert instead of spinning forever — the reported prod wedge).
 * Heavy children (AppsPageLayout / Meta / the wizard) are stubbed so this stays
 * network-free.
 */

const mocks = vi.hoisted(() => ({
  edit: {
    data: undefined as unknown,
    isLoading: true,
    isFetching: true,
    isError: false,
    error: null as { message?: string } | null,
    refetch: vi.fn(),
  },
}));

vi.mock('~/utils/trpc', () => ({
  setTrpcBatchingEnabled: vi.fn(),
  trpc: {
    appListings: {
      getMyListingForEdit: { useQuery: () => mocks.edit },
    },
  },
}));

vi.mock('~/components/Apps/AppsPageLayout', () => ({
  AppsPageLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));
vi.mock('~/components/Apps/ExternalSubmitForm', () => ({
  ExternalSubmitForm: ({ edit }: { edit?: { slug?: string } }) => (
    <div data-testid="apps-offsite-edit-form-stub">editing {edit?.slug}</div>
  ),
}));

const { AppsSubmitEditView } = await import('./AppsSubmitEditView');

beforeEach(() => {
  mocks.edit = {
    data: undefined,
    isLoading: true,
    isFetching: true,
    isError: false,
    error: null,
    refetch: vi.fn(),
  };
});

describe('AppsSubmitEditView — routing', () => {
  test('shows a loader while the listing loads', async () => {
    renderWithProviders(<AppsSubmitEditView listingId="apl_1" />);
    await expect.element(page.getByTestId('apps-offsite-edit-loading')).toBeInTheDocument();
  });

  test('renders the edit wizard with the fetched context on success', async () => {
    mocks.edit = {
      data: { slug: 'vitrine', status: 'draft' },
      isLoading: false,
      isFetching: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    };
    renderWithProviders(<AppsSubmitEditView listingId="apl_1" />);
    const stub = page.getByTestId('apps-offsite-edit-form-stub');
    await expect.element(stub).toBeInTheDocument();
    await expect.element(stub).toHaveTextContent('editing vitrine');
  });

  test('shows a friendly error for a not-found / not-owner listing', async () => {
    mocks.edit = {
      data: undefined,
      isLoading: false,
      isFetching: false,
      isError: true,
      error: { message: 'listing apl_1 not found' },
      refetch: vi.fn(),
    };
    renderWithProviders(<AppsSubmitEditView listingId="apl_1" />);
    await expect.element(page.getByTestId('apps-offsite-edit-not-found')).toBeInTheDocument();
    expect(page.getByTestId('apps-offsite-edit-form-stub').elements()).toHaveLength(0);
  });

  test('a SETTLED query with no data and NO thrown error still renders the alert (never a silent blank/loader)', async () => {
    // Guards the "streamed error / empty success" shape: the query has settled
    // (isLoading false) with `data` undefined but `isError` false. The view must
    // still land on the recoverable not-found alert, not the loader or a blank.
    mocks.edit = {
      data: undefined,
      isLoading: false,
      isFetching: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    };
    renderWithProviders(<AppsSubmitEditView listingId="apl_1" />);
    await expect.element(page.getByTestId('apps-offsite-edit-not-found')).toBeInTheDocument();
    expect(page.getByTestId('apps-offsite-edit-loading').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-offsite-edit-form-stub').elements()).toHaveLength(0);
  });

  test('the "Try again" control refetches the query', async () => {
    const refetch = vi.fn();
    mocks.edit = {
      data: undefined,
      isLoading: false,
      isFetching: false,
      isError: true,
      error: null,
      refetch,
    };
    renderWithProviders(<AppsSubmitEditView listingId="apl_1" />);
    const retry = page.getByTestId('apps-offsite-edit-retry');
    await expect.element(retry).toBeInTheDocument();
    await retry.click();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  test('BOUNDED loader: a query stuck in isLoading falls through to the alert once the ceiling elapses (never an infinite spinner)', async () => {
    // The reported prod wedge: the query never settles, so `isLoading` stays true
    // forever. With a tiny ceiling the guard must flip the view to the recoverable
    // alert — proving the spinner can never trap the user indefinitely. A pre-fix
    // build (loader gated on `isLoading` alone) leaves the loader up forever and
    // fails this test.
    mocks.edit = {
      data: undefined,
      isLoading: true,
      isFetching: true,
      isError: false,
      error: null,
      refetch: vi.fn(),
    };
    renderWithProviders(<AppsSubmitEditView listingId="apl_1" loaderCeilingMs={30} />);
    // Loader shows first…
    await expect.element(page.getByTestId('apps-offsite-edit-loading')).toBeInTheDocument();
    // …then the ceiling elapses and the recoverable alert takes over.
    await expect.element(page.getByTestId('apps-offsite-edit-not-found')).toBeInTheDocument();
    expect(page.getByTestId('apps-offsite-edit-loading').elements()).toHaveLength(0);
  });

  test('retry RE-ARMS a fresh ceiling: a never-settling query recovers the spinner then re-lands the alert', async () => {
    // Covers the trickiest bit of the bounded loader: `retryNonce` re-arming the
    // ceiling timer. The query NEVER settles (`isLoading` stays true across the
    // refetch — the real prod symptom, NOT the error-state mock the retry test
    // above uses). So clicking "Try again" cannot rely on `isLoading` toggling;
    // the nonce bump is the ONLY thing that flips the loader back on. We prove:
    //   1. ceiling elapses → alert,
    //   2. click "Try again" → the SPINNER returns (only possible if the nonce
    //      re-armed `loaderExpired=false` while the query is still loading),
    //   3. a FRESH ceiling elapses → the alert returns again.
    const refetch = vi.fn(); // never-settling: refetch does not change the query state
    mocks.edit = {
      data: undefined,
      isLoading: true,
      isFetching: true,
      isError: false,
      error: null,
      refetch,
    };
    // A comfortable ceiling so the transient re-armed spinner is observable by the
    // polling matcher (not a real 15s wait — the prod default is 15_000ms).
    renderWithProviders(<AppsSubmitEditView listingId="apl_1" loaderCeilingMs={200} />);

    // 1. First ceiling elapses → recoverable alert.
    await expect.element(page.getByTestId('apps-offsite-edit-not-found')).toBeInTheDocument();

    // 2. Retry re-arms the loader (proves nonce → fresh timer, since isLoading
    //    never toggled) and re-issues the fetch.
    await page.getByTestId('apps-offsite-edit-retry').click();
    await expect.element(page.getByTestId('apps-offsite-edit-loading')).toBeInTheDocument();
    expect(refetch).toHaveBeenCalledTimes(1);

    // 3. The fresh ceiling elapses → the alert returns (still never settled).
    await expect.element(page.getByTestId('apps-offsite-edit-not-found')).toBeInTheDocument();
    expect(page.getByTestId('apps-offsite-edit-loading').elements()).toHaveLength(0);
  });

  test('slow load that eventually resolves recovers to the form automatically (no manual retry)', async () => {
    // Load-bearing auto-recovery: the query is still pending when the ceiling
    // elapses (alert shows), then the data arrives on a later render and the form
    // renders itself — the user does NOT have to click "Try again".
    mocks.edit = {
      data: undefined,
      isLoading: true,
      isFetching: true,
      isError: false,
      error: null,
      refetch: vi.fn(),
    };
    const { rerender } = await renderWithProviders(
      <AppsSubmitEditView listingId="apl_1" loaderCeilingMs={30} />
    );

    // Ceiling elapses while still pending → recoverable alert.
    await expect.element(page.getByTestId('apps-offsite-edit-not-found')).toBeInTheDocument();

    // The slow query now resolves with data — flip the mock and re-render (the
    // same component instance, so its ceiling state persists).
    mocks.edit = {
      data: { slug: 'vitrine', status: 'draft' },
      isLoading: false,
      isFetching: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    };
    await rerender(<AppsSubmitEditView listingId="apl_1" loaderCeilingMs={30} />);

    // Form appears with no manual retry; the alert is gone.
    const stub = page.getByTestId('apps-offsite-edit-form-stub');
    await expect.element(stub).toBeInTheDocument();
    await expect.element(stub).toHaveTextContent('editing vitrine');
    expect(page.getByTestId('apps-offsite-edit-not-found').elements()).toHaveLength(0);
  });

  test('error retry shows a disabled "Retrying…" state while the refetch is in flight (isFetching)', async () => {
    // Fix for the inert-retry gap: after an *error*, `refetch()` keeps
    // `status: 'error'` (so `isLoading` stays false) and only flips `isFetching`
    // → true. The button must reflect that in-flight retry instead of sitting
    // there looking dead. The mock's refetch flips `isFetching` on, mirroring
    // React-Query; the `handleRetry` state bump re-renders and reads it.
    const refetch = vi.fn(() => {
      mocks.edit.isFetching = true;
    });
    mocks.edit = {
      data: undefined,
      isLoading: false,
      isFetching: false,
      isError: true,
      error: { message: 'listing apl_1 not found' },
      refetch,
    };
    renderWithProviders(<AppsSubmitEditView listingId="apl_1" />);

    const retry = page.getByTestId('apps-offsite-edit-retry');
    await expect.element(retry).toHaveTextContent('Try again');
    await retry.click();

    // In-flight retry: disabled + "Retrying…" (keyed off isFetching, not isLoading).
    await expect.element(retry).toHaveTextContent('Retrying…');
    await expect.element(retry).toBeDisabled();
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
