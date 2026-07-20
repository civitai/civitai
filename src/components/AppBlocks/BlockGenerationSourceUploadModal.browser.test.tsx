import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * BlockGenerationSourceUploadModal — the UNSCANNED `generationSource` upload path.
 *
 * Proves that a `generationSource` block image upload:
 *   1. uploads through the SAME consumer-blob util the generator uses
 *      (`uploadConsumerBlob`) — never `createImage`;
 *   2. resolves ONLY the source shape { url, width, height } (real dims from the
 *      blob via `getImageDimensions`);
 *   3. NEVER touches the moderated scan/gate service (blockImageUpload.persist /
 *      gate) — those trpc mutations are mocked with spies and asserted untouched,
 *      a regression guard even though this modal doesn't import them today.
 */

const mocks = vi.hoisted(() => ({
  uploadConsumerBlob: vi.fn(),
  getImageDimensions: vi.fn(),
  resizeImage: vi.fn(),
  imageToJpegBlob: vi.fn(),
  persistMutate: vi.fn(),
  gateMutate: vi.fn(),
}));

vi.mock('~/utils/consumer-blob-upload', () => ({
  uploadConsumerBlob: mocks.uploadConsumerBlob,
}));

vi.mock('~/utils/image-utils', async (orig) => {
  const actual = await orig<typeof import('~/utils/image-utils')>();
  return { ...actual, getImageDimensions: mocks.getImageDimensions };
});

// The generator's client-side resize/re-encode helpers. Mocked here as SPIES so
// we can assert the modal downscales to the SCHEMA bound (DIM_MAX) before upload
// — the actual canvas pixel-clamp is canvas-utils' own well-tested contract
// (calculateAspectRatioFit). They're also mocked out of necessity: their real
// path (imageToJpegBlob → canvasToBlobWithImageExif) uses `Buffer`, which Next
// polyfills in the browser bundle (the shipped generator relies on exactly this)
// but the vitest browser env does not provide. So the real pixel path is
// exercised in production via SourceImageUpload; here we lock the ORCHESTRATION
// (which bounds, in which order).
vi.mock('~/shared/utils/canvas-utils', () => ({
  resizeImage: mocks.resizeImage,
  imageToJpegBlob: mocks.imageToJpegBlob,
}));

// The moderated scan/gate service. This modal must NEVER call it — the spies
// stay untouched on the generationSource branch (the orchestrator scans the
// OUTPUT). Mocking a module the modal doesn't import is harmless, and it turns
// "someone later wires a scan into this path" into a red test.
vi.mock('~/utils/trpc', () => ({
  trpc: {
    blockImageUpload: {
      persist: { useMutation: () => ({ mutateAsync: mocks.persistMutate }) },
      gate: { useMutation: () => ({ mutateAsync: mocks.gateMutate }) },
    },
  },
}));

// eslint-disable-next-line import/first
import BlockGenerationSourceUploadModal from '~/components/AppBlocks/BlockGenerationSourceUploadModal';
// eslint-disable-next-line import/first
import { DialogProvider } from '~/components/Dialog/DialogProvider';
// eslint-disable-next-line import/first
import { dialogStore, useDialogStore } from '~/components/Dialog/dialogStore';
// eslint-disable-next-line import/first
import { DIM_MAX, DIM_MIN } from '~/server/schema/blocks/workflow.schema';

const BLOB_URL =
  'https://orchestration.civitai.com/v2/consumer/blobs/ABC123.jpeg?sig=x&exp=2030-01-01T00:00:00Z';

/** A minimal image File. The resize/encode helpers are mocked, so bytes are inert. */
function makeImageFile(name = 'source.png', type = 'image/png'): File {
  return new File([new Uint8Array([1, 2, 3, 4])], name, { type });
}

/** The hidden native <input type=file> Mantine's FileInput renders. */
function fileInputEl(): Promise<HTMLInputElement> {
  return vi.waitFor(() => {
    const el = document.querySelector<HTMLInputElement>('input[type="file"]:not([multiple])');
    if (!el) throw new Error('file input not found');
    return el;
  });
}

function openModal(onResolved: (r: unknown) => void) {
  renderWithProviders(<DialogProvider />);
  dialogStore.trigger({
    id: 'gen-source-test',
    component: BlockGenerationSourceUploadModal,
    props: { onResolved },
  });
}

// Sentinel blobs threaded through the mocked resize → encode → upload pipeline so
// each stage's output can be asserted as the next stage's input.
const RESIZED_BLOB = new Blob(['resized-png'], { type: 'image/png' });
const JPEG_BLOB = new Blob(['jpeg-bytes'], { type: 'image/jpeg' });

