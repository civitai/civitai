import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';
import { chooseFiles, makeUnreadableFilesFail } from '../../../test/unreadable-files';
import type * as ApplicationError from '~/utils/application-error';
import type * as AuthHelpers from '~/utils/auth-helpers';
import type * as CanvasUtils from '~/shared/utils/canvas-utils';
import type * as DeviceHelpers from '~/utils/device-helpers';
import type * as ImageUtils from '~/utils/image-utils';
import type * as SessionProviderModule from '~/providers/SessionProvider';
import type * as Trpc from '~/utils/trpc';

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
  openLoginPopup: vi.fn(),
  reportApplicationError: vi.fn(),
  /** Android unless a test says otherwise: the Files fallback is offered only there. */
  android: true,
  /** Signed in unless a test signs out. */
  currentUser: { id: 1 } as { id: number } | null,
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => mocks.currentUser }));

// Outside a provider useSession reports 'loading'; resolved here from the mocked user.
vi.mock('~/providers/SessionProvider', async (orig) => ({
  ...(await orig<typeof SessionProviderModule>()),
  useSession: () => ({
    data: undefined,
    status: mocks.currentUser ? 'authenticated' : 'unauthenticated',
    update: async () => null,
  }),
}));
vi.mock('~/utils/auth-helpers', async (orig) => ({
  ...(await orig<typeof AuthHelpers>()),
  openLoginPopup: mocks.openLoginPopup,
}));

vi.mock('~/utils/consumer-blob-upload', () => ({
  uploadConsumerBlob: mocks.uploadConsumerBlob,
}));

vi.mock('~/utils/image-utils', async (orig) => ({
  ...(await orig<typeof ImageUtils>()),
  getImageDimensions: mocks.getImageDimensions,
}));

// The generator's client-side resize/re-encode helpers. Mocked here as SPIES so
// we can assert the modal downscales to the SCHEMA bound (DIM_MAX) before upload
// — the actual canvas pixel-clamp is canvas-utils' own well-tested contract
// (calculateAspectRatioFit). The real pixel path is exercised in production via
// SourceImageUpload; here we lock the ORCHESTRATION (which bounds, in which order).
vi.mock('~/shared/utils/canvas-utils', async (orig) => ({
  ...(await orig<typeof CanvasUtils>()),
  resizeImage: mocks.resizeImage,
  imageToJpegBlob: mocks.imageToJpegBlob,
}));

vi.mock('~/utils/device-helpers', async (orig) => ({
  ...(await orig<typeof DeviceHelpers>()),
  isAndroidDevice: () => mocks.android,
}));

vi.mock('~/utils/application-error', async (orig) => ({
  ...(await orig<typeof ApplicationError>()),
  reportApplicationError: mocks.reportApplicationError,
}));

// The moderated scan/gate service. This modal must NEVER call it — the spies
// stay untouched on the generationSource branch (the orchestrator scans the
// OUTPUT). Mocking a module the modal doesn't import is harmless, and it turns
// "someone later wires a scan into this path" into a red test.
vi.mock('~/utils/trpc', async (orig) => ({
  ...(await orig<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'blockImageUpload.persist': { useMutation: () => ({ mutateAsync: mocks.persistMutate }) },
    'blockImageUpload.gate': { useMutation: () => ({ mutateAsync: mocks.gateMutate }) },
  }),
}));

