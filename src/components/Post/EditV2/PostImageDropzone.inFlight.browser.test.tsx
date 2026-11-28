import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type * as PostEditProviderMod from '~/components/Post/EditV2/PostEditProvider';
import type * as ShowCreatePostErrorMod from '~/components/Post/showCreatePostError';
import type * as Notifications from '~/utils/notifications';

/**
 * Generator media shows in the dropzone from its source url from the moment it is handed over
 * until it is queued for upload, and not after. The real dropzone, transmitter and upload hook run;
 * the network, the S3 upload and the post store are replaced, as in the sibling dropzone tests.
 */

const mocks = vi.hoisted(() => ({
  params: {} as Record<string, unknown>,
  post: { id: 1 } as { id: number } | null,
  uploadToS3: vi.fn(),
  showErrorNotification: vi.fn(),
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return { ...(await importOriginal<typeof TrpcMod>()), trpc: makeTrpcProxy() };
});

vi.mock('~/components/Post/EditV2/PostEditProvider', async (orig) => ({
  ...(await orig<typeof PostEditProviderMod>()),
  usePostEditStore: (selector: (state: unknown) => unknown) =>
    selector({ post: mocks.post, images: [], setImages: vi.fn() }),
  usePostEditParams: () => mocks.params,
}));

vi.mock('~/components/Post/showCreatePostError', async (orig) => ({
  ...(await orig<typeof ShowCreatePostErrorMod>()),
  useShowCreatePostError: () => vi.fn(),
}));

vi.mock('~/utils/notifications', async (orig) => ({
  ...(await orig<typeof Notifications>()),
  showErrorNotification: mocks.showErrorNotification,
}));

vi.mock('~/hooks/useS3Upload', () => ({
  useS3Upload: () => ({
    files: [],
    uploadToS3: mocks.uploadToS3,
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
    mocks.params = {};
    mocks.post = { id: 1 };
    mocks.uploadToS3.mockReset().mockImplementation(() => new Promise(() => undefined));
    mocks.showErrorNotification.mockReset();
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

  test('a downloaded item stays preparing until it is queued for upload, then its tile goes', async () => {
    const png = await (await fetch(SOURCE_URL)).blob();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(png));
    // Whether the preparing tile was still up when the upload began.
    let preparingAtUpload: boolean | undefined;
    mocks.uploadToS3.mockImplementation(() => {
      preparingAtUpload = !!document.body.textContent?.includes('Preparing…');
      return new Promise(() => undefined);
    });
    orchestratorMediaTransmitter.setUrls('generator', [{ url: SOURCE_URL }]);
    mocks.params = { src: 'generator' };
    renderDropzone();

    await vi.waitFor(() => expect(mocks.uploadToS3).toHaveBeenCalledTimes(1));
    expect(preparingAtUpload).toBe(true);
    await vi.waitFor(() => expect(document.body.textContent).not.toContain('Preparing…'));
  });

  test('an item whose download fails does not stay preparing', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    orchestratorMediaTransmitter.setUrls('generator', [{ url: SOURCE_URL }]);
    mocks.params = { src: 'generator' };
    renderDropzone();

    await vi.waitFor(() => expect(mocks.showErrorNotification).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(document.body.textContent).not.toContain('Preparing…'));
    expect(mocks.uploadToS3).not.toHaveBeenCalled();
  });

  test('a batch whose post create a newer batch replaced does not stay preparing', async () => {
    const png = await (await fetch(SOURCE_URL)).blob();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(png));
    // No post yet, and the stubbed create never answers: each batch waits on its own create.
    mocks.post = null;
    const first = `${SOURCE_URL}#first`;
    const second = `${SOURCE_URL}#second`;
    mocks.params = { src: 'generator' };
    renderDropzone();
    const preparingSrcs = () =>
      [...document.querySelectorAll('[aria-label="Uploading"] img')].map((img) =>
        img.getAttribute('src')
      );

    orchestratorMediaTransmitter.setUrls('generator', [{ url: first }]);
    await vi.waitFor(() => expect(preparingSrcs()).toEqual([first]));
    // Long enough for the first download to finish and its create to start.
    await new Promise((r) => setTimeout(r, 200));

    orchestratorMediaTransmitter.setUrls('generator', [{ url: second }]);
    await vi.waitFor(() => expect(preparingSrcs()).toEqual([second]));
  });
});
