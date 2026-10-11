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
  afterEach(() => restoreReads());

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
        'app-block-upload pick failed: pick-unreadable',
        'app-block-upload-pick',
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
    const corrupt = new File([new Uint8Array([1, 2, 3, 4])], 'photo-0.png', { type: 'image/png' });
    await chooseFiles(fileInputEl(), [corrupt]);

    await expect.element(page.getByText(PREP_MESSAGE, { exact: true })).toBeVisible();
    expect(mocks.uploadToCF).not.toHaveBeenCalled();
    expect(onAccepted).not.toHaveBeenCalled();
  });

  test('an upload failure still shows its own message', async () => {
    mocks.uploadToCF.mockRejectedValue(new Error('Failed to upload image: 500'));
    openModal(vi.fn());
    await chooseFiles(fileInputEl(), [await pngFile('photo-0.png')]);

    await expect.element(page.getByText('Failed to upload image: 500')).toBeVisible();
  });
});
