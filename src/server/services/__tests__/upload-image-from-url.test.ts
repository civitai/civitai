import { describe, expect, it, vi } from 'vitest';
import type * as FileUtils from '~/utils/file-utils';

const { fetchBlob } = vi.hoisted(() => ({ fetchBlob: vi.fn(async () => null) }));
vi.mock('~/utils/file-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof FileUtils>()),
  fetchBlob,
}));

const { uploadImageFromUrl } = await import('~/server/services/image.service');

describe('uploadImageFromUrl', () => {
  it('fetches nothing from a url off the orchestrator hosts', async () => {
    await expect(
      uploadImageFromUrl({ imageUrl: 'https://169.254.169.254/latest/meta-data/' })
    ).rejects.toThrow('Unsupported image url');
    expect(fetchBlob).not.toHaveBeenCalled();
  });

  it('fetches an orchestrator sample url', async () => {
    const imageUrl = 'https://orchestration-new.civitai.com/v2/consumer/blobs/A.jpeg';
    await expect(uploadImageFromUrl({ imageUrl })).rejects.toThrow('Failed to fetch image');
    expect(fetchBlob).toHaveBeenCalledWith(imageUrl);
  });
});
