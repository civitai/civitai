import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type * as PostEditProviderMod from '~/components/Post/EditV2/PostEditProvider';
import type * as ShowCreatePostErrorMod from '~/components/Post/showCreatePostError';
import type { TrackedFile } from '~/components/FileUpload/FileUploadProvider';

/**
 * The dropzone shows each item on its way to the post: generator media from its source url while
 * it downloads, and a file being uploaded from a local URL. Only the upload itself and the post
 * store are replaced.
 */

const mocks = vi.hoisted(() => ({
  files: [] as TrackedFile[],
  params: {} as Record<string, unknown>,
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return { ...(await importOriginal<typeof TrpcMod>()), trpc: makeTrpcProxy() };
});

vi.mock('~/components/Post/EditV2/PostEditProvider', async (orig) => ({
  ...(await orig<typeof PostEditProviderMod>()),
  usePostEditStore: (selector: (state: unknown) => unknown) =>
    selector({ post: { id: 1 }, images: [], setImages: vi.fn() }),
  usePostEditParams: () => mocks.params,
}));

vi.mock('~/components/Post/showCreatePostError', async (orig) => ({
  ...(await orig<typeof ShowCreatePostErrorMod>()),
  useShowCreatePostError: () => vi.fn(),
}));

vi.mock('~/hooks/useS3Upload', () => ({
  useS3Upload: () => ({
    files: mocks.files,
    uploadToS3: () => new Promise(() => undefined),
    resetFiles: vi.fn(),
    removeFile: vi.fn(),
  }),
}));

// eslint-disable-next-line import/first
import { PostImageDropzone } from '~/components/Post/EditV2/PostImageDropzone';
// eslint-disable-next-line import/first
import { orchestratorMediaTransmitter } from '~/store/post-image-transmitter.store';

// A 1x1 PNG: it loads, so the tile keeps it as an image.
const SOURCE_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function renderDropzone() {
  renderWithProviders(<PostImageDropzone />, { user: { id: 1, muted: false } });
}

describe('PostImageDropzone — items on their way to the post', () => {
  beforeEach(() => {
    mocks.files = [];
    mocks.params = {};
  });
  afterEach(() => vi.restoreAllMocks());

  test('generator media shows from its source url, preparing, while it is still downloading', async () => {
    // The download never finishes: the item has no File yet.
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => undefined));
    orchestratorMediaTransmitter.setUrls('generator', [{ url: SOURCE_URL }]);
    mocks.params = { src: 'generator' };
    renderDropzone();

    await vi.waitFor(() => {
      const img = document.querySelector<HTMLImageElement>('[aria-label="Uploading"] img');
      expect(img?.getAttribute('src')).toBe(SOURCE_URL);
    });
    expect(document.querySelector('[aria-label="Uploading"]')?.textContent).toContain('Preparing…');
  });

  test('a file being uploaded shows from a local URL', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' });
    mocks.files = [
      {
        file,
        progress: 30,
        uploaded: 1,
        size: file.size,
        speed: 0,
        timeRemaining: 0,
        status: 'uploading',
        abort: () => undefined,
        url: '',
        name: file.name,
      },
    ];
    renderDropzone();

    await vi.waitFor(() => {
      const img = document.querySelector<HTMLImageElement>('[aria-label="Uploading"] img');
      expect(img?.getAttribute('src')).toMatch(/^blob:/);
    });
  });
});
