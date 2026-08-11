import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// The bounds the prechecks apply, IMPORTED rather than spelled: a literal here
// would agree with a precheck that hard-coded a different number.
import {
  LISTING_ASSET_MAX_DIMENSION_PX,
  LISTING_COVER_ASPECT_MAX,
  LISTING_COVER_ASPECT_MIN,
  LISTING_COVER_MIN_WIDTH_PX,
  LISTING_ICON_ASPECT_MAX,
  LISTING_ICON_ASPECT_MIN,
  LISTING_ICON_MAX_PX,
  LISTING_ICON_MIN_PX,
  LISTING_SCREENSHOT_ASPECT_MAX,
  LISTING_SCREENSHOT_ASPECT_MIN,
  LISTING_SCREENSHOT_MIN_PX,
} from '~/server/schema/blocks/app-listing.schema';
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
  // `ListingAssetStep` rasterises a data-URI (e.g. SVG) icon through this procedure.
  ingestDataUriAsync: vi.fn(),
  persistAsync: vi.fn(),
  uploadToCF: vi.fn(),
  // Item 1: the per-asset scan-status poll (utils.appListings.getAssetScanStatuses.fetch).
  scanStatusFetch: vi.fn(),
  // Hoisted (rather than an inline `vi.fn()` in the factory) so the per-kind
  // precheck tests can read what the author was actually told: the icon/cover rows
  // render `state.message` inline, but a SCREENSHOT slot renders only a status
  // badge, so for screenshots this notification is the ONLY channel the rejection
  // reason travels on.
  showErrorNotification: vi.fn(),
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
          useMutation: () => ({
            mutate: vi.fn(),
            mutateAsync: mocks.persistAsync,
            isPending: false,
          }),
        },
        ingestAssetFromUrl: {
          useMutation: () => ({
            mutate: vi.fn(),
            mutateAsync: mocks.ingestAsync,
            isPending: false,
          }),
        },
        // `ListingAssetStep` calls `trpc.appListings.ingestAssetFromDataUri.useMutation()`
        // unconditionally at the top of the component. A wholesale `vi.mock` of
        // `~/utils/trpc` that omits it makes that read `undefined.useMutation` — an
        // unhandled THROW during render, so nothing mounts and all 13 tests fail by
        // burning their 5s timeout (~178s of wall clock).
        ingestAssetFromDataUri: {
          useMutation: () => ({
            mutate: vi.fn(),
            mutateAsync: mocks.ingestDataUriAsync,
            isPending: false,
          }),
        },
        setIcon: {
          useMutation: () => ({
            mutate: vi.fn(),
            mutateAsync: mocks.setIconAsync,
            isPending: false,
          }),
        },
        setCover: {
          useMutation: () => ({
            mutate: vi.fn(),
            mutateAsync: mocks.setCoverAsync,
            isPending: false,
          }),
        },
        addScreenshot: {
          useMutation: () => ({
            mutate: vi.fn(),
            mutateAsync: mocks.addScreenshotAsync,
            isPending: false,
          }),
        },
        removeScreenshot: {
          useMutation: () => ({
            mutate: vi.fn(),
            mutateAsync: mocks.removeAsync,
            isPending: false,
          }),
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
  showErrorNotification: mocks.showErrorNotification,
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
 *
 * The default 640×480 is a VALID SCREENSHOT (aspect 1.33 inside 0.4–2.6, shorter
 * side 480 ≥ 320) because the client now applies the server's per-kind geometry
 * rules before uploading: a fixture that merely decodes is no longer enough for a
 * test whose subject is anything downstream of the picker.
 */
async function makeImageFile(name = 'shot.png', width = 640, height = 480): Promise<File> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob null'))), 'image/png');
  });
  const file = new File([blob], name, { type: 'image/png' });
  // The dimension precheck below is the whole point of the oversize fixtures, so
  // assert the fixture actually HAS the dimensions asked for before any test
  // reasons about which side of the bound it falls on — a canvas that silently
  // clamped would make an "under the bound" result a fact about the fixture.
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width !== width || bitmap.height !== height) {
      throw new Error(`fixture is ${bitmap.width}×${bitmap.height}, asked for ${width}×${height}`);
    }
  } finally {
    bitmap.close();
  }
  return file;
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
  mocks.showErrorNotification.mockReset();
  // Default upload pipeline: CF upload + persist resolve so the row can reach
  // the attached+scanning state.
  mocks.uploadToCF.mockResolvedValue({ id: 'cf-image-id' });
  mocks.persistAsync.mockResolvedValue({ imageId: 501 });
  // Default scan poll: the image is still scanning (keeps the "Scanning…" badge).
  // A test that wants it to LAND overrides this to return 'scanned' / 'blocked'.
  mocks.scanStatusFetch.mockImplementation(async ({ imageIds }: { imageIds: number[] }) => ({
    statuses: imageIds.map((imageId) => ({ imageId, status: 'pending' as const })),
  }));
});

