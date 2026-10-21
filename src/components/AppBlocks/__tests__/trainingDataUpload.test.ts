import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ConsumerBlobUploadMod from '~/utils/consumer-blob-upload';

const { uploadConsumerBlob } = vi.hoisted(() => ({ uploadConsumerBlob: vi.fn() }));
vi.mock('~/utils/consumer-blob-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof ConsumerBlobUploadMod>()),
  uploadConsumerBlob: (...a: unknown[]) => uploadConsumerBlob(...a),
}));

import { uploadTrainingDataImage } from '../trainingDataUpload';

const png = () => new Blob([new Uint8Array([1])], { type: 'image/png' });
const URL_K1 = 'https://orchestration.civitai.com/v2/consumer/blobs/K1.png?sig=1';

describe('uploadTrainingDataImage', () => {
  beforeEach(() => uploadConsumerBlob.mockReset());

  it('returns the upload url and the key a training item names', async () => {
    uploadConsumerBlob.mockResolvedValue({ id: 'K1.png', url: URL_K1 });
    await expect(uploadTrainingDataImage(png())).resolves.toEqual({ url: URL_K1, air: 'K1.png' });
  });

  it.each([
    ['no url', { id: 'K1.png', url: null }],
    ['a blocked blob', { id: 'K1.png', url: URL_K1, blockedReason: 'refused' }],
    ['a url that names no blob key', { id: 'K1.png', url: 'https://example.com/x.png' }],
  ])('throws for %s, so the host never records it', async (_l, blob) => {
    uploadConsumerBlob.mockResolvedValue(blob);
    await expect(uploadTrainingDataImage(png())).rejects.toThrow('could not be uploaded');
  });

  it('refuses a file that is not an image before uploading anything', async () => {
    await expect(
      uploadTrainingDataImage(new Blob([new Uint8Array([1])], { type: 'video/mp4' }))
    ).rejects.toThrow('image');
    expect(uploadConsumerBlob).not.toHaveBeenCalled();
  });
});