// eslint-disable-next-line import/first
import BlockGenerationSourceUploadModal from '~/components/AppBlocks/BlockGenerationSourceUploadModal';
// eslint-disable-next-line import/first
import { DialogProvider } from '~/components/Dialog/DialogProvider';
// eslint-disable-next-line import/first
import { dialogStore, useDialogStore } from '~/components/Dialog/dialogStore';
// eslint-disable-next-line import/first
import { maxOrchestratorImageFileSize } from '~/server/common/constants';
// eslint-disable-next-line import/first
import { DIM_MAX, DIM_MIN } from '~/server/schema/blocks/workflow.schema';
// eslint-disable-next-line import/first
import { ImagePrepError } from '~/shared/utils/canvas-utils';
// eslint-disable-next-line import/first
import { isPickSnapshot, pickOriginal } from '~/utils/unreadable-pick';

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
    mocks.currentUser = { id: 1 };
    mocks.openLoginPopup.mockReset();
    mocks.android = true;
    mocks.reportApplicationError.mockReset().mockResolvedValue(undefined);
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
    // Retried like the generator's read of an uploaded url: a load can fail transiently.
    expect(mocks.getImageDimensions).toHaveBeenCalledWith(BLOB_URL, { loadRetries: 2 });

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

  test('signed out: choosing an image opens sign-in instead of uploading', async () => {
    mocks.currentUser = null;
    const onResolved = vi.fn();
    openModal(onResolved);
    await userEvent.upload(await fileInputEl(), makeImageFile());

    await vi.waitFor(() => expect(mocks.openLoginPopup).toHaveBeenCalledTimes(1));
    const here = window.location.pathname + window.location.search + window.location.hash;
    expect(mocks.openLoginPopup).toHaveBeenCalledWith(here, 'image-upload');
    await new Promise((r) => setTimeout(r, 200));
    expect(mocks.resizeImage).not.toHaveBeenCalled();
    expect(mocks.uploadConsumerBlob).not.toHaveBeenCalled();
    expect(onResolved).not.toHaveBeenCalled();
  });
});

const PICK_MESSAGE =
  "Your phone's photo picker gave us a file we can't open. Choose it from Files instead.";
const PREP_MESSAGE =
  "Couldn't read this image on your device. Try a different file or a screenshot.";
const UNCONFIRMED_MESSAGE = "Couldn't confirm the upload. Please try again.";
const RAW_LOAD_ERROR = 'Image failed to load (complete=true, naturalWidth=0)';

function filesFallbackInput() {
  const input = document.querySelector<HTMLInputElement>(
    '[data-testid="unreadable-pick-files-input"]'
  );
  if (!input) throw new Error('Files fallback input not found');
  return input;
}

const previewEl = () => document.querySelector('[data-testid="block-generation-source-preview"]');

/** The visible control of the main file input (a button); the native input behind it is hidden. */
function mainControlEl() {
  const el = document.querySelector<HTMLButtonElement>(
    'button[data-testid="block-generation-source-file-input"]'
  );
  if (!el) throw new Error('main file control not found');
  return el;
}

/**
 * #5746: some Android photo pickers hand over a File no API can read, or one that turns unreadable
 * after the first read. A decode retry cannot help; the pick is copied into memory up front, and an
 * unreadable one gets the Files chooser instead of a dead preview.
 */
