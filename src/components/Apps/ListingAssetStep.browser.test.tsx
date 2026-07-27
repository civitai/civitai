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
  // Item 1: the per-asset scan-status poll (utils.appListings.getAssetScanStatuses.fetch).
  scanStatusFetch: vi.fn(),
}));

vi.mock('~/utils/trpc', () => {
  return {
    trpc: {
      useUtils: () => ({
        appListings: {
          getAssetScanStatuses: { fetch: mocks.scanStatusFetch },
        },
      }),
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
  mocks.scanStatusFetch.mockReset();
  // Default upload pipeline: CF upload + persist resolve so the row can reach
  // the attached+scanning state.
  mocks.uploadToCF.mockResolvedValue({ id: 'cf-image-id' });
  mocks.persistAsync.mockResolvedValue({ imageId: 501 });
  // Default scan poll: the image is still scanning (keeps the "Scanning…" badge).
  // A test that wants it to LAND overrides this to return 'scanned' / 'blocked'.
  mocks.scanStatusFetch.mockImplementation(
    async ({ imageIds }: { imageIds: number[] }) => ({
      statuses: imageIds.map((imageId) => ({ imageId, status: 'pending' as const })),
    })
  );
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

  test('accepting a suggestion STORES the id immediately (mid-scan) then the scan badge lands "Scanned"', async () => {
    mocks.ingestAsync.mockResolvedValue({ imageId: 777 });
    // Item 1: the attach STORES the id immediately even while scanning →
    // `{ status: 'attached', scanPending: true }`. The client shows a "Scanning…" badge
    // and polls the scan status (below) to flip it to "Scanned".
    mocks.setIconAsync.mockResolvedValue({ status: 'attached', iconId: 777, scanPending: true });
    mocks.scanStatusFetch.mockResolvedValue({
      statuses: [{ imageId: 777, status: 'scanned' }],
    });

    renderStep();
    await page.getByTestId('apps-offsite-accept-icon').click();

    // The ingest ran and the attach was called ONCE (stored immediately, not re-polled).
    expect(mocks.ingestAsync).toHaveBeenCalledWith({
      url: suggestions.iconImageUrl,
      kind: 'icon',
    });
    expect(mocks.setIconAsync).toHaveBeenCalledWith({ listingId: 'listing-1', imageId: 777 });

    // The scan-status poll lands → the badge flips to "Scanned".
    await expect
      .element(page.getByTestId('apps-asset-scan-scanned'))
      .toBeInTheDocument();
    expect(mocks.scanStatusFetch).toHaveBeenCalledWith({ imageIds: [777] });
  });

  test('a BLOCKED scan result surfaces a "Blocked — replace" badge (submit floor still counts it attached)', async () => {
    mocks.ingestAsync.mockResolvedValue({ imageId: 778 });
    mocks.setIconAsync.mockResolvedValue({ status: 'attached', iconId: 778, scanPending: true });
    mocks.scanStatusFetch.mockResolvedValue({
      statuses: [{ imageId: 778, status: 'blocked' }],
    });

    renderStep();
    await page.getByTestId('apps-offsite-accept-icon').click();

    await expect.element(page.getByTestId('apps-asset-scan-blocked')).toBeInTheDocument();
    await expect.element(page.getByText(/Blocked — replace/i)).toBeInTheDocument();
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
  test('a freshly-uploaded screenshot shows a preview thumbnail while its scan is in-flight', async () => {
    // Attach STORES the row immediately with scanPending → the scan badge stays
    // "Scanning…" (the default scanStatusFetch keeps returning pending).
    mocks.addScreenshotAsync.mockResolvedValue({
      status: 'attached',
      id: 'row-1',
      order: 0,
      scanPending: true,
    });
    renderStep();

    await userEvent.upload(await fileInputEl('screenshots'), await makeImageFile());

    // The local object-URL preview thumbnail renders and persists through the scan…
    const preview = page.getByTestId('apps-offsite-screenshot-preview-0');
    await expect.element(preview).toBeInTheDocument();
    // …and its src is the local blob: object URL (what the user just picked).
    expect(preview.element().getAttribute('src') ?? '').toMatch(/^blob:/);
    // …and the per-asset scan badge shows "Scanning…".
    await expect.element(page.getByTestId('apps-asset-scan-scanning')).toBeInTheDocument();
  });

  test('a freshly-uploaded icon shows a preview thumbnail while its scan is in-flight', async () => {
    mocks.setIconAsync.mockResolvedValue({ status: 'attached', iconId: 501, scanPending: true });
    renderStep();

    await userEvent.upload(await fileInputEl('icon'), await makeImageFile('icon.png'));

    const preview = page.getByTestId('apps-offsite-current-icon-preview');
    await expect.element(preview).toBeInTheDocument();
    expect(preview.element().getAttribute('src') ?? '').toMatch(/^blob:/);
    await expect.element(page.getByTestId('apps-asset-scan-scanning')).toBeInTheDocument();
  });

  test('a scanning screenshot can be CANCELLED (allowRemove=false) — server row removed, slot drops, blob revoked', async () => {
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
    // The id is stored immediately (with a row) while scanning; cancelling your own
    // just-added upload must STILL be allowed in create mode (allowRemove=false) — it
    // removes the committed-but-scanning row on the server.
    mocks.addScreenshotAsync.mockResolvedValue({
      status: 'attached',
      id: 'row-1',
      order: 0,
      scanPending: true,
    });
    mocks.removeAsync.mockResolvedValue({ removed: 'row-1' });
    renderStep();

    await userEvent.upload(await fileInputEl('screenshots'), await makeImageFile());
    await expect.element(page.getByTestId('apps-asset-scan-scanning')).toBeInTheDocument();

    // The cancel control is offered mid-scan even with allowRemove=false.
    const cancel = page.getByTestId('apps-offsite-screenshot-cancel-0');
    await expect.element(cancel).toBeInTheDocument();
    // Capture the blob URL now (so we can assert it's revoked on cancel).
    const blobUrl = page
      .getByTestId('apps-offsite-screenshot-preview-0')
      .element()
      .getAttribute('src');

    await cancel.click();

    // The committed row was removed on the server …
    await vi.waitFor(() => expect(mocks.removeAsync).toHaveBeenCalledWith({ screenshotId: 'row-1' }));
    // … the slot is gone (no preview, no "Screenshot 1" row) …
    await expect.element(page.getByText('Screenshot 1')).not.toBeInTheDocument();
    expect(page.getByTestId('apps-offsite-screenshot-preview-0').elements()).toHaveLength(0);
    // … and the local object URL was revoked (no blob leak).
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

  test('tri-state completeness alert + onCompletenessChange (partial-media floor)', async () => {
    // (a) BELOW FLOOR — icon prefilled, cover missing → warning copy, meetsFloor false.
    const belowFloor = { meetsFloor: null as boolean | null, complete: null as boolean | null };
    renderStep({
      initial: {
        icon: { imageId: 1, url: 'https://edge/icon.png' },
        cover: { imageId: null, url: null },
        screenshots: [],
      },
      onCompletenessChange: (s) => {
        belowFloor.meetsFloor = s.meetsFloor;
        belowFloor.complete = s.complete;
      },
    });
    const alert = page.getByTestId('apps-listing-assets-completeness');
    await expect.element(alert).toHaveTextContent(/Add an icon and cover to publish/i);
    await vi.waitFor(() => expect(belowFloor.meetsFloor).toBe(false));
    expect(belowFloor.complete).toBe(false);
  });

  test('alert: FLOOR met but no screenshots → neutral "optional" copy, meetsFloor true', async () => {
    const state = { meetsFloor: null as boolean | null, complete: null as boolean | null };
    renderStep({
      initial: {
        icon: { imageId: 1, url: 'https://edge/icon.png' },
        cover: { imageId: 2, url: 'https://edge/cover.png' },
        screenshots: [],
      },
      onCompletenessChange: (s) => {
        state.meetsFloor = s.meetsFloor;
        state.complete = s.complete;
      },
    });
    const alert = page.getByTestId('apps-listing-assets-completeness');
    await expect
      .element(alert)
      .toHaveTextContent(/Screenshots are recommended but optional/i);
    await vi.waitFor(() => expect(state.meetsFloor).toBe(true));
    expect(state.complete).toBe(false);
  });

  test('alert: fully complete (icon+cover+screenshot) → "All set." + complete true', async () => {
    const state = { meetsFloor: null as boolean | null, complete: null as boolean | null };
    renderStep({
      initial: {
        icon: { imageId: 1, url: 'https://edge/icon.png' },
        cover: { imageId: 2, url: 'https://edge/cover.png' },
        screenshots: [
          { id: 'row-1', imageId: 3, url: 'https://edge/shot.png', caption: null, order: 0 },
        ],
      },
      onCompletenessChange: (s) => {
        state.meetsFloor = s.meetsFloor;
        state.complete = s.complete;
      },
    });
    const alert = page.getByTestId('apps-listing-assets-completeness');
    await expect.element(alert).toHaveTextContent(/All set/i);
    await vi.waitFor(() => expect(state.complete).toBe(true));
    expect(state.meetsFloor).toBe(true);
  });

  test('repeated upload + cancel does not crash or leak (blobs revoked each cycle)', async () => {
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
    // Each add stores a distinct row (still scanning); cancel removes it server-side.
    let n = 0;
    mocks.addScreenshotAsync.mockImplementation(async () => ({
      status: 'attached' as const,
      id: `row-${n++}`,
      order: 0,
      scanPending: true,
    }));
    mocks.removeAsync.mockResolvedValue({ removed: 'row' });
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
