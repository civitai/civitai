import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import type * as StorageResolver from '~/server/services/storage-resolver';

/**
 * The chunked upload relay's store write must leave an object servable exactly like the
 * single-shot relay's: same bucket, a server-minted key, and the same storage-resolver
 * registration. These drive the real helpers against a spied S3 client and compare the two
 * paths' registrations directly, so a completion that skipped (or mis-sized) the registration —
 * an object the edge and the scanner can never locate — fails here.
 */

const BUCKET = 'civitai-media-uploads-test';

vi.mock('~/env/server', () => ({
  env: new Proxy(
    {
      S3_IMAGE_B2_ENDPOINT: 'https://s3.example.test',
      S3_IMAGE_B2_ACCESS_KEY: 'image-b2-key',
      S3_IMAGE_B2_SECRET_KEY: 'image-b2-secret',
      S3_IMAGE_B2_BUCKET: 'civitai-media-uploads-test',
      S3_IMAGE_B2_REGION: 'us-west-004',
    } as Record<string, unknown>,
    {
      get(target, prop: string) {
        return prop in target ? target[prop] : undefined;
      },
    }
  ),
}));

const { mockRegisterMediaLocation } = vi.hoisted(() => ({ mockRegisterMediaLocation: vi.fn() }));
vi.mock('~/server/services/storage-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof StorageResolver>()),
  registerMediaLocation: mockRegisterMediaLocation,
}));

import {
  abortImageMultipartToStore,
  completeImageMultipartToStore,
  getB2ImageS3Client,
  startImageMultipartToStore,
  uploadImageBufferToStore,
  uploadImagePartToStore,
} from '~/utils/s3-utils';

type SentCommand = { input: Record<string, unknown> };

const COMMANDS = [
  ['CreateMultipartUpload', CreateMultipartUploadCommand],
  ['UploadPart', UploadPartCommand],
  ['CompleteMultipartUpload', CompleteMultipartUploadCommand],
  ['AbortMultipartUpload', AbortMultipartUploadCommand],
] as const;

/** By `instanceof`, not `constructor.name`, which a bundler is free to rename. */
function kind(command: SentCommand) {
  return COMMANDS.find(([, ctor]) => command instanceof ctor)?.[0] ?? 'other';
}
let sent: SentCommand[];

beforeEach(() => {
  vi.clearAllMocks();
  sent = [];
  vi.spyOn(getB2ImageS3Client(), 'send').mockImplementation((async (command: SentCommand) => {
    sent.push(command);
    switch (kind(command)) {
      case 'CreateMultipartUpload':
        return { UploadId: 'upload-77' };
      case 'UploadPart':
        return { ETag: `"etag-${command.input.PartNumber}"` };
      default:
        return {};
    }
  }) as never);
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('image multipart store helpers', () => {
  it('starts a multipart upload in the image bucket under a server-minted key', async () => {
    const { key, uploadId } = await startImageMultipartToStore({ contentType: 'image/webp' });
    expect(key).toMatch(UUID_RE);
    expect(uploadId).toBe('upload-77');
    expect(sent.map((c) => [kind(c), c.input])).toEqual([
      ['CreateMultipartUpload', { Bucket: BUCKET, Key: key, ContentType: 'image/webp' }],
    ]);
  });

  it('uploads a part into the same bucket and returns its ETag', async () => {
    const body = new Uint8Array(1_234);
    const etag = await uploadImagePartToStore({ key: 'k-1', uploadId: 'u-1', partNumber: 3, body });
    expect(etag).toBe('"etag-3"');
    expect(kind(sent[0])).toBe('UploadPart');
    expect(sent[0].input).toMatchObject({
      Bucket: BUCKET,
      Key: 'k-1',
      UploadId: 'u-1',
      PartNumber: 3,
    });
  });

  it('completes and registers the object the way the single-shot write does', async () => {
    const single = await uploadImageBufferToStore(Buffer.alloc(4_567), {
      contentType: 'image/png',
    });
    const parts = [
      { ETag: '"a"', PartNumber: 1 },
      { ETag: '"b"', PartNumber: 2 },
    ];
    const chunked = await completeImageMultipartToStore({
      key: 'chunked-key',
      uploadId: 'u-9',
      parts,
      totalBytes: 9_876_543,
    });

    expect(chunked).toEqual({ key: 'chunked-key', backend: single.backend });
    const complete = sent.find((c) => kind(c) === 'CompleteMultipartUpload');
    expect(complete?.input).toEqual({
      Bucket: BUCKET,
      Key: 'chunked-key',
      UploadId: 'u-9',
      MultipartUpload: { Parts: parts },
    });
    // Same registration call shape for both paths, each with its own byte count.
    expect(mockRegisterMediaLocation.mock.calls).toEqual([
      [single.key, 'backblaze', 4_567],
      ['chunked-key', 'backblaze', 9_876_543],
    ]);
  });

  it('does not register an object whose completion failed', async () => {
    vi.mocked(getB2ImageS3Client().send).mockRejectedValueOnce(new Error('InvalidPart') as never);
    await expect(
      completeImageMultipartToStore({
        key: 'k-2',
        uploadId: 'u-2',
        parts: [{ ETag: '"a"', PartNumber: 1 }],
        totalBytes: 5_555,
      })
    ).rejects.toThrow('InvalidPart');
    expect(mockRegisterMediaLocation).not.toHaveBeenCalled();
  });

  it('aborts in the image bucket', async () => {
    await abortImageMultipartToStore({ key: 'k-3', uploadId: 'u-3' });
    expect(sent.map((c) => [kind(c), c.input])).toEqual([
      ['AbortMultipartUpload', { Bucket: BUCKET, Key: 'k-3', UploadId: 'u-3' }],
    ]);
  });
});
