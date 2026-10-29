import { beforeEach, describe, expect, test, vi } from 'vitest';
import ExifReader from 'exifreader';
import { embedMetadata } from '@civitai/generation-metadata';
import type * as ConsumerBlobUpload from '~/utils/consumer-blob-upload';

/**
 * A generated image's embedded generation metadata must survive the resize/re-encode before upload.
 * The upload still succeeds without it, so only a test on the bytes notices.
 */

const mocks = vi.hoisted(() => ({ uploadConsumerBlob: vi.fn() }));

vi.mock('~/utils/consumer-blob-upload', async (orig) => ({
  ...(await orig<typeof ConsumerBlobUpload>()),
  uploadConsumerBlob: mocks.uploadConsumerBlob,
}));

// eslint-disable-next-line import/first
import { uploadOrchestratorImage } from '~/components/Generation/Input/SourceImageUploadMultiple';
// eslint-disable-next-line import/first
import { getCroppedImg } from '~/shared/utils/canvas-utils';

const STAMP = { software: '0b5e8f0e-3c1a-4f6e-9d2b-7a4c1e9f2d10', artist: 'ai' };

async function stampedFile(width: number, height: number, type: 'image/png' | 'image/jpeg') {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.fillRect(0, 0, width, height);
  const plain = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), type));
  const bytes = await embedMetadata(new Uint8Array(await plain.arrayBuffer()), {
    ...STAMP,
    parameters: 'a lighthouse\nSteps: 20, Sampler: Euler a, CFG scale: 7, Seed: 1',
  });
  return new File([bytes as BlobPart], type === 'image/png' ? 'gen.png' : 'gen.jpg', { type });
}

async function stampOf(blob: Blob) {
  const tags = ExifReader.load(await blob.arrayBuffer());
  return { software: tags.Software?.description, artist: tags.Artist?.description };
}

async function upload(file: File) {
  const result = await uploadOrchestratorImage(file, `test-${Math.random()}`);
  expect(mocks.uploadConsumerBlob).toHaveBeenCalledTimes(1);
  const [sent] = mocks.uploadConsumerBlob.mock.calls[0] as [Blob];
  return { sent, result };
}

describe('uploadOrchestratorImage — a Civitai generation keeps its AI stamp through the re-encode', () => {
  beforeEach(() => {
    mocks.uploadConsumerBlob.mockReset().mockResolvedValue({ url: 'https://example.com/x.jpg' });
  });

  test('a PNG converted to JPEG', async () => {
    const source = await stampedFile(600, 600, 'image/png');
    expect(await stampOf(source)).toEqual(STAMP);

    const { sent } = await upload(source);

    expect(sent.type).toBe('image/jpeg');
    expect(await stampOf(sent)).toEqual(STAMP);
  });

  test('a JPEG over the size limit, resized', async () => {
    // Wider than maxUpscaleSize (3840), so the uploader must resize rather than pass it through.
    const source = await stampedFile(3900, 320, 'image/jpeg');
    expect(await stampOf(source)).toEqual(STAMP);

    const { sent, result } = await upload(source);

    expect(result.width).toBeLessThan(3900);
    expect(await stampOf(sent)).toEqual(STAMP);
  });

  // The crop modal re-encodes before the upload, and a cropped JPEG within the size limit is then
  // uploaded as-is, so the stamp rides on the crop's own copy.
  test('a cropped image', async () => {
    const source = await stampedFile(800, 600, 'image/png');
    const url = URL.createObjectURL(source);
    try {
      const cropped = await getCroppedImg(url, { x: 100, y: 0, width: 600, height: 600 });
      expect(cropped).toBeInstanceOf(Blob);

      const { sent, result } = await upload(
        new File([cropped!], 'crop.jpg', { type: 'image/jpeg' })
      );

      expect(result.width).toBe(600);
      expect(await stampOf(sent)).toEqual(STAMP);
    } finally {
      URL.revokeObjectURL(url);
    }
  });
});
