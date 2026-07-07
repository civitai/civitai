import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * W13 — /apps/submit "External link" mode WIZARD. Browser-mode surface test
 * (report-only in Tekton): the stepper starts on the URL step, advancing from a
 * valid URL prefills name + slug on the Details step (derived from the URL), and
 * an invalid URL blocks the advance with the shared inline https error. The pure
 * derivation + step-gating are unit-tested separately in
 * `__tests__/deriveListingFromUrl.test.ts`.
 */

const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
  mutate: vi.fn(),
}));

vi.mock('~/utils/trpc', () => {
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    trpc: {
      appListings: {
        submitExternalListing: {
          useMutation: (opts?: unknown) => {
            mocks.submit(opts);
            return { mutate: mocks.mutate, mutateAsync: vi.fn(), isPending: false };
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
  mocks.mutate.mockClear();
});

describe('ExternalSubmitForm — wizard', () => {
  test('starts on the URL step (details/create not yet shown)', async () => {
    renderWithProviders(<ExternalSubmitForm />);
    await expect
      .element(page.getByRole('textbox', { name: /External URL/ }))
      .toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Next' })).toBeInTheDocument();
    // The Create-draft button lives on the Details step and is not rendered yet.
    expect(page.getByRole('button', { name: 'Create draft' }).elements()).toHaveLength(0);
  });

  test('a valid URL advances to Details and prefills name + slug', async () => {
    renderWithProviders(<ExternalSubmitForm />);
    await page.getByRole('textbox', { name: /External URL/ }).fill('https://vitrine.civitai.com');
    await page.getByRole('button', { name: 'Next' }).click();

    // Details step is now active with the prefilled name + slug.
    await expect.element(page.getByRole('textbox', { name: /^Name/ })).toHaveValue('Vitrine');
    await expect.element(page.getByRole('textbox', { name: /^Slug/ })).toHaveValue('vitrine');
    await expect.element(page.getByRole('button', { name: 'Create draft' })).toBeInTheDocument();
  });

  test('an invalid (http) URL blocks the advance with an inline error', async () => {
    renderWithProviders(<ExternalSubmitForm />);
    await page.getByRole('textbox', { name: /External URL/ }).fill('http://example.com');
    await page.getByRole('button', { name: 'Next' }).click();
    // Shared https validation surfaces inline; we stay on the URL step.
    await expect.element(page.getByText(/https/i)).toBeInTheDocument();
    expect(page.getByRole('button', { name: 'Create draft' }).elements()).toHaveLength(0);
  });

  test('submitting valid details calls submitExternalListing (server owns the draft)', async () => {
    renderWithProviders(<ExternalSubmitForm />);
    await page.getByRole('textbox', { name: /External URL/ }).fill('https://vitrine.civitai.com');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Create draft' }).click();
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
  });
});
