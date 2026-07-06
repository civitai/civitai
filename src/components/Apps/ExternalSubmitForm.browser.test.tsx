import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * W13 P3a — /apps/submit "External link" mode form. Browser-mode surface test
 * (report-only in Tekton): the metadata form renders + client-side validation
 * (mirroring `submitExternalListingSchema`) blocks an empty/invalid submit and
 * surfaces inline errors BEFORE the round-trip.
 */

const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
}));

vi.mock('~/utils/trpc', () => {
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    trpc: {
      appListings: {
        submitExternalListing: {
          useMutation: (opts?: unknown) => {
            mocks.submit(opts);
            return { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
          },
        },
        persistAssetImage: { useMutation: mutation },
        setIcon: { useMutation: mutation },
        setCover: { useMutation: mutation },
        addScreenshot: { useMutation: mutation },
      },
    },
  };
});

vi.mock('~/hooks/useCFImageUpload', () => ({
  useCFImageUpload: () => ({ uploadToCF: vi.fn(), files: [], resetFiles: vi.fn(), removeImage: vi.fn() }),
}));

vi.mock('~/utils/notifications', () => ({
  showSuccessNotification: vi.fn(),
  showErrorNotification: vi.fn(),
}));

const { ExternalSubmitForm } = await import('./ExternalSubmitForm');

beforeEach(() => {
  mocks.submit.mockClear();
});

describe('ExternalSubmitForm — validation surface', () => {
  test('renders the metadata fields', async () => {
    renderWithProviders(<ExternalSubmitForm />);
    await expect.element(page.getByText('Slug', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText('External URL', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Create draft' })).toBeInTheDocument();
  });

  test('submitting an empty form surfaces inline validation errors (server not called)', async () => {
    renderWithProviders(<ExternalSubmitForm />);
    await page.getByRole('button', { name: 'Create draft' }).click();
    // The pure client mirror (validateOffsiteSubmitForm) drives these inline errors.
    await expect.element(page.getByText('Name is required.')).toBeInTheDocument();
    // Slug + URL errors also appear.
    await expect
      .element(page.getByText(/Slug must be 3–40 characters\./))
      .toBeInTheDocument();
  });
});
