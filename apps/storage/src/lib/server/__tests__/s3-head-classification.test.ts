import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `headObject`'s error classification — the seam that decides whether a caller sees "the object is
 * gone" or "we could not ask".
 *
 * 🔴 Why this file exists at all: `app.test.ts` mocks the whole backend
 * (`headObject: async () => ({ exists: true, … })`), so nothing in this service exercised the
 * classifier. That is fine while `exists: false` only means a missing key. It stopped being fine
 * when the main app's moderator publish guard started reading this answer as a PERMANENT,
 * un-overridable refusal to publish: a classification that says "absent" for a question we never
 * successfully asked now fails the whole moderator queue CLOSED.
 */

const send = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = send;
  },
  HeadObjectCommand: class {
    constructor(public input: unknown) {}
  },
  // The module imports these at load time; they are never constructed in this file's cases.
  AbortMultipartUploadCommand: class {},
  CompleteMultipartUploadCommand: class {},
  CreateMultipartUploadCommand: class {},
  DeleteObjectCommand: class {},
  DeleteObjectsCommand: class {},
  GetObjectCommand: class {},
  PutObjectCommand: class {},
  UploadPartCommand: class {},
}));
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn(async () => 'https://x') }));

const { createS3Client } = await import('../s3');

const backend = () =>
  createS3Client({
    endpoint: 'https://s3.test.invalid',
    accessKey: 'k',
    secretKey: 's',
    bucket: 'a-bucket',
  });

beforeEach(() => {
  vi.resetAllMocks();
});

describe('headObject — which S3 rejections mean "definitively not there"', () => {
  it('reports a present object', async () => {
    send.mockResolvedValue({ ContentLength: 4096, ContentType: 'image/png' });
    await expect(backend().headObject('some-key')).resolves.toMatchObject({
      exists: true,
      size: 4096,
    });
  });

  it.each([
    ['NotFound', { name: 'NotFound', $metadata: { httpStatusCode: 404 } }],
    ['NoSuchKey', { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } }],
    [
      'a bare 404 from a provider with no recognisable name',
      { $metadata: { httpStatusCode: 404 } },
    ],
  ])('maps %s to exists:false', async (_label, error) => {
    send.mockRejectedValue(error);
    await expect(backend().headObject('some-key')).resolves.toEqual({ exists: false });
  });

  it('RETHROWS a missing BUCKET rather than calling it a missing object', async () => {
    /**
     * 🔴 The finding this closes. `NoSuchBucket` carries `httpStatusCode: 404`, so the bare-404 row
     * above swallows it unless the NAME is tested first — and the two mean opposite things. A
     * missing key is one broken image; a missing bucket is "every key will answer this way,
     * because we are asking the wrong store".
     *
     * Downstream that difference is the whole safety property: the storage client turns a throw
     * into a `StorageClientError`, which the missing-media guard reads as `unknown` and FAILS OPEN.
     * Classified as `exists: false` it would instead refuse every publish in the moderator queue,
     * permanently, while emitting log lines indistinguishable from a genuine run of misses.
     *
     * 🔴 The fixture KEEPS the 404 status deliberately. Dropping it would make this case pass even
     * with the name check deleted — it would fall through to the generic rethrow at the bottom —
     * so the test could not see the mutant it exists to catch.
     */
    send.mockRejectedValue({ name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } });
    await expect(backend().headObject('some-key')).rejects.toMatchObject({ name: 'NoSuchBucket' });
  });

  it.each([
    ['a 403 from a rotated key', { name: 'Forbidden', $metadata: { httpStatusCode: 403 } }],
    ['a 500 from the backend', { name: 'InternalError', $metadata: { httpStatusCode: 500 } }],
  ])('rethrows %s, so the caller can tell it apart from a miss', async (_label, error) => {
    send.mockRejectedValue(error);
    await expect(backend().headObject('some-key')).rejects.toBeTruthy();
  });
});
