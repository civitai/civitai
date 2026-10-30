import { beforeEach, describe, expect, test, vi } from 'vitest';
import type * as ConsumerBlobUpload from '~/utils/consumer-blob-upload';

/**
 * The form re-uploads an on-site source as a fresh blob before submit. The blob's own scan may
 * never come back, so a rating already known for the source must follow it to the new url.
 */

const UPLOADED =
  'https://orchestration-new.civitai.com/v2/consumer/blobs/REUPLOADED.jpeg?sig=s&exp=2999-01-01T00:00:00Z';

const mocks = vi.hoisted(() => ({ uploadConsumerBlob: vi.fn() }));

vi.mock('~/utils/consumer-blob-upload', async (orig) => ({
  ...(await orig<typeof ConsumerBlobUpload>()),
  uploadConsumerBlob: mocks.uploadConsumerBlob,
}));

// eslint-disable-next-line import/first
import { uploadOrchestratorImage } from '~/components/Generation/Input/SourceImageUploadMultiple';
// eslint-disable-next-line import/first
import { recordSourceRating } from '~/components/form-graph/generation/useFlux3MatureSource';
// eslint-disable-next-line import/first
import { sourceMetadataStore, useSourceMetadataStore } from '~/store/source-metadata.store';

async function sourceBlob() {
  const canvas = document.createElement('canvas');
  canvas.width = 600;
  canvas.height = 600;
  canvas.getContext('2d')!.fillRect(0, 0, 600, 600);
  return new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
}

const sourceUrl = async () => URL.createObjectURL(await sourceBlob());

beforeEach(() => {
  useSourceMetadataStore.getState().clearAll();
  mocks.uploadConsumerBlob.mockReset().mockResolvedValue({ url: UPLOADED });
});

describe('uploadOrchestratorImage — a known source rating follows the re-upload', () => {
  test('a mature source is still mature under its uploaded url', async () => {
    const src = await sourceUrl();
    recordSourceRating(src, 'x');

    const result = await uploadOrchestratorImage(src, 'test-rating');

    expect(result.url).toBe(UPLOADED);
    expect(sourceMetadataStore.getMetadata(UPLOADED)?.nsfwLevel).toBe('x');
  });

  test('a cropped copy of a mature source is still mature under its uploaded url', async () => {
    const src = await sourceUrl();
    recordSourceRating(src, 'x');
    const cropped = new File([await sourceBlob()], 'crop.png', { type: 'image/png' });

    await uploadOrchestratorImage(cropped, 'test-crop', src);

    expect(sourceMetadataStore.getMetadata(UPLOADED)?.nsfwLevel).toBe('x');
  });
});
