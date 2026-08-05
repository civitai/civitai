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

/**
 * A loader ceiling large enough that its timer can NEVER fire inside a test.
 *
 * 🔴 This is the tool that makes the re-armed spinner an ABSORBING state. See the
 * "absorbing state" note on the retry tests below — asserting the spinner while a
 * short ceiling is live is an unwinnable race, not a slow assertion.
 */
const NEVER_ELAPSES_MS = 600_000;

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
    // 🔴 This test used to assert the loader is PRESENT before asserting the
    // fall-through, with a 30ms ceiling — a race against its own fixture.
    // `expect.element` polls on a 50ms INTERVAL with the first attempt
    // immediate, so once that immediate poll missed React's commit, every
    // subsequent poll was already past the 30ms ceiling and the loader was gone:
    // unwinnable, and it burned the full ~14.9s budget before failing. That is
    // what made `preview / component-tests` red — on machine load, not on code.
    //
    // The pre-ceiling assertion is DELETED rather than given a wider window,
    // because widening only makes the race rarer. It was also redundant: the
    // first test in this file asserts the loader renders at the PRODUCTION
    // ceiling (15s), where it is safe because the loader is committed on the
    // FIRST render — not merely because the window is wide. What this test
    // uniquely owns is the FALL-THROUGH, and both assertions below only ever
    // WAIT on an absorbing state (`isLoading` never toggles here), so a short
    // ceiling makes them fast and deterministic.
    renderWithProviders(<AppsSubmitEditView listingId="apl_1" loaderCeilingMs={30} />);
    // The ceiling elapses and the recoverable alert takes over.
    await expect.element(page.getByTestId('apps-offsite-edit-not-found')).toBeInTheDocument();
    expect(page.getByTestId('apps-offsite-edit-loading').elements()).toHaveLength(0);
  });

  // 🔴 ABSORBING-STATE RULE for the two retry tests below. This file lost the same
  // race twice, in two different tests, and the second loss is what made
  // `preview / component-tests` intermittently red (~1 in 3) with no PR to blame.
  //
  // `expect.element` polls (first attempt immediate, then every 50ms, 15s budget).
  // Waiting for a state to ARRIVE is safe: load only makes it arrive later and the
  // matcher keeps polling. Waiting for a state that will LEAVE is a race the matcher
  // CANNOT win — once the state is gone it never comes back, so every remaining poll
  // is also too late. The test then burns the FULL 15s budget before failing, which
  // is the signature to look for (a ~15.0s failing test inside an otherwise-healthy
  // ~80s suite).
  //
  // Measured on this component (component instrumented with `performance.now()`
  // timestamps): after the retry click the spinner is observable for exactly
  // `loaderCeilingMs`, and the matcher's first poll lands 40-78ms into that window on
  // an idle box. At the `loaderCeilingMs={200}` this test used to ship with, that is
  // a ~150ms margin — and a saturated CI box (the same box builds the preview image;
  // its cold `import` costs 228s vs 0.3s locally) erases it. Proof the value governed
  // the outcome: at `loaderCeilingMs={1}` the window measured 3.3ms and the test went
  // 3-of-5 RED at 14986-15021ms, byte-identical to the CI failure.
  //
  // So: NEVER assert the transient spinner while a short ceiling is live. Either
  // widen the ceiling so the spinner cannot delete itself (test 1), or don't assert
  // it at all and await the absorbing end-state instead (test 2). Widening the
  // *matcher* budget or the *ceiling* alone would only make the race rarer — it stays
  // unwinnable whenever the machine is slow enough, which is exactly when CI runs.

  test('retry RE-ARMS the loader: a never-settling query recovers the spinner', async () => {
    // The query NEVER settles (`isLoading` stays true across the refetch — the real
    // prod symptom, NOT the error-state mock the retry test above uses). So clicking
    // "Try again" cannot rely on `isLoading` toggling; `setLoaderExpired(false)` in
    // `handleRetry` is the ONLY thing that can flip the loader back on.
    const refetch = vi.fn(); // never-settling: refetch does not change the query state
    mocks.edit = {
      data: undefined,
      isLoading: true,
      isFetching: true,
      isError: false,
      error: null,
      refetch,
    };
    const { rerender } = await renderWithProviders(
      <AppsSubmitEditView listingId="apl_1" loaderCeilingMs={30} />
    );

    // 1. The first ceiling elapses → the recoverable alert. ABSORBING: `isLoading`
    //    never toggles, so nothing takes the alert away again.
    await expect.element(page.getByTestId('apps-offsite-edit-not-found')).toBeInTheDocument();

    // 2. Widen the ceiling so that when the spinner returns it CANNOT delete itself.
    //    🔴 NEGATIVE CONTROL: `loaderCeilingMs` is an effect dep, so this rerender
    //    re-runs the effect and arms a fresh timer — but it must NOT by itself revive
    //    the spinner (`loaderExpired` stays true until something clears it). Asserting
    //    that here is what makes the spinner in step 3 attributable to the RETRY
    //    rather than to this prop change.
    await rerender(<AppsSubmitEditView listingId="apl_1" loaderCeilingMs={NEVER_ELAPSES_MS} />);
    await expect.element(page.getByTestId('apps-offsite-edit-not-found')).toBeInTheDocument();
    expect(page.getByTestId('apps-offsite-edit-loading').elements()).toHaveLength(0);

    // 3. Retry → the spinner returns, and with the ceiling widened it is ABSORBING,
    //    so this assertion waits rather than races.
    await page.getByTestId('apps-offsite-edit-retry').click();
    await expect.element(page.getByTestId('apps-offsite-edit-loading')).toBeInTheDocument();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  test('retry re-arms a FRESH ceiling: the re-armed timer elapses and re-lands the alert', async () => {
    // This is the test that pins `retryNonce` in the effect's dep array. The ceiling
    // is never changed, so the timer that fires after the retry can ONLY be one the
    // retry itself armed. Drop the nonce from the deps and the effect never re-runs:
    // `handleRetry` clears `loaderExpired` and nothing ever sets it back, so the
    // spinner stays up forever and both assertions below fail.
    const refetch = vi.fn(); // never-settling: refetch does not change the query state
    mocks.edit = {
      data: undefined,
      isLoading: true,
      isFetching: true,
      isError: false,
      error: null,
      refetch,
    };
    renderWithProviders(<AppsSubmitEditView listingId="apl_1" loaderCeilingMs={30} />);

    // The first ceiling elapses → the alert. ABSORBING.
    await expect.element(page.getByTestId('apps-offsite-edit-not-found')).toBeInTheDocument();

    await page.getByTestId('apps-offsite-edit-retry').click();
    // The click resolved, so `handleRetry` ran (React flushes a discrete event's
    // state updates synchronously inside the dispatch, before the click RPC returns)
    // — which means `loaderExpired` was cleared and the spinner was committed.
    // We deliberately do NOT assert the spinner: it deletes itself 30ms later, and
    // asserting it here is precisely the unwinnable race described above.
    expect(refetch).toHaveBeenCalledTimes(1);

    // The FRESH ceiling elapses and re-lands the alert. ABSORBING — and since the
    // spinner provably went up, the alert can only be back because a re-armed timer
    // fired.
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
