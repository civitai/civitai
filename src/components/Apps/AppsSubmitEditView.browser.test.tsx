import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * W13 — `/apps/submit?edit=` routing view (`AppsSubmitEditView`). Browser-mode
 * surface test of the three states: loading, error (not-found / not-owner — the
 * proc throws, surfaced as a friendly inline alert), and success (renders the
 * External wizard in EDIT mode with the fetched context). Heavy children
 * (AppsPageLayout / Meta / the wizard) are stubbed so this stays network-free.
 */

const mocks = vi.hoisted(() => ({
  edit: { data: undefined as unknown, isLoading: true, isError: false, error: null as { message?: string } | null },
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
  mocks.edit = { data: undefined, isLoading: true, isError: false, error: null };
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
    };
    renderWithProviders(<AppsSubmitEditView listingId="apl_1" />);
    await expect.element(page.getByTestId('apps-offsite-edit-not-found')).toBeInTheDocument();
    expect(page.getByTestId('apps-offsite-edit-form-stub').elements()).toHaveLength(0);
  });
});