describe('BlockGenerationSourceUploadModal — a pick the photo picker made unreadable', () => {
  let restoreReads = () => undefined as void;

  beforeEach(() => {
    useDialogStore.getState().closeAll();
    mocks.currentUser = { id: 1 };
    mocks.android = true;
    mocks.reportApplicationError.mockReset().mockResolvedValue(undefined);
    mocks.uploadConsumerBlob.mockReset();
    mocks.getImageDimensions.mockReset();
    mocks.resizeImage.mockReset().mockResolvedValue(RESIZED_BLOB);
    mocks.imageToJpegBlob.mockReset().mockResolvedValue(JPEG_BLOB);
    restoreReads = makeUnreadableFilesFail();
  });
  afterEach(() => {
    restoreReads();
    vi.restoreAllMocks();
  });

  test('an unreadable pick offers the Files chooser: no preview, no resize, no upload, reported once', async () => {
    const onResolved = vi.fn();
    openModal(onResolved);
    await chooseFiles(fileInputEl(), [makeImageFile('unreadable-0.jpg', 'image/jpeg')]);

    await expect.element(page.getByText(PICK_MESSAGE, { exact: true })).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Choose from Files' })).toBeVisible();
    expect(filesFallbackInput().hasAttribute('accept')).toBe(false);
    expect(previewEl()).toBeNull();
    expect(mocks.resizeImage).not.toHaveBeenCalled();
    expect(mocks.uploadConsumerBlob).not.toHaveBeenCalled();
    expect(onResolved).not.toHaveBeenCalled();
    expect(
      mocks.reportApplicationError.mock.calls.map(([e, ctx]) => [
        (e as Error).message,
        (ctx as { name?: string }).name,
        (ctx as { message?: string }).message,
      ])
    ).toEqual([
      [
        'app-block-source-upload pick failed: pick-unreadable',
        'app-block-source-upload-pick',
        'picked-file image/jpeg <5MB NotReadableError android:true',
      ],
    ]);
  });

  test('on Android, a file chosen from Files is uploaded and resolves', async () => {
    mocks.uploadConsumerBlob.mockResolvedValue({ url: BLOB_URL });
    mocks.getImageDimensions.mockResolvedValue({ width: 640, height: 480 });
    const onResolved = vi.fn();
    openModal(onResolved);
    await chooseFiles(fileInputEl(), [makeImageFile('unreadable-0.jpg', 'image/jpeg')]);
    await expect.element(page.getByText(PICK_MESSAGE, { exact: true })).toBeVisible();

    const fromFiles = makeImageFile('photo-0.jpg', 'image/jpeg');
    await chooseFiles(filesFallbackInput(), [fromFiles]);

    await vi.waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    expect(onResolved).toHaveBeenCalledWith({ url: BLOB_URL, width: 640, height: 480 });
    const [resizedFrom] = mocks.resizeImage.mock.calls[0];
    expect(pickOriginal(resizedFrom as File)).toBe(fromFiles);
  });

  test('off Android: a neutral message and no Files chooser', async () => {
    mocks.android = false;
    openModal(vi.fn());
    await chooseFiles(fileInputEl(), [makeImageFile('unreadable-0.jpg', 'image/jpeg')]);

    await expect
      .element(
        page.getByText("We couldn't open this file. Try choosing it again.", { exact: true })
      )
      .toBeVisible();
    expect(document.querySelector('[data-testid="unreadable-pick-files-input"]')).toBeNull();
    expect(previewEl()).toBeNull();
    expect(mocks.resizeImage).not.toHaveBeenCalled();
    expect(mocks.reportApplicationError.mock.calls.map(([, ctx]) => ctx)).toEqual([
      expect.objectContaining({
        message: 'picked-file image/jpeg <5MB NotReadableError android:false',
      }),
    ]);
  });

  test('every stage reads an in-memory copy of the pick, never the picked File itself', async () => {
    mocks.uploadConsumerBlob.mockResolvedValue({ url: BLOB_URL });
    mocks.getImageDimensions.mockResolvedValue({ width: 640, height: 480 });
    const createObjectURL = vi.spyOn(URL, 'createObjectURL');
    const picked = makeImageFile('photo-0.jpg', 'image/jpeg');
    const onResolved = vi.fn();
    openModal(onResolved);
    await chooseFiles(fileInputEl(), [picked]);

    await vi.waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    const [resizedFrom] = mocks.resizeImage.mock.calls[0];
    expect(resizedFrom).not.toBe(picked);
    expect(isPickSnapshot(resizedFrom as File)).toBe(true);
    expect(pickOriginal(resizedFrom as File)).toBe(picked);
    // The preview too: a url made for the picked File dies with it.
    const previewed = createObjectURL.mock.calls
      .map(([arg]) => arg)
      .filter((arg): arg is File => arg instanceof File);
    createObjectURL.mockRestore();
    expect(previewed).toHaveLength(1);
    expect(isPickSnapshot(previewed[0])).toBe(true);
    expect(pickOriginal(previewed[0])).toBe(picked);
  });

  test('an image the browser cannot decode shows friendly copy, through the real resize', async () => {
    const { resizeImage } = await vi.importActual<typeof CanvasUtils>(
      '~/shared/utils/canvas-utils'
    );
    mocks.resizeImage.mockImplementationOnce(resizeImage);
    const onResolved = vi.fn();
    openModal(onResolved);
    // Bytes no browser can decode: the real decode fails the way #5746's screenshot shows.
    await chooseFiles(fileInputEl(), [makeImageFile('photo-0.jpg', 'image/jpeg')]);

    await expect.element(page.getByText(PREP_MESSAGE, { exact: true })).toBeVisible();
    expect(document.body.textContent).not.toContain('complete=');
    expect(mocks.uploadConsumerBlob).not.toHaveBeenCalled();
  });

  test('a decode failure shows friendly copy, not the browser diagnostic', async () => {
    mocks.resizeImage.mockRejectedValue(
      new ImagePrepError('decode', false, RAW_LOAD_ERROR, { cause: new Event('error') })
    );
    const onResolved = vi.fn();
    openModal(onResolved);
    await chooseFiles(fileInputEl(), [makeImageFile('photo-0.jpg', 'image/jpeg')]);

    await expect.element(page.getByText(PREP_MESSAGE, { exact: true })).toBeVisible();
    // A readable pick keeps its preview: the control for the `previewEl()` null checks above.
    expect(previewEl()).not.toBeNull();
    expect(document.body.textContent).not.toContain('complete=');
    expect(mocks.uploadConsumerBlob).not.toHaveBeenCalled();
    expect(onResolved).not.toHaveBeenCalled();
  });

  test('a failed read of the uploaded url asks for another try, not for a different file', async () => {
    mocks.uploadConsumerBlob.mockResolvedValue({ url: BLOB_URL });
    mocks.getImageDimensions.mockRejectedValue(
      new Error(RAW_LOAD_ERROR, { cause: new Event('error') })
    );
    const onResolved = vi.fn();
    openModal(onResolved);
    await chooseFiles(fileInputEl(), [makeImageFile('photo-0.jpg', 'image/jpeg')]);

    // The file was fine and the upload succeeded; the url is what failed to load.
    await expect.element(page.getByText(UNCONFIRMED_MESSAGE, { exact: true })).toBeVisible();
    expect(document.body.textContent).not.toContain('Try a different file');
    expect(document.body.textContent).not.toContain('complete=');
    expect(onResolved).not.toHaveBeenCalled();
  });

  test('closing the modal mid-upload resolves nothing', async () => {
    let finishUpload: (v: { url: string }) => void = () => undefined;
    mocks.uploadConsumerBlob.mockReturnValue(new Promise((r) => (finishUpload = r)));
    mocks.getImageDimensions.mockResolvedValue({ width: 640, height: 480 });
    const onResolved = vi.fn();
    openModal(onResolved);
    await chooseFiles(fileInputEl(), [makeImageFile('photo-0.jpg', 'image/jpeg')]);
    await vi.waitFor(() => expect(mocks.uploadConsumerBlob).toHaveBeenCalledTimes(1));

    useDialogStore.getState().closeAll();
    await vi.waitFor(() => expect(document.querySelector('input[type="file"]')).toBeNull());
    finishUpload({ url: BLOB_URL });
    await new Promise((r) => setTimeout(r, 100));

    expect(mocks.getImageDimensions).not.toHaveBeenCalled();
    expect(onResolved).not.toHaveBeenCalled();
  });

  test('after an unreadable pick both choosers are usable, and the button opens the Files chooser', async () => {
    mocks.uploadConsumerBlob.mockResolvedValue({ url: BLOB_URL });
    mocks.getImageDimensions.mockResolvedValue({ width: 640, height: 480 });
    const onResolved = vi.fn();
    openModal(onResolved);
    await chooseFiles(fileInputEl(), [makeImageFile('unreadable-0.jpg', 'image/jpeg')]);
    await expect.element(page.getByText(PICK_MESSAGE, { exact: true })).toBeVisible();

    const button = page.getByRole('button', { name: 'Choose from Files' });
    expect.soft(mainControlEl().disabled).toBe(false);
    expect.soft((button.element() as HTMLButtonElement).disabled).toBe(false);

    // A real click: a disabled button would not reach the input. The OS chooser is not opened.
    const opened = vi.spyOn(filesFallbackInput(), 'click').mockImplementation(() => undefined);
    await button.click({ timeout: 2000 });
    expect(opened).toHaveBeenCalledTimes(1);

    await chooseFiles(filesFallbackInput(), [makeImageFile('photo-0.jpg', 'image/jpeg')]);
    await vi.waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
  });

  test('closing the modal while the pick is still being read previews and uploads nothing', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL');
    const picked = makeImageFile('photo-0.jpg', 'image/jpeg');
    let finishRead: (bytes: ArrayBuffer) => void = () => undefined;
    const read = vi.fn(() => new Promise<ArrayBuffer>((r) => (finishRead = r)));
    picked.arrayBuffer = read;
    const onResolved = vi.fn();
    openModal(onResolved);
    await chooseFiles(fileInputEl(), [picked]);
    expect(read).toHaveBeenCalledTimes(1);

    useDialogStore.getState().closeAll();
    await vi.waitFor(() => expect(document.querySelector('input[type="file"]')).toBeNull());
    finishRead(new Uint8Array([1, 2, 3, 4]).buffer);
    await new Promise((r) => setTimeout(r, 100));

    const previewed = createObjectURL.mock.calls.filter(([arg]) => arg instanceof File);
    createObjectURL.mockRestore();
    expect(previewed).toEqual([]);
    expect(mocks.resizeImage).not.toHaveBeenCalled();
    expect(mocks.uploadConsumerBlob).not.toHaveBeenCalled();
    expect(onResolved).not.toHaveBeenCalled();
  });

  test('an unreadable pick clears the preview of the pick before it', async () => {
    mocks.resizeImage.mockRejectedValue(
      new ImagePrepError('decode', false, RAW_LOAD_ERROR, { cause: new Event('error') })
    );
    openModal(vi.fn());
    await chooseFiles(fileInputEl(), [makeImageFile('photo-0.jpg', 'image/jpeg')]);
    await expect.element(page.getByText(PREP_MESSAGE, { exact: true })).toBeVisible();
    expect(previewEl()).not.toBeNull();

    await chooseFiles(fileInputEl(), [makeImageFile('unreadable-0.jpg', 'image/jpeg')]);
    await expect.element(page.getByText(PICK_MESSAGE, { exact: true })).toBeVisible();
    expect(previewEl()).toBeNull();
  });

  test('a readable pick clears the unreadable-pick alert', async () => {
    mocks.resizeImage.mockRejectedValue(
      new ImagePrepError('decode', false, RAW_LOAD_ERROR, { cause: new Event('error') })
    );
    openModal(vi.fn());
    await chooseFiles(fileInputEl(), [makeImageFile('unreadable-0.jpg', 'image/jpeg')]);
    await expect.element(page.getByText(PICK_MESSAGE, { exact: true })).toBeVisible();

    // Ends in an error, so the modal stays open and the alert would still be there to see.
    await chooseFiles(fileInputEl(), [makeImageFile('photo-0.jpg', 'image/jpeg')]);
    await expect.element(page.getByText(PREP_MESSAGE, { exact: true })).toBeVisible();
    expect(document.body.textContent).not.toContain(PICK_MESSAGE);
  });

  test('a file over the pick-copy size is taken by the main input and by the Files chooser alike', async () => {
    const oversized = (name: string) => {
      const file = makeImageFile(name, 'image/jpeg');
      // `size` is redefined rather than allocating the bytes.
      Object.defineProperty(file, 'size', { value: maxOrchestratorImageFileSize + 1 });
      return file;
    };
    mocks.resizeImage.mockRejectedValue(
      new ImagePrepError('decode', false, RAW_LOAD_ERROR, { cause: new Event('error') })
    );
    openModal(vi.fn());

    const fromMain = oversized('photo-0.jpg');
    await chooseFiles(fileInputEl(), [fromMain]);
    await vi.waitFor(() => expect(mocks.resizeImage).toHaveBeenCalledTimes(1));
    expect(mocks.resizeImage.mock.calls[0][0]).toBe(fromMain);

    await chooseFiles(fileInputEl(), [makeImageFile('unreadable-0.jpg', 'image/jpeg')]);
    await expect.element(page.getByText(PICK_MESSAGE, { exact: true })).toBeVisible();
    const fromFiles = oversized('photo-1.jpg');
    await chooseFiles(filesFallbackInput(), [fromFiles]);
    await vi.waitFor(() => expect(mocks.resizeImage).toHaveBeenCalledTimes(2));
    expect(mocks.resizeImage.mock.calls[1][0]).toBe(fromFiles);
    expect(document.body.textContent).not.toContain('Files should not exceed');
  });
});
