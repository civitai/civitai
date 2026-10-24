import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';
import { chooseFiles, makeUnreadableFilesFail } from '../../../test/unreadable-files';
import type * as ApplicationError from '~/utils/application-error';
import type * as DeviceHelpers from '~/utils/device-helpers';
import type * as Trpc from '~/utils/trpc';

/**
 * BlockImageUploadModal (the moderated `display` path) and a pick the photo picker made unreadable
 * (#5746): its image-only file input opens the same Android photo picker as the generation-source
 * modal, so a pick is copied into memory up front and an unreadable one gets the Files chooser.
 */

const mocks = vi.hoisted(() => ({
  uploadToCF: vi.fn(),
  persistMutate: vi.fn(),
  gateMutate: vi.fn(),
  reportApplicationError: vi.fn(),
  /** Android unless a test says otherwise: the Files fallback is offered only there. */
  android: true,
}));

vi.mock('~/hooks/useCFImageUpload', () => ({
  useCFImageUpload: () => ({ uploadToCF: mocks.uploadToCF }),
}));

vi.mock('~/utils/trpc', async (orig) => ({
  ...(await orig<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'blockImageUpload.persist': { useMutation: () => ({ mutateAsync: mocks.persistMutate }) },
    'blockImageUpload.gate': { useMutation: () => ({ mutateAsync: mocks.gateMutate }) },
  }),
}));

vi.mock('~/utils/device-helpers', async (orig) => ({
  ...(await orig<typeof DeviceHelpers>()),
  isAndroidDevice: () => mocks.android,
}));

vi.mock('~/utils/application-error', async (orig) => ({
  ...(await orig<typeof ApplicationError>()),
  reportApplicationError: mocks.reportApplicationError,
}));

// eslint-disable-next-line import/first
import BlockImageUploadModal from '~/components/AppBlocks/BlockImageUploadModal';
// eslint-disable-next-line import/first
import { DialogProvider } from '~/components/Dialog/DialogProvider';
// eslint-disable-next-line import/first
import { dialogStore, useDialogStore } from '~/components/Dialog/dialogStore';
// eslint-disable-next-line import/first
import { constants } from '~/server/common/constants';
// eslint-disable-next-line import/first
import { isPickSnapshot, pickOriginal } from '~/utils/unreadable-pick';

const PICK_MESSAGE =
  "Your phone's photo picker gave us a file we can't open. Choose it from Files instead.";
const PREP_MESSAGE =
  "Couldn't read this image on your device. Try a different file or a screenshot.";

/** A real, decodable 3x2 PNG, so the modal's own dimension read succeeds. */
async function pngFile(name: string) {
  const canvas = new OffscreenCanvas(3, 2);
  canvas.getContext('2d')?.fillRect(0, 0, 3, 2);
  return new File([await canvas.convertToBlob({ type: 'image/png' })], name, {
    type: 'image/png',
  });
}

/** Bytes no browser can decode as an image. */
function corruptFile(name: string) {
  return new File([new Uint8Array([1, 2, 3, 4])], name, { type: 'image/png' });
}

function fileInputEl(): Promise<HTMLInputElement> {
  return vi.waitFor(() => {
    const el = document.querySelector<HTMLInputElement>(
      'input[type="file"]:not([data-testid="unreadable-pick-files-input"])'
    );
    if (!el) throw new Error('file input not found');
    return el;
  });
}

function filesFallbackInput() {
  const input = document.querySelector<HTMLInputElement>(
    '[data-testid="unreadable-pick-files-input"]'
  );
  if (!input) throw new Error('Files fallback input not found');
  return input;
}

const previewEl = () => document.querySelector('[data-testid="block-image-upload-preview"]');

/** The visible control of the main file input (a button); the native input behind it is hidden. */
function mainControlEl() {
  const el = document.querySelector<HTMLButtonElement>(
    'button[data-testid="block-image-upload-file-input"]'
  );
  if (!el) throw new Error('main file control not found');
  return el;
}

function openModal(onAccepted: (handle: { imageId: number; url: string }) => void) {
  renderWithProviders(<DialogProvider />);
  dialogStore.trigger({
    id: 'display-upload-test',
    component: BlockImageUploadModal,
    props: { onResolved: vi.fn(), onAccepted },
  });
}