describe('BlockGenerationSourceUploadModal (generationSource — unscanned source)', () => {
  beforeEach(() => {
    useDialogStore.getState().closeAll();
    mocks.uploadConsumerBlob.mockReset();
    mocks.getImageDimensions.mockReset();
    mocks.persistMutate.mockReset();
    mocks.gateMutate.mockReset();
    // Happy-path resize/encode by default (individual tests assert the args).
    mocks.resizeImage.mockReset().mockResolvedValue(RESIZED_BLOB);
    mocks.imageToJpegBlob.mockReset().mockResolvedValue(JPEG_BLOB);
  });

  test('resizes+re-encodes then uploads via uploadConsumerBlob, resolving { url, width, height } — no createImage/scan/gate', async () => {
    mocks.uploadConsumerBlob.mockResolvedValue({ url: BLOB_URL });
    mocks.getImageDimensions.mockResolvedValue({ width: 640, height: 480 });
    const onResolved = vi.fn();

    openModal(onResolved);
    await userEvent.upload(await fileInputEl(), makeImageFile());

    await vi.waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    // Exactly the source projection — no imageId / nsfwLevel / contentRating.
    expect(onResolved).toHaveBeenCalledWith({ url: BLOB_URL, width: 640, height: 480 });
    expect(Object.keys(onResolved.mock.calls[0][0]).sort()).toEqual(['height', 'url', 'width']);

    // Pipeline mirrors SourceImageUpload: resizeImage → imageToJpegBlob →
    // uploadConsumerBlob (the RE-ENCODED jpeg blob, not the raw File).
    expect(mocks.resizeImage).toHaveBeenCalledTimes(1);
    expect(mocks.imageToJpegBlob).toHaveBeenCalledTimes(1);
    expect(mocks.imageToJpegBlob).toHaveBeenCalledWith(RESIZED_BLOB);
    expect(mocks.uploadConsumerBlob).toHaveBeenCalledTimes(1);
    expect(mocks.uploadConsumerBlob).toHaveBeenCalledWith(JPEG_BLOB);
    // Real dims derived from the uploaded blob URL (mirrors SourceImageUpload).
    expect(mocks.getImageDimensions).toHaveBeenCalledWith(BLOB_URL);

    // The moderated scan/gate service is NEVER reached on this branch.
    expect(mocks.persistMutate).not.toHaveBeenCalled();
    expect(mocks.gateMutate).not.toHaveBeenCalled();
  });

  test('an upload failure surfaces an error and does NOT resolve (no partial source)', async () => {
    mocks.uploadConsumerBlob.mockRejectedValue(new Error('Failed to upload blob: 500'));
    const onResolved = vi.fn();

    openModal(onResolved);
    await userEvent.upload(await fileInputEl(), makeImageFile());

    await expect.element(page.getByText(/Failed to upload blob/i)).toBeInTheDocument();
    expect(onResolved).not.toHaveBeenCalled();
    expect(mocks.persistMutate).not.toHaveBeenCalled();
    expect(mocks.gateMutate).not.toHaveBeenCalled();
  });

  test('downscales to the blockSourceImageSchema bound (DIM_MAX, not the generator maxUpscaleSize) so a large image passes submit', async () => {
    mocks.uploadConsumerBlob.mockResolvedValue({ url: BLOB_URL });
    // The uploaded (resized) blob's dims are read here; set to the schema bound so
    // the resolved source is within DIM_MIN..DIM_MAX (would pass blockSourceImageSchema).
    mocks.getImageDimensions.mockResolvedValue({ width: DIM_MAX, height: 1365 });
    const onResolved = vi.fn();

    openModal(onResolved);
    await userEvent.upload(await fileInputEl(), makeImageFile('big.png'));

    await vi.waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));

    // THE FIX: the modal caps the pre-upload resize at the sourceImage schema
    // bound (DIM_MAX = 2048), NOT the generator's larger maxUpscaleSize (3840).
    // resizeImage's contract (calculateAspectRatioFit) then guarantees every side
    // ≤ maxWidth/maxHeight, so the uploaded source always lands within
    // DIM_MIN..DIM_MAX and is accepted at workflow submit instead of clamped-rejected.
    expect(mocks.resizeImage).toHaveBeenCalledTimes(1);
    const [srcArg, optsArg] = mocks.resizeImage.mock.calls[0];
    expect(srcArg).toBeInstanceOf(File);
    expect(optsArg).toEqual({
      maxWidth: DIM_MAX,
      maxHeight: DIM_MAX,
      minWidth: DIM_MIN,
      minHeight: DIM_MIN,
    });
    expect(optsArg.maxWidth).toBe(2048);

    // The resolved dims are within the schema bounds.
    const resolved = onResolved.mock.calls[0][0] as { width: number; height: number };
    expect(Math.max(resolved.width, resolved.height)).toBeLessThanOrEqual(DIM_MAX);
    expect(Math.min(resolved.width, resolved.height)).toBeGreaterThanOrEqual(DIM_MIN);

    expect(mocks.persistMutate).not.toHaveBeenCalled();
    expect(mocks.gateMutate).not.toHaveBeenCalled();
  });

  test('a VIDEO file is rejected with a clear message and never resized or uploaded', async () => {
    const onResolved = vi.fn();
    openModal(onResolved);

    // uploadConsumerBlob would accept video/mp4, but a video can't be an img2img
    // source — the modal must reject it before touching the resize/upload path.
    await userEvent.upload(await fileInputEl(), makeImageFile('clip.mp4', 'video/mp4'));

    await expect.element(page.getByText(/choose an image file/i)).toBeInTheDocument();
    expect(mocks.resizeImage).not.toHaveBeenCalled();
    expect(mocks.uploadConsumerBlob).not.toHaveBeenCalled();
    expect(onResolved).not.toHaveBeenCalled();
    expect(mocks.persistMutate).not.toHaveBeenCalled();
    expect(mocks.gateMutate).not.toHaveBeenCalled();
  });
});
