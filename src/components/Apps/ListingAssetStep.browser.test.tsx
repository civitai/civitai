import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * W13 — the shared listing ASSET step, focused on the OG-image AUTO-FILL path
 * (Accept a server-suggested icon/cover → ingest → poll the attach proc until the
 * scan lands). Browser-mode surface test (report-only in Tekton).
 *
 * Two behaviours are asserted (the client half of the OG-pull-ingest fix):
 *  1. A freshly-ingested image is NOT attached eagerly — the row shows a
 *     "Scanning image…" state while the attach proc RESOLVES with the non-error
 *     `{ status: 'pending' }` result (scanning is no longer a 4xx — supersedes the
 *     old CONFLICT), and flips to "attached" only once the attach resolves
 *     `{ status: 'attached' }` (scan complete). The decision is structural over the
 *     resolved `status`, never prose. (Poll logic proven pure in
 *     `__tests__/assetPolling.test.ts`; this proves the component wiring.)
 *  2. A TERMINAL ingest failure — the attach proc THROWING the terminal error the
 *     server returns for a `NotFound` image — surfaces the CLEAR human message and
 *     leaves the manual-upload FileInput usable (never an eternal "still scanning"
 *     dead-end).
 */

/**
 * Build an error shaped like a tRPC CLIENT error: a real Error (so `.message` is
 * the human display string) with the structural `data.code` the client reads to
 * decide retriable-vs-terminal.
 */
function trpcAttachError(code: string, message: string): Error & { data: { code: string } } {
  return Object.assign(new Error(message), { data: { code } });
}

const mocks = vi.hoisted(() => ({
  ingestAsync: vi.fn(),
  setIconAsync: vi.fn(),
  setCoverAsync: vi.fn(),
  addScreenshotAsync: vi.fn(),
  removeAsync: vi.fn(),
  persistAsync: vi.fn(),
  uploadToCF: vi.fn(),
}));

vi.mock('~/utils/trpc', () => {
  const passthrough = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    trpc: {
      appListings: {
        persistAssetImage: {
          useMutation: () => ({ mutate: vi.fn(), mutateAsync: mocks.persistAsync, isPending: false }),
        },
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
        removeScreenshot: {
          useMutation: () => ({ mutate: vi.fn(), mutateAsync: mocks.removeAsync, isPending: false }),
        },
      },
    },
  };
});