describe('BlockImageUploadModal — a pick the photo picker made unreadable', () => {
  let restoreReads = () => undefined as void;

  beforeEach(() => {
    useDialogStore.getState().closeAll();
    mocks.android = true;
    mocks.uploadToCF.mockReset().mockResolvedValue({ id: 'cf-key' });
    mocks.persistMutate.mockReset().mockResolvedValue({ imageId: 77 });
    mocks.gateMutate.mockReset();
    mocks.reportApplicationError.mockReset().mockResolvedValue(undefined);
    restoreReads = makeUnreadableFilesFail();
  });
  afterEach(() => {
    restoreReads();
    vi.restoreAllMocks();
  });

  test('an unreadable pick offers the Files chooser: no preview, no upload, reported once', async () => {
    const onAccepted = vi.fn();
    openModal(onAccepted);
    await chooseFiles(fileInputEl(), [await pngFile('unreadable-0.png')]);

    await expect.element(page.getByText(PICK_MESSAGE, { exact: true })).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Choose from Files' })).toBeVisible();
    expect(previewEl()).toBeNull();
    expect(mocks.uploadToCF).not.toHaveBeenCalled();
    expect(mocks.persistMutate).not.toHaveBeenCalled();
    expect(onAccepted).not.toHaveBeenCalled();
    expect(
      mocks.reportApplicationError.mock.calls.map(([e, ctx]) => [
        (e as Error).message,
        (ctx as { name?: string }).name,
        (ctx as { message?: string }).message,
      ])
    ).toEqual([
      [
        'app-block-display-upload pick failed: pick-unreadable',
        'app-block-display-upload-pick',
        'picked-file image/png <5MB NotReadableError android:true',
      ],
    ]);
  });

  test('on Android, a file chosen from Files is uploaded as an in-memory copy and accepted', async () => {
    const onAccepted = vi.fn();
    openModal(onAccepted);
    await chooseFiles(fileInputEl(), [await pngFile('unreadable-0.png')]);
    await expect.element(page.getByText(PICK_MESSAGE, { exact: true })).toBeVisible();

    const fromFiles = await pngFile('photo-0.png');
    await chooseFiles(filesFallbackInput(), [fromFiles]);

    await vi.waitFor(() => expect(onAccepted).toHaveBeenCalledTimes(1));
    expect(onAccepted.mock.calls[0][0]).toMatchObject({ imageId: 77 });
    const [uploaded] = mocks.uploadToCF.mock.calls[0];
    expect(isPickSnapshot(uploaded as File)).toBe(true);
    expect(pickOriginal(uploaded as File)).toBe(fromFiles);
    expect(mocks.persistMutate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'photo-0.png', width: 3, height: 2, mimeType: 'image/png' })
    );
  });

  test('an image the browser cannot decode shows friendly copy, not the browser diagnostic', async () => {
    const onAccepted = vi.fn();
    openModal(onAccepted);
    await chooseFiles(fileInputEl(), [corruptFile('photo-0.png')]);

    await expect.element(page.getByText(PREP_MESSAGE, { exact: true })).toBeVisible();
    // A readable pick keeps its preview: the control for the `previewEl()` null check above.
    expect(previewEl()).not.toBeNull();
    expect(mocks.uploadToCF).not.toHaveBeenCalled();
    expect(onAccepted).not.toHaveBeenCalled();
  });

  test('the preview and the dimension read use an in-memory copy, never the picked File', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL');
    const createImageBitmap = vi.spyOn(window, 'createImageBitmap');
    const onAccepted = vi.fn();
    openModal(onAccepted);
    const picked = await pngFile('photo-0.png');
    await chooseFiles(fileInputEl(), [picked]);

    await vi.waitFor(() => expect(onAccepted).toHaveBeenCalledTimes(1));
    const files = (calls: unknown[][]) =>
      calls.map(([arg]) => arg).filter((arg): arg is File => arg instanceof File);
    const previewed = files(createObjectURL.mock.calls);
    const decoded = files(createImageBitmap.mock.calls);
    createObjectURL.mockRestore();
    createImageBitmap.mockRestore();
    for (const read of [previewed, decoded]) {
      expect(read).toHaveLength(1);
      expect(isPickSnapshot(read[0])).toBe(true);
      expect(pickOriginal(read[0])).toBe(picked);
    }
  });

  test('closing the modal mid-upload accepts nothing', async () => {
    let finishUpload: (v: { id: string }) => void = () => undefined;
    mocks.uploadToCF.mockReturnValue(new Promise((r) => (finishUpload = r)));
    const onAccepted = vi.fn();
    openModal(onAccepted);
    await chooseFiles(fileInputEl(), [await pngFile('photo-0.png')]);
    await vi.waitFor(() => expect(mocks.uploadToCF).toHaveBeenCalledTimes(1));

    useDialogStore.getState().closeAll();
    await vi.waitFor(() => expect(document.querySelector('input[type="file"]')).toBeNull());
    finishUpload({ id: 'cf-key' });
    await new Promise((r) => setTimeout(r, 100));

    expect(mocks.persistMutate).not.toHaveBeenCalled();
    expect(onAccepted).not.toHaveBeenCalled();
  });

  // Passes at base too: the control that the friendly copy is not shown for every error.
  test('an upload failure still shows its own message', async () => {
    mocks.uploadToCF.mockRejectedValue(new Error('Failed to upload image: 500'));
    openModal(vi.fn());
    await chooseFiles(fileInputEl(), [await pngFile('photo-0.png')]);

    await expect.element(page.getByText('Failed to upload image: 500')).toBeVisible();
  });

  test('after an unreadable pick both choosers are usable, and the button opens the Files chooser', async () => {
    const onAccepted = vi.fn();
    openModal(onAccepted);
    await chooseFiles(fileInputEl(), [await pngFile('unreadable-0.png')]);
    await expect.element(page.getByText(PICK_MESSAGE, { exact: true })).toBeVisible();

    const button = page.getByRole('button', { name: 'Choose from Files' });
    expect.soft(mainControlEl().disabled).toBe(false);
    expect.soft((button.element() as HTMLButtonElement).disabled).toBe(false);

    // A real click: a disabled button would not reach the input. The OS chooser is not opened.
    const opened = vi.spyOn(filesFallbackInput(), 'click').mockImplementation(() => undefined);
    await button.click({ timeout: 2000 });
    expect(opened).toHaveBeenCalledTimes(1);

    await chooseFiles(filesFallbackInput(), [await pngFile('photo-0.png')]);
    await vi.waitFor(() => expect(onAccepted).toHaveBeenCalledTimes(1));
  });

  test('closing the modal while the pick is still being read previews and uploads nothing', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL');
    const createImageBitmap = vi.spyOn(window, 'createImageBitmap');
    const picked = await pngFile('photo-0.png');
    const bytes = await picked.arrayBuffer();
    let finishRead: (bytes: ArrayBuffer) => void = () => undefined;
    const read = vi.fn(() => new Promise<ArrayBuffer>((r) => (finishRead = r)));
    picked.arrayBuffer = read;
    const onAccepted = vi.fn();
    openModal(onAccepted);
    await chooseFiles(fileInputEl(), [picked]);
    expect(read).toHaveBeenCalledTimes(1);

    useDialogStore.getState().closeAll();
    await vi.waitFor(() => expect(document.querySelector('input[type="file"]')).toBeNull());
    finishRead(bytes);
    await new Promise((r) => setTimeout(r, 100));

    const previewed = createObjectURL.mock.calls.filter(([arg]) => arg instanceof File);
    const decoded = createImageBitmap.mock.calls.length;
    createObjectURL.mockRestore();
    createImageBitmap.mockRestore();
    expect(previewed).toEqual([]);
    expect(decoded).toBe(0);
    expect(mocks.uploadToCF).not.toHaveBeenCalled();
    expect(mocks.persistMutate).not.toHaveBeenCalled();
    expect(onAccepted).not.toHaveBeenCalled();
  });

  test('an unreadable pick clears the preview of the pick before it', async () => {
    openModal(vi.fn());
    await chooseFiles(fileInputEl(), [corruptFile('photo-0.png')]);
    await expect.element(page.getByText(PREP_MESSAGE, { exact: true })).toBeVisible();
    expect(previewEl()).not.toBeNull();

    await chooseFiles(fileInputEl(), [await pngFile('unreadable-0.png')]);
    await expect.element(page.getByText(PICK_MESSAGE, { exact: true })).toBeVisible();
    expect(previewEl()).toBeNull();
  });

  test('a readable pick clears the unreadable-pick alert', async () => {
    openModal(vi.fn());
    await chooseFiles(fileInputEl(), [await pngFile('unreadable-0.png')]);
    await expect.element(page.getByText(PICK_MESSAGE, { exact: true })).toBeVisible();

    // Ends in an error, so the modal stays open and the alert would still be there to see.
    await chooseFiles(fileInputEl(), [corruptFile('photo-0.png')]);
    await expect.element(page.getByText(PREP_MESSAGE, { exact: true })).toBeVisible();
    expect(document.body.textContent).not.toContain(PICK_MESSAGE);
  });

  test('a file over the pick-copy size is taken by the main input and by the Files chooser alike', async () => {
    const oversized = async (name: string) => {
      const file = await pngFile(name);
      // `size` is redefined rather than allocating the bytes.
      Object.defineProperty(file, 'size', { value: constants.mediaUpload.maxImageFileSize + 1 });
      return file;
    };
    mocks.uploadToCF.mockRejectedValue(new Error('Failed to upload image: 500'));
    openModal(vi.fn());

    const fromMain = await oversized('photo-0.png');
    await chooseFiles(fileInputEl(), [fromMain]);
    await vi.waitFor(() => expect(mocks.uploadToCF).toHaveBeenCalledTimes(1));
    expect(mocks.uploadToCF.mock.calls[0][0]).toBe(fromMain);

    await chooseFiles(fileInputEl(), [await pngFile('unreadable-0.png')]);
    await expect.element(page.getByText(PICK_MESSAGE, { exact: true })).toBeVisible();
    const fromFiles = await oversized('photo-1.png');
    await chooseFiles(filesFallbackInput(), [fromFiles]);
    await vi.waitFor(() => expect(mocks.uploadToCF).toHaveBeenCalledTimes(2));
    expect(mocks.uploadToCF.mock.calls[1][0]).toBe(fromFiles);
    expect(document.body.textContent).not.toContain('Files should not exceed');
  });
});
