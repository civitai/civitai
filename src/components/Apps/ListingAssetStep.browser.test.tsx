import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * W13 — the shared listing ASSET step, focused on the OG-image AUTO-FILL path
 * (Accept a server-suggested icon/cover → ingest → poll the attach proc until the
 * scan lands). Browser-mode surface test (report-only in Tekton).
 *
 * Two behaviours are asserted (the client half of the OG-pull-ingest fix):
 *  1. A freshly-ingested image is NOT attached eagerly — the row shows a
 *     "Scanning image…" state while the attach proc keeps rejecting with the
 *     retriable "scan is not complete", and flips to "attached" only once the
 *     attach resolves (scan complete). (Poll logic proven pure in
 *     `__tests__/assetPolling.test.ts`; this proves the component wiring.)
 *  2. A TERMINAL ingest failure — the attach proc rejecting with the distinct,
 *     non-retriable "couldn't be imported — upload it manually" message the server
 *     now returns for a `NotFound` image — surfaces a CLEAR error and leaves the
 *     manual-upload FileInput usable (never an eternal "still scanning" dead-end).
 */

const mocks = vi.hoisted(() => ({
  ingestAsync: vi.fn(),
  setIconAsync: vi.fn(),
  setCoverAsync: vi.fn(),
  addScreenshotAsync: vi.fn(),
}));

vi.mock('~/utils/trpc', () => {
  const passthrough = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    trpc: {
      appListings: {
        persistAssetImage: { useMutation: passthrough },
        ingestAssetFromUrl: {
          useMutation: () => ({ mutate: vi.fn(), mutateAsync: mocks.ingestAsync, isPending: false }),
        },
        setIcon: {
          useMutation: () => ({ mutate: vi.fn(), mutateAsync: mocks.setIconAsync, isPending: false }),
        },
        setCover: {
          useMutation: () => ({ mutate: vi.fn(), mutateAsync: mocks.setCoverAsync, isPending: false }),
        },
        addScreenshot: {
          useMutation: () => ({
            mutate: vi.fn(),
            mutateAsync: mocks.addScreenshotAsync,
            isPending: false,
          }),
        },
        removeScreenshot: { useMutation: passthrough },
      },
    },
  };
});

vi.mock('~/hooks/useCFImageUpload', () => ({
  useCFImageUpload: () => ({
    uploadToCF: vi.fn(),
    files: [],
    resetFiles: vi.fn(),
    removeImage: vi.fn(),
  }),
}));

vi.mock('~/utils/notifications', () => ({
  showSuccessNotification: vi.fn(),
  showErrorNotification: vi.fn(),
}));

const { ListingAssetStep } = await import('./ListingAssetStep');

const suggestions = {
  iconImageUrl: 'https://cdn.example.com/icon.png',
  coverImageUrl: 'https://cdn.example.com/cover.png',
};

function renderStep() {
  return renderWithProviders(
    <ListingAssetStep listingId="listing-1" contentRating="g" suggestions={suggestions} />
  );
}

beforeEach(() => {
  mocks.ingestAsync.mockReset();
  mocks.setIconAsync.mockReset();
  mocks.setCoverAsync.mockReset();
  mocks.addScreenshotAsync.mockReset();
});

describe('ListingAssetStep — OG-image auto-fill', () => {
  test('renders the suggested-icon accept affordance from the server suggestion', async () => {
    renderStep();
    await expect.element(page.getByTestId('apps-offsite-accept-icon')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-offsite-suggested-icon-preview')).toBeInTheDocument();
    // The "re-scan it just like an upload" reassurance is shown (icon + cover
    // both render it → scope with .first()).
    await expect
      .element(page.getByText(/re-scan it just like an upload/i).first())
      .toBeInTheDocument();
  });

  test('accepting a suggestion shows a scanning state, then attaches once the scan lands', async () => {
    mocks.ingestAsync.mockResolvedValue({ imageId: 777 });
    // The attach proc rejects "scan is not complete" while the image is still
    // scanning, then resolves once the scan lands — the polling drives to attached.
    mocks.setIconAsync
      .mockRejectedValueOnce(
        new Error('image is not approved for publishing (scan is not complete)')
      )
      .mockResolvedValue({ ok: true });

    renderStep();
    await page.getByTestId('apps-offsite-accept-icon').click();

    // The ingest ran and the row is in the scanning state (NOT eagerly attached).
    expect(mocks.ingestAsync).toHaveBeenCalledWith({
      url: suggestions.iconImageUrl,
      kind: 'icon',
    });
    await expect.element(page.getByText(/Scanning image/i)).toBeInTheDocument();

    // Once the scan lands (2nd attach resolves after the poll delay), the icon
    // badge flips to "attached" (exact match → the badge, not "0 attached" / the
    // completeness copy).
    await expect
      .element(page.getByText('attached', { exact: true }))
      .toBeInTheDocument();
    expect(mocks.setIconAsync).toHaveBeenCalledWith({ listingId: 'listing-1', imageId: 777 });
  });

  test('a terminal ingest (NotFound) surfaces a clear error and keeps manual upload usable', async () => {
    mocks.ingestAsync.mockResolvedValue({ imageId: 888 });
    // The server now returns a DISTINCT, non-retriable message for a NotFound
    // image (not the retriable "scan is not complete") — the client classifies it
    // as a terminal error instead of polling forever.
    mocks.setIconAsync.mockRejectedValue(
      new Error("that image couldn't be imported — upload it manually instead")
    );

    renderStep();
    await page.getByTestId('apps-offsite-accept-icon').click();

    // The clear, actionable error is shown (not an eternal "still scanning").
    await expect.element(page.getByText(/upload it manually/i)).toBeInTheDocument();

    // The failed auto-fill transitioned OUT of idle (the suggestion accept button
    // is gone) and the row now offers the plain manual "Upload icon" file input —
    // the author is never stuck on the failed auto-fill.
    await expect.element(page.getByText('Upload icon', { exact: true })).toBeInTheDocument();
    expect(page.getByTestId('apps-offsite-accept-icon').elements()).toHaveLength(0);
  });
});