vi.mock('~/hooks/useCFImageUpload', () => ({
  useCFImageUpload: () => ({
    uploadToCF: mocks.uploadToCF,
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

function renderStep(props: Partial<Parameters<typeof ListingAssetStep>[0]> = {}) {
  return renderWithProviders(
    <ListingAssetStep
      listingId="listing-1"
      contentRating="g"
      suggestions={suggestions}
      {...props}
    />
  );
}

/**
 * Generate a REAL png File (via canvas → toBlob) — an arbitrary-bytes File would
 * fail `createImageBitmap` in the upload path (readImageDimensions), so the row
 * would never reach the scanning state we assert on.
 */
async function makeImageFile(name = 'shot.png'): Promise<File> {
  const canvas = document.createElement('canvas');
  canvas.width = 200;
  canvas.height = 150;
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob null'))), 'image/png');
  });
  return new File([blob], name, { type: 'image/png' });
}

/**
 * The hidden native <input type=file> Mantine's FileInput renders (display:none).
 * icon/cover = not-multiple by DOM order; screenshots = multiple. Waits for React
 * to commit (querying synchronously right after render finds nothing).
 */
function fileInputEl(which: 'icon' | 'cover' | 'screenshots'): Promise<HTMLInputElement> {
  return vi.waitFor(() => {
    if (which === 'screenshots') {
      const el = document.querySelector<HTMLInputElement>('input[type="file"][multiple]');
      if (!el) throw new Error('screenshots file input not found');
      return el;
    }
    const singles = document.querySelectorAll<HTMLInputElement>(
      'input[type="file"]:not([multiple])'
    );
    const el = singles[which === 'icon' ? 0 : 1];
    if (!el) throw new Error(`${which} file input not found`);
    return el;
  });
}

beforeEach(() => {
  mocks.ingestAsync.mockReset();
  mocks.setIconAsync.mockReset();
  mocks.setCoverAsync.mockReset();
  mocks.addScreenshotAsync.mockReset();
  mocks.removeAsync.mockReset();
  mocks.persistAsync.mockReset();
  mocks.uploadToCF.mockReset();
  // Default upload pipeline: CF upload + persist resolve so the row can reach
  // the scanning state driven by the attach proc.
  mocks.uploadToCF.mockResolvedValue({ id: 'cf-image-id' });
  mocks.persistAsync.mockResolvedValue({ imageId: 501 });
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
    // The attach proc RESOLVES with the non-error `{ status: 'pending' }` while the
    // image is still scanning (no throw — supersedes the old CONFLICT), then resolves
    // `{ status: 'attached' }` once the scan lands — the polling drives to attached.
    mocks.setIconAsync
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValue({ status: 'attached', iconId: 777 });

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
    // The server returns the TERMINAL code (BAD_REQUEST) for a NotFound image —
    // the client classifies it as a terminal error instead of polling forever, and
    // shows the human message for display.
    mocks.setIconAsync.mockRejectedValue(
      trpcAttachError(
        'BAD_REQUEST',
        "that image couldn't be imported — upload it manually instead"
      )
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

describe('ListingAssetStep — uploaded-asset preview + cancel mid-scan', () => {
  test('a freshly-uploaded screenshot shows a preview thumbnail while it scans', async () => {
    // Attach proc resolves `pending` → the row stays in the scanning state.
    mocks.addScreenshotAsync.mockResolvedValue({ status: 'pending' });
    renderStep();

    await userEvent.upload(await fileInputEl('screenshots'), await makeImageFile());

    // The local object-URL preview thumbnail renders BEFORE the attach lands…
    const preview = page.getByTestId('apps-offsite-screenshot-preview-0');
    await expect.element(preview).toBeInTheDocument();
    // …and its src is the local blob: object URL (what the user just picked).
    expect(preview.element().getAttribute('src') ?? '').toMatch(/^blob:/);
    // …and the row is scanning (not eagerly attached).
    await expect.element(page.getByText(/Scanning image/i)).toBeInTheDocument();
  });

  test('a freshly-uploaded icon shows a preview thumbnail while it scans', async () => {
    mocks.setIconAsync.mockResolvedValue({ status: 'pending' });
    renderStep();

    await userEvent.upload(await fileInputEl('icon'), await makeImageFile('icon.png'));

    const preview = page.getByTestId('apps-offsite-current-icon-preview');
    await expect.element(preview).toBeInTheDocument();
    expect(preview.element().getAttribute('src') ?? '').toMatch(/^blob:/);
    await expect.element(page.getByText(/Scanning image/i)).toBeInTheDocument();
  });

  test('a scanning screenshot can be CANCELLED (allowRemove=false) — slot drops, poll stops, blob revoked', async () => {
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
    mocks.addScreenshotAsync.mockResolvedValue({ status: 'pending' });
    // create mode → allowRemove defaults to false; cancelling your own in-flight
    // upload must STILL be allowed.
    renderStep();

    await userEvent.upload(await fileInputEl('screenshots'), await makeImageFile());
    await expect.element(page.getByText(/Scanning image/i)).toBeInTheDocument();

    // The cancel control is offered mid-scan even with allowRemove=false.
    const cancel = page.getByTestId('apps-offsite-screenshot-cancel-0');
    await expect.element(cancel).toBeInTheDocument();
    // Capture the blob URL now (so we can assert it's revoked on cancel).
    const blobUrl = page
      .getByTestId('apps-offsite-screenshot-preview-0')
      .element()
      .getAttribute('src');
    const callsBeforeCancel = mocks.addScreenshotAsync.mock.calls.length;

    await cancel.click();

    // The slot is gone (no preview, no "Screenshot 1" row).
    await expect.element(page.getByText('Screenshot 1')).not.toBeInTheDocument();
    expect(page.getByTestId('apps-offsite-screenshot-preview-0').elements()).toHaveLength(0);
    // The poll stopped: no further attach mutation fires after the cancel.
    expect(mocks.addScreenshotAsync.mock.calls.length).toBe(callsBeforeCancel);
    // The local object URL was revoked (no blob leak).
    expect(revokeSpy).toHaveBeenCalledWith(blobUrl);
    revokeSpy.mockRestore();
  });

  const prefill = {
    icon: { imageId: 1, url: 'https://edge/icon.png' },
    cover: { imageId: 2, url: 'https://edge/cover.png' },
    screenshots: [{ id: 'row-9', imageId: 3, url: 'https://edge/shot.png', caption: null, order: 0 }],
  };

  test('an attached prefilled screenshot offers NO remove/cancel when allowRemove=false', async () => {
    renderStep({ initial: prefill, allowRemove: false });
    await expect.element(page.getByText('Screenshot 1')).toBeInTheDocument();
    // Attached, server-owned row → not locally cancellable, and not removable
    // without allowRemove (create-flow behaviour, unchanged).
    expect(page.getByTestId('apps-offsite-screenshot-remove-0').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-offsite-screenshot-cancel-0').elements()).toHaveLength(0);
  });

  test('an attached prefilled screenshot uses the server remove proc when allowRemove=true', async () => {
    mocks.removeAsync.mockResolvedValue({ ok: true });
    renderStep({ initial: prefill, allowRemove: true });
    const remove = page.getByTestId('apps-offsite-screenshot-remove-0');
    await expect.element(remove).toBeInTheDocument();
    await remove.click();
    await vi.waitFor(() =>
      expect(mocks.removeAsync).toHaveBeenCalledWith({ screenshotId: 'row-9' })
    );
  });

  test('repeated upload + cancel does not crash or leak (blobs revoked each cycle)', async () => {
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
    mocks.addScreenshotAsync.mockResolvedValue({ status: 'pending' });
    renderStep();

    for (let i = 0; i < 3; i++) {
      await userEvent.upload(await fileInputEl('screenshots'), await makeImageFile(`s${i}.png`));
      const cancel = page.getByTestId('apps-offsite-screenshot-cancel-0');
      await expect.element(cancel).toBeInTheDocument();
      await cancel.click();
      await expect.element(page.getByText('Screenshot 1')).not.toBeInTheDocument();
    }
    // One revoke per cancelled cycle (no leak, no crash).
    expect(revokeSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
    revokeSpy.mockRestore();
  });
});