describe('ListingAssetStep — OG-image auto-fill', () => {
  test('renders the suggested-icon accept affordance from the server suggestion', async () => {
    renderStep();
    await expect.element(page.getByTestId('apps-offsite-accept-icon')).toBeInTheDocument();
    await expect
      .element(page.getByTestId('apps-offsite-suggested-icon-preview'))
      .toBeInTheDocument();
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
    await expect.element(page.getByTestId('apps-asset-scan-scanned')).toBeInTheDocument();
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
      trpcAttachError('BAD_REQUEST', "that image couldn't be imported — upload it manually instead")
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

    // Square + comfortably inside the icon bounds — see `makeImageFile`.
    await userEvent.upload(await fileInputEl('icon'), await makeImageFile('icon.png', 256, 256));

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
    await vi.waitFor(() =>
      expect(mocks.removeAsync).toHaveBeenCalledWith({ screenshotId: 'row-1' })
    );
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
    screenshots: [
      { id: 'row-9', imageId: 3, url: 'https://edge/shot.png', caption: null, order: 0 },
    ],
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
    await expect.element(alert).toHaveTextContent(/Screenshots are recommended but optional/i);
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

describe('ListingAssetStep — per-side dimension precheck (issue #3772)', () => {
  /**
   * The server has applied `listingAssetTooLargeReason` to listing uploads since
   * #3801 — but only in `persistAssetImage`, i.e. AFTER the object-store upload
   * has finished. `uploadAndPersist` already reads the file's intrinsic dimensions
   * before it uploads, so the rejection is knowable from the file picker; these
   * assert it is actually taken there.
   *
   * The two fixtures differ by exactly ONE pixel on the side the bound is over
   * (`LISTING_ASSET_MAX_DIMENSION_PX` and `+ 1`), which is what makes the pair
   * able to cross the bound rather than merely sit on one side of it. The bound
   * is imported, not spelled — a literal here would pass just as happily against
   * a precheck that hard-coded a different number.
   *
   * 🔴 These prove the UPLOAD IS SKIPPED, not that the image is rejected: the
   * server re-derives the dimensions from the stored bytes and re-applies the
   * same predicate, and that is the enforcement point. A green run here says
   * nothing about the server-side bound, which
   * `__tests__/offsite-listing.service.test.ts` covers.
   */
  test('an over-bound cover is refused BEFORE the upload starts', async () => {
    renderStep();

    await userEvent.upload(
      await fileInputEl('cover'),
      await makeImageFile('huge.png', LISTING_ASSET_MAX_DIMENSION_PX + 1, 512)
    );

    // The author is told why, in the server's own words — asserted as the whole
    // rendered string INCLUDING the offending value, so a guard that fired for a
    // different reason (or named a different number) cannot satisfy it.
    await expect
      .element(
        page.getByText(
          `That image is too large (max ${LISTING_ASSET_MAX_DIMENSION_PX}px per side, got ${
            LISTING_ASSET_MAX_DIMENSION_PX + 1
          }px).`
        )
      )
      .toBeInTheDocument();
    // … and not one byte was sent to the object store, nor a row persisted.
    expect(mocks.uploadToCF).not.toHaveBeenCalled();
    expect(mocks.persistAsync).not.toHaveBeenCalled();
  });

  test('the bound is caught on EITHER axis — a tall icon is refused too', async () => {
    renderStep();

    // The landscape case above cannot tell `max(w, h)` apart from a check that
    // only ever looks at the width; this one crosses the bound on the OTHER axis,
    // so a single-axis precheck fails here even though it passes there.
    await userEvent.upload(
      await fileInputEl('icon'),
      await makeImageFile('tall.png', 512, LISTING_ASSET_MAX_DIMENSION_PX + 1)
    );

    await expect
      .element(
        page.getByText(
          `That image is too large (max ${LISTING_ASSET_MAX_DIMENSION_PX}px per side, got ${
            LISTING_ASSET_MAX_DIMENSION_PX + 1
          }px).`
        )
      )
      .toBeInTheDocument();
    expect(mocks.uploadToCF).not.toHaveBeenCalled();
    expect(mocks.persistAsync).not.toHaveBeenCalled();
  });

  test('a cover EXACTLY at the bound still uploads (the check is >, not >=)', async () => {
    mocks.setCoverAsync.mockResolvedValue({ status: 'attached', coverId: 501, scanPending: true });
    renderStep();

    // Half the long side, so the aspect (2.0) also sits inside the COVER's own
    // 1.3–2.4 band: the fixture has to clear every rule the client now applies, or
    // this would fail for a reason that has nothing to do with the bound it guards.
    const atBoundHeight = LISTING_ASSET_MAX_DIMENSION_PX / 2;
    await userEvent.upload(
      await fileInputEl('cover'),
      await makeImageFile('at-bound.png', LISTING_ASSET_MAX_DIMENSION_PX, atBoundHeight)
    );

    // The positive control for the test above: the SAME code path and the same
    // slot, one pixel narrower, reaches the store. Without this a precheck that
    // rejected everything — or one whose comparison was inverted at the boundary —
    // would look correct.
    await vi.waitFor(() => expect(mocks.uploadToCF).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(mocks.persistAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          width: LISTING_ASSET_MAX_DIMENSION_PX,
          height: atBoundHeight,
        })
      )
    );
  });
});

describe('ListingAssetStep — per-KIND geometry precheck (issue #3772)', () => {
  /**
   * The per-side ceiling above is kind-AGNOSTIC. Every other geometry rule the
   * server applies is per-kind and lives at ATTACH (`validateListingImage`, reached
   * through `setIcon`/`setCover`/`addScreenshot`) — which the client only gets to
   * AFTER the upload AND the persist. So a 5000px icon, or a merely wrongly-shaped
   * one, still cost a full transfer before being refused, and a wrongly-shaped icon
   * is far easier to produce by accident than an 8192px one.
   *
   * Each bound is asserted in BOTH directions: a fixture the server would refuse is
   * refused before `uploadToCF`, and a fixture at the boundary the server ACCEPTS
   * still uploads. The accept half is not decoration — over-rejection at the picker
   * is a worse failure than the wasted upload this is fixing, and only the accept
   * cases can catch it.
   *
   * 🔴 As with the block above, these prove the UPLOAD IS SKIPPED, not that the
   * image is rejected. The server re-derives the pair from the stored bytes and
   * re-applies `validateListingImage`; that remains the enforcement point, and it is
   * covered by `src/server/services/blocks/__tests__/app-listing-assets.service.test.ts`.
   *
   * Every expected message is BUILT FROM THE IMPORTED CONSTANTS and asserted whole,
   * including the offending value, so a guard that fired for a different reason — or
   * named a different number — cannot satisfy it.
   */

  /**
   * Drive one slot with one fixture and assert nothing reached the object store —
   * and that the author was told WHY, in the server's exact words.
   *
   * The message is asserted on the channel that actually carries it for that slot:
   * icon/cover rows render `state.message` inline, a screenshot slot renders only a
   * status badge. `showErrorNotification` carries it for all three, so it is the
   * assertion every kind shares; without it the screenshot cases would be asserting
   * on an element the component never renders.
   */
  async function expectRefused(
    which: 'icon' | 'cover' | 'screenshots',
    file: File,
    message: string
  ) {
    const kind = which === 'screenshots' ? 'screenshot' : which;
    await userEvent.upload(await fileInputEl(which), file);
    await vi.waitFor(() =>
      expect(mocks.showErrorNotification).toHaveBeenCalledWith({
        title: `Could not add ${kind}`,
        // The Error the author sees, matched on its whole message — not a substring,
        // so a guard that fired for a different bound cannot satisfy it.
        error: expect.objectContaining({ message }),
      })
    );
    if (which !== 'screenshots') {
      await expect.element(page.getByText(message)).toBeInTheDocument();
    }
    expect(mocks.uploadToCF).not.toHaveBeenCalled();
    expect(mocks.persistAsync).not.toHaveBeenCalled();
  }

  /** Drive one slot with one fixture and assert it DID reach the object store. */
  async function expectUploaded(
    which: 'icon' | 'cover' | 'screenshots',
    file: File,
    width: number,
    height: number
  ) {
    await userEvent.upload(await fileInputEl(which), file);
    await vi.waitFor(() => expect(mocks.uploadToCF).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(mocks.persistAsync).toHaveBeenCalledWith(expect.objectContaining({ width, height }))
    );
  }

  beforeEach(() => {
    // The accept cases run past the upload into the attach proc; without a resolved
    // result the row would error for a reason unrelated to the bound under test.
    mocks.setIconAsync.mockResolvedValue({ status: 'attached', iconId: 501, scanPending: false });
    mocks.setCoverAsync.mockResolvedValue({ status: 'attached', coverId: 501, scanPending: false });
    mocks.addScreenshotAsync.mockResolvedValue({
      status: 'attached',
      id: 'row-1',
      order: 0,
      scanPending: false,
    });
  });

  // --- icon: longer side (the bound the kind-agnostic ceiling is DOUBLE of) ------

  test('an icon over the ICON pixel cap is refused before the upload — at half the kind-agnostic ceiling', async () => {
    renderStep();
    // 🔴 The discriminating case for this whole block: this is UNDER
    // LISTING_ASSET_MAX_DIMENSION_PX, so the pre-existing per-side precheck passes
    // it. Only a check that knows the asset is an ICON refuses it.
    expect(LISTING_ICON_MAX_PX).toBeLessThan(LISTING_ASSET_MAX_DIMENSION_PX);
    const over = LISTING_ICON_MAX_PX + 1;
    await expectRefused(
      'icon',
      await makeImageFile('big-icon.png', over, over),
      `icon must be at most ${LISTING_ICON_MAX_PX}px on its longer side (got ${over}px)`
    );
  });

  test('an icon EXACTLY at the ICON pixel cap still uploads', async () => {
    renderStep();
    await expectUploaded(
      'icon',
      await makeImageFile('max-icon.png', LISTING_ICON_MAX_PX, LISTING_ICON_MAX_PX),
      LISTING_ICON_MAX_PX,
      LISTING_ICON_MAX_PX
    );
  });

  // --- icon: aspect (both sides of the band) ------------------------------------

  test('a WIDE icon is refused before the upload', async () => {
    renderStep();
    await expectRefused(
      'icon',
      await makeImageFile('wide-icon.png', 242, 200),
      `icon must be square-ish (aspect 1.21 outside ${LISTING_ICON_ASPECT_MIN}–${LISTING_ICON_ASPECT_MAX})`
    );
  });

  test('a TALL icon is refused before the upload — the band is two-sided', async () => {
    renderStep();
    // The wide case above cannot tell a two-sided band from a bare upper bound.
    await expectRefused(
      'icon',
      await makeImageFile('tall-icon.png', 200, 242),
      `icon must be square-ish (aspect 0.83 outside ${LISTING_ICON_ASPECT_MIN}–${LISTING_ICON_ASPECT_MAX})`
    );
  });

  test('an icon at the aspect band EDGE still uploads', async () => {
    renderStep();
    // 220/200 = 1.1 exactly — the boundary the two refusals bracket.
    await expectUploaded('icon', await makeImageFile('edge-icon.png', 220, 200), 220, 200);
  });

  // --- icon: minimum shorter side ----------------------------------------------

  test('an under-size icon is refused before the upload', async () => {
    renderStep();
    const under = LISTING_ICON_MIN_PX - 1;
    await expectRefused(
      'icon',
      await makeImageFile('small-icon.png', under, under),
      `icon must be at least ${LISTING_ICON_MIN_PX}px on its shorter side (got ${under}px)`
    );
  });

  test('an icon EXACTLY at the minimum still uploads', async () => {
    renderStep();
    await expectUploaded(
      'icon',
      await makeImageFile('min-icon.png', LISTING_ICON_MIN_PX, LISTING_ICON_MIN_PX),
      LISTING_ICON_MIN_PX,
      LISTING_ICON_MIN_PX
    );
  });

  // --- cover: aspect + minimum width -------------------------------------------

  test('a SQUARE cover is refused before the upload', async () => {
    renderStep();
    // Width is kept above the cover minimum so the ASPECT rule is what fires.
    await expectRefused(
      'cover',
      await makeImageFile('square-cover.png', 640, 640),
      `cover must be landscape (aspect 1.00 outside ${LISTING_COVER_ASPECT_MIN}–${LISTING_COVER_ASPECT_MAX})`
    );
  });

  test('an over-wide cover is refused before the upload', async () => {
    renderStep();
    await expectRefused(
      'cover',
      await makeImageFile('panorama.png', 1600, 640),
      `cover must be landscape (aspect 2.50 outside ${LISTING_COVER_ASPECT_MIN}–${LISTING_COVER_ASPECT_MAX})`
    );
  });

  test('a cover at the widest ACCEPTED aspect still uploads', async () => {
    renderStep();
    // 1536/640 = 2.4 exactly — one step inside the refusal above.
    await expectUploaded('cover', await makeImageFile('wide-cover.png', 1536, 640), 1536, 640);
  });

  test('a too-narrow cover is refused before the upload', async () => {
    renderStep();
    const under = LISTING_COVER_MIN_WIDTH_PX - 1;
    // Aspect 1.5 — inside the band, so WIDTH is unambiguously what fires.
    await expectRefused(
      'cover',
      await makeImageFile('narrow-cover.png', under, 426),
      `cover must be at least ${LISTING_COVER_MIN_WIDTH_PX}px wide (got ${under}px)`
    );
  });

  test('a cover EXACTLY at the minimum width still uploads', async () => {
    renderStep();
    await expectUploaded(
      'cover',
      await makeImageFile('min-cover.png', LISTING_COVER_MIN_WIDTH_PX, 427),
      LISTING_COVER_MIN_WIDTH_PX,
      427
    );
  });

  // --- screenshot: aspect + minimum shorter side --------------------------------

  test('an over-wide screenshot is refused before the upload', async () => {
    renderStep();
    await expectRefused(
      'screenshots',
      await makeImageFile('wide-shot.png', 1080, 400),
      `screenshot aspect 2.70 is outside ${LISTING_SCREENSHOT_ASPECT_MIN}–${LISTING_SCREENSHOT_ASPECT_MAX}`
    );
  });

  test('an over-tall screenshot is refused before the upload — the band is two-sided', async () => {
    renderStep();
    await expectRefused(
      'screenshots',
      await makeImageFile('tall-shot.png', 400, 1080),
      `screenshot aspect 0.37 is outside ${LISTING_SCREENSHOT_ASPECT_MIN}–${LISTING_SCREENSHOT_ASPECT_MAX}`
    );
  });

  test('a screenshot at the widest ACCEPTED aspect still uploads', async () => {
    renderStep();
    // 1040/400 = 2.6 exactly.
    await expectUploaded('screenshots', await makeImageFile('edge-shot.png', 1040, 400), 1040, 400);
  });

  test('an under-size screenshot is refused before the upload', async () => {
    renderStep();
    const under = LISTING_SCREENSHOT_MIN_PX - 1;
    // Aspect 2.5 — inside the band, so the SHORTER SIDE is what fires.
    await expectRefused(
      'screenshots',
      await makeImageFile('small-shot.png', 800, under),
      `screenshot must be at least ${LISTING_SCREENSHOT_MIN_PX}px on its shorter side`
    );
  });

  test('a screenshot EXACTLY at the minimum shorter side still uploads', async () => {
    renderStep();
    await expectUploaded(
      'screenshots',
      await makeImageFile('min-shot.png', 800, LISTING_SCREENSHOT_MIN_PX),
      800,
      LISTING_SCREENSHOT_MIN_PX
    );
  });

  // --- the kind is actually THREADED, not assumed --------------------------------

  test('ONE fixture, three verdicts — the slot decides which rules apply', async () => {
    // 🔴 The guard against the kind being hardcoded or mis-threaded. A 256×256 square
    // is a VALID icon, but too square for a cover (aspect 1.00 < 1.3) and too small
    // for a screenshot (256 < 320). Any implementation that validates every upload
    // as one fixed kind gets at least one of these three wrong, and a `kind`
    // threaded from the wrong place gets the accept and the refusals inconsistent.
    const square = () => makeImageFile('square.png', 256, 256);

    renderStep();
    await expectUploaded('icon', await square(), 256, 256);

    mocks.uploadToCF.mockClear();
    mocks.persistAsync.mockClear();
    mocks.showErrorNotification.mockClear();
    await expectRefused(
      'cover',
      await square(),
      `cover must be landscape (aspect 1.00 outside ${LISTING_COVER_ASPECT_MIN}–${LISTING_COVER_ASPECT_MAX})`
    );

    await expectRefused(
      'screenshots',
      await square(),
      `screenshot must be at least ${LISTING_SCREENSHOT_MIN_PX}px on its shorter side`
    );
  });
});
