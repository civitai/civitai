import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import { chooseFiles, makeFullReadsFail } from '../../../../test/unreadable-files';
import type * as TrpcMod from '~/utils/trpc';
import type * as PostEditProviderMod from '~/components/Post/EditV2/PostEditProvider';
import type * as ShowCreatePostErrorMod from '~/components/Post/showCreatePostError';
import type * as MediaPreprocessors from '~/utils/media-preprocessors';
import type * as Notifications from '~/utils/notifications';
import type * as DeviceHelpers from '~/utils/device-helpers';
import type * as ApplicationError from '~/utils/application-error';

/**
 * The post editor offers the Files fallback for a dropped file whose read fails later on, but only
 * for a file still backed by the device: an in-memory copy taken at the pick cannot be refused by
 * the picker, so its failure is the image itself and keeps the ordinary error. The real dropzone and
 * upload hook run; only preparing the file (preprocessFile) and the upload itself are replaced.
 */

const mocks = vi.hoisted(() => ({
  preprocessFile: vi.fn(),
  uploadToS3: vi.fn(),
  showErrorNotification: vi.fn(),
  images: [] as unknown[],
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return { ...(await importOriginal<typeof TrpcMod>()), trpc: makeTrpcProxy() };
});

vi.mock('~/components/Post/EditV2/PostEditProvider', async (orig) => ({
  ...(await orig<typeof PostEditProviderMod>()),
  usePostEditStore: (selector: (state: unknown) => unknown) =>
    selector({ post: { id: 1 }, images: mocks.images, setImages: vi.fn() }),
  usePostEditParams: () => ({}),
}));

vi.mock('~/components/Post/showCreatePostError', async (orig) => ({
  ...(await orig<typeof ShowCreatePostErrorMod>()),
  useShowCreatePostError: () => vi.fn(),
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1, muted: false }) }));

vi.mock('~/hooks/useS3Upload', () => ({
  useS3Upload: () => ({
    files: [],
    uploadToS3: mocks.uploadToS3,
    resetFiles: vi.fn(),
    removeFile: vi.fn(),
  }),
}));

vi.mock('~/utils/media-preprocessors', async (orig) => ({
  ...(await orig<typeof MediaPreprocessors>()),
  preprocessFile: mocks.preprocessFile,
}));

vi.mock('~/utils/notifications', async (orig) => ({
  ...(await orig<typeof Notifications>()),
  showErrorNotification: mocks.showErrorNotification,
}));

vi.mock('~/utils/device-helpers', async (orig) => ({
  ...(await orig<typeof DeviceHelpers>()),
  isAndroidDevice: () => true,
}));

vi.mock('~/utils/application-error', async (orig) => ({
  ...(await orig<typeof ApplicationError>()),
  reportApplicationError: vi.fn(async () => undefined),
}));

// eslint-disable-next-line import/first
import { PostImageDropzone } from '~/components/Post/EditV2/PostImageDropzone';
// eslint-disable-next-line import/first
import { POST_IMAGE_LIMIT } from '~/server/common/constants';

const PICK_MESSAGE =
  "Your phone's photo picker gave us a file we can't open. Choose it from Files instead.";

const imageFile = (name: string) =>
  new File([new Uint8Array([1, 2, 3])], name, { type: 'image/jpeg' });
/** A pick still backed by the device: its pick-time copy is not taken (its full read fails). */
const devicePick = (name: string) => imageFile(`uncopied-${name}`);

const notReadable = () => new DOMException('could not be read', 'NotReadableError');

function prepared(file: File) {
  return {
    type: 'image' as const,
    name: file.name,
    mimeType: file.type,
    objectUrl: URL.createObjectURL(file),
    metadata: { size: file.size, width: 10, height: 10, hash: '' },
    meta: undefined,
  };
}

function dropzoneInput() {
  return vi.waitFor(() => {
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="post-dropzone"] input[type=file]:not([data-testid="unreadable-pick-files-input"])'
    );
    if (!input) throw new Error('dropzone input not found');
    return input;
  });
}

function renderDropzone() {
  renderWithProviders(
    <div data-testid="post-dropzone">
      <PostImageDropzone />
    </div>
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('PostImageDropzone — a dropped file whose read fails later', () => {
  let restoreFullReads = () => undefined as void;
  beforeEach(() => {
    mocks.images = [];
    mocks.preprocessFile.mockReset();
    mocks.uploadToS3.mockReset().mockImplementation(() => new Promise(() => undefined));
    mocks.showErrorNotification.mockReset();
    restoreFullReads = makeFullReadsFail();
  });
  afterEach(() => restoreFullReads());

  test('still backed by the device: the Files fallback is offered, with no error notification', async () => {
    mocks.preprocessFile.mockRejectedValue(notReadable());
    renderDropzone();
    await chooseFiles(dropzoneInput(), [devicePick('0.jpg')]);

    await expect.element(page.getByText(PICK_MESSAGE, { exact: true })).toBeVisible();
    expect(mocks.showErrorNotification).not.toHaveBeenCalled();
  });

  test('an in-memory copy taken at the pick: its failure keeps the error notification', async () => {
    mocks.preprocessFile.mockRejectedValue(notReadable());
    renderDropzone();
    await chooseFiles(dropzoneInput(), [imageFile('photo-0.jpg')]);

    await vi.waitFor(() => expect(mocks.showErrorNotification).toHaveBeenCalledTimes(1));
    await sleep(200);
    expect(page.getByText(PICK_MESSAGE).elements()).toHaveLength(0);
  });

  test('the next drop clears the fallback the last one raised', async () => {
    mocks.preprocessFile.mockRejectedValueOnce(notReadable());
    renderDropzone();
    await chooseFiles(dropzoneInput(), [devicePick('0.jpg')]);
    await expect.element(page.getByText(PICK_MESSAGE, { exact: true })).toBeVisible();

    mocks.preprocessFile.mockImplementation(async (file: File) => prepared(file));
    await chooseFiles(dropzoneInput(), [imageFile('photo-1.jpg')]);
    await vi.waitFor(() => expect(mocks.uploadToS3).toHaveBeenCalledTimes(1));
    await expect.poll(() => page.getByText(PICK_MESSAGE).elements().length).toBe(0);
  });
});

describe('PostImageDropzone — a pick over the post limit', () => {
  beforeEach(() => {
    mocks.preprocessFile.mockReset().mockImplementation(async (file: File) => prepared(file));
    mocks.uploadToS3.mockReset().mockImplementation(() => new Promise(() => undefined));
    mocks.showErrorNotification.mockReset();
  });

  test('only as many files as the post has room for are read', async () => {
    mocks.images = Array.from({ length: POST_IMAGE_LIMIT - 2 }, (_, i) => ({
      type: 'added',
      data: { id: i, url: `u${i}` },
    }));
    const files = [0, 1, 2].map((i) => imageFile(`photo-${i}.jpg`));
    const fullReads = files.map((file) => vi.spyOn(file, 'arrayBuffer'));
    renderDropzone();
    await chooseFiles(dropzoneInput(), files);

    await vi.waitFor(() => expect(mocks.uploadToS3).toHaveBeenCalledTimes(2));
    expect(fullReads.map((read) => read.mock.calls.length)).toEqual([1, 1, 0]);
  });
});
