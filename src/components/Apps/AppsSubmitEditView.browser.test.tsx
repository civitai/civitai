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
  mocks.edit = { data: undefined, isLoading: true, isError: false, error: null, refetch: vi.fn() };
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
    mocks.edit = { data: undefined, isLoading: false, isError: true, error: null, refetch };
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
    mocks.edit = { data: undefined, isLoading: true, isError: false, error: null, refetch: vi.fn() };
    renderWithProviders(<AppsSubmitEditView listingId="apl_1" loaderCeilingMs={30} />);
    // Loader shows first…
    await expect.element(page.getByTestId('apps-offsite-edit-loading')).toBeInTheDocument();
    // …then the ceiling elapses and the recoverable alert takes over.
    await expect.element(page.getByTestId('apps-offsite-edit-not-found')).toBeInTheDocument();
    expect(page.getByTestId('apps-offsite-edit-loading').elements()).toHaveLength(0);
  });
});
