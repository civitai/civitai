import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as S3Utils from '~/utils/s3-utils';

const { serverUploadImage } = vi.hoisted(() => ({ serverUploadImage: vi.fn() }));
vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof S3Utils>()),
  serverUploadImage,
}));

const { uploadImageFromUrl, TrainingSampleRefusedError, MAX_TRAINING_SAMPLE_REDIRECTS } =
  await import('~/server/services/image.service');

const TRUSTED = 'https://orchestration-new.civitai.com/v2/consumer/blobs/A.jpeg';
const TRUSTED_2 = 'https://orchestration.civitai.com/v2/consumer/blobs/B.jpeg';
const UNTRUSTED = 'https://169.254.169.254/latest/meta-data/';

const redirectTo = (location: string) => new Response(null, { status: 302, headers: { location } });
const image = () => new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }));

const fetchMock = vi.fn();
const fetchedUrls = () => fetchMock.mock.calls.map(([url]) => url);

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  serverUploadImage.mockReset().mockResolvedValue({ done: async () => ({ Key: 'stored-key' }) });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('uploadImageFromUrl', () => {
  it('stores the fetched sample and reads its metadata from the fetched bytes', async () => {
    fetchMock.mockResolvedValueOnce(image());

    const result = await uploadImageFromUrl({ imageUrl: TRUSTED });

    expect(fetchedUrls()).toEqual([TRUSTED]);
    expect(serverUploadImage).toHaveBeenCalledTimes(1);
    expect(serverUploadImage.mock.calls[0][0].file.size).toBe(3);
    expect(result).toMatchObject({ url: 'stored-key', type: 'image', metadata: { size: 3 } });
  });

  it('fetches nothing from a url off the orchestrator hosts', async () => {
    await expect(uploadImageFromUrl({ imageUrl: UNTRUSTED })).rejects.toBeInstanceOf(
      TrainingSampleRefusedError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not follow a redirect to a url off the orchestrator hosts', async () => {
    fetchMock.mockResolvedValueOnce(redirectTo(UNTRUSTED));

    await expect(uploadImageFromUrl({ imageUrl: TRUSTED })).rejects.toBeInstanceOf(
      TrainingSampleRefusedError
    );
    expect(fetchedUrls()).toEqual([TRUSTED]);
  });

  it('follows a redirect between orchestrator urls, never automatically', async () => {
    fetchMock.mockResolvedValueOnce(redirectTo(TRUSTED_2)).mockResolvedValueOnce(image());

    await expect(uploadImageFromUrl({ imageUrl: TRUSTED })).resolves.toMatchObject({
      url: 'stored-key',
    });
    expect(fetchedUrls()).toEqual([TRUSTED, TRUSTED_2]);
    for (const [, init] of fetchMock.mock.calls) expect(init.redirect).toBe('manual');
  });

  it('refuses a redirect past the limit, though the next hop would answer', async () => {
    for (let i = 0; i <= MAX_TRAINING_SAMPLE_REDIRECTS; i++)
      fetchMock.mockResolvedValueOnce(redirectTo(TRUSTED_2));
    fetchMock.mockResolvedValueOnce(image());

    await expect(uploadImageFromUrl({ imageUrl: TRUSTED })).rejects.toBeInstanceOf(
      TrainingSampleRefusedError
    );
    expect(fetchMock).toHaveBeenCalledTimes(MAX_TRAINING_SAMPLE_REDIRECTS + 1);
    expect(serverUploadImage).not.toHaveBeenCalled();
  });
});
